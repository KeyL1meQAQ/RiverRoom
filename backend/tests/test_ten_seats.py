import pytest

from backend import equity, game
from backend.tests.test_game import finish, table
from backend.tests.test_equity import DECK, reference


def test_tenth_seat_full_hand_and_clockwise_wrap():
    room, ids = table((100,) * 10)
    extra = game.add_player(room, 'observer10', 1000)['id']
    with pytest.raises(game.GameError):
        game.command(room, extra, dict(type='request_seat', seat=10, name='extra', amount=100), 1000)
    with pytest.raises(game.GameError, match='占用'):
        game.command(room, extra, dict(type='request_seat', seat=9, name='extra', amount=100), 1000)
    assert game.next_seat([0, 8, 9], 8) == 9
    assert game.next_seat([0, 8, 9], 9) == 0
    room['big_blind'] = 8
    game.command(room, ids[0], dict(type='start'), 1000)
    hand = room['hand']
    assert room['big_blind'] == 9
    assert set(hand['ids']) == set(ids)
    assert game.view(room, extra, 1000)['hand']['cards'] == {}
    room['paused'] = True
    finish(room)
    assert len(room['history']) == 1
    assert sum(player['stack'] for player in room['players'].values()) == 1000


def test_ten_player_native_odds_match_independent_evaluator():
    # Ten distinct pairs, plus a turn board: every possible river is checked.
    holes = tuple(tuple(DECK[i:i + 2]) for i in range(0, 20, 2))
    board = tuple(DECK[20:24])
    assert equity.count_wins(holes, board) == reference(holes, board)
    with pytest.raises(ValueError, match='Invalid runout'):
        equity.count_wins(holes + (tuple(DECK[24:26]),), board)
