"""Regression cases from the nine-player run and its settlement audit."""
import asyncio
import copy

import pytest

from backend import achievements, engine, game
from backend.app import Service
from backend.store import Store
from backend.tests.test_game import action, table
from backend.tests.test_achievements import allin_table


def allin_hand(stacks, holes, board, board2, version=2, short_deck=False):
    hand = engine.new_hand([str(i) for i in range(len(stacks))], list(range(len(stacks))),
                           stacks, [1, 2] + [0] * (len(stacks) - 2), 2, 1, short_deck)
    if version == 1:
        hand.pop('rules_version')
    dealt = [c for column in zip(*holes) for c in column]
    burns = [c for c in hand['deck'] if c not in dealt + list(board) + list(board2)][:6]
    prefix = dealt
    for i, cards in enumerate([board, board2]):
        prefix += [burns[i * 3], *cards[:3], burns[i * 3 + 1], cards[3], burns[i * 3 + 2], cards[4]]
    hand['deck'] = prefix + [c for c in hand['deck'] if c not in prefix]
    state = engine.state_for(hand)
    for _ in range(40):
        phase = engine.advance(hand, state, True)
        if phase == 'finished':
            hand['boards'] = engine.boards(state)
            return hand, state
        if phase == 'runout':
            hand['runouts'] = 2
        elif state.can_complete_bet_or_raise_to():
            engine.step(hand, state, 'complete_bet_or_raise_to', state.max_completion_betting_or_raising_to_amount)
        else:
            engine.step(hand, state, 'check_or_call')
    pytest.fail('all-in hand did not finish')


@pytest.mark.parametrize('version,expected', [(1, [0, 0, 4, 4, 0]), (2, [0, 0, 5, 3, 0])])
def test_each_original_pot_splits_its_odd_chip_and_legacy_replays(version, expected):
    hand, state = allin_hand([1, 1, 2, 2, 2],
        [('2c', '3c'), ('2d', '3d'), ('Ah', 'Ad'), ('Kh', 'Kd'), ('Qh', 'Qd')],
        ['As', '4h', '7d', '9c', 'Js'], ['Ks', '5h', '8d', 'Tc', '6s'], version)
    assert state.stacks == expected
    assert state.bets == [0] * 5
    assert engine.state_for(hand).stacks == expected
    if version == 2:
        assert hand['pots'] == [dict(amount=5, eligible=['0', '1', '2', '3', '4']),
                                dict(amount=3, eligible=['2', '3', '4'])]
        assert [(a['pot'], a['board'], sum(a['amounts'])) for a in hand['awards']] == [
            (0, 0, 3), (0, 1, 2), (1, 0, 2), (1, 1, 1)]
        assert achievements.main_winner(hand) is None
        # Presentation caches cannot alter deterministic replay or payouts.
        hand['pots'][0]['amount'] = 99999
        assert engine.state_for(hand).stacks == expected


def test_final_tie_remainder_reaches_new_recipient_and_keeps_zero_chip_winner():
    hand, state = allin_hand([1] * 5,
        [('Ac', '2c'), ('Ad', '3c'), ('Ah', '4c'), ('Ks', 'Kd'), ('6c', '6h')],
        ['Kc', 'Kh', '7s', '8s', '9s'], ['As', 'Jc', 'Tc', '9d', '8d'])
    assert state.stacks == [1, 1, 0, 3, 0]
    assert state.bets == [0] * 5
    assert hand['awards'][-1]['winners'] == [0, 1, 2]
    assert hand['awards'][-1]['amounts'] == [1, 1, 0, 0, 0]
    assert engine.state_for(hand).stacks == state.stacks
    assert achievements.main_winner(hand) is None


def straddled(stacks, legacy=False):
    hand = engine.new_hand([str(i) for i in range(len(stacks))], list(range(len(stacks))),
                          stacks, [1, 2, 4] + [0] * (len(stacks) - 3), 2, 1)
    if legacy:
        hand.pop('rules_version')
    state = engine.state_for(hand)
    engine.advance(hand, state, False)
    return hand, state


def test_straddle_first_raise_increment_and_postflop_base():
    hand, state = straddled([100] * 4)
    assert state.actor_index == 3
    assert engine.legal(state)['min_raise'] == 8
    assert not state.can_complete_bet_or_raise_to(6)
    engine.step(hand, state, 'complete_bet_or_raise_to', 8)
    assert engine.legal(state)['min_raise'] == 12
    for _ in range(3):
        engine.step(hand, state, 'check_or_call')
    assert engine.advance(hand, state, False) == 'betting'
    assert len(engine.boards(state)[0]) == 3
    assert engine.legal(state)['min_raise'] == 2
    assert engine.legal(engine.state_for(hand)) == engine.legal(state)


