import asyncio
import copy
from ctypes import c_int
from itertools import combinations
from math import comb
from random import Random

import pytest
from pokerkit import ShortDeckHoldemHand

from backend import engine, equity, game, hands, squid
from backend.app import Service
from backend.store import Store
from backend.tests.test_game import action, finish, settle_dealing, table
from backend.tests.test_showdown import fixed_table
from backend.tests.test_squid import change, fold_hand, next_hand

DECK = tuple(r + s for r in '6789TJQKA' for s in 'cdhs')
FLUSH_HOLES = [('Ah', 'Kh'), ('Ac', 'Ad')]
FLUSH_BOARD = ('Qh', 'Jh', '8h', 'Qc', 'Qd')


@pytest.mark.parametrize('value', [1, None, 'true', [], {}])
def test_short_deck_requires_boolean(value):
    with pytest.raises(game.GameError, match='短牌开关'):
        game.settings(dict(short_deck=value))


def test_defaults_mutual_exclusion_and_owner_only_atomic_save():
    assert game.settings({})['short_deck'] is False
    with pytest.raises(game.GameError, match='不能同时开启'):
        game.create_room('invalid', dict(short_deck=True, bounty=True), 'owner', 1000)
    room, ids = table(bounty=True, bounty_amount=7)
    game.command(room, ids[0], dict(type='start'), 1000)
    before = copy.deepcopy(room)
    with pytest.raises(game.GameError):
        game.command(room, ids[1], dict(type='settings', settings=dict(short_deck=True, bounty=False)), 1001)
    with pytest.raises(game.GameError, match='不能同时开启'):
        change(room, short_deck=True)
    with pytest.raises(game.GameError, match='两手之间'):
        change(room, short_deck=True, bounty=False, bb=4)
    assert room == before
    change(room, short_deck=True, bounty=False)
    assert room['settings']['bounty_amount'] == 7
    assert room['hand']['short_deck'] is False
    assert room['hand']['bounty_rule']['enabled'] is True
    assert game.view(room, ids[0], 1001)['short_deck_current'] is False
    fold_hand(room)
    # Completed-hand display continues to identify the cards still on the table.
    assert game.view(room, ids[0], 1002)['short_deck_current'] is False
    next_hand(room)
    assert room['hand']['short_deck'] is True
    assert set(room['hand']['deck']) == set(DECK)
    assert room['hand']['bounty_rule']['enabled'] is False
    change(room, short_deck=False)
    assert not room['settings']['bounty']
    assert room['settings']['bounty_amount'] == 7
    assert room['hand']['short_deck'] is True
    fold_hand(room)
    next_hand(room)
    assert room['hand']['short_deck'] is False
    assert len(room['hand']['deck']) == 52
    assert [h['short_deck'] for h in room['history']] == [False, True]
    assert any('牌局模式改为短牌' in row['text'] for row in room['logs'])


def test_pending_short_deck_does_not_cancel_current_bounty(monkeypatch):
    from backend.tests.test_bounty import reward_table, fold_to_big_blind
    room, ids, _ = reward_table(monkeypatch)
    change(room, short_deck=True, bounty=False)
    fold_to_big_blind(room)
    assert room['hand']['bounty']['total'] == 10
    assert room['hand']['bounty']['pid'] == ids[1]
    assert not room['history'][-1]['short_deck']


