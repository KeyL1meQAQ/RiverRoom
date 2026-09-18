import asyncio
import copy

import pytest

from backend import achievements, bounty, engine, game
from backend.app import Service
from backend.store import Store
from backend.tests.test_game import action, finish, settle_dealing, table
from backend.tests.test_showdown import fixed_table

HOLES = [('Ac', 'Ad'), ('7c', '2d'), ('Kc', 'Kd')]
BOARD = ('7h', '2s', '9d', 'Js', '3h')


def reward_table(monkeypatch, **kwargs):
    return fixed_table(monkeypatch, HOLES, board=BOARD, bounty=True, bounty_amount=5, **kwargs)


def fold_to_big_blind(room):
    action(room, 'fold')
    action(room, 'fold')


def test_fold_reward_pays_each_dealt_player_and_preserves_private_cards(monkeypatch):
    room, ids, observer = reward_table(monkeypatch)
    before = game.view(room, observer, 1001)
    assert before['hand']['cards'] == {} and before['hand']['bounty'] is None
    newcomer = game.add_player(room, 'newcomer', 1001)['id']
    game.command(room, newcomer, dict(type='request_seat', seat=5, name='下一手', amount=100), 1001)
    game.command(room, room['owner'], dict(type='approve', request=room['requests'][-1]['id']), 1001)
    room['players'][ids[0]]['online'] = False
    fold_to_big_blind(room)
    hand = room['hand']
    award = hand['bounty']
    assert award['pid'] == ids[1] and award['total'] == 10
    assert {p['pid']: p['amount'] for p in award['payments']} == {ids[0]: 5, ids[2]: 5}
    assert hand['result'][1]['won'] == 1  # Uncalled big blind is returned, not a pot award.
    assert hand['result'][1]['delta'] == 11
    assert sum(p['stack'] for p in room['players'].values()) == 400
    assert sum(p['profit'] for p in room['players'].values()) == 0
    public = game.view(room, observer, 1002)
    assert public['hand']['cards'] == {ids[1]: ['7c', '2d']}
    assert public['history'][-1]['bounty'] == award
    public['hand']['bounty']['payments'][0]['amount'] = 999
    assert hand['bounty']['payments'][0]['amount'] == 5
    previous = copy.deepcopy(room)
    game.finish_hand(room, engine.state_for(hand), 1002)
    assert room == previous


@pytest.mark.parametrize('cards,enabled,expected', [
    (('7c', '2d'), True, True), (('2c', '7d'), True, True),
    (('7c', '2c'), True, False), (('7c', '3d'), True, False),
    (('7c', '2d'), False, False),
])
def test_exact_hole_cards_and_toggle(monkeypatch, cards, enabled, expected):
    room, ids, observer = fixed_table(monkeypatch, [HOLES[0], cards, HOLES[2]],
                                     board=BOARD, bounty=enabled)
    fold_to_big_blind(room)
    assert bool(room['hand']['bounty']) is expected
    assert bool(game.public_hand(room['hand'], observer)['cards']) is expected


def test_short_balance_before_topup_and_leave_counts_bust(monkeypatch):
    # Engine order is seat 1, seat 2, seat 0; owner folds with 3 left.
    room, ids, _ = reward_table(monkeypatch, stacks=(3, 3, 100))
    game.command(room, room['owner'], dict(type='topup', amount=50), 1001)
    game.command(room, ids[0], dict(type='leave'), 1001)
    fold_to_big_blind(room)
    award = room['hand']['bounty']
    assert award['total'] == 5
    assert {p['pid']: p['amount'] for p in award['payments']} == {ids[0]: 2, ids[2]: 3}
    assert room['players'][ids[0]]['seat'] is None
    assert room['players'][ids[2]]['stack'] == 50
    assert all(room['players'][pid]['achievements']['busts'] == 1 for pid in [ids[0], ids[2]])
    assert sum(r['delta'] for r in room['hand']['result']) == 0
    assert room['hand']['result'][2]['delta'] == -3
    achievements.record(room, room['hand'])
    assert room['players'][ids[2]]['achievements']['busts'] == 1


def test_exact_reward_balance_enters_rebuy_wait(monkeypatch):
    room, ids, _ = reward_table(monkeypatch, stacks=(5, 100, 100))
    fold_to_big_blind(room)
    assert room['players'][ids[2]]['stack'] == 0
    assert ids[2] in room['rebuy'] and room['phase'] == 'rebuy'
    assert room['players'][ids[2]]['achievements']['busts'] == 1


