import asyncio
import copy

import pytest

from backend import achievements, engine, game, squid
from backend.app import Service
from backend.store import Store
from backend.tests.test_game import action, finish, settle_dealing, table
from backend.tests.test_showdown import fixed_table


def fold_hand(room, winner=None):
    while room['phase'] == 'betting':
        action(room, 'call' if room['hand']['clock']['pid'] == winner else 'fold')


def next_hand(room):
    game.tick(room, room['hand']['reveal_until'] + .01)


def change(room, **patch):
    game.command(room, room['owner'], dict(type='settings', settings=patch), 1001)


def seated_newcomer(room, name='新人', amount=100):
    p = game.add_player(room, name, 1001)
    p.update(online=True, last_seen=1001)
    game.command(room, p['id'], dict(type='request_seat', name=name, seat=8, amount=amount), 1001)
    game.command(room, room['owner'], dict(type='approve', request=room['requests'][-1]['id']), 1001)
    return p


def test_cycle_awards_then_settles_conserves_and_restarts():
    room, ids = table(squid=True, squid_amount=10)
    game.command(room, ids[0], dict(type='start'), 1000)
    assert room['squid_round']['total'] == 2
    fold_hand(room)
    assert room['hand']['squid']['settlement'] is None
    assert sum(m['count'] for m in room['squid_round']['members']) == 1
    next_hand(room)
    fold_hand(room)
    event = room['hand']['squid']['settlement']
    assert event['number'] == 1 and event['status'] == 'settled'
    assert sum(m['count'] for m in event['members']) == 2
    assert sorted(m['count'] for m in event['members']) == [0, 1, 1]
    assert len(event['payments']) == 1
    assert all(p['due'] == p['amount'] == 20 for p in event['payments'])
    assert room['squid_round'] is None
    assert sum(p['stack'] for p in room['players'].values()) == 300
    assert sum(p['profit'] for p in room['players'].values()) == 0
    next_hand(room)
    assert room['squid_round']['number'] == 2
    assert all(m['count'] == 0 for m in room['squid_round']['members'])


@pytest.mark.parametrize('reveal', [False, True])
def test_repeat_winner_gets_no_token_or_extra_reveal_and_round_waits(reveal):
    room, ids = table(squid=True, squid_amount=10, squid_reveal=reveal)
    game.command(room, ids[0], dict(type='start'), 1000)
    fold_hand(room, winner=ids[0])
    assert room['hand']['squid']['award']['pid'] == ids[0]
    next_hand(room)
    fold_hand(room, winner=ids[0])
    assert room['hand']['squid'] is None
    assert ids[0] not in room['hand']['revealed']
    assert [m['count'] for m in room['squid_round']['members']].count(0) == 2
    assert squid.member(room, ids[0])['count'] == 1
    assert not room['squid_history']
    next_hand(room)
    fold_hand(room, winner=ids[1])
    event = room['hand']['squid']['settlement']
    assert len(event['payments']) == 1
    assert event['payments'][0]['pid'] == ids[2]
    assert event['payments'][0]['amount'] == 20
    assert [p['amount'] for p in event['payments'][0]['transfers']] == [10, 10]


