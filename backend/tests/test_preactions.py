import asyncio
import copy

import pytest
from fastapi.testclient import TestClient

from backend import engine, game
from backend.app import Service, browser_hash, create_app
from backend.store import Store
from backend.tests.test_action_sounds import act, started
from backend.tests.test_game import settle_dealing, finish


def offer(room, pid):
    return game.view(room, pid, 1001)['pre_action']


def choice(room, pid, action):
    return dict(type='pre_action', **{k: offer(room, pid)[k] for k in ('hand', 'street', 'revision')}, action=action)


def choose(room, pid, action):
    game.command(room, pid, choice(room, pid, action), 1001)


@pytest.mark.parametrize('short_deck', [False, True])
def test_legal_options_are_personal_private_and_not_the_current_actors(short_deck):
    room, ids = started((100, 100, 100), short_deck=short_deck)
    observer = game.add_player(room, 'observer', 1000)['id']
    assert offer(room, ids[0]) is None
    assert offer(room, ids[1])['options'] == ['call', 'fold', 'check_or_fold']
    assert offer(room, ids[2])['options'] == ['check', 'fold', 'check_or_fold']
    choose(room, ids[2], 'check')
    assert offer(room, ids[2])['selected'] == 'check'
    assert offer(room, ids[1])['selected'] is None
    assert offer(room, observer) is None
    for viewer in [*ids, observer]:
        visible = game.view(room, viewer, 1001)
        assert all('pre_action' not in p and 'pre_action_revision' not in p for p in visible['players'])
        assert 'pre_action' not in visible['hand']
    assert not any('预行动' in item['text'] for item in room['logs'])
    assert 'pre_action' not in game.public_hand(room['hand'], ids[2])


@pytest.mark.parametrize('pid_index,invalid', [(1, 'check'), (2, 'call'), (1, 'raise'), (2, 'bet')])
def test_invalid_selection_is_rejected_without_mutation(pid_index, invalid):
    room, ids = started((100, 100, 100))
    before = copy.deepcopy(room)
    with pytest.raises(game.GameError):
        choose(room, ids[pid_index], invalid)
    assert room == before


def test_check_is_cleared_immediately_on_raise_and_reselect_is_allowed_before_turn():
    room, ids = started((100, 100, 100))
    choose(room, ids[2], 'check')
    stale = choice(room, ids[2], None)
    bank = room['players'][ids[2]]['bank']
    act(room, 'raise', 10)
    assert room['hand']['clock']['pid'] == ids[1]
    assert offer(room, ids[2])['selected'] is None
    assert offer(room, ids[2])['options'][0] == 'call'
    with pytest.raises(game.GameError, match='已更新'):
        game.command(room, ids[2], stale, 1001)
    act(room, now=1002)
    assert room['hand']['clock'] == dict(pid=ids[2], initial=bank, base_until=1022, until=1022 + bank)
    assert game.view(room, ids[2], 1002)['legal']['call'] == 8
    assert room['hand']['last_actions'].get(ids[2]) is None


def test_invalidated_selection_can_be_replaced_before_turn():
    room, ids = started((100, 100, 100))
    choose(room, ids[2], 'check')
    act(room, 'raise', 10)
    choose(room, ids[2], 'call')
    act(room)
    assert room['phase'] == 'action_hold'
    assert room['hand']['last_actions'][ids[2]] == '跟注'


@pytest.mark.parametrize('action,raise_amount,expected', [
    ('check', None, '过牌'), ('check_or_fold', None, '过牌'),
    ('check_or_fold', 10, '弃牌'), ('fold', None, '弃牌'),
])
def test_automatic_intentions_execute_once_and_preserve_last_action_hold(action, raise_amount, expected):
    room, ids = started((100, 100, 100))
    choose(room, ids[2], action)
    stale = choice(room, ids[2], None)
    bank = room['players'][ids[2]]['bank']
    act(room, 'raise' if raise_amount else 'call', raise_amount)
    act(room, now=1002)
    assert room['phase'] == 'action_hold'
    assert room['deadline'] == 1002 + game.LAST_ACTION_PAUSE
    assert room['hand']['clock'] is None
    assert room['hand']['last_actions'][ids[2]] == expected
    assert room['players'][ids[2]]['pre_action'] is None
    assert room['players'][ids[2]]['bank'] == bank
    assert sum(x['text'].endswith(expected) for x in room['logs']) >= 1
    events = room['hand'].get('action_events', [])
    assert len([e for e in events if e['pid'] == ids[2]]) == int(expected == '过牌')
    with pytest.raises(game.GameError):
        game.command(room, ids[2], stale, 1002)
    settle_dealing(room)
    assert all(not p.get('pre_action') for p in room['players'].values())
    if expected == '过牌':
        assert room['hand']['clock']['pid'] == ids[1]
        act(room, now=1004)
        assert room['hand']['clock']['pid'] == ids[2]  # No auto-check on the flop.


