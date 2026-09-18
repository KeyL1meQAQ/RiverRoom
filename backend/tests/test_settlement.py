import copy

import pytest

from backend import engine, game, settlement
from backend.tests.test_game import action, settle_dealing
from backend.tests.test_presentation import raw_call
from backend.tests.test_showdown import fixed_table
from backend.tests.test_bounty import reward_table, fold_to_big_blind
from backend.tests.squid_fixture import snapshots as squid_snapshots


def balances(plan):
    result = {pid: a['before'] for pid, a in plan['accounts'].items()}
    for event in plan['events']:
        if event['source']:
            result[event['source']] -= event['amount']
            assert result[event['source']] >= 0
        result[event['target']] += event['amount']
    return result


def test_first_runout_has_own_result_without_advancing_second_or_paying(monkeypatch):
    room, ids, viewer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')], twice=True,
                                    board2=('Kh', '2d', '3s', '7h', '8d'))
    action(room, 'raise', 100)
    raw_call(room, 1001)
    for pid in ids:
        game.command(room, pid, dict(type='vote', value=True), 1002)
    while not room['hand'].get('runout_result'):
        game.tick(room, room['deadline'])
    hand = room['hand']
    groups = copy.deepcopy(hand['runout_result'])
    public = game.view(room, viewer, room['deadline'] - 1.5)
    assert len(public['hand']['boards'][0]) == 5
    assert all(len(board) < 5 for board in public['hand']['boards'][1:])
    assert public['hand']['result'] is None and not public['hand']['awards']
    assert public['hand']['public_hand_labels']
    assert not room['history']
    original_ops = copy.deepcopy(hand['ops'])
    game.tick(room, room['deadline'] - .001)
    assert hand['ops'] == original_ops
    settle_dealing(room)
    assert groups == [g for g in hand['showdown_results'] if g['board'] == 0]
    assert hand['active_board'] == 1 and not hand.get('runout_result')
    assert sum(balances(hand['presentation']).values()) == 200


def test_bounty_trajectory_uses_pre_bonus_balance_and_real_transfers(monkeypatch):
    room, ids, _ = reward_table(monkeypatch)
    fold_to_big_blind(room)
    hand = room['hand']
    plan = hand['presentation']
    assert sum(e['amount'] for e in plan['events'] if e['kind'] == 'pot') == sum(r['won'] for r in hand['result'])
    assert sum(e['amount'] for e in plan['events'] if e['kind'] == 'bounty') == hand['bounty']['total']
    assert all(value == room['players'][pid]['stack'] for pid, value in balances(plan).items())
    assert hand['reveal_until'] == plan['until'] + 5
    with pytest.raises(game.GameError, match='派彩完成'):
        game.command(room, ids[0], dict(type='show_cards', hand=hand['number'], cards=[0]), plan['until'] - .001)
    game.command(room, ids[0], dict(type='show_cards', hand=hand['number'], cards=[0]), plan['until'])
    room['paused'] = True
    game.tick(room, plan['until'] + 5)
    assert room['number'] == hand['number']


def test_leaver_uses_held_balance_even_after_backend_cashout():
    snapshot = squid_snapshots()['settled']
    plan = snapshot['hand']['presentation']
    event = snapshot['hand']['squid']['settlement']
    leaver = next(p for p in snapshot['players'] if p['seat'] is None and p['buyout'] > 0)
    assert leaver['stack'] == 0
    account = plan['accounts'][leaver['id']]
    recorded = next(r for r in event['results'] if r['pid'] == leaver['id'])
    assert account['seat'] is None and account['before'] == recorded['before']
    assert balances(plan)[leaver['id']] == recorded['after']
    actual = {(p['pid'], t['pid']): t['amount'] for p in event['payments'] for t in p['transfers'] if t['amount']}
    shown = {(e['source'], e['target']): e['amount'] for e in plan['events'] if e['kind'] == 'squid'}
    assert actual == shown


def test_transfer_order_is_button_relative_without_changing_allocation():
    captured = {pid: dict(pid=pid, name=pid, seat=seat, before=100)
                for pid, seat in [('a', 1), ('b', 6), ('c', 3), ('d', 8), ('e', None)]}
    hand = dict(ids=list(captured), button=4, result=[], squid=dict(settlement=dict(
        members=[dict(pid=pid) for pid in captured], payments=[
            dict(pid=pid, transfers=[dict(pid=to, amount=amount) for to, amount in [('a', 5), ('d', 7), ('e', 0)]])
            for pid in ['c', 'b']])) )
    plan = settlement.timeline(hand, captured, 1000)
    assert [(e['source'], e['target'], e['amount']) for e in plan['events']] == [
        ('b', 'd', 7), ('b', 'a', 5), ('c', 'd', 7), ('c', 'a', 5)]
    for i, event in enumerate(plan['events']):
        assert event['until'] - event['start'] == pytest.approx(.18)
        if i:
            assert event['start'] == plan['events'][i - 1]['until']
    assert plan['until'] == pytest.approx(1001.12)


def test_presentation_survives_store_roundtrip_and_never_repays(monkeypatch, tmp_path):
    from backend.store import Store
    room, _, _ = reward_table(monkeypatch)
    fold_to_big_blind(room)
    store = Store(f'sqlite:///{tmp_path}/settlement.sqlite')
    store.save(room)
    restored = store.all()[0]
    assert restored['hand']['presentation'] == room['hand']['presentation']
    before = copy.deepcopy(restored)
    game.finish_hand(restored, engine.state_for(restored['hand']), 2000)
    assert restored == before


def test_legacy_in_progress_hand_keeps_existing_window(monkeypatch):
    room, _, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    room['hand'].pop('presentation_version')
    action(room, 'fold')
    hand = room['hand']
    assert not hand.get('presentation')
    assert hand['reveal_until'] == hand['finished_at'] + 5


def test_cashout_and_approved_topup_do_not_change_pot_animation_amounts(monkeypatch):
    room, ids, _ = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    game.command(room, ids[0], dict(type='topup', amount=50), 1000.5)
    if not room['requests'][0]['approved']:
        game.command(room, room['owner'], dict(type='approve', request=room['requests'][0]['id']), 1000.5)
    action(room, 'raise', 100)
    action(room)
    hand = room['hand']
    plan = hand['presentation']
    assert sum(e['amount'] for e in plan['events'] if e['kind'] == 'pot') == 200
    assert sum(balances(plan).values()) == 200
    assert sum(p['stack'] for p in room['players'].values()) == 250
    assert room['deadline'] >= plan['until'] + 5
