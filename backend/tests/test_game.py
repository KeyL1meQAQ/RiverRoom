import pytest

from backend import engine, game


def table(stacks=(100, 100, 100), **config):
    room = game.create_room('测试桌', config, 'browser0', 1000)
    ids = [room['owner']]
    for i in range(1, len(stacks)):
        ids.append(game.add_player(room, f'browser{i}', 1000)['id'])
    for i, (pid, stack) in enumerate(zip(ids, stacks)):
        p = room['players'][pid]
        p.update(online=True, last_seen=1000)
        game.command(room, pid, dict(type='request_seat', seat=i, name=f'玩家{i}', amount=stack), 1000)
        if pid != room['owner']:
            game.command(room, room['owner'], dict(type='approve', request=room['requests'][-1]['id']), 1000)
    room['empty_since'] = None
    return room, ids


def settle_dealing(room):
    for _ in range(10):
        if room['phase'] != 'dealing':
            return
        game.tick(room, room['deadline'])
    pytest.fail('dealing did not complete')


def action(room, kind='call', amount=None, now=1001):
    settle_dealing(room)
    hand = room['hand']
    now = max(now, hand['clock']['base_until'] - 20)
    pid = hand['clock']['pid']
    game.command(room, pid, dict(type='act', hand=hand['number'], seq=hand['action_seq'], action=kind, amount=amount), now)
    settle_dealing(room)


def finish(room):
    settle_dealing(room)
    for _ in range(100):
        if room['phase'] != 'betting':
            return
        action(room)
    pytest.fail('hand did not complete')


def test_full_hand_preserves_chips_and_public_privacy():
    room, ids = table()
    game.command(room, ids[0], {'type': 'start'}, 1000)
    for pid in ids:
        visible = game.view(room, pid, 1001)
        assert set(visible['hand']['cards']) == {pid}
        assert 'deck' not in visible['hand']
        assert all('browser' not in p and 'code' not in p for p in visible['players'])
    finish(room)
    assert sum(p['stack'] for p in room['players'].values()) == 300
    assert sum(p['profit'] for p in room['players'].values()) == 0
    assert len(room['history']) == 1
    assert all(p['hands'] == 1 for p in room['players'].values())


def test_run_it_twice_requires_every_player():
    room, ids = table(twice=True)
    game.command(room, ids[0], {'type': 'start'}, 1000)
    action(room, 'raise', 100)
    action(room)
    action(room)
    assert room['phase'] == 'runout'
    for pid in ids[:-1]:
        game.command(room, pid, {'type': 'vote', 'value': True}, 1002)
        assert room['phase'] == 'runout'
    game.command(room, ids[-1], {'type': 'vote', 'value': True}, 1002)
    settle_dealing(room)
    assert len(room['hand']['boards']) == 2
    assert sum(p['stack'] for p in room['players'].values()) == 300
    replay = engine.state_for(room['hand'])
    assert replay.stacks == [room['players'][pid]['stack'] for pid in room['hand']['ids']]


@pytest.mark.parametrize('vote', [False, None])
def test_runout_rejection_and_timeout(vote):
    room, ids = table(twice=True)
    game.command(room, ids[0], {'type': 'start'}, 1000)
    action(room, 'raise', 100)
    action(room)
    action(room)
    for pid in ids[:-1]:
        game.command(room, pid, {'type': 'vote', 'value': True}, 1002)
    if vote is not None:
        game.command(room, ids[-1], {'type': 'vote', 'value': vote}, 1002)
    game.tick(room, 1020)
    assert room['hand']['runouts'] == 1
    assert len(room['hand']['boards']) == 1


def test_short_allin_does_not_reopen_raise():
    hand = engine.new_hand(['a', 'b', 'c'], [0, 1, 2], [130, 1000, 1000], [1, 2, 0], 2, 1)
    state = engine.state_for(hand)
    engine.advance(hand, state, False)
    engine.step(hand, state, 'complete_bet_or_raise_to', 100)
    engine.step(hand, state, 'complete_bet_or_raise_to', 130)
    assert state.min_completion_betting_or_raising_to_amount == 228
    engine.step(hand, state, 'check_or_call')
    assert state.actor_index == 2
    assert not state.can_complete_bet_or_raise_to()


def test_straddle_is_prompted_before_hole_cards_and_voluntary():
    room, ids = table(straddle=True)
    game.command(room, ids[0], {'type': 'start'}, 1000)
    assert room['phase'] == 'straddle' and room['hand'] is None
    pid = room['straddle_offer']['pid']
    game.command(room, pid, {'type': 'straddle', 'value': True}, 1001)
    hand = room['hand']
    state = engine.state_for(hand)
    assert state.bets[hand['ids'].index(pid)] == 4
    assert hand['clock']['pid'] != pid


