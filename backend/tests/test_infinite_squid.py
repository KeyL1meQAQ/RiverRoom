"""Infinite-round contracts: real game lifecycle plus bounded settlement scenarios."""
import copy

import pytest

from backend import game, squid
from backend.app import Service
from backend.store import Store
from backend.tests.test_game import table
from backend.tests.test_squid import change, fold_hand, next_hand, seated_newcomer


def infinite(stacks=(1000,) * 3, **config):
    return table(stacks, squid=True, squid_mode='infinite', squid_amount=10, **config)


def resolved_hand(room, ids, winner=None, awards=None):
    """Drive the rule boundary with explicit engine awards (not a live poker hand)."""
    room['number'] += 1
    hand = dict(number=room['number'], ids=ids, folded=[], revealed=[],
                awards=awards if awards is not None else [dict(pot=0, board=0,
                    winners=[winner] if winner is not None else [0, 1], amounts=[0] * len(ids))])
    squid.begin_hand(room, hand, squid.effective_rule(room), 1000 + room['number'])
    event = squid.finish_hand(room, hand, 1000 + room['number'])
    return hand, event


def test_repeated_winner_exhausts_budget_and_all_debtors_pay():
    room, ids = infinite(squid_multiplier=True, squid_reveal=True)
    game.command(room, ids[0], dict(type='start'), 1000)
    for gained in (2, 1, 1, 1, 1):
        assert room['hand']['squid_contested'] == gained
        fold_hand(room, ids[0])
        assert room['hand']['squid']['award']['gained'] == gained
        assert ids[0] in room['hand']['revealed']
        if room['squid_round']:
            next_hand(room)
    event = room['squid_history'][-1]
    assert event['total'] == event['issued'] == 6
    assert event['reason'] == '发放完毕'
    assert len(event['payments']) == 2
    assert all(p['amount'] == p['due'] == 240 for p in event['payments'])
    winner = next(r for r in event['results'] if r['pid'] == ids[0])
    assert (winner['count'], winner['multiplier'], winner['delta'], winner['due']) == (6, 4, 480, 480)
    assert sum(p['stack'] for p in room['players'].values()) == 3000
    next_hand(room)
    assert room['hand']['squid_contested'] == 2


def test_early_end_only_charges_issued_and_heads_up_restarts():
    room, ids = infinite((100, 100))
    game.command(room, ids[0], dict(type='start'), 1000)
    fold_hand(room)
    event = room['squid_history'][-1]
    assert (event['total'], event['issued'], event['payments'][0]['due']) == (5, 2, 20)
    assert event['reason'] == '仅剩一人无鱿鱼'
    next_hand(room)
    assert room['squid_round']['number'] == 2 and room['hand']['squid_contested'] == 2


def test_chops_and_refunds_carry_cap_and_restart_without_duplicate_awards():
    room, ids = infinite(squid_multiplier=True)
    for expected in (2, 3, 4, 5, 6, 6):
        hand, event = resolved_hand(room, ids, awards=[] if expected == 3 else None)
        assert hand['squid_contested'] == expected and event is None
        before = copy.deepcopy(room)
        assert squid.finish_hand(room, hand, 9999) is None
        assert room == before
    hand, event = resolved_hand(room, ids, winner=0)
    assert event['award']['gained'] == 6
    assert event['settlement']['payments'][0]['due'] == 240
    before = copy.deepcopy(room)
    assert squid.finish_hand(room, hand, 9999) == event
    assert room == before
    hand, _ = resolved_hand(room, ids, winner=0)
    assert hand['squid_contested'] == 2


@pytest.mark.parametrize('count,factor', [(1, 1), (2, 1), (3, 2), (4, 2), (5, 4), (6, 4), (7, 8), (9, 8), (13, 8)])
def test_personal_thresholds_and_all_tokens(count, factor):
    room, ids = infinite((10000,) * 10, squid_multiplier=True)
    # Feed count-1 ties: one award crosses all applicable thresholds at once.
    for _ in range(max(0, count - 2)):
        resolved_hand(room, ids)
    hand, _ = resolved_hand(room, ids, winner=0)
    if count == 1:
        assert squid.multiplier(1, dict(mode='infinite', multiplier=True)) == factor
    else:
        member = squid.member(room, ids[0])
        actual = member['count'] if member else hand['squid']['award']['count']
        assert actual == count
        assert squid.multiplier(actual, dict(mode='infinite', multiplier=True)) == factor
    assert squid.multiplier(count, dict(mode='classic', multiplier=True)) == 1
    assert squid.multiplier(count, dict(mode='infinite', multiplier=False)) == 1


