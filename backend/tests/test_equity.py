import asyncio
import copy
from ctypes import c_int
from itertools import combinations
from math import comb
from random import Random
from threading import Event

import pytest
from pokerkit import StandardHighHand

from backend import engine, equity, game
from backend.app import Service
from backend.store import Store
from backend.tests.test_game import action, settle_dealing
from backend.tests.test_presentation import raw_call
from backend.tests.test_showdown import fixed_table

DECK = tuple(r + s for r in '23456789TJQKA' for s in 'cdhs')


def reference(holes, board, dead=()):
    used = {c for h in holes for c in h} | set(board) | set(dead)
    wins = [0] * len(holes)
    total = 0
    for tail in combinations([c for c in DECK if c not in used], 5 - len(board)):
        ranks = [StandardHighHand.from_game(''.join(h), ''.join(board + tail)) for h in holes]
        best = max(ranks)
        if ranks.count(best) == 1:
            wins[ranks.index(best)] += 1
        total += 1
    return tuple(wins), total


@pytest.mark.parametrize('holes,board,dead', [
    ((('As', 'Ah'), ('Ks', 'Kh')), ('2c', '7d', '9h'), ()),
    ((('As', 'Ah'), ('Ks', 'Kh')), ('2c', '7d', '9h', 'Js'), ('Kc', 'Kd')),
    ((('As', 'Ks'), ('Ah', 'Kh'), ('9h', '9d')), ('Qc', 'Jd', 'Tc'), ('Ts',)),
    ((('2c', '3d'), ('4c', '5d')), ('Ts', 'Js', 'Qs', 'Ks', 'As'), ()),
    ((('As', '2s'), ('Ks', 'Kh')), ('3s', '4s', '5s'), ('6s',)),
    ((('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')), ('Ah', 'Kh', 'Qs', '2c'), ('As',)),
])
def test_native_enumeration_matches_independent_pokerkit(holes, board, dead):
    assert equity.count_wins(holes, board, dead) == reference(holes, board, dead)


def test_native_rank_order_matches_pokerkit_across_random_hands():
    rng = Random(193)
    cases = [tuple(rng.sample(DECK, 7)) for _ in range(2500)]
    def native(cards):
        return equity.library().rr_rank7((c_int * 7)(*(equity.card(c) for c in cards)))
    ranks = [(native(cards), StandardHighHand.from_game(''.join(cards))) for cards in cases]
    ranks.sort(key=lambda pair: pair[0])
    for (a, x), (b, y) in zip(ranks, ranks[1:]):
        assert (a == b) == (x == y)
        assert (a < b) == (x < y)


def test_dead_cards_remove_outs_and_order_is_irrelevant():
    holes = (('As', 'Ah'), ('Ks', 'Kh'))
    board = ('2c', '7d', '9h', 'Js')
    assert equity.count_wins(holes, board) == ((42, 2), 44)
    assert equity.count_wins(holes, board, ('Kc', 'Kd')) == ((42, 0), 42)
    hand = dict(runout_players=['a', 'b'], dealt=dict(a=list(holes[0]), b=list(holes[1]), folded=['Kc', 'Kd']),
                boards=[list(board)], deck=list(DECK))
    rates = equity.rates_for_prefix(hand, 0, 4, ('Ac',))
    assert rates == dict(total=41, wins=dict(a=41, b=0))
    hand['deck'].reverse()
    assert equity.rates_for_prefix(hand, 0, 4, ('Ac',)) == rates
    hand['boards'][0].append('Qd')  # Already prepared for animation, not yet visible.
    assert equity.rates_for_prefix(hand, 0, 4, ('Ac',)) == rates


@pytest.mark.parametrize('dead', [('As',), ('2c',), ('Qd', 'Qd')])
def test_invalid_duplicate_cards_never_enter_native_code(dead):
    with pytest.raises(ValueError, match='Duplicate'):
        equity.count_wins((('As', 'Ah'), ('Ks', 'Kh')), ('2c', '7d', '9h'), dead)


