import asyncio
import copy

import pytest

from backend import achievements, engine, game
from backend.app import Service, create_app, browser_hash
from backend.store import Store
from backend.tests.test_game import action, finish, settle_dealing
from backend.tests.test_showdown import fixed_table
from fastapi.testclient import TestClient


def allin_table(monkeypatch, twice=False, board2=None, topup=False):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')],
        stacks=(100, 40, 100), twice=twice, board2=board2)
    if topup:
        game.command(room, ids[2], dict(type='topup', amount=50), 1001)
        assert room['requests'][0]['approved']
    action(room, 'raise', 100)
    action(room)
    # All-in is not yet a completed bust.
    assert all(p['achievements'] == dict(wins=0, busts=0) for p in room['players'].values())
    action(room)
    if twice:
        for pid in ids:
            game.command(room, pid, dict(type='vote', value=True), 1002)
        settle_dealing(room)
    return room, ids, observer


def legacy(room):
    for key in ('achievement_version', 'achievement_hand', 'achievement_since'):
        room.pop(key, None)
    for player in room['players'].values():
        player.pop('achievements', None)


def test_main_win_side_win_bust_and_queued_topup(monkeypatch):
    room, ids, observer = allin_table(monkeypatch, topup=True)
    assert room['players'][ids[0]]['achievements'] == dict(wins=1, busts=0)
    assert room['players'][ids[1]]['achievements'] == dict(wins=0, busts=0)
    assert room['players'][ids[2]]['achievements'] == dict(wins=0, busts=1)
    assert room['players'][ids[2]]['stack'] == 50
    assert room['players'][observer]['achievements'] == dict(wins=0, busts=0)
    before = copy.deepcopy(room)
    game.finish_hand(room, engine.state_for(room['hand']), 2000)
    achievements.record(room, room['history'][0])
    assert room == before
    # Counts follow the participant, not the seat or chips bought afterward.
    game.command(room, ids[0], dict(type='leave'), 2001)
    game.command(room, ids[0], dict(type='request_seat', seat=3, name='重新入座', amount=80), 2002)
    game.command(room, room['owner'], dict(type='approve', request=room['requests'][-1]['id']), 2003)
    assert room['players'][ids[0]]['achievements'] == dict(wins=1, busts=0)
    assert game.view(room, observer, 2004)['players'][0]['achievements'] is not None


@pytest.mark.parametrize('second,win', [
    (('4h', '7s', '8d', 'Ts', 'Jh'), True),
    (('Kh', '2d', '3s', '7h', '8d'), False),
    (('Th', 'Jh', 'Qh', 'Kh', 'Ah'), False),
])
def test_twice_requires_both_main_pots_but_not_side_pots(monkeypatch, second, win):
    room, ids, _ = allin_table(monkeypatch, twice=True, board2=second)
    assert room['players'][ids[0]]['achievements']['wins'] == int(win)
    assert sum(p['achievements']['wins'] for p in room['players'].values()) == int(win)
    if win:
        assert any(a['pot'] > 0 and a['winners'] == [1] for a in room['hand']['awards'])


def test_folding_win_is_counted_without_revealing_cards(monkeypatch):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')])
    action(room, 'fold')
    action(room, 'fold')
    winner = next(r['pid'] for r in room['hand']['result'] if r['won'])
    assert room['players'][winner]['achievements']['wins'] == 1
    assert room['hand']['awards'][0]['winners'] == []
    assert winner not in game.view(room, observer, 1002)['hand']['cards']
    legacy(room)
    for hand in [room['hand'], *room['history']]:
        for award in hand['awards']:
            award.pop('winners')
        hand.pop('folded')
    assert achievements.migrate(room)
    assert room['players'][winner]['achievements']['wins'] == 1


def test_board_tie_and_odd_zero_chip_winner_do_not_count(monkeypatch):
    room, _, _ = fixed_table(monkeypatch, [('2c', '3d'), ('4c', '5d'), ('6c', '7d')],
        board=('Ts', 'Js', 'Qs', 'Ks', 'As'))
    finish(room)
    assert all(p['achievements']['wins'] == 0 for p in room['players'].values())
    hand = dict(ids=['a', 'b'], runouts=2, awards=[
        dict(pot=0, board=0, winners=[0], amounts=[1, 0]),
        dict(pot=0, board=1, winners=[0, 1], amounts=[1, 0]),
    ])
    assert achievements.main_winner(hand) is None


def test_single_main_award_can_cover_both_runouts():
    hand = dict(ids=['a', 'b'], runouts=2,
        awards=[dict(pot=0, board=None, winners=[0], amounts=[4, 0])])
    assert achievements.main_winner(hand) == 'a'