def test_short_debtor_uses_multiplier_weights_and_stable_remainder():
    room, ids = infinite((100, 100, 41), squid_multiplier=True)
    resolved_hand(room, ids, winner=0)  # 2/0/0
    resolved_hand(room, ids, winner=0)  # 3/0/0
    resolved_hand(room, ids)  # carry 1, next award 2
    _, event = resolved_hand(room, ids, winner=1)  # 3/2/0: early end
    settlement = event['settlement']
    assert (settlement['issued'], settlement['total']) == (5, 6)
    payment = settlement['payments'][0]
    assert (payment['due'], payment['amount']) == (80, 41)
    assert [(t['due'], t['amount']) for t in payment['transfers']] == [(60, 31), (20, 10)]
    assert sum(r['delta'] for r in settlement['results']) == 0
    assert sum(p['stack'] for p in room['players'].values()) == 241


def test_first_run_chop_ignores_second_run_and_side_pots():
    room, ids = infinite()
    awards = [dict(pot=0, board=0, winners=[0, 1], amounts=[1, 0, 0]),
              dict(pot=0, board=1, winners=[2], amounts=[0, 0, 1]),
              dict(pot=1, board=0, winners=[0], amounts=[2, 0, 0])]
    _, event = resolved_hand(room, ids, awards=awards)
    assert event is None
    hand, event = resolved_hand(room, ids, winner=2)
    assert hand['squid_contested'] == event['award']['gained'] == 3


def test_join_leave_return_changes_members_not_total_and_settlement_releases_funds():
    room, ids = infinite()
    game.command(room, ids[0], dict(type='start'), 1000)
    newcomer = seated_newcomer(room, amount=1000)
    assert squid.member(room, newcomer['id']) is None
    fold_hand(room, ids[0])
    next_hand(room)
    assert room['squid_round']['total'] == 6 and len(room['squid_round']['members']) == 4
    game.command(room, newcomer['id'], dict(type='leave'), 1002)
    fold_hand(room, ids[0])
    assert newcomer['squid_held'] and newcomer['buyout'] == 0
    before = newcomer['stack'], newcomer['buyin']
    game.command(room, newcomer['id'], dict(type='request_seat', seat=8, name=newcomer['name'], amount=0), 1003)
    game.command(room, ids[0], dict(type='approve', request=room['requests'][-1]['id']), 1003)
    assert (newcomer['stack'], newcomer['buyin']) == before
    next_hand(room)
    assert len(room['squid_round']['members']) == 4 and room['squid_round']['total'] == 6
    game.command(room, newcomer['id'], dict(type='leave'), 1004)
    fold_hand(room, ids[0])
    held = newcomer['stack']
    for _ in range(2):
        next_hand(room)
        fold_hand(room, ids[0])
    event = room['squid_history'][-1]
    assert len(event['payments']) == 3
    assert newcomer['buyout'] == held - 60 and not newcomer['squid_held']
    next_hand(room)
    assert room['squid_round']['total'] == 6


def test_mode_and_multiplier_wait_for_round_price_waits_for_hand():
    room, ids = table((1000,) * 3, squid=True, squid_amount=10)
    game.command(room, ids[0], dict(type='start'), 1000)
    change(room, squid_mode='infinite', squid_multiplier=True, squid_amount=20)
    fold_hand(room, ids[0])
    assert game.view(room, ids[0], 1002)['squid_current']['mode'] == 'classic'
    next_hand(room)
    assert room['hand']['squid_rule'] == dict(enabled=True, amount=20, reveal=False, mode='classic', multiplier=False)
    fold_hand(room, ids[0])  # ordinary repeat wins do not finish the round
    next_hand(room)
    fold_hand(room, ids[1])
    next_hand(room)
    assert room['hand']['squid_rule']['mode'] == 'infinite'
    assert room['squid_round']['multiplier'] is True
    change(room, squid_mode='classic', squid_multiplier=False)
    fold_hand(room, ids[0])
    assert game.view(room, ids[0], 1002)['squid_current']['mode'] == 'infinite'
    next_hand(room)
    assert room['hand']['squid_rule']['multiplier'] is True
    fold_hand(room, ids[1])
    assert room['squid_history'][-1]['mode'] == 'infinite'
    next_hand(room)
    assert room['squid_round']['mode'] == 'classic' and not room['squid_round']['multiplier']


def test_straddle_locks_new_round_and_cancellation_reads_last_selection():
    room, ids = infinite(straddle=True)
    game.command(room, ids[0], dict(type='start'), 1000)
    change(room, squid_mode='classic', squid_multiplier=True)
    game.deal(room, 1002, False)
    assert room['squid_round']['mode'] == 'infinite' and not room['squid_round']['multiplier']
    assert room['hand']['squid_contested'] == 2
    room, ids = infinite(straddle=True)
    game.command(room, ids[0], dict(type='start'), 1000)
    change(room, squid_mode='classic')
    game.command(room, ids[1], dict(type='away', value=True), 1001)
    game.deal(room, 1002, False)
    assert room['squid_round']['mode'] == 'classic' and room['squid_round']['total'] == 1


