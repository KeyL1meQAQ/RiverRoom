"""Real squid awards and held balances for browser regression fixtures."""
import copy
import json

from backend import game
from backend.tests.test_game import table
from backend.tests.test_squid import fold_hand, next_hand


def snapshots():
    room, ids = table((100, 100, 100), squid=True, squid_amount=10)
    game.command(room, ids[0], dict(type='start'), 1000)
    result = dict(before=copy.deepcopy(game.view(room, ids[0], 1001)))
    game.command(room, ids[0], dict(type='leave'), 1001)
    fold_hand(room)
    result['held'] = copy.deepcopy(game.view(room, ids[0], room['hand']['finished_at']))
    next_hand(room)
    result['last_before'] = copy.deepcopy(game.view(room, ids[0], room['hand']['clock']['base_until'] - 20))
    fold_hand(room)
    room['paused'] = True
    result['settled'] = copy.deepcopy(game.view(room, ids[0], room['hand']['finished_at']))
    return result


if __name__ == '__main__':
    print(json.dumps(snapshots(), ensure_ascii=False))