def test_showdown_zero_reward_still_reveals_and_records_event(monkeypatch):
    room, ids, observer = reward_table(monkeypatch)
    action(room, 'raise', 100)
    action(room)
    action(room)
    assert room['hand']['result'] is not None
    award = room['hand']['bounty']
    assert award['pid'] == ids[1] and award['total'] == 0
    assert all(p['amount'] == 0 for p in award['payments'])
    assert game.public_hand(room['hand'], observer)['cards'][ids[1]] == ['7c', '2d']
    assert room['players'][ids[1]]['stack'] == 300


@pytest.mark.parametrize('second,qualifies', [
    (('7s', '2h', '8d', 'Ts', '4h'), True),
    (('Ah', '4s', '8d', 'Ts', '6h'), False),
    (('Ts', 'Qs', 'Ks', 'As', '9s'), False),
])
def test_run_twice_requires_both_main_pots(monkeypatch, second, qualifies):
    room, ids, _ = reward_table(monkeypatch, twice=True, board2=second)
    action(room, 'raise', 100)
    action(room)
    action(room)
    for pid in ids:
        game.command(room, pid, dict(type='vote', value=True), 1002)
    settle_dealing(room)
    assert bool(room['hand']['bounty']) is qualifies
    if qualifies:
        assert room['hand']['bounty']['total'] == 0


def test_main_tie_never_rewards_even_with_one_paid_recipient(monkeypatch):
    room, _, _ = fixed_table(monkeypatch, HOLES, stacks=(1, 1, 1), bounty=True,
                            board=('Ts', 'Js', 'Qs', 'Ks', 'As'), twice=True,
                            board2=('Th', 'Jh', 'Qh', 'Kh', 'Ah'))
    while room['phase'] == 'betting':
        action(room)
    for pid in room['hand']['ids']:
        game.command(room, pid, dict(type='vote', value=True), 1002)
    settle_dealing(room)
    assert room['hand']['bounty'] is None


@pytest.mark.parametrize('main_holder', [True, False])
def test_main_win_can_lose_side_pot_but_side_only_never_qualifies(monkeypatch, main_holder):
    # Main winner short-stacked; the runner-up wins the side pot.
    holes = [('7c', '2d'), ('Ac', 'Ad'), ('Kc', 'Kd')] if main_holder else HOLES
    board = BOARD if main_holder else ('Ah', '7h', '2s', 'Js', '3h')
    room, ids, _ = fixed_table(monkeypatch, holes, stacks=(100, 40, 100), board=board,
                              bounty=True, bounty_amount=5)
    action(room, 'raise', 100)
    action(room)
    action(room)
    assert bool(room['hand']['bounty']) is main_holder
    if main_holder:
        assert room['hand']['bounty']['pid'] == ids[0]
        assert room['hand']['bounty']['total'] == 5
        assert any(a['pot'] == 1 and a['amounts'][1] > 0 for a in room['hand']['awards'])


@pytest.mark.parametrize('value', [0, -1, 1.5, True, '5', game.MAX_INTEGER + 1])
def test_invalid_amount_rejected(value):
    with pytest.raises(game.GameError):
        game.settings(dict(bounty=True, bounty_amount=value))


def test_defaults_fixed_amount_and_midhand_permissions():
    room, ids = table()
    assert bounty.rule(room['settings']) == dict(enabled=False, amount=None)
    game.command(room, ids[0], dict(type='settings', settings=dict(bounty=True)), 1000)
    assert room['settings']['bounty_amount'] == 2
    game.command(room, ids[0], dict(type='settings', settings=dict(bb=4)), 1000)
    assert room['settings']['bounty_amount'] == 2
    game.command(room, ids[0], dict(type='start'), 1000)
    with pytest.raises(game.GameError, match='房主'):
        game.command(room, ids[1], dict(type='settings', settings=dict(bounty=False)), 1001)
    with pytest.raises(game.GameError, match='只能调整'):
        game.command(room, ids[0], dict(type='settings', settings=dict(bb=8)), 1001)
    game.command(room, ids[0], dict(type='settings', settings=dict(bounty=False)), 1001)
    assert room['hand']['bounty_rule'] == dict(enabled=True, amount=2)
    assert game.view(room, ids[0], 1001)['bounty_current']['enabled']
    game.command(room, ids[0], dict(type='settings', settings=dict(bounty=True)), 1001)
    assert room['settings']['bounty_amount'] == 2


def test_midhand_change_does_not_change_current_payment(monkeypatch):
    room, ids, _ = reward_table(monkeypatch)
    game.command(room, room['owner'], dict(type='settings', settings=dict(bounty=False, bounty_amount=99)), 1001)
    fold_to_big_blind(room)
    assert room['hand']['bounty']['total'] == 10
    game.tick(room, room['hand']['reveal_until'])
    assert room['hand']['bounty_rule'] == dict(enabled=False, amount=99)