def test_newcomer_recounts_only_next_round_and_last_config_wins_while_paused():
    room, ids = infinite()
    game.command(room, ids[0], dict(type='start'), 1000)
    newcomer = seated_newcomer(room, amount=1000)
    fold_hand(room, ids[0])
    game.command(room, ids[0], dict(type='pause'), 1002)
    change(room, squid_mode='classic', squid_multiplier=True)
    next_hand(room)
    assert room['squid_round']['mode'] == 'infinite'
    assert not room['squid_round']['multiplier']
    assert squid.member(room, newcomer['id']) is None
    change(room, squid_mode='infinite', squid_multiplier=False)
    game.command(room, ids[0], dict(type='resume'), 1100)
    game.tick(room, room['deadline'] + .01)
    assert len(room['squid_round']['members']) == 4 and room['squid_round']['total'] == 6
    for i in range(4):
        if i:
            next_hand(room)
        fold_hand(room, ids[0])
    assert room['squid_history'][-1]['total'] == 6
    next_hand(room)
    assert room['squid_round']['total'] == 7 and room['squid_round']['mode'] == 'infinite'
    assert not room['squid_round']['multiplier'] and room['hand']['squid_contested'] == 2


def test_in_progress_round_limits_price_even_when_switching_to_classic():
    room, ids = infinite()
    game.command(room, ids[0], dict(type='start'), 1000)
    with pytest.raises(game.GameError):
        change(room, squid_mode='classic', squid_amount=game.MAX_INFINITE_SQUID_AMOUNT + 1)
    assert room['settings']['squid_mode'] == 'infinite'


def test_legacy_round_and_preparation_do_not_adopt_requested_infinite_mode():
    room, ids = table(squid=True, straddle=True)
    game.command(room, ids[0], dict(type='start'), 1000)
    room['straddle_offer']['squid_rule'].pop('mode')
    room['straddle_offer']['squid_rule'].pop('multiplier')
    change(room, squid_mode='infinite', squid_multiplier=True)
    game.deal(room, 1002, False)
    assert room['squid_round']['mode'] == 'classic'
    for key in ('mode', 'multiplier', 'hands', 'carry'):
        room['squid_round'].pop(key)
    room['hand']['squid_rule'].pop('mode')
    room['hand']['squid_rule'].pop('multiplier')
    fold_hand(room, ids[0])
    next_hand(room)
    # The legacy active round keeps its semantics even though settings request infinite.
    game.deal(room, 1100, False)
    assert room['hand']['squid_rule']['mode'] == 'classic'
    assert room['squid_round']['total'] == 2


def test_restart_preserves_infinite_carry_multiple_tokens_and_pending_settings(tmp_path):
    room, ids = infinite(squid_multiplier=True)
    game.command(room, ids[0], dict(type='start'), 1000)
    fold_hand(room, ids[0])
    next_hand(room)
    fold_hand(room, ids[0])
    # Explicit rule-boundary chop after the real game hands.
    resolved_hand(room, ids)
    change(room, squid_mode='classic', squid_multiplier=False)
    before = copy.deepcopy(room['squid_round'])
    store = Store(f'sqlite:///{tmp_path}/infinite.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    assert restored['squid_round'] == before
    assert not squid.migrate(restored)
    assert squid.member(restored, ids[0])['count'] == 3
    assert restored['settings']['squid_mode'] == 'classic'
    assert squid.effective_rule(restored)['multiplier'] is True
    hand, event = resolved_hand(restored, ids, winner=1)
    assert hand['squid_contested'] == 2
    assert next(r for r in event['settlement']['results'] if r['pid'] == ids[0])['multiplier'] == 2


@pytest.mark.parametrize('stacks,status', [((100, 100), 'settled'), ((100, 100, 100), 'cancelled')])
def test_disable_finishes_current_hand_then_reopen_starts_fresh(stacks, status):
    room, ids = infinite(stacks)
    game.command(room, ids[0], dict(type='start'), 1000)
    change(room, squid=False)
    fold_hand(room)
    assert room['squid_history'][-1]['status'] == status
    assert room['squid_round'] is None
    change(room, squid=True)
    next_hand(room)
    assert room['squid_round']['number'] == 2 and room['hand']['squid_contested'] == 2


@pytest.mark.parametrize('patch', [dict(squid_mode='other'), dict(squid_mode=None),
    dict(squid_multiplier=1), dict(squid_multiplier='true'),
    dict(squid_mode='infinite', squid_amount=game.MAX_INFINITE_SQUID_AMOUNT + 1)])
def test_validate_new_options_and_safe_amount(patch):
    with pytest.raises(game.GameError):
        game.settings(patch)
