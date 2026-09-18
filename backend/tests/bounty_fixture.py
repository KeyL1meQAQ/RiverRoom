"""Actual deterministic bounty settlements used by browser presentation tests."""
import copy
import json

import pytest

from backend import game
from backend.tests.test_bounty import reward_table, fold_to_big_blind
from backend.tests.test_game import action


def snapshots():
    results = {}
    for zero in (False, True):
        with pytest.MonkeyPatch.context() as patch:
            room, _, observer = reward_table(patch)
            room['paused'] = True
            key = 'zero' if zero else 'paid'
            results[key + '_before'] = copy.deepcopy(game.view(room, room['owner'], 1001))
            if zero:
                action(room, 'raise', 100)
                action(room)
                action(room)
            else:
                fold_to_big_blind(room)
            results[key] = copy.deepcopy(game.view(room, room['owner'], room['hand']['finished_at']))
            results[key + '_observer'] = copy.deepcopy(game.view(room, observer, room['hand']['finished_at']))
    return results


if __name__ == '__main__':
    print(json.dumps(snapshots(), ensure_ascii=False))