@pytest.mark.parametrize('vote', [True, False, 'timeout'])
def test_vote_privacy_and_runout_frames_include_all_used_cards(monkeypatch, vote):
    room, ids, observer = fixed_table(monkeypatch,
        [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')], twice=True)
    room['paused'] = True
    action(room, 'raise', 100)
    folded = room['hand']['clock']['pid']
    action(room, 'fold')
    action(room)
    hand = room['hand']
    assert room['phase'] == 'runout'
    for viewer in [observer, *ids]:
        public = game.view(room, viewer, 1002)['hand']
        assert public['runout_equity'] is None
        assert set(public['cards']) == ({viewer} if viewer in ids else set())
    if vote == 'timeout':
        game.tick(room, room['deadline'])
    else:
        for pid in hand['voters']:
            game.command(room, pid, dict(type='vote', value=vote), 1002)
    assert hand['runouts'] == (2 if vote is True else 1)
    assert set(hand['revealed']) == set(ids) - {folded}
    frames = hand['runout_equity']['frames']
    assert frames['0']['total'] == comb(46, 5)  # All six holes; burn not yet performed on screen.
    for count in (1, 2, 3):
        assert frames[str(count)]['total'] == comb(52 - 6 - 1 - count, 5 - count)
    for viewer in [observer, *ids]:
        public = game.view(room, viewer, hand['deal']['start'])['hand']
        assert public['runout_equity'] == hand['runout_equity']
        assert folded not in public['runout_equity']['frames']['0']['wins']
        assert not {'deck', 'ops', 'burns', 'dealt', 'runout_players'} & public.keys()
        if viewer != folded:
            assert folded not in public['cards']
    assert game.public_hand(hand, observer)['runout_equity'] is None
    settle_dealing(room)
    assert game.view(room, observer, 1020)['hand']['runout_equity'] is None


@pytest.mark.parametrize('prefix', [0, 3, 4])
def test_second_run_uses_first_board_and_burns_once_and_restores(monkeypatch, tmp_path, prefix):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')], twice=True)
    room['paused'] = True
    while len(room['hand']['boards'][0]) < prefix:
        action(room)
    action(room, 'raise', engine.state_for(room['hand']).max_completion_betting_or_raising_to_amount)
    action(room)
    for pid in ids:
        game.command(room, pid, dict(type='vote', value=True), 1002)
    while not room['hand'].get('runout_result'):
        game.tick(room, room['deadline'])
    assert game.view(room, observer, room['deadline'])['hand']['runout_equity'] is None
    before_burns = tuple(map(repr, engine.state_for(room['hand']).burn_cards))
    game.tick(room, room['deadline'])
    hand = room['hand']
    assert hand['active_board'] == 1
    assert hand['runout_equity']['board'] == 1
    assert hand['runout_equity']['frames'][str(prefix)] == equity.rates_for_prefix(hand, 1, prefix, before_burns)
    expected_remaining = 52 - 4 - len(before_burns) - 5
    assert hand['runout_equity']['frames'][str(prefix)]['total'] == comb(expected_remaining, 5 - prefix)
    store = Store(f'sqlite:///{tmp_path}/runout.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    assert restored['hand']['runout_equity'] == hand['runout_equity']
    game.command(restored, restored['owner'], dict(type='resume'), 1100)
    settle_dealing(restored)
    assert restored['hand']['result']
    assert game.view(restored, observer, 1110)['hand']['runout_equity'] is None


def test_ordinary_actions_and_showdown_have_no_odds(monkeypatch):
    room, ids, observer = fixed_table(monkeypatch, [('Ac', 'Ad'), ('Kc', 'Kd')])
    assert game.view(room, observer, 1001)['hand']['runout_equity'] is None
    raw_call(room, 1001)
    raw_call(room, 1001)
    assert room['phase'] == 'action_hold'
    assert game.view(room, observer, 1001)['hand']['runout_equity'] is None
    game.tick(room, room['deadline'])
    assert room['phase'] == 'dealing'
    assert game.view(room, observer, 1001)['hand']['runout_equity'] is None


def test_mutation_worker_keeps_loop_responsive_and_state_atomic(tmp_path):
    async def check():
        store = Store(f'sqlite:///{tmp_path}/worker.db')
        room = game.create_room('worker', {}, 'owner', 1000)
        store.save(room)
        service = Service(store)
        original = copy.deepcopy(service.rooms[room['id']])
        entered, release = Event(), Event()
        def slow(working):
            working['name'] = 'committed'
            entered.set()
            assert release.wait(5)
        task = asyncio.create_task(service.mutate(room['id'], slow))
        try:
            for _ in range(100):
                if entered.is_set():
                    break
                await asyncio.sleep(.005)
            assert entered.is_set()
            assert not task.done()
            assert service.rooms[room['id']] == original
        finally:
            release.set()
            await task
        assert service.rooms[room['id']]['name'] == 'committed'
        assert store.all()[0] == service.rooms[room['id']]
        before = copy.deepcopy(service.rooms[room['id']])
        def invalid(working):
            working['name'] = 'discarded'
            raise game.GameError('invalid')
        with pytest.raises(game.GameError):
            await service.mutate(room['id'], invalid)
        assert service.rooms[room['id']] == before == store.all()[0]
    asyncio.run(check())