def test_legacy_unfinished_round_caps_tokens_and_keeps_history_and_balances(tmp_path):
    room, ids = table((100,) * 4, squid=True, squid_amount=10)
    game.command(room, ids[0], dict(type='start'), 1000)
    squid.member(room, ids[0])['count'] = 2
    legacy_history = [dict(number=0, status='settled', members=[dict(pid=ids[0], count=3)])]
    room['squid_history'] = copy.deepcopy(legacy_history)
    before = copy.deepcopy(room['players'])
    store = Store(f'sqlite:///{tmp_path}/legacy-squid.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    assert squid.member(restored, ids[0])['count'] == 1
    assert restored['squid_round']['total'] == 3
    assert restored['squid_history'] == legacy_history
    assert [p['stack'] for p in restored['players'].values()] == [p['stack'] for p in before.values()]
    assert not squid.migrate(restored)
    assert store.all()[0]['squid_round'] == restored['squid_round']
    for p in restored['players'].values():
        p.update(online=True, last_seen=2000)
    game.command(restored, ids[0], dict(type='resume'), 2000)
    fold_hand(restored, winner=ids[1])
    assert restored['hand']['squid']['settlement'] is None
    next_hand(restored)
    fold_hand(restored, winner=ids[2])
    event = restored['hand']['squid']['settlement']
    assert event['payments'][0]['pid'] == ids[3]
    assert event['payments'][0]['amount'] == 30
    assert restored['squid_history'][0] == legacy_history[0]


def test_newcomer_only_added_when_dealt_and_returning_player_not_counted_again():
    room, ids = table(squid=True)
    game.command(room, ids[0], dict(type='start'), 1000)
    p = seated_newcomer(room)
    assert room['squid_round']['total'] == 2 and squid.member(room, p['id']) is None
    fold_hand(room)
    next_hand(room)
    assert room['squid_round']['total'] == 3 and squid.member(room, p['id'])['count'] == 0
    game.command(room, p['id'], dict(type='leave'), 1002)
    fold_hand(room)
    assert p['seat'] is None and p['squid_held'] and p['buyout'] == 0
    original = p['stack'], p['buyin']
    game.command(room, p['id'], dict(type='request_seat', name=p['name'], seat=8, amount=0), 1003)
    game.command(room, room['owner'], dict(type='approve', request=room['requests'][-1]['id']), 1003)
    assert (p['stack'], p['buyin']) == original and not p['squid_held']
    next_hand(room)
    assert room['squid_round']['total'] == 3 and len(room['squid_round']['members']) == 4


def test_leaver_retains_liability_and_receives_buyout_after_settlement():
    room, ids = table(squid=True, squid_amount=10)
    game.command(room, ids[0], dict(type='start'), 1000)
    fold_hand(room)
    # Leave a zero-token participant, retaining enough balance to pay next hand.
    pid = next(m['pid'] for m in room['squid_round']['members'] if m['count'] == 0)
    p = room['players'][pid]
    game.command(room, pid, dict(type='leave'), 1002)
    held = p['stack']
    assert p['seat'] is None and p['buyout'] == 0
    assert game.view(room, pid, 1002)['players'][ids.index(pid)]['squid_held']
    next_hand(room)
    assert room['squid_round']['total'] == 2
    fold_hand(room)
    event = room['hand']['squid']['settlement']
    paid = next(x for x in event['payments'] if x['pid'] == pid)
    assert paid['amount'] == 20
    assert p['stack'] == 0 and p['buyout'] == held - 20 and not p['squid_held']
    assert sum(x['stack'] + x['buyout'] for x in room['players'].values()) == 300
    assert room['history'][-1]['squid']['settlement'] == event


def test_price_change_preserves_old_tokens_and_current_hand_snapshot():
    room, ids = table(squid=True, squid_amount=10)
    game.command(room, ids[0], dict(type='start'), 1000)
    change(room, squid_amount=20)
    assert room['hand']['squid_rule']['amount'] == 10
    fold_hand(room)
    assert room['squid_round']['amount'] == 20
    next_hand(room)
    change(room, squid_amount=99)
    fold_hand(room)
    assert room['hand']['squid']['settlement']['amount'] == 20
    assert all(p['due'] == 40 for p in room['hand']['squid']['settlement']['payments'])


def test_disable_last_hand_settles_first_but_incomplete_round_cancels():
    room, ids = table(squid=True)
    game.command(room, ids[0], dict(type='start'), 1000)
    change(room, squid=False)
    fold_hand(room)
    assert room['hand']['squid']['award'] and room['squid_round'] is None
    assert room['squid_history'][-1]['status'] == 'cancelled'
    room, ids = table((100, 100), squid=True, squid_amount=5)
    game.command(room, ids[0], dict(type='start'), 1000)
    change(room, squid=False)
    fold_hand(room)
    assert len(room['squid_history']) == 1 and room['squid_history'][0]['status'] == 'settled'


def test_midhand_on_off_on_only_final_value_applies():
    room, ids = table(squid=True)
    game.command(room, ids[0], dict(type='start'), 1000)
    change(room, squid=False)
    change(room, squid=True)
    fold_hand(room)
    assert room['squid_round']['number'] == 1 and not room['squid_history']
    change(room, squid=False)
    change(room, squid=True)
    next_hand(room)
    assert room['squid_round']['number'] == 2


@pytest.mark.parametrize('end', [False, True])
def test_no_active_players_can_cancel_and_release_all_held_balances(end):
    room, ids = table(squid=True)
    game.command(room, ids[0], dict(type='start'), 1000)
    fold_hand(room)
    for pid in ids:
        game.command(room, pid, dict(type='leave'), 1002)
    room['paused'] = True
    if end:
        game.command(room, ids[0], dict(type='end'), 1002)
        game.tick(room, room['hand']['reveal_until'])
        assert room['closed_at']
    else:
        change(room, squid=False)
    assert room['squid_round'] is None
    assert sum(p['buyout'] for p in room['players'].values()) == 300
    assert all(p['stack'] == 0 and not p.get('squid_held') for p in room['players'].values())


def test_away_waiting_and_recovery_keep_round_and_resume_without_duplicate_members(tmp_path):
    room, ids = table(squid=True)
    game.command(room, ids[0], dict(type='start'), 1000)
    fold_hand(room)
    for pid in ids[:2]:
        game.command(room, pid, dict(type='away', value=True), 1002)
    next_hand(room)
    assert room['phase'] == 'waiting'
    before = copy.deepcopy(room['squid_round'])
    store = Store(f'sqlite:///{tmp_path}/squid.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    assert restored['squid_round'] == before
    for p in restored['players'].values():
        p.update(online=True, last_seen=2000)
    game.command(restored, ids[0], dict(type='away', value=False), 2000)
    game.command(restored, ids[0], dict(type='resume'), 2000)
    assert restored['squid_round'] == before


def test_last_player_short_payment_is_split_evenly_with_stable_remainders():
    room, ids = table((100, 100, 2, 100), squid=True, squid_amount=10)
    # The third distinct winner leaves one debtor with only two chips.
    hand = dict(ids=ids, number=1, awards=[dict(pot=0, board=None, winners=[3], amounts=[0, 0, 0, 1])],
                folded=[], revealed=[], squid_rule=squid.rule(room['settings']), squid_round_number=1)
    room['squid_round'] = dict(number=1, total=3, amount=10, started_hand=1, at=1000,
                              members=[dict(pid=pid, name=pid, count=1 if i < 2 else 0) for i, pid in enumerate(ids)])
    event = squid.finish_hand(room, hand, 1001)['settlement']
    assert len(event['payments']) == 1
    short = event['payments'][0]
    assert (short['pid'], short['due'], short['amount']) == (ids[2], 30, 2)
    assert [p['amount'] for p in short['transfers']] == [1, 1, 0]
    assert [p['due'] for p in short['transfers']] == [10, 10, 10]
    assert hand['squid_busted'] == [ids[2]]
    assert squid.distribute(1, [1, 1]) == [1, 0]
    assert squid.distribute(20, [3, 2]) == [12, 8]
    assert all(p['stack'] >= 0 for p in room['players'].values())
    assert sum(p['stack'] for p in room['players'].values()) == 302


@pytest.mark.parametrize('reveal', [False, True])
def test_fold_award_reveal_is_optional_and_private_until_settled(reveal):
    room, ids = table(squid=True, squid_reveal=reveal)
    observer = game.add_player(room, 'observer', 1000)['id']
    game.command(room, ids[0], dict(type='start'), 1000)
    assert game.public_hand(room['hand'], observer)['cards'] == {}
    fold_hand(room)
    winner = room['hand']['squid']['award']['pid']
    assert (winner in game.public_hand(room['hand'], observer)['cards']) is reveal


def test_only_first_runout_main_pot_counts(monkeypatch):
    room, ids, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('7c', '2d'), ('Kc', 'Kd')],
        board=('7h', '2s', '9d', 'Js', '3h'), board2=('Ah', '4s', '8d', 'Ts', '6h'), twice=True, squid=True)
    action(room, 'raise', 100)
    action(room)
    action(room)
    for pid in ids:
        game.command(room, pid, dict(type='vote', value=True), 1002)
    settle_dealing(room)
    assert room['hand']['squid']['award']['pid'] == ids[1]
    assert achievements.main_winner(room['hand']) is None


