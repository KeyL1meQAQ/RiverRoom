"""Exact unique-winner probabilities conditioned on all already used cards.

The native enumerator is display-only; PokerKit remains the settlement engine.
Dead cards include folded holes and burns, but never the future deck order.
"""
from ctypes import CDLL, POINTER, c_int, c_uint32, c_uint64
from functools import lru_cache
from pathlib import Path

RANKS = '23456789TJQKA'
SUITS = 'cdhs'


def card(code):
    if not isinstance(code, str) or len(code) != 2:
        raise ValueError('Invalid card')
    return RANKS.index(code[0]) * 4 + SUITS.index(code[1])


@lru_cache(maxsize=1)
def library():
    lib = CDLL(str(Path(__file__).with_name('_runout_odds.so')))
    lib.rr_count_variant.argtypes = [POINTER(c_int), c_int, POINTER(c_int), c_int,
                                    POINTER(c_int), c_int, c_int, POINTER(c_uint64)]
    lib.rr_count_variant.restype = c_uint64
    lib.rr_rank7.argtypes = [POINTER(c_int)]
    lib.rr_rank7.restype = c_uint32
    lib.rr_rank7_short_deck.argtypes = [POINTER(c_int)]
    lib.rr_rank7_short_deck.restype = c_uint32
    return lib


@lru_cache(maxsize=512)
def count_wins(holes, board, dead=(), short_deck=False):
    """Enumerate every remaining board once, returning (win counts, total)."""
    if not 2 <= len(holes) <= 9 or any(len(h) != 2 for h in holes) or len(board) > 5:
        raise ValueError('Invalid runout')
    active = tuple(c for h in holes for c in h) + board
    if len(set(active + dead)) != len(active + dead):
        raise ValueError('Duplicate card')
    if (36 if short_deck else 52) - len(active + dead) < 5 - len(board):
        raise ValueError('Not enough remaining cards')
    encoded = [card(c) for c in active + dead]
    if short_deck and any(c < 16 for c in encoded):
        raise ValueError('Invalid short deck card')
    hole_count = len(holes) * 2
    hole_array = (c_int * hole_count)(*encoded[:hole_count])
    board_array = (c_int * len(board))(*encoded[hole_count:len(active)])
    dead_array = (c_int * len(dead))(*encoded[len(active):])
    wins = (c_uint64 * len(holes))()
    total = library().rr_count_variant(hole_array, len(holes), board_array, len(board), dead_array, len(dead), short_deck, wins)
    return tuple(wins), total


def rates_for_prefix(hand, board_index, count, burns):
    players = hand['runout_players']
    holes = tuple(tuple(hand['dealt'][pid]) for pid in players)
    board = tuple(hand['boards'][board_index][:count])
    known = {c for h in holes for c in h} | set(board)
    used = ({c for h in hand['dealt'].values() for c in h} | set(burns)
            | {c for b in hand['boards'][:board_index] for c in b})
    # Shared prefixes count once. Future cards in this/next board do not enter.
    dead = tuple(sorted(used - known))
    wins, total = count_wins(holes, board, dead, hand.get('short_deck', False))
    return dict(total=total, wins=dict(zip(players, wins)))


def prepare_deal(hand, board_index, start, end, before_burns, after_burns):
    """Capture each visible prefix before engine/animation advances again."""
    previous = hand.get('runout_equity')
    frames = {}
    for count in range(start, end + 1):
        if count == 5:
            continue  # The completed board shows results instead of odds.
        key = str(count)
        if count == start and previous and previous['board'] == board_index and key in previous['frames']:
            frames[key] = previous['frames'][key]
        else:
            frames[key] = rates_for_prefix(hand, board_index, count,
                                          before_burns if count == start else after_burns)
    hand['runout_equity'] = dict(board=board_index, frames=frames)
