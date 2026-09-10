"""Deterministic public snapshots for browser presentation tests."""
import copy
import json

import pytest

from backend import game
from backend.tests.test_game import action, finish, settle_dealing
from backend.tests.test_presentation import raw_call
from backend.tests.test_showdown import fixed_table


def snapshots():
    result = {}
    with pytest.MonkeyPatch.context() as patch:
        room, ids, _ = fixed_table(patch, [('Ac', 'Ad'), ('Kc', 'Kd')])
        room['paused'] = True
        result['preflop'] = game.view(room, room['owner'], 1001)
        raw_call(room, 1001)
        raw_call(room, 1001)
        result['flop'] = game.view(room, room['owner'], 1001)
        settle_dealing(room)
        result['flop_done'] = game.view(room, room['owner'], 1001.75)

    with pytest.MonkeyPatch.context() as patch:
        holes = [('2c', '3d'), ('4c', '5d'), ('6c', '7d'), ('8c', '9d'), ('Tc', 'Jd'),
                 ('Qc', 'Kd'), ('Ac', '2d'), ('3c', '4d'), ('5c', '6d')]
        room, ids, observer = fixed_table(patch, holes, board=('Ts', 'Js', 'Qs', 'Ks', 'As'))
        room['paused'] = True
        finish(room)
        result['tie'] = game.view(room, room['owner'], room['hand']['finished_at'])
        result['tie_observer'] = game.view(room, observer, room['hand']['finished_at'])

    with pytest.MonkeyPatch.context() as patch:
        room, ids, observer = fixed_table(patch, holes, stacks=(200,) * 9)
        room['paused'] = True
        for _ in range(9):
            action(room)
        action(room)
        action(room)
        action(room, 'raise', 20)
        action(room)
        action(room, 'raise', 100)
        action(room, 'fold')
        action(room, 'raise', 198)
        action(room)
        result['table_actions'] = copy.deepcopy(game.view(room, room['owner'], 1002))

    with pytest.MonkeyPatch.context() as patch:
        room, ids, observer = fixed_table(patch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')],
                                           stacks=(200, 40, 100), twice=True,
                                           board2=('Kh', '2d', '3s', '7h', '8d'))
        room['paused'] = True
        action(room, 'raise', 200)
        action(room)
        action(room)
        for pid in ids:
            game.command(room, pid, {'type': 'vote', 'value': True}, 1002)
        settle_dealing(room)
        result['twice'] = game.view(room, room['owner'], room['hand']['finished_at'])

    with pytest.MonkeyPatch.context() as patch:
        room, ids, _ = fixed_table(patch, [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd')],
                                  board=('2h', '5s', '9d', 'Qs', '3h'))
        room['paused'] = True
        folded = room['hand']['clock']['pid']
        action(room, 'fold')
        result['folded_before'] = game.view(room, folded, 1001)
        finish(room)
        result['folded_after'] = game.view(room, folded, room['hand']['finished_at'])
    return copy.deepcopy(result)


if __name__ == '__main__':
    print(json.dumps(snapshots(), ensure_ascii=False))