@pytest.mark.parametrize('awards', [[],
    [dict(pot=1, board=0, winners=[0], amounts=[5, 0])],
    [dict(pot=0, board=0, winners=[0, 1], amounts=[1, 0])],
    [dict(pot=0, board=1, winners=[0], amounts=[1, 0])]])
def test_no_squid_for_empty_pot_side_only_tied_or_second_board_only(awards):
    assert squid.first_main_winner(dict(ids=['a', 'b'], awards=awards, folded=[])) is None


def test_straddle_locks_rule_and_cancellation_uses_latest():
    room, ids = table(squid=True, straddle=True, squid_amount=5)
    game.command(room, ids[0], dict(type='start'), 1000)
    assert room['squid_round'] is None  # Preparing cards does not enroll anyone yet.
    change(room, squid_amount=12, squid_reveal=True)
    assert game.view(room, ids[0], 1001)['squid_current']['amount'] == 5
    game.deal(room, 1002, False)
    assert room['hand']['squid_rule'] == dict(enabled=True, amount=5, reveal=False)
    room, ids = table(squid=True, straddle=True, squid_amount=5)
    game.command(room, ids[0], dict(type='start'), 1000)
    change(room, squid_amount=12)
    game.command(room, ids[1], dict(type='away', value=True), 1001)
    game.deal(room, 1002, False)
    assert room['hand']['squid_rule']['amount'] == 12
    assert room['squid_round']['total'] == 1


