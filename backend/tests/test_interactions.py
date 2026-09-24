import copy

import pytest
from fastapi.testclient import TestClient

from backend.app import Service, browser_hash, create_app
from backend import game, interactions
from backend.store import Store
from backend.tests.test_game import finish, table


class RecordingSocket:
    def __init__(self):
        self.messages = []

    async def send_json(self, message):
        self.messages.append(message)


def test_old_kick_ban_is_migrated(tmp_path):
    store = Store(f'sqlite:///{tmp_path}/rooms.db')
    room = game.create_room('旧房间', {}, 'host', 1000)
    guest = game.add_player(room, 'guest', 1000)
    guest['banned'] = True
    store.save(room)
    restored = Service(store).rooms[room['id']]
    assert not restored['players'][guest['id']]['banned']
    game.command(restored, guest['id'], {'type': 'request_seat', 'seat': 1, 'name': '回来', 'amount': 100}, 1001)
    assert restored['requests'][-1]['pid'] == guest['id']


def test_kicked_player_can_interact_until_their_seat_is_released():
    room, ids = table()
    game.command(room, ids[0], {'type': 'start'}, 1000)
    game.command(room, ids[0], {'type': 'kick', 'pid': ids[1]}, 1001)
    event, channel = interactions.make_event(room, ids[1], {'type': 'bubble', 'preset': '我很抱歉'}, 1001)
    assert event['from'] == ids[1] and channel == 'bubble'
    finish(room)
    assert room['players'][ids[1]]['seat'] is None
    with pytest.raises(game.GameError, match='请先入座'):
        interactions.make_event(room, ids[1], {'type': 'bubble', 'preset': '我很抱歉'}, 1002)


def test_interactions_are_validated_rate_limited_and_not_persisted(tmp_path):
    store = Store(f'sqlite:///{tmp_path}/rooms.db')
    with TestClient(create_app(store)) as client:
        rid = client.post('/api/rooms', json={'name': '互动'}).json()['id']
        host_cookie = client.cookies.get('river_browser')
        host = client.get(f'/api/rooms/{rid}').json()['me']
        client.post(f'/api/rooms/{rid}/commands', json={
            'type': 'request_seat', 'seat': 0, 'name': '房主', 'amount': 100, 'command_id': 'seat-host-123'})
        client.cookies.clear()
        guest = client.get(f'/api/rooms/{rid}').json()['me']
        guest_cookie = client.cookies.get('river_browser')
        client.post(f'/api/rooms/{rid}/commands', json={
            'type': 'request_seat', 'seat': 1, 'name': '客人', 'amount': 100, 'command_id': 'seat-guest-123'})
        client.cookies.clear()
        client.cookies.set('river_browser', host_cookie)
        request = client.get(f'/api/rooms/{rid}').json()['requests'][-1]['id']
        client.post(f'/api/rooms/{rid}/commands', json={
            'type': 'approve', 'request': request, 'command_id': 'approve-guest-123'})
        client.cookies.clear()
        observer = client.get(f'/api/rooms/{rid}').json()['me']
        observer_cookie = client.cookies.get('river_browser')
        service = client.app.state.service
        sockets = [RecordingSocket() for _ in range(3)]
        for socket, pid, cookie in zip(sockets, (host, guest, observer),
                                       (host_cookie, guest_cookie, observer_cookie)):
            service.connections[rid][socket] = (pid, browser_hash(cookie))
        before = copy.deepcopy(service.rooms[rid])

        def post(cookie, payload):
            client.cookies.clear()
            client.cookies.set('river_browser', cookie)
            return client.post(f'/api/rooms/{rid}/interactions', json=payload)

        assert post(observer_cookie, {'type': 'bubble', 'preset': '😂'}).status_code == 400
        assert post(host_cookie, []).status_code == 400
        assert post(host_cookie, {'type': 'bubble', 'preset': '自由输入'}).status_code == 400
        assert post(host_cookie, {'type': 'throw', 'item': 'tomato', 'target': [], 'count': 1}).status_code == 400
        assert post(host_cookie, {'type': 'throw', 'item': 'tomato', 'target': host, 'count': 1}).status_code == 400
        assert post(host_cookie, {'type': 'throw', 'item': 'tomato', 'target': observer, 'count': 1}).status_code == 400
        assert post(host_cookie, {'type': 'throw', 'item': 'tomato', 'target': guest, 'count': 2}).status_code == 400
        assert post(host_cookie, {'type': 'bubble', 'preset': '我很抱歉'}).status_code == 200
        assert post(host_cookie, {'type': 'bubble', 'preset': '😏'}).status_code == 429
        assert post(host_cookie, {'type': 'throw', 'item': 'poop', 'target': guest, 'count': 1}).status_code == 200
        assert post(host_cookie, {'type': 'throw', 'item': 'egg', 'target': guest, 'count': 10}).status_code == 200
        assert post(host_cookie, {'type': 'throw', 'item': 'egg', 'target': guest, 'count': 1}).status_code == 429
        assert post(host_cookie, {'type': 'throw', 'item': 'egg', 'target': guest, 'count': 10}).status_code == 429
        service.interaction_times[(rid, host, 'bubble')] = 0
        assert post(host_cookie, {'type': 'bubble', 'preset': '😏'}).status_code == 200
        assert service.rooms[rid] == before
        assert store.all()[0] == before
        for socket in sockets:
            events = [message['event'] for message in socket.messages]
            assert [event['kind'] for event in events] == ['bubble', 'throw', 'throw', 'bubble']
            assert events[1]['count'] == 1 and events[2]['count'] == 10
