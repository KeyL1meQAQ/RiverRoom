import copy
import time

import pytest
from fastapi.testclient import TestClient

from backend.app import Service, create_app
from backend import engine, game
from backend.store import Store
from backend.tests.test_game import table, action, settle_dealing


@pytest.fixture
def store(tmp_path):
    return Store(f'sqlite:///{tmp_path}/rooms.db')


def test_restart_restores_private_deck_actions_bank_and_votes(store):
    room, ids = table(twice=True)
    game.command(room, ids[0], {'type': 'start'}, 1000)
    action(room, 'raise', 100)
    action(room)
    action(room)
    game.command(room, ids[0], {'type': 'vote', 'value': True}, 1002)
    room['players'][ids[0]]['bank'] = 3
    saved = copy.deepcopy(room['hand'])
    store.save(room)
    service = Service(store)
    restored = service.rooms[room['id']]
    assert restored['recovery'] and restored['paused']
    assert restored['hand']['deck'] == saved['deck']
    assert restored['hand']['ops'] == saved['ops']
    assert restored['players'][ids[0]]['bank'] == 3
    game.command(restored, ids[0], {'type': 'resume'}, 1010)
    assert restored['phase'] == 'runout' and restored['deadline'] == 1025
    assert restored['hand']['votes'] == {ids[0]: True}
    game.command(restored, ids[1], {'type': 'vote', 'value': True}, 1011)
    game.command(restored, ids[2], {'type': 'vote', 'value': True}, 1011)
    settle_dealing(restored)
    assert restored['hand']['runouts'] == 2
    assert sum(p['stack'] for p in restored['players'].values()) == 300


def test_api_recovery_revokes_old_identity_and_rotates_code(store):
    with TestClient(create_app(store)) as client:
        rid = client.post('/api/rooms', json={'name': '召回测试'}).json()['id']
        old_cookie = client.cookies.get('river_browser')
        state = client.get(f'/api/rooms/{rid}').json()
        me, old_code = state['me'], state['recovery_code']
        command = dict(type='request_seat', seat=0, name='玩家', amount=100, command_id='seat-command-123')
        assert client.post(f'/api/rooms/{rid}/commands', json=command).status_code == 200
        assert client.post(f'/api/rooms/{rid}/commands', json=command).json()['duplicate']
        assert len(client.app.state.service.rooms[rid]['ledger']) == 1
        client.cookies.clear()
        spectator = client.get(f'/api/rooms/{rid}').json()
        assert spectator['me'] != me
        assert client.post(f'/api/rooms/{rid}/recover', json={'code': old_code}).status_code == 200
        recovered = client.get(f'/api/rooms/{rid}').json()
        assert recovered['me'] == me
        assert recovered['recovery_code'] != old_code
        assert client.post(f'/api/rooms/{rid}/recover', json={'code': old_code}).status_code == 400
        client.cookies.clear()
        client.cookies.set('river_browser', old_cookie)
        assert client.post(f'/api/rooms/{rid}/commands', json={'type': 'leave', 'command_id': 'old-leave-123'}).status_code == 401


def test_rejected_command_is_atomic_and_origin_is_checked(store):
    with TestClient(create_app(store)) as client:
        assert client.post('/api/rooms', json={'name': '拒绝'}, headers={'Origin': 'https://example.com'}).status_code == 403
        assert client.post('/api/rooms', json={'name': '名' * 21}).status_code == 400
        rid = client.post('/api/rooms', json={'name': '事务测试'}).json()['id']
        before = copy.deepcopy(client.app.state.service.rooms[rid])
        r = client.post(f'/api/rooms/{rid}/commands', json={'type': 'request_seat', 'seat': 0, 'name': '玩家', 'amount': -1, 'command_id': 'invalid-12345'})
        assert r.status_code == 400
        assert client.app.state.service.rooms[rid] == before
        assert store.all()[0] == before


def test_non_owner_cannot_approve_and_csv_sanitizes_names(store):
    with TestClient(create_app(store)) as client:
        rid = client.post('/api/rooms', json={'name': '审批测试'}).json()['id']
        client.post(f'/api/rooms/{rid}/commands', json={'type': 'request_seat', 'seat': 0, 'name': '=123', 'amount': 100, 'command_id': 'request-1234'})
        assert "'=123" in client.get(f'/api/rooms/{rid}/stats.csv').text
        client.cookies.clear()
        client.get(f'/api/rooms/{rid}')
        result = client.post(f'/api/rooms/{rid}/commands', json={'type': 'settings', 'settings': {}, 'command_id': 'config-12345'})
        assert result.status_code == 400


def test_twenty_rooms_progress_independently(store):
    rooms = []
    for _ in range(20):
        room, ids = table()
        game.command(room, ids[0], {'type': 'start'}, 1000)
        store.save(room)
        rooms.append(room)
    start = time.monotonic()
    for room in rooms:
        for _ in range(12):
            if room['phase'] == 'betting':
                action(room)
        old = room['version']
        room['version'] += 1
        store.save(room, old)
        assert sum(p['stack'] for p in room['players'].values()) == 300
    assert time.monotonic() - start < 10
    assert len(store.all()) == 20


def test_history_endpoint_keeps_folded_cards_private(store):
    from backend.app import browser_hash
    from backend.tests.test_game import finish
    room, ids = table()
    cookie = 'test-history-browser-123456789'
    room['players'][ids[0]]['browser'] = browser_hash(cookie)
    game.command(room, ids[0], {'type': 'start'}, 1000)
    action(room, 'fold')
    finish(room)
    store.save(room)
    with TestClient(create_app(store)) as client:
        client.cookies.set('river_browser', cookie)
        own = client.get(f'/api/rooms/{room["id"]}/history').json()['hands'][0]
        assert ids[0] in own['cards']
        assert 'deck' not in own and 'ops' not in own
        client.cookies.clear()
        client.get(f'/api/rooms/{room["id"]}')
        public = client.get(f'/api/rooms/{room["id"]}/history').json()['hands'][0]
        assert ids[0] not in public['cards']
        assert client.get(f'/api/rooms/{room["id"]}/logs?hand=1').json()['logs']


def test_tie_odd_chips_are_distributed_one_each():
    hand = engine.new_hand(['a', 'b', 'c', 'd'], [0, 1, 2, 3], [100] * 4, [1, 2, 0, 0], 2, 1)
    # Royal flush on the board makes all remaining players tie. One folded
    # big blind contributes two chips: 8 chips shared by three players.
    prefix = ['2c', '3c', '4c', '5c', '6c', '7c', '8c', '9c', '2d', 'Ts', 'Js', 'Qs', '3d', 'Ks', '4d', 'As']
    hand['deck'] = prefix + [c for c in hand['deck'] if c not in prefix]
    state = engine.state_for(hand)
    engine.advance(hand, state, False)
    engine.step(hand, state, 'check_or_call')
    engine.step(hand, state, 'check_or_call')
    engine.step(hand, state, 'check_or_call')
    engine.step(hand, state, 'fold')
    for _ in range(20):
        phase = engine.advance(hand, state, False)
        if phase == 'finished':
            break
        engine.step(hand, state, 'check_or_call')
    assert hand['boards'] if 'boards' in hand else engine.boards(state) == [['Ts', 'Js', 'Qs', 'Ks', 'As']]
    assert hand['awards'][0]['amounts'] == [3, 0, 3, 2]
    assert sum(state.stacks) == 400
    assert engine.state_for(hand).stacks == state.stacks