def test_defaults_permission_legacy_and_amount_validation():
    room, ids = table()
    assert squid.rule(room['settings']) == dict(enabled=False, amount=None, reveal=False)
    change(room, squid=True)
    assert room['settings']['squid_amount'] == 2
    change(room, bb=4, squid=False)
    change(room, squid=True)
    assert room['settings']['squid_amount'] == 2
    for value in [True, 0, -1, 1.1, '2', game.MAX_INTEGER]:
        with pytest.raises(game.GameError):
            game.settings(dict(squid=True, squid_amount=value))
    with pytest.raises(game.GameError, match='房主'):
        game.command(room, ids[1], dict(type='settings', settings=dict(squid=False)), 1001)
    game.command(room, ids[0], dict(type='start'), 1000)
    # An old in-progress hand cannot retrospectively join a newly enabled round.
    room['hand'].pop('squid_rule')
    room['hand'].pop('squid_round_number')
    room['squid_round'] = None
    fold_hand(room)
    assert room['hand']['squid'] is None


def test_squid_settlement_rollback_and_restart_are_atomic(monkeypatch, tmp_path):
    room, ids = table((100, 100), squid=True, squid_amount=10)
    game.command(room, ids[0], dict(type='start'), 1000)
    store = Store(f'sqlite:///{tmp_path}/atomic.db')
    store.save(room)
    service = Service(store)
    game.command(service.rooms[room['id']], ids[0], dict(type='resume'), 2000)
    before = copy.deepcopy(service.rooms[room['id']])
    save = store.save
    def fail(*args):
        raise RuntimeError('write failure')
    monkeypatch.setattr(store, 'save', fail)
    with pytest.raises(RuntimeError):
        asyncio.run(service.mutate(room['id'], lambda r: action(r, 'fold', now=2001)))
    assert service.rooms[room['id']] == before
    monkeypatch.setattr(store, 'save', save)
    asyncio.run(service.mutate(room['id'], lambda r: action(r, 'fold', now=2001)))
    finished = copy.deepcopy(service.rooms[room['id']])
    restored = Service(store).rooms[room['id']]
    game.finish_hand(restored, engine.state_for(restored['hand']), 3000)
    assert restored['squid_history'] == finished['squid_history']
    assert [p['stack'] for p in restored['players'].values()] == [p['stack'] for p in finished['players'].values()]


def test_held_short_player_bust_is_counted_once_and_rebuildable():
    room, ids = table((5, 100, 100), squid=True, squid_amount=10)
    game.command(room, ids[0], dict(type='start'), 1000)
    game.command(room, ids[0], dict(type='leave'), 1001)
    fold_hand(room)
    assert room['players'][ids[0]]['squid_held']
    next_hand(room)
    fold_hand(room)
    assert room['players'][ids[0]]['achievements']['busts'] == 1
    assert ids[0] in room['hand']['squid_busted']
    previous = copy.deepcopy(room['players'][ids[0]])
    achievements.record(room, room['hand'])
    assert room['players'][ids[0]] == previous
    room.pop('achievement_version')
    achievements.migrate(room)
    assert room['players'][ids[0]]['achievements']['busts'] == 1