def test_straddle_snapshot_survives_update_restart_and_legacy_offer(tmp_path):
    room, ids = table(straddle=True, bounty=True, bounty_amount=7)
    game.command(room, ids[0], dict(type='start'), 1000)
    assert room['phase'] == 'straddle'
    game.command(room, ids[0], dict(type='settings', settings=dict(bounty_amount=20)), 1001)
    assert game.view(room, ids[0], 1001)['bounty_current']['amount'] == 7
    store = Store(f'sqlite:///{tmp_path}/straddle.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    for p in restored['players'].values():
        p.update(online=True, last_seen=2000)
    game.command(restored, ids[0], dict(type='resume'), 2000)
    game.command(restored, restored['straddle_offer']['pid'], dict(type='straddle', value=False), 2001)
    assert restored['hand']['bounty_rule'] == dict(enabled=True, amount=7)
    # An offer prepared by the previous version has no snapshot: no retroactive reward.
    room['straddle_offer'].pop('bounty_rule')
    game.deal(room, 1002, False)
    assert not room['hand']['bounty_rule']['enabled']


def test_canceled_offer_uses_latest_rule_for_new_preparation():
    room, ids = table(straddle=True, bounty=True, bounty_amount=7)
    game.command(room, ids[0], dict(type='start'), 1000)
    game.command(room, ids[0], dict(type='settings', settings=dict(bounty_amount=20)), 1001)
    # Removing a player invalidates the existing offer and starts a fresh preparation.
    game.command(room, ids[1], dict(type='away', value=True), 1001)
    game.deal(room, 1002, False)
    assert room['hand']['bounty_rule'] == dict(enabled=True, amount=20)


def test_legacy_room_and_inflight_hand_never_get_retroactive_reward(monkeypatch, tmp_path):
    room, ids, _ = reward_table(monkeypatch)
    room['settings'].pop('bounty')
    room['settings'].pop('bounty_amount')
    room['hand'].pop('bounty_rule')
    store = Store(f'sqlite:///{tmp_path}/old.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    assert bounty.rule(restored['settings']) == dict(enabled=False, amount=None)
    game.command(restored, restored['owner'], dict(type='settings', settings=dict(bounty=True)), 2000)
    game.command(restored, restored['owner'], dict(type='resume'), 2000)
    fold_to_big_blind(restored)
    assert restored['hand']['bounty'] is None


def test_reward_transaction_rolls_back_and_restart_never_pays_twice(monkeypatch, tmp_path):
    room, ids, _ = reward_table(monkeypatch)
    action(room, 'fold')
    store = Store(f'sqlite:///{tmp_path}/atomic.db')
    store.save(room)
    service = Service(store)
    game.command(service.rooms[room['id']], room['owner'], dict(type='resume'), 2000)
    before = copy.deepcopy(service.rooms[room['id']])
    saved = store.save
    def fail(*args):
        raise RuntimeError('storage failure')
    monkeypatch.setattr(store, 'save', fail)
    with pytest.raises(RuntimeError, match='storage failure'):
        asyncio.run(service.mutate(room['id'], lambda r: action(r, 'fold', now=2001)))
    assert service.rooms[room['id']] == before
    monkeypatch.setattr(store, 'save', saved)
    asyncio.run(service.mutate(room['id'], lambda r: action(r, 'fold', now=2001)))
    finished = service.rooms[room['id']]
    balances = {pid: p['stack'] for pid, p in finished['players'].items()}
    event = copy.deepcopy(finished['hand']['bounty'])
    restored = Service(store).rooms[room['id']]
    game.finish_hand(restored, engine.state_for(restored['hand']), 3000)
    assert {pid: p['stack'] for pid, p in restored['players'].items()} == balances
    assert restored['hand']['bounty'] == event and len(restored['history']) == 1


def test_zero_pot_does_not_reward_even_with_seven_deuce():
    room, seats = table([100] * 4, bounty=True)
    game.command(room, seats[0], dict(type='start'), 1000)
    old_bb = next(p['id'] for p in room['players'].values() if p['seat'] == room['big_blind'])
    while room['phase'] == 'betting':
        action(room, 'fold')
    game.command(room, old_bb, dict(type='away', value=True), 1001)
    game.tick(room, room['hand']['reveal_until'])
    hand = room['hand']
    winner = hand['ids'][0]
    # Force the persisted private cards to match the rule; no pot still takes priority.
    hand['dealt'][winner] = ['7c', '2d']
    while room['phase'] == 'betting':
        action(room, 'fold', now=1007)
    assert hand['awards'] == [] and hand['bounty'] is None
