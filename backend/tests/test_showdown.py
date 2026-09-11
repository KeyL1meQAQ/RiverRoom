import copy

import pytest

from backend import engine, game
from backend.app import Service
from backend.tests.test_game import action, finish, settle_dealing, table


def fixed_table(monkeypatch, holes, stacks=None, board=('2h', '5s', '9d', 'Js', '3h'), board2=None, **config):
    original = engine.new_hand

    def new_hand(*args):
        hand = original(*args)
        dealt = [card for column in zip(*holes) for card in column]
        burns = [c for c in hand['deck'] if c not in dealt and c not in board and c not in (board2 or [])][:6 if board2 else 3]
        prefix = dealt + burns[:1] + list(board[:3]) + burns[1:2] + [board[3]] + burns[2:3] + [board[4]]
        if board2:
            prefix += burns[3:4] + list(board2[:3]) + burns[4:5] + [board2[3]] + burns[5:] + [board2[4]]
        hand['deck'] = prefix + [c for c in hand['deck'] if c not in prefix]
        return hand

    monkeypatch.setattr(engine, 'new_hand', new_hand)
    room, seats = table(stacks or (100,) * len(holes), **config)
    observer = game.add_player(room, 'observer', 1000)['id']
    game.command(room, seats[0], {'type': 'start'}, 1000)
    return room, room['hand']['ids'], observer


def reach_river(room):
    while len(room['hand']['boards'][0]) < 5:
        action(room)


def show(room, pid, cards, now=1002, number=None):
    game.command(room, pid, {'type': 'show_cards', 'hand': number or room['number'], 'cards': cards}, now)


def test_check_showdown_reveals_prefix_through_final_winner(monkeypatch):
    room, ids, observer = fixed_table(monkeypatch, [('Kc', 'Kd'), ('Qc', 'Qd'), ('Ac', 'Ad'), ('Tc', 'Td')])
    finish(room)
    hand = room['hand']
    assert hand['awards'][0]['board'] is None
    assert hand['showdown_order'] == ids
    assert hand['revealed'] == ids[:3]
    assert hand['reveal_until'] == hand['finished_at'] + 5
    for viewer in [observer, *ids]:
        state = game.view(room, viewer, 1002)
        assert not any(p['folded'] for p in state['players'])
        for pid in ids[:3]:
            assert state['hand']['cards'][pid] == hand['dealt'][pid]
            assert state['history'][-1]['cards'][pid] == hand['dealt'][pid]
            assert next(p for p in state['players'] if p['id'] == pid)['cards'] == hand['dealt'][pid]
        if viewer != ids[3]:
            assert ids[3] not in state['hand']['cards']


def test_river_last_raise_starts_order_and_wraps(monkeypatch):
    room, ids, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd'), ('Tc', 'Td')])
    reach_river(room)
    action(room)
    action(room)
    action(room, 'raise', 10)
    finish(room)
    assert room['hand']['showdown_order'] == ids[2:] + ids[:2]
    assert room['hand']['revealed'] == ids[2:] + ids[:1]


def test_turn_aggressor_does_not_start_checked_river(monkeypatch):
    room, ids, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')])
    while len(room['hand']['boards'][0]) < 4:
        action(room)
    action(room)
    action(room, 'raise', 10)
    finish(room)
    assert room['hand']['showdown_order'] == ids
    assert room['hand']['revealed'] == ids[:1]


def test_heads_up_checked_river_starts_left_of_button(monkeypatch):
    room, ids, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    finish(room)
    assert room['players'][ids[0]]['seat'] != room['button']
    assert room['hand']['showdown_order'] == ids
    assert room['hand']['revealed'] == ids[:1]


def test_tied_winner_later_in_order_must_also_reveal(monkeypatch):
    room, ids, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Qc', 'Qd'), ('Ah', 'As'), ('Tc', 'Td')])
    finish(room)
    winners = [r['pid'] for r in room['hand']['result'] if r['won']]
    assert winners == [ids[0], ids[2]]
    assert room['hand']['revealed'] == ids[:3]