def test_straddle_short_allin_does_not_reopen_but_accumulated_full_increment_does():
    hand, state = straddled([6, 100, 100, 100])
    engine.step(hand, state, 'check_or_call')  # D calls 4.
    engine.step(hand, state, 'complete_bet_or_raise_to', 6)
    engine.step(hand, state, 'check_or_call')
    engine.step(hand, state, 'check_or_call')
    assert state.actor_index == 3 and state.checking_or_calling_amount == 2
    assert not state.can_complete_bet_or_raise_to()
    assert not engine.state_for(hand).can_complete_bet_or_raise_to()

    hand, state = straddled([6, 8, 100, 100])
    engine.step(hand, state, 'check_or_call')
    engine.step(hand, state, 'complete_bet_or_raise_to', 6)
    engine.step(hand, state, 'complete_bet_or_raise_to', 8)
    engine.step(hand, state, 'check_or_call')
    assert state.actor_index == 3
    assert state.can_complete_bet_or_raise_to() and engine.legal(state)['min_raise'] == 12
    assert engine.legal(engine.state_for(hand)) == engine.legal(state)


def test_legacy_straddle_six_remains_replayable():
    hand, state = straddled([100] * 4, legacy=True)
    assert engine.legal(state)['min_raise'] == 6
    engine.step(hand, state, 'complete_bet_or_raise_to', 6)
    assert engine.state_for(hand).bets == state.bets
    assert engine.legal(engine.state_for(hand)) == engine.legal(state)


@pytest.mark.parametrize('departure', ['away', 'leave'])
@pytest.mark.parametrize('legacy', [False, True])
def test_zero_pot_from_normal_blind_rotation_counts_win_once_and_closes(departure, legacy, tmp_path):
    room, ids = table([200] * 4, refill=2)
    game.command(room, ids[0], dict(type='start'), 1000)
    old_bb = next(pid for pid in ids if room['players'][pid]['seat'] == room['big_blind'])
    while room['phase'] == 'betting':
        action(room, 'fold')
    game.command(room, old_bb, dict(type=departure, value=True), 1001)
    game.tick(room, room['hand']['reveal_until'])
    hand = room['hand']
    if legacy:
        hand.pop('rules_version')
    assert hand['blinds'] == [2, 0, 0]
    assert room['small_blind'] not in hand['seats']
    while engine.state_for(hand).actor_index != (len(hand['ids']) - 1):
        action(room, 'fold', now=1007)
    # Save before the final fold, exactly where production rolled back.
    room.update(closing=True)
    store = Store(f'sqlite:///{tmp_path}/zero.db')
    store.save(room)
    service = Service(store)
    restored = service.rooms[room['id']]
    assert restored['recovery'] and restored['hand']['result'] is None
    before = {pid: copy.deepcopy(p['achievements']) for pid, p in restored['players'].items()}
    winner = hand['ids'][0]
    game.command(restored, ids[0], dict(type='end'), 2000)
    # The remaining actor times out normally; all callbacks are transactional.
    until = restored['hand']['clock']['until']
    asyncio.run(service.mutate(room['id'], lambda r: game.tick(r, until)))
    assert service.rooms[room['id']]['phase'] == 'action_hold'
    asyncio.run(service.mutate(room['id'], lambda r: game.tick(r, r['deadline'])))
    finished = service.rooms[room['id']]
    assert finished['hand']['awards'] == []
    assert finished['hand']['uncontested_winner'] == winner
    assert all(r['delta'] == r['won'] == 0 for r in finished['hand']['result'])
    assert len(finished['history']) == 2
    assert finished['players'][winner]['achievements']['wins'] == before[winner]['wins'] + 1
    assert all(p['achievements']['busts'] == before[pid]['busts'] for pid, p in finished['players'].items())
    assert all(finished['players'][pid]['hands'] == 2 for pid in hand['ids'])
    assert all(finished['players'][pid]['bank'] == 10 for pid in hand['ids'])
    assert game.public_hand(finished['hand'], 'observer')['cards'] == {}
    achievements.record(finished, finished['hand'])
    assert finished['players'][winner]['achievements']['wins'] == before[winner]['wins'] + 1
    asyncio.run(service.mutate(room['id'], lambda r: game.tick(r, r['hand']['reveal_until'])))
    assert service.rooms[room['id']]['closed_at'] is not None
    assert sum(p['buyout'] for p in service.rooms[room['id']]['players'].values()) == 800
    assert sum(p['profit'] for p in service.rooms[room['id']]['players'].values()) == 0