def test_straddle_timeout_is_no_and_heads_up_skips():
    room, ids = table(straddle=True)
    game.command(room, ids[0], {'type': 'start'}, 1000)
    game.tick(room, 1005)
    assert max(room['hand']['blinds']) == 2
    headsup, ids = table((100, 100), straddle=True)
    game.command(headsup, ids[0], {'type': 'start'}, 1000)
    assert headsup['phase'] == 'betting'
    assert headsup['hand']['clock']['pid'] == ids[0]


def test_timebank_only_consumes_after_base_and_survives_reseat():
    room, ids = table()
    game.command(room, ids[0], {'type': 'start'}, 1000)
    pid = room['hand']['clock']['pid']
    game.tick(room, 1019)
    assert room['players'][pid]['bank'] == 10
    game.tick(room, 1025)
    assert room['players'][pid]['bank'] == 5
    action(room, now=1025)
    assert room['players'][pid]['bank'] == 5
    game.command(room, pid, {'type': 'leave'}, 1025)
    for _ in range(100):
        if room['phase'] != 'betting':
            break
        action(room, now=1026)
    assert room['players'][pid]['seat'] is None
    assert room['players'][pid]['bank'] <= 5


def test_rebuy_early_completion_and_timeout_auto_leave():
    room, ids = table()
    room.update(started=True, phase='rebuy', rebuy=ids[1:], deadline=1020)
    for pid in ids[1:]:
        room['players'][pid]['stack'] = 0
    game.command(room, ids[1], {'type': 'topup', 'amount': 50}, 1001)
    game.command(room, ids[0], {'type': 'approve', 'request': room['requests'][0]['id']}, 1002)
    assert room['phase'] == 'rebuy'
    game.command(room, ids[2], {'type': 'leave'}, 1003)
    assert room['phase'] == 'betting'
    assert room['number'] == 1
    other, ids = table()
    other.update(phase='rebuy', rebuy=[ids[1]], deadline=1020)
    other['players'][ids[1]]['stack'] = 0
    game.command(other, ids[1], {'type': 'topup', 'amount': 50}, 1001)
    game.tick(other, 1021)
    assert other['players'][ids[1]]['seat'] is None
    assert not other['requests']


def test_bank_refills_only_completed_dealt_hands():
    room, ids = table(refill=1)
    game.command(room, ids[0], {'type': 'start'}, 1000)
    for p in room['players'].values():
        p['bank'] = 2
    finish(room)
    assert all(p['bank'] == 10 for p in room['players'].values())


def test_offline_five_minutes_and_away_current_hand():
    room, ids = table()
    p = room['players'][ids[1]]
    p.update(online=False, offline=1000)
    game.tick(room, 1299)
    assert not p['away']
    game.tick(room, 1300)
    assert p['away'] and p['seat'] == 1
    p.update(online=True, away=False)
    game.command(room, ids[0], {'type': 'start'}, 1301)
    game.command(room, ids[1], {'type': 'away', 'value': True}, 1302)
    assert engine.state_for(room['hand']).statuses[room['hand']['ids'].index(ids[1])]


def test_full_cashout_and_forbid_partial():
    room, ids = table()
    p = room['players'][ids[1]]
    with pytest.raises(game.GameError):
        game.post_ledger(room, p, 'buyout', 20, 1001, ids[0])
    game.command(room, ids[1], {'type': 'leave'}, 1001)
    assert p['stack'] == 0 and p['buyout'] == 100 and p['profit'] == 0


def test_sidepots_and_replay_with_unequal_stacks():
    hand = engine.new_hand(['a', 'b', 'c'], [0, 1, 2], [40, 100, 200], [1, 2, 0], 2, 1)
    prefix = ['Ac', 'Kc', 'Qc', 'Ad', 'Kd', 'Qd', '2c', '2h', '5s', '9d', '3c', 'Js', '4c', '3h',
              '5c', '4h', '7s', '8d', '6c', 'Ts', '7c', 'Jh']
    hand['deck'] = prefix + [c for c in hand['deck'] if c not in prefix]
    state = engine.state_for(hand)
    engine.advance(hand, state, True)
    engine.step(hand, state, 'complete_bet_or_raise_to', 200)
    engine.step(hand, state, 'check_or_call')
    engine.step(hand, state, 'check_or_call')
    assert engine.advance(hand, state, True) == 'runout'
    hand['runouts'] = 2
    engine.advance(hand, state, True)
    assert sum(state.stacks) == 340
    assert len({a['pot'] for a in hand['awards']}) >= 2
    assert engine.state_for(hand).stacks == state.stacks