def test_fold_win_and_folded_single_card_reveal(monkeypatch):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')])
    folded = room['hand']['clock']['pid']
    action(room, 'fold')
    action(room, 'fold')
    assert room['hand']['revealed'] == []
    assert game.public_hand(room['hand'], observer)['cards'] == {}
    balances = [p['stack'] for p in room['players'].values()]
    show(room, folded, [1])
    card = room['hand']['dealt'][folded][1]
    for viewer in [observer, *(pid for pid in ids if pid != folded)]:
        state = game.view(room, viewer, 1002)
        assert state['hand']['cards'][folded] == [None, card]
        assert state['history'][-1]['cards'][folded] == [None, card]
        assert next(p for p in state['players'] if p['id'] == folded)['cards'] == [None, card]
    assert room['logs'][-1]['text'].endswith(card)
    assert room['hand']['dealt'][folded][0] not in room['logs'][-1]['text']
    count = len(room['logs'])
    show(room, folded, [1])
    assert len(room['logs']) == count
    show(room, folded, [0, 1], now=1003)
    assert folded in room['hand']['revealed']
    assert game.public_hand(room['hand'], observer)['cards'][folded] == room['hand']['dealt'][folded]
    assert [p['stack'] for p in room['players'].values()] == balances


@pytest.mark.parametrize('timeout', [False, True])
def test_fold_persists_after_settlement_and_restart_until_next_deal(monkeypatch, tmp_path, timeout):
    from backend.store import Store

    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')])
    folded = room['hand']['clock']['pid']
    room['paused'] = True
    if timeout:
        game.tick(room, room['hand']['clock']['until'] + 1)
    else:
        action(room, 'fold')
    assert next(p for p in game.view(room, observer, 1002)['players'] if p['id'] == folded)['folded']
    finish(room)
    assert room['hand']['folded'] == [folded]
    # Exercise an older persisted hand with no dedicated fold record.
    for hand in [room['hand'], room['history'][0]]:
        hand.pop('folded')
    store = Store(f'sqlite:///{tmp_path}/folded.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    after = restored['hand']['reveal_until'] + 1
    for viewer in [folded, observer, ids[0]]:
        visible = game.view(restored, viewer, after)
        assert [p['id'] for p in visible['players'] if p['folded']] == [folded]
        assert next(p for p in visible['players'] if p['id'] == folded)['cards'] == (
            room['hand']['dealt'][folded] if viewer == folded else [])
    assert restored['history'][0]['folded'] == [folded]
    assert not game.migrate_reveals(restored)
    for p in restored['players'].values():
        p['online'] = True
    game.command(restored, restored['owner'], {'type': 'resume'}, after)
    game.tick(restored, after + 10)
    assert restored['number'] == 2
    assert not any(p['folded'] for p in game.view(restored, observer, after + 10)['players'])


@pytest.mark.parametrize('cards', [None, [], [2], [-1], [True], [0, 0], [0, 1, 0], ['0']])
def test_invalid_card_indices_are_rejected(monkeypatch, cards):
    room, ids, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    action(room, 'fold')
    with pytest.raises(game.GameError):
        show(room, ids[0], cards)
    assert room['hand']['revealed'] == []


def test_deadline_hand_number_and_membership_are_checked(monkeypatch):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    action(room, 'fold')
    game.command(room, room['owner'], {'type': 'pause'}, 1002)
    with pytest.raises(game.GameError, match='过期'):
        show(room, ids[0], [0], number=2)
    with pytest.raises(game.GameError, match='没有可展示'):
        show(room, observer, [0])
    with pytest.raises(game.GameError, match='时间已结束'):
        show(room, ids[0], [0], now=1006)
    game.tick(room, 1010)
    assert room['number'] == 1
    with pytest.raises(game.GameError, match='时间已结束'):
        show(room, ids[0], [0], now=1010)


def test_allin_with_sidepots_reveals_every_contender(monkeypatch):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')], stacks=(200, 40, 100), twice=True)
    action(room, 'raise', 200)
    action(room)
    action(room)
    assert room['phase'] == 'runout'
    assert set(game.public_hand(room['hand'], observer)['cards']) == set(ids)
    for pid in ids:
        game.command(room, pid, {'type': 'vote', 'value': True}, 1002)
    settle_dealing(room)
    assert set(room['hand']['revealed']) == set(ids)
    assert len({a['pot'] for a in room['hand']['awards']}) >= 2
    assert len(room['hand']['boards']) == 2
    assert sum(p['stack'] for p in room['players'].values()) == 340


def test_allin_does_not_expose_cards_before_calls_and_excludes_folded(monkeypatch):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd'), ('Tc', 'Td')])
    action(room, 'raise', 100)
    assert game.public_hand(room['hand'], observer)['cards'] == {}
    folded = room['hand']['clock']['pid']
    action(room, 'fold')
    action(room)
    assert game.public_hand(room['hand'], observer)['cards'] == {}
    action(room)
    assert set(room['hand']['revealed']) == set(ids) - {folded}
    assert folded not in game.public_hand(room['hand'], observer)['cards']


def test_allin_on_river_reveals_losers_after_the_winner(monkeypatch):
    room, ids, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')])
    reach_river(room)
    action(room, 'raise', 98)
    finish(room)
    assert set(room['hand']['revealed']) == set(ids)


def test_rebuy_resolving_early_preserves_five_seconds(monkeypatch):
    room, ids, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    action(room, 'raise', 100)
    action(room)
    assert room['phase'] == 'rebuy'
    finished_at = room['hand']['finished_at']
    assert room['deadline'] == finished_at + 20
    loser = room['rebuy'][0]
    game.command(room, loser, {'type': 'topup', 'amount': 100}, finished_at + 1)
    if room['requests']:
        game.command(room, room['owner'], {'type': 'approve', 'request': room['requests'][0]['id']}, finished_at + 1)
    assert room['number'] == 1 and room['phase'] == 'between'
    assert room['deadline'] == finished_at + 5
    game.tick(room, finished_at + 4.9)
    assert room['number'] == 1
    game.tick(room, finished_at + 5)
    assert room['number'] == 2


def test_closing_waits_for_reveal_and_leavers_can_show(monkeypatch):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    departing = room['hand']['clock']['pid']
    game.command(room, departing, {'type': 'leave'}, 1001)
    game.command(room, room['owner'], {'type': 'end'}, 1001)
    action(room, 'fold')
    assert room['players'][departing]['seat'] is None
    assert room['closed_at'] is None
    show(room, departing, [0])
    assert game.public_hand(room['hand'], observer)['cards'][departing][0]
    game.tick(room, 1006)
    assert room['closed_at'] == 1006


def test_partial_reveal_survives_restart_without_extending_deadline(monkeypatch, tmp_path):
    from backend.store import Store

    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    action(room, 'fold')
    show(room, ids[0], [0])
    store = Store(f'sqlite:///{tmp_path}/restart.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    game.command(restored, restored['owner'], {'type': 'resume'}, 1010)
    assert restored['hand']['reveal_until'] == 1006
    with pytest.raises(game.GameError, match='时间已结束'):
        show(restored, ids[0], [1], now=1010)
    public = game.view(restored, observer, 1010)
    assert public['hand']['cards'][ids[0]] == [room['hand']['dealt'][ids[0]][0], None]
    assert public['history'][0]['cards'][ids[0]] == public['hand']['cards'][ids[0]]


def test_migration_repairs_old_winners_without_exposing_old_losers(monkeypatch, tmp_path):
    from backend.store import Store

    room, ids, observer = fixed_table(monkeypatch, [('Kc', 'Kd'), ('Ac', 'Ad'), ('Qc', 'Qd')])
    finish(room)
    for hand in [room['hand'], room['history'][0]]:
        hand.pop('reveal_version')
        hand.pop('shown_cards')
        hand.pop('showdown_order')
        hand.pop('reveal_until')
        hand.pop('showdown_results')
        hand['revealed'] = []
    room['closed_at'] = 1010
    store = Store(f'sqlite:///{tmp_path}/migration.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    assert restored['hand']['revealed'] == [ids[1]]
    assert restored['history'][0]['revealed'] == [ids[1]]
    assert restored['history'][0]['showdown_results'][0]['winners'][0]['pid'] == ids[1]
    assert set(game.view(restored, observer, 1011)['hand']['cards']) == {ids[1]}
    assert store.all()[0] == restored
    snapshot = copy.deepcopy(restored)
    assert not game.migrate_reveals(restored)
    assert restored == snapshot