def test_achievement_failure_finishes_hand_and_recovers_without_double_count(monkeypatch, tmp_path):
    compute = achievements.busted_players
    monkeypatch.setattr(achievements, 'busted_players', lambda hand: (_ for _ in ()).throw(ValueError('test failure')))
    room, ids, _ = allin_table(monkeypatch)
    assert room['phase'] == 'rebuy'
    assert len(room['history']) == 1
    assert room['players'][ids[0]]['achievements']['wins'] == 1
    assert room['achievement_pending'] == dict(wins=[], busts=[1])
    assert game.view(room, ids[0], 2000)['achievement_pending'] == dict(wins=0, busts=1)
    assert room['players'][ids[2]]['achievements']['busts'] == 0
    monkeypatch.setattr(achievements, 'busted_players', compute)
    store = Store(f'sqlite:///{tmp_path}/pending.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    assert restored['achievement_pending'] == dict(wins=[], busts=[])
    assert restored['players'][ids[0]]['achievements']['wins'] == 1
    assert restored['players'][ids[2]]['achievements']['busts'] == 1
    again = Service(store).rooms[room['id']]
    assert again['players'][ids[2]]['achievements']['busts'] == 1


def test_v1_achievement_migration_preserves_counts_and_since(monkeypatch):
    room, ids, _ = allin_table(monkeypatch)
    room['achievement_version'] = 1
    room.pop('achievement_pending')
    room['achievement_since'] = dict(wins=2, busts=1)
    before = {pid: p['achievements'].copy() for pid, p in room['players'].items()}
    assert achievements.migrate(room)
    assert room['achievement_since'] == dict(wins=2, busts=1)
    assert {pid: p['achievements'] for pid, p in room['players'].items()} == before
    assert room['achievement_pending'] == dict(wins=[], busts=[])


def test_pending_retry_is_bounded_fair_and_does_not_reset_later_counts(monkeypatch):
    room, ids, _ = allin_table(monkeypatch)
    source = room['hand']
    room['history'].extend(dict(copy.deepcopy(source), number=n) for n in range(2, 22))
    room['achievement_pending']['wins'] = list(range(2, 22))
    room['achievement_hand'] = 21
    compute = achievements.main_winner
    calls = []
    def flaky(hand):
        calls.append(hand['number'])
        if hand['number'] <= 9:
            raise ValueError('Still unavailable')
        return compute(hand)
    monkeypatch.setattr(achievements, 'main_winner', flaky)
    assert achievements.retry_pending(room)
    assert calls == list(range(2, 10))
    assert room['players'][ids[0]]['achievements']['wins'] == 1
    calls.clear()
    achievements.retry_pending(room)
    assert calls == list(range(10, 18))
    assert room['players'][ids[0]]['achievements']['wins'] == 9
    # A newly completed hand remains countable despite old pending gaps.
    achievements.record(room, dict(copy.deepcopy(source), number=22))
    assert room['players'][ids[0]]['achievements']['wins'] == 10
    assert room['achievement_since']['wins'] == 1
    monkeypatch.setattr(achievements, 'main_winner', compute)
    while room['achievement_pending']['wins']:
        achievements.retry_pending(room)
    assert room['players'][ids[0]]['achievements']['wins'] == 22
    assert not achievements.retry_pending(room)


def test_retry_storage_failure_rolls_back_counts_and_pending_together(monkeypatch, tmp_path):
    compute = achievements.main_winner
    def fail(hand):
        raise ValueError('Not available yet')
    monkeypatch.setattr(achievements, 'main_winner', fail)
    room, ids, _ = allin_table(monkeypatch)
    store = Store(f'sqlite:///{tmp_path}/retry.db')
    store.save(room)
    service = Service(store)
    before = copy.deepcopy(service.rooms[room['id']])
    monkeypatch.setattr(achievements, 'main_winner', compute)
    save = store.save
    def fail_save(*args):
        raise RuntimeError('Storage unavailable')
    monkeypatch.setattr(store, 'save', fail_save)
    with pytest.raises(RuntimeError, match='Storage unavailable'):
        asyncio.run(service.mutate(room['id'], achievements.retry_pending))
    assert service.rooms[room['id']] == before
    assert store.all()[0] == before
    monkeypatch.setattr(store, 'save', save)
    asyncio.run(service.mutate(room['id'], achievements.retry_pending))
    asyncio.run(service.mutate(room['id'], achievements.retry_pending))
    after = store.all()[0]
    assert after['achievement_pending'] == dict(wins=[], busts=[])
    assert after['players'][ids[0]]['achievements']['wins'] == 1
    assert after['players'][ids[2]]['achievements']['busts'] == 1