def test_full_history_backfill_and_restart_are_idempotent(monkeypatch, tmp_path):
    room, ids, _ = allin_table(monkeypatch)
    room['history'] = [dict(copy.deepcopy(room['hand']), number=i) for i in range(1, 106)]
    room.update(hand=copy.deepcopy(room['history'][-1]), number=105, closed_at=2000)
    legacy(room)
    # Legacy winner metadata is recovered by private deterministic replay.
    for hand in [room['hand'], *room['history']]:
        for award in hand['awards']:
            award.pop('winners')
    store = Store(f'sqlite:///{tmp_path}/badges.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    assert restored['players'][ids[0]]['achievements']['wins'] == 105
    assert restored['players'][ids[2]]['achievements']['busts'] == 105
    assert restored['achievement_since'] == dict(wins=1, busts=1)
    assert len(game.view(restored, ids[0], 2001)['history']) == 100
    again = Service(store).rooms[room['id']]
    assert again == restored
    assert not achievements.migrate(again)


def test_incomplete_history_uses_explicit_contiguous_start(monkeypatch):
    room, ids, _ = allin_table(monkeypatch)
    room['history'] = [dict(copy.deepcopy(room['hand']), number=i) for i in range(1, 5)]
    room.update(hand=copy.deepcopy(room['history'][-1]), number=4)
    room['history'][1].pop('awards')
    room['history'][1].pop('ops')
    legacy(room)
    achievements.migrate(room)
    assert room['achievement_since'] == dict(wins=3, busts=1)
    assert room['players'][ids[0]]['achievements']['wins'] == 2
    assert room['players'][ids[2]]['achievements']['busts'] == 4
    legacy(room)
    room['history'] = room['history'][2:]
    achievements.migrate(room)
    assert room['achievement_since'] == dict(wins=3, busts=3)
    assert room['players'][ids[2]]['achievements']['busts'] == 2


def test_live_corrupt_result_fails_instead_of_resetting_counts(monkeypatch):
    room, _, _ = allin_table(monkeypatch)
    broken = dict(room['hand'], number=2, awards=[])
    with pytest.raises(ValueError, match='Missing main pot'):
        achievements.record(room, broken)
    assert room['achievement_since'] == dict(wins=1, busts=1)


def test_recovery_and_public_view_preserve_achievements(monkeypatch, tmp_path):
    room, ids, _ = allin_table(monkeypatch)
    cookie = 'achievement-recovery-cookie-123456'
    room['players'][ids[0]]['browser'] = browser_hash(cookie)
    code = room['players'][ids[0]]['code']
    store = Store(f'sqlite:///{tmp_path}/recovery.db')
    store.save(room)
    with TestClient(create_app(store)) as client:
        rid = room['id']
        client.get(f'/api/rooms/{rid}')
        assert client.post(f'/api/rooms/{rid}/recover', json=dict(code=code)).status_code == 200
        state = client.get(f'/api/rooms/{rid}').json()
        assert state['me'] == ids[0]
        assert next(p for p in state['players'] if p['id'] == ids[0])['achievements']['wins'] == 1
        assert state['achievement_since'] == dict(wins=1, busts=1)
        assert all('deck' not in p and 'code' not in p for p in state['players'])


def test_count_write_failure_rolls_back_and_retry_counts_once(monkeypatch, tmp_path):
    room, ids, _ = allin_table(monkeypatch)
    store = Store(f'sqlite:///{tmp_path}/atomic.db')
    store.save(room)
    service = Service(store)
    before = copy.deepcopy(service.rooms[room['id']])
    next_hand = dict(copy.deepcopy(room['hand']), number=2)
    save = store.save
    def fail(*args):
        raise RuntimeError('Simulated storage failure')
    monkeypatch.setattr(store, 'save', fail)
    with pytest.raises(RuntimeError, match='Simulated storage failure'):
        asyncio.run(service.mutate(room['id'], lambda r: achievements.record(r, next_hand)))
    assert service.rooms[room['id']] == before
    assert store.all()[0] == before
    monkeypatch.setattr(store, 'save', save)
    asyncio.run(service.mutate(room['id'], lambda r: achievements.record(r, next_hand)))
    asyncio.run(service.mutate(room['id'], lambda r: achievements.record(r, next_hand)))
    assert service.rooms[room['id']]['players'][ids[0]]['achievements']['wins'] == 2
    assert store.all()[0]['players'][ids[2]]['achievements']['busts'] == 2


def test_public_snapshot_does_not_share_mutable_achievement_fields(monkeypatch):
    room, ids, observer = allin_table(monkeypatch)
    snapshot = game.view(room, observer, 2000)
    room['players'][ids[0]]['achievements']['wins'] += 1
    room['achievement_since']['wins'] = 2
    assert next(p for p in snapshot['players'] if p['id'] == ids[0])['achievements']['wins'] == 1
    assert snapshot['achievement_since']['wins'] == 1