def test_any_call_follows_raise_and_calls_short_all_in_without_spending_bank():
    room, ids = started((100, 7, 100))
    choose(room, ids[1], 'call')
    act(room, 'raise', 20)
    state = engine.state_for(room['hand'])
    index = room['hand']['ids'].index(ids[1])
    assert state.stacks[index] == 0 and state.bets[index] == 7
    assert room['hand']['last_actions'][ids[1]] == '全下'
    assert room['players'][ids[1]]['bank'] == 10
    assert room['hand']['clock']['pid'] == ids[2]
    assert offer(room, ids[1]) is None
    assert room['hand']['action_events'][-1]['kind'] == 'chips'


def test_chained_calls_and_check_are_committed_without_exposing_intermediate_turns():
    room, ids = started((100, 100, 100))
    choose(room, ids[1], 'call')
    choose(room, ids[2], 'check')
    act(room)
    assert room['phase'] == 'action_hold' and room['hand']['clock'] is None
    assert [e['kind'] for e in room['hand']['action_events']] == ['chips', 'chips', 'check']
    assert len({e['seq'] for e in room['hand']['action_events']}) == 3
    assert all(game.view(room, pid, 1001)['legal'] is None for pid in ids)
    assert all(p['bank'] == 10 and not p.get('pre_action') for p in room['players'].values())


def test_modify_cancel_and_stale_window_rejection():
    room, ids = started((100, 100, 100))
    old_window = choice(room, ids[1], 'fold')
    choose(room, ids[1], 'call')
    with pytest.raises(game.GameError, match='已更新'):
        game.command(room, ids[1], old_window, 1001)
    choose(room, ids[1], 'fold')
    assert offer(room, ids[1])['selected'] == 'fold'
    choose(room, ids[1], None)
    assert offer(room, ids[1])['selected'] is None
    act(room)
    assert room['hand']['clock']['pid'] == ids[1]


def test_requests_from_before_an_unselected_turn_cannot_apply_to_a_later_opportunity():
    room, ids = started((100, 100, 100))
    old = choice(room, ids[1], 'call')
    act(room)
    with pytest.raises(game.GameError):
        game.command(room, ids[1], old, 1001)
    act(room)
    with pytest.raises(game.GameError, match='已更新'):
        game.command(room, ids[1], old, 1001)
    assert room['players'][ids[1]].get('pre_action') is None


@pytest.mark.parametrize('transition', ['offline', 'away', 'leave', 'kick', 'pause'])
def test_offline_away_pending_leave_and_pause_do_not_cancel(transition):
    room, ids = started((100, 100, 100))
    choose(room, ids[1], 'call')
    if transition == 'offline':
        room['players'][ids[1]].update(online=False, offline=1001)
    else:
        game.command(room, ids[0] if transition in ('kick', 'pause') else ids[1],
                     dict(type=transition, value=True, pid=ids[1]), 1001)
    act(room)
    assert room['hand']['last_actions'][ids[1]] == '跟注'
    assert room['hand']['clock']['pid'] == ids[2]


def test_timeout_advances_into_saved_preaction():
    room, ids = started((100, 100, 100))
    choose(room, ids[1], 'call')
    game.tick(room, room['hand']['clock']['until'])
    assert room['hand']['last_actions'][ids[1]] == '跟注'
    assert room['players'][ids[1]]['bank'] == 10
    assert room['hand']['clock']['pid'] == ids[2]


def test_restart_preserves_intention_and_recovery_only_allows_cancel(tmp_path):
    room, ids = started((100, 100, 100))
    choose(room, ids[1], 'call')
    choose(room, ids[2], 'check')
    store = Store(f'sqlite:///{tmp_path}/preactions.db')
    store.save(room)
    service = Service(store)
    restored = service.rooms[room['id']]
    before_ops = copy.deepcopy(restored['hand']['ops'])
    assert restored['recovery']
    assert offer(restored, ids[1])['selected'] == 'call'
    assert offer(restored, ids[1])['options'] == []
    game.tick(restored, 1035)
    assert restored['hand']['ops'] == before_ops
    with pytest.raises(game.GameError, match='恢复'):
        choose(restored, ids[1], 'fold')
    choose(restored, ids[2], None)
    game.command(restored, ids[0], {'type': 'resume'}, 1040)
    assert restored['hand']['clock']['pid'] == ids[0]
    act(restored, now=1041)
    assert restored['hand']['last_actions'][ids[1]] == '跟注'
    assert restored['hand']['clock']['pid'] == ids[2]
    assert restored['hand']['clock']['base_until'] == 1061


