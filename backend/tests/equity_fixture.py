"""Real engine runout snapshots, including the server's staged flop payload."""
import copy
import json

import pytest

from backend import game
from backend.tests.test_game import action
from backend.tests.test_showdown import fixed_table


def snapshots():
    result = {}
    with pytest.MonkeyPatch.context() as patch:
        holes = [('Ac', 'Ad'), ('Kc', 'Kd'), ('Qc', 'Qd'), ('Tc', 'Td'), ('8c', '8d'),
                 ('6c', '6d'), ('4c', '4d'), ('2c', '2d'), ('3c', '3d')]
        room, ids, observer = fixed_table(patch, holes, twice=True)
        room['paused'] = True
        action(room, 'raise', 100)
        while room['phase'] == 'betting':
            action(room)
        result['vote'] = game.view(room, room['owner'], 1002)
        for pid in ids:
            game.command(room, pid, dict(type='vote', value=True), 1002)
        result['reveal'] = copy.deepcopy(game.view(room, room['owner'], room['hand']['deal']['start'] - .75))
        result['observer'] = copy.deepcopy(game.view(room, observer, room['hand']['deal']['start'] - .75))
        result['flop'] = copy.deepcopy(game.view(room, room['owner'], room['hand']['deal']['start']))
        game.tick(room, room['deadline'])
        result['turn'] = copy.deepcopy(game.view(room, room['owner'], room['hand']['deal']['start']))
        game.tick(room, room['deadline'])
        result['river'] = copy.deepcopy(game.view(room, room['owner'], room['hand']['deal']['start']))
        game.tick(room, room['deadline'])
        result['first_result'] = copy.deepcopy(game.view(room, room['owner'], room['deadline'] - 1.5))
        game.tick(room, room['deadline'])
        result['second'] = copy.deepcopy(game.view(room, room['owner'], room['hand']['deal']['start'] - .75))
        while room['phase'] == 'dealing':
            game.tick(room, room['deadline'])
        result['finished'] = game.view(room, room['owner'], room['hand']['finished_at'])
    return result


if __name__ == '__main__':
    print(json.dumps(snapshots(), ensure_ascii=False))