@pytest.mark.parametrize('initial', [False, True])
def test_straddle_snapshot_survives_switch_and_restart(tmp_path, initial):
    room, ids = table(straddle=True, short_deck=initial)
    game.command(room, ids[0], dict(type='start'), 1000)
    change(room, short_deck=not initial)
    assert game.view(room, ids[0], 1001)['short_deck_current'] is initial
    store = Store(f'sqlite:///{tmp_path}/offer.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    for p in restored['players'].values():
        p.update(online=True, last_seen=2000)
    game.command(restored, ids[0], dict(type='resume'), 2000)
    game.command(restored, restored['straddle_offer']['pid'], dict(type='straddle', value=True), 2000)
    assert restored['hand']['short_deck'] is initial
    assert max(restored['hand']['blinds']) == 4
    assert engine.state_for(restored['hand']).min_completion_betting_or_raising_to_amount == 8
    fold_hand(restored)
    next_hand(restored)
    assert restored['straddle_offer']['short_deck'] is not initial


def test_cancelled_preparation_uses_latest_mode():
    room, ids = table(straddle=True)
    game.command(room, ids[0], dict(type='start'), 1000)
    change(room, short_deck=True)
    p = room['players'][room['straddle_offer']['ids'][0]]
    p['away'] = True
    game.deal(room, 1001, False)
    assert room['hand']['short_deck'] is True  # Two remaining players skip Straddle.
    assert len(room['hand']['ids']) == 2


@pytest.mark.parametrize('short_deck', [False, True])
@pytest.mark.parametrize('holes,board,short_label', [
    (FLUSH_HOLES, FLUSH_BOARD, '同花'),
    ([('Ac', 'Kd'), ('9d', '9s')], ('6c', '7h', '8d', '9c', 'Qh'), '顺子'),
])
def test_actual_settlement_and_labels_follow_hand_mode(monkeypatch, short_deck, holes, board, short_label):
    room, ids, observer = fixed_table(monkeypatch, holes, board=board, short_deck=short_deck)
    room['paused'] = True
    change(room, short_deck=not short_deck)
    finish(room)
    winner = ids[0] if short_deck else ids[1]
    assert [r['pid'] for r in room['hand']['result'] if r['won']] == [winner]
    public = game.view(room, observer, 1020)
    assert public['hand']['short_deck'] is short_deck
    assert public['history'][-1]['short_deck'] is short_deck
    assert public['hand']['showdown_results'][0]['winners'][0]['pid'] == winner
    if short_deck:
        result = public['hand']['showdown_results'][0]['winners'][0]
        assert result['label'] == short_label
        assert len(result['cards']) == 5
        assert public['hand']['public_hand_labels'][winner] == [short_label]
        assert game.view(room, winner, 1020)['hand']['own_hand_labels'][0][-1] == short_label
    assert sum(p['stack'] for p in room['players'].values()) == 200


def test_short_deck_description_cache_and_low_straight_flush():
    assert hands.describe(('Ac', 'Kd'), ('6c', '7h', '8d', '9c', 'Qh'), True)[0] == '顺子'
    assert hands.describe(('Ac', 'Kd'), ('6c', '7h', '8d', '9c', 'Qh'))[0] == '高牌[A]'
    assert hands.describe(('Ah', '6h'), ('7h', '8h', '9h'), True)[0] == '同花顺'
    assert hands.describe(('Ah', 'Kh'), ('Qh', 'Jh', 'Th'), True)[0] == '皇家同花顺'


def test_short_deck_original_side_pots_and_odd_chips_on_both_boards():
    from backend.tests.test_remediation import allin_hand
    hand, state = allin_hand([1, 1, 2, 2, 2],
        [('6c', '7c'), ('6d', '7d'), ('Ah', 'Ad'), ('Kh', 'Kd'), ('Qh', 'Qd')],
        ['As', '8h', '8d', 'Tc', 'Js'], ['Ks', '9h', '9d', 'Th', '6s'], short_deck=True)
    assert state.stacks == [0, 0, 5, 3, 0]
    assert [(a['pot'], a['board'], sum(a['amounts'])) for a in hand['awards']] == [
        (0, 0, 3), (0, 1, 2), (1, 0, 2), (1, 1, 1)]
    assert engine.state_for(hand).stacks == state.stacks


def test_squid_departed_funds_remain_held_across_mode_switch():
    room, ids = table((100,) * 4, squid=True, squid_amount=10)
    game.command(room, ids[0], dict(type='start'), 1000)
    fold_hand(room, winner=ids[0])
    game.command(room, ids[3], dict(type='leave'), 1002)
    departed = copy.deepcopy(room['players'][ids[3]])
    assert departed['squid_held']
    change(room, short_deck=True)
    assert room['players'][ids[3]] == departed
    next_hand(room)
    assert room['hand']['short_deck'] is True
    assert squid.member(room, ids[3])['count'] == 0
    fold_hand(room, winner=ids[1])
    next_hand(room)
    fold_hand(room, winner=ids[2])
    settled = room['hand']['squid']['settlement']
    assert settled['payments'][0]['pid'] == ids[3]
    assert settled['payments'][0]['amount'] == 30
    assert room['players'][ids[3]]['buyout'] == departed['stack'] - 30


@pytest.mark.parametrize('players,prefix,twice', [(2, 0, False), (2, 0, True), (9, 0, True), (9, 3, True), (9, 4, True)])
def test_full_table_runouts_replay_privacy_and_card_count(players, prefix, twice):
    room, ids = table((100,) * players, short_deck=True, twice=twice)
    observer = game.add_player(room, 'observer', 1000)['id']
    game.command(room, ids[0], dict(type='start'), 1000)
    room['paused'] = True
    assert game.view(room, observer, 1001)['hand']['cards'] == {}
    while len(room['hand']['boards'][0]) < prefix:
        action(room)
    action(room, 'raise', engine.state_for(room['hand']).max_completion_betting_or_raising_to_amount)
    while room['phase'] == 'betting':
        action(room)
    if twice:
        assert room['phase'] == 'runout'
        assert game.view(room, observer, 1002)['hand']['cards'] == {}
        for pid in ids:
            game.command(room, pid, dict(type='vote', value=True), 1002)
        # At the first visible prefix no future burns are excluded.
        frame = room['hand']['runout_equity']['frames'][str(prefix)]
        burned = 0 if prefix == 0 else 1 if prefix == 3 else 2
        assert frame['total'] == comb(36 - 2 * players - prefix - burned, 5 - prefix)
    settle_dealing(room)
    hand = room['hand']
    replay = engine.state_for(hand)
    assert hand['result'] is not None
    assert len(hand['boards']) == (2 if twice else 1)
    assert all(set(board) <= set(DECK) for board in hand['boards'])
    assert replay.stacks == [room['players'][pid]['stack'] for pid in hand['ids']]
    assert sum(replay.stacks) == 100 * players
    if players == 9 and prefix == 0:
        assert len(replay.deck_cards) == 2
        assert len(replay.burn_cards) == 6


def test_first_run_winners_use_short_deck_and_restore_mid_run(monkeypatch, tmp_path):
    room, ids, observer = fixed_table(monkeypatch, FLUSH_HOLES, board=FLUSH_BOARD,
        board2=('6c', '7c', '8c', '9c', 'Tc'), short_deck=True, twice=True)
    room['paused'] = True
    action(room, 'raise', 100)
    action(room)
    for pid in ids:
        game.command(room, pid, dict(type='vote', value=True), 1002)
    while not room['hand'].get('runout_result'):
        game.tick(room, room['deadline'])
    result = room['hand']['runout_result'][0]['winners']
    assert [(p['pid'], p['label']) for p in result] == [(ids[0], '同花')]
    change(room, short_deck=False)
    store = Store(f'sqlite:///{tmp_path}/runout.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    game.command(restored, restored['owner'], dict(type='resume'), 2000)
    settle_dealing(restored)
    hand = restored['hand']
    assert hand['short_deck'] is True and not restored['settings']['short_deck']
    assert game.public_hand(hand, observer)['short_deck'] is True
    assert hand['showdown_results'][0]['winners'][0]['pid'] == ids[0]
    assert len(hand['showdown_results'][1]['winners']) == 2
    assert sum(p['stack'] for p in restored['players'].values()) == 200


def test_switch_preserves_squid_and_room_counters_and_pause():
    room, ids = table(squid=True, squid_amount=10)
    game.command(room, ids[0], dict(type='start'), 1000)
    fold_hand(room, winner=ids[0])
    game.command(room, ids[0], dict(type='pause'), 1002)
    before = copy.deepcopy(room)
    change(room, short_deck=True)
    assert room['squid_round'] == before['squid_round']
    assert room['players'] == before['players']
    assert room['ledger'] == before['ledger']
    assert room['number'] == before['number']
    next_hand(room)
    assert room['number'] == 1
    game.command(room, ids[0], dict(type='resume'), room['hand']['reveal_until'] + .1)
    game.tick(room, room['hand']['reveal_until'] + .2)
    assert room['hand']['short_deck'] is True
    assert squid.member(room, ids[0])['count'] == 1
    fold_hand(room, winner=ids[1])
    assert room['hand']['squid']['settlement']['payments'][0]['amount'] == 20
    assert all(p['hands'] == 2 for p in room['players'].values())
    assert sum(p['stack'] for p in room['players'].values()) == 300


@pytest.mark.parametrize('preparing', [False, True])
def test_legacy_records_default_to_standard_even_with_pending_short_deck(tmp_path, preparing):
    room, ids = table(straddle=preparing)
    room['settings'].pop('short_deck')
    game.command(room, ids[0], dict(type='start'), 1000)
    record = room['straddle_offer'] if preparing else room['hand']
    record.pop('short_deck')
    change(room, short_deck=True)
    store = Store(f'sqlite:///{tmp_path}/legacy.db')
    store.save(room)
    restored = Service(store).rooms[room['id']]
    assert not game.view(restored, ids[0], 1001)['short_deck_current']
    assert restored['settings']['short_deck']
    if not preparing:
        assert len(engine.state_for(restored['hand']).deck_cards) == 46
    # Separately prove missing room configuration migrates to ordinary mode.
    restored['settings'].pop('short_deck')
    assert game.migrate_short_deck(restored)
    assert not restored['settings']['short_deck']
    assert not game.migrate_short_deck(restored)


@pytest.mark.parametrize('holes,board,dead', [
    (tuple(FLUSH_HOLES), FLUSH_BOARD[:3], ()),
    ((('Ac', 'Kd'), ('9d', '9s')), ('6c', '7h', '8d', '9c'), ('Qh',)),
    ((('Ah', '6h'), ('As', '6s')), ('7h', '8h', '9h'), ('Th', 'Jh')),
    ((('Ac', 'Ad'), ('Kc', 'Kd')), ('6h', '7h', '8h', '9h', 'Th'), ()),
])
def test_short_deck_odds_match_independent_pokerkit(holes, board, dead):
    used = {c for pair in holes for c in pair} | set(board) | set(dead)
    wins = [0] * len(holes)
    total = 0
    for tail in combinations([c for c in DECK if c not in used], 5 - len(board)):
        ranks = [ShortDeckHoldemHand.from_game(''.join(h), ''.join(board + tail)) for h in holes]
        best = max(ranks)
        if ranks.count(best) == 1:
            wins[ranks.index(best)] += 1
        total += 1
    assert equity.count_wins(holes, board, dead, True) == (tuple(wins), total)
    if len(board) == 4:
        assert equity.count_wins(holes, board, dead)[1] == total + 16


def test_short_deck_native_ranking_matches_random_pokerkit_hands():
    rng = Random(620)
    cases = [tuple(rng.sample(DECK, 7)) for _ in range(3000)]
    cases.extend([('Ah', '6h', '7h', '8h', '9h', 'Ac', 'Ad'),
                  ('6h', '7h', '8h', '9h', 'Th', 'Ac', 'Ad')])
    ranked = [(equity.library().rr_rank7_short_deck((c_int * 7)(*(equity.card(c) for c in cards))),
               ShortDeckHoldemHand.from_game(''.join(cards))) for cards in cases]
    ranked.sort(key=lambda pair: pair[0])
    for (a, x), (b, y) in zip(ranked, ranked[1:]):
        assert (a == b) == (x == y)
        assert (a < b) == (x < y)
    with pytest.raises(ValueError, match='short deck card'):
        equity.count_wins((('Ac', 'Ad'), ('2c', 'Kd')), ('6h', '7h', '8h'), short_deck=True)


def test_settings_storage_failure_rolls_back_both_modes(tmp_path, monkeypatch):
    room, _ = table(bounty=True)
    store = Store(f'sqlite:///{tmp_path}/atomic.db')
    store.save(room)
    service = Service(store)
    before = copy.deepcopy(service.rooms[room['id']])
    def fail(*args):
        raise RuntimeError('storage failure')
    monkeypatch.setattr(store, 'save', fail)
    with pytest.raises(RuntimeError, match='storage failure'):
        asyncio.run(service.mutate(room['id'], lambda r: change(r, short_deck=True, bounty=False)))
    assert service.rooms[room['id']] == before == store.all()[0]