def test_non_betting_stages_reject_and_do_not_carry_selections_across_streets_or_hands():
    room, ids = started((100, 100, 100))
    old = choice(room, ids[2], 'check')
    choose(room, ids[2], 'check')
    act(room)
    act(room)
    assert room['phase'] == 'action_hold'
    with pytest.raises(game.GameError):
        game.command(room, ids[2], old, 1001)
    game.tick(room, room['deadline'])
    assert room['phase'] == 'dealing'
    with pytest.raises(game.GameError):
        game.command(room, ids[2], old, 1003)
    settle_dealing(room)
    old['revision'] = room['players'][ids[2]]['pre_action_revision']
    with pytest.raises(game.GameError, match='已更新'):
        game.command(room, ids[2], old, 1004)
    finish(room)
    game.tick(room, room['deadline'])
    assert room['number'] == 2
    with pytest.raises(game.GameError):
        game.command(room, ids[2], old, 1010)


def test_failed_save_cannot_confirm_selection_or_consume_it_with_an_action(tmp_path, monkeypatch):
    room, ids = started((100, 100, 100))
    store = Store(f'sqlite:///{tmp_path}/atomic.db')
    service = Service(store)
    store.save(room)
    service.rooms[room['id']] = room
    published = []
    async def publish(rid):
        published.append(copy.deepcopy(service.rooms[rid]))
    service.publish = publish
    original = store.save
    def fail(*args):
        raise RuntimeError('save failed')
    monkeypatch.setattr(store, 'save', fail)
    with pytest.raises(RuntimeError):
        asyncio.run(service.mutate(room['id'], lambda r: choose(r, ids[1], 'call')))
    assert published == [] and not room['players'][ids[1]].get('pre_action')
    monkeypatch.setattr(store, 'save', original)
    asyncio.run(service.mutate(room['id'], lambda r: choose(r, ids[1], 'call')))
    saved = copy.deepcopy(service.rooms[room['id']])
    monkeypatch.setattr(store, 'save', fail)
    with pytest.raises(RuntimeError):
        asyncio.run(service.mutate(room['id'], act))
    assert len(published) == 1
    assert store.all()[0] == saved == service.rooms[room['id']]
    monkeypatch.setattr(store, 'save', original)
    asyncio.run(service.mutate(room['id'], act))
    assert len(published) == 2 and published[-1]['hand']['clock']['pid'] == ids[2]
    assert not store.all()[0]['players'][ids[1]]['pre_action']


def test_api_duplicate_commands_identity_recovery_and_private_views(tmp_path):
    room, ids = started((100, 100, 100))
    cookie = 'preaction-browser-cookie-123456789'
    room['players'][ids[1]]['browser'] = browser_hash(cookie)
    store = Store(f'sqlite:///{tmp_path}/api.db')
    with TestClient(create_app(store)) as client:
        store.save(room)
        client.app.state.service.rooms[room['id']] = room
        client.cookies.set('river_browser', cookie)
        root = f'/api/rooms/{room["id"]}'
        data = {**choice(room, ids[1], 'call'), 'command_id': 'preaction-test-1234'}
        assert client.post(root + '/commands', json=data).status_code == 200
        first = client.get(root).json()
        assert client.post(root + '/commands', json=data).json()['duplicate']
        assert client.get(root).json()['pre_action'] == first['pre_action']
        code = first['recovery_code']
        client.cookies.clear()
        assert client.get(root).json()['pre_action'] is None
        assert client.post(root + '/recover', json={'code': code}).status_code == 200
        recalled = client.get(root).json()
        assert recalled['me'] == ids[1] and recalled['pre_action']['selected'] == 'call'


def test_ten_seat_fold_chain_stops_at_last_player_and_preserves_chip_conservation():
    room, ids = started((100,) * 10)
    actor = room['hand']['clock']['pid']
    for pid in ids:
        if pid != actor:
            choose(room, pid, 'fold')
    act(room, 'fold')
    assert room['phase'] == 'action_hold'
    assert all(not p.get('pre_action') for p in room['players'].values())
    assert len(engine.folded_players(room['hand'])) == 9
    settle_dealing(room)
    assert room['hand']['result'] is not None
    assert sum(p['stack'] for p in room['players'].values()) == 1000


@pytest.mark.parametrize('cancel_first', [False, True])
def test_room_lock_serializes_cancel_against_execution(tmp_path, cancel_first):
    room, ids = started((100, 100, 100))
    choose(room, ids[1], 'call')
    cancel = choice(room, ids[1], None)
    store = Store(f'sqlite:///{tmp_path}/race.db')
    service = Service(store)
    store.save(room)
    service.rooms[room['id']] = room

    async def race():
        operations = [lambda r: game.command(r, ids[1], cancel, 1001), act]
        if not cancel_first:
            operations.reverse()
        return await asyncio.gather(*(service.mutate(room['id'], fn) for fn in operations), return_exceptions=True)

    results = asyncio.run(race())
    saved = service.rooms[room['id']]
    assert store.all()[0] == saved
    assert saved['hand']['clock']['pid'] == ids[1 if cancel_first else 2]
    assert not saved['players'][ids[1]]['pre_action']
    assert len(saved['hand']['action_events']) == (1 if cancel_first else 2)
    assert sum(isinstance(result, game.GameError) for result in results) == int(not cancel_first)