def test_seven_deuce_paid_before_squid_and_topup_only_after_both(monkeypatch):
    room, ids, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('7c', '2d'), ('Kc', 'Kd')],
        board=('7h', '2s', '9d', 'Js', '3h'), stacks=(8, 4, 100),
        bounty=True, bounty_amount=5, squid=True, squid_amount=5)
    # The small blind holds a token; the big blind wins the second one.
    squid.member(room, ids[0])['count'] = 1
    game.command(room, room['owner'], dict(type='topup', amount=50), 1001)
    fold_hand(room)
    assert room['hand']['bounty']['total'] == 8
    payments = {p['pid']: p['amount'] for p in room['hand']['squid']['settlement']['payments']}
    assert payments == {ids[2]: 3}
    assert room['players'][ids[2]]['stack'] == 50  # Pending buyin cannot fund either side payment.
    assert room['players'][ids[2]]['achievements']['busts'] == 1
    assert room['players'][ids[0]]['stack'] > 0  # Squid receipts arrive before bust detection.
    assert room['players'][ids[0]]['achievements']['busts'] == 0
    assert sum(p['stack'] for p in room['players'].values()) == 162


def test_zero_balance_former_player_is_not_busted_again_and_kick_keeps_liability(monkeypatch):
    room, ids, _ = fixed_table(monkeypatch, [('2c', '3d'), ('Ac', 'Ad'), ('Kc', 'Kd')],
        board=('Ah', '8h', '9s', '4d', '6s'), stacks=(100, 1, 100), squid=True, squid_amount=5)
    target = ids[0]  # Small blind all-in, deterministically loses at showdown.
    game.command(room, room['owner'], dict(type='kick', pid=target), 1001)
    finish(room)
    p = room['players'][target]
    assert p['stack'] == 0 and p['seat'] is None and p['squid_held'] and not p['banned']
    assert p['achievements']['busts'] == 1
    game.command(room, target, dict(type='request_seat', seat=3, name=p['name'], amount=100), 1002)
    game.command(room, target, dict(type='cancel_request', request=room['requests'][-1]['id']), 1002)
    next_hand(room)
    fold_hand(room)
    assert p['achievements']['busts'] == 1
    payment = next(p for p in room['hand']['squid']['settlement']['payments'] if p['pid'] == target)
    assert payment['amount'] == 0 and payment['due'] == 10


def test_automatic_close_releases_held_funds_and_legacy_straddle_does_not_enroll():
    room, ids = table(squid=True)
    game.command(room, ids[0], dict(type='start'), 1000)
    fold_hand(room)
    for pid in ids:
        game.command(room, pid, dict(type='leave'), 1002)
        room['players'][pid]['online'] = False
    room['empty_since'] = 1002
    game.tick(room, 1002 + 86400)
    assert room['closed_at'] and sum(p['buyout'] for p in room['players'].values()) == 300
    assert room['squid_history'][-1]['status'] == 'cancelled'
    room, ids = table(straddle=True)
    game.command(room, ids[0], dict(type='start'), 1000)
    room['straddle_offer'].pop('squid_rule')
    change(room, squid=True)
    game.deal(room, 1002, False)
    assert not room['hand']['squid_rule']['enabled'] and room['squid_round'] is None


def test_pending_zero_additional_buyin_cannot_use_already_cashed_out_balance():
    room, ids = table(squid=True)
    game.command(room, ids[0], dict(type='start'), 1000)
    fold_hand(room)
    p = room['players'][ids[1]]
    game.command(room, p['id'], dict(type='leave'), 1002)
    game.command(room, p['id'], dict(type='request_seat', seat=1, name=p['name'], amount=0), 1002)
    request = room['requests'][-1]['id']
    change(room, squid=False)
    assert p['stack'] == 0 and p['buyout'] > 0
    with pytest.raises(game.GameError, match='已结算'):
        game.command(room, room['owner'], dict(type='approve', request=request), 1003)
