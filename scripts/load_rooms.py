"""Exercise 20 concurrent rooms against a running HTTP/WebSocket service."""
import asyncio
import json
import os
import time
import uuid

import httpx
from websockets.asyncio.client import connect

BASE = os.getenv('BASE_URL', 'http://127.0.0.1:8000')


async def run_room(index):
    async with httpx.AsyncClient(base_url=BASE, timeout=30) as a, httpx.AsyncClient(base_url=BASE, timeout=30) as b:
        async def cmd(client, rid, **values):
            r = await client.post(f'/api/rooms/{rid}/commands', json={**values, 'command_id': str(uuid.uuid4())})
            r.raise_for_status()
        async def get(client, path):
            r = await client.get(path)
            r.raise_for_status()
            return r.json()
        r = await a.post('/api/rooms', json={'name': f'并发验收 {index}', 'settings': {'timebank': 0}})
        r.raise_for_status()
        rid = r.json()['id']
        root = f'/api/rooms/{rid}'
        sa, sb = await get(a, root), await get(b, root)
        url = BASE.replace('http', 'ws', 1) + f'/ws/{rid}'
        async with connect(url, additional_headers={'Cookie': f'river_browser={a.cookies.get("river_browser")}'}) as wa, connect(url, additional_headers={'Cookie': f'river_browser={b.cookies.get("river_browser")}'}) as wb:
            latest = {}
            changed = asyncio.Event()
            async def drain(ws, name):
                async for payload in ws:
                    message = json.loads(payload)
                    if message['type'] == 'state':
                        latest[name] = message['state']
                        changed.set()
            async def next_state(previous):
                def progress(state):
                    hand = state.get('hand') or {}
                    return (state.get('phase'), hand.get('number'), hand.get('seq'), (hand.get('deal') or {}).get('seq'))
                async with asyncio.timeout(30):
                    while 'a' not in latest or progress(latest['a']) == progress(previous):
                        changed.clear()
                        await changed.wait()
                return latest['a']
            readers = [asyncio.create_task(drain(wa, 'a')), asyncio.create_task(drain(wb, 'b'))]
            try:
                await cmd(a, rid, type='request_seat', seat=0, name='甲', amount=200)
                await cmd(b, rid, type='request_seat', seat=4, name='乙', amount=200)
                state = await get(a, root)
                await cmd(a, rid, type='approve', request=state['requests'][0]['id'])
                await cmd(a, rid, type='start')
                await cmd(a, rid, type='pause')
                state = await get(a, root)
                hand_deadline = time.monotonic() + 30
                while time.monotonic() < hand_deadline:
                    if state['hand']['result'] is not None:
                        break
                    if state['phase'] == 'betting':
                        actor = state['hand']['clock']['pid']
                        client = a if actor == sa['me'] else b
                        await cmd(client, rid, type='act', action='call', hand=state['hand']['number'], seq=state['hand']['seq'])
                    state = await next_state(state)
                assert state['hand']['result'] is not None
                assert sum(p['holding'] for p in state['players']) == 400
                assert sum(p['profit'] for p in state['players']) == 0
                await cmd(a, rid, type='end')
                close_deadline = time.monotonic() + 8
                while time.monotonic() < close_deadline and not all(latest.get(name, {}).get('closed_at') for name in ('a', 'b')):
                    await asyncio.sleep(.1)
                assert latest['a']['closed_at'] and latest['b']['closed_at']
                assert sum(p['buyout'] for p in latest['a']['players']) == 400
            finally:
                for task in readers:
                    task.cancel()
                await asyncio.gather(*readers, return_exceptions=True)
    return rid


async def main():
    start = time.monotonic()
    rooms = await asyncio.gather(*(run_room(i) for i in range(20)))
    print(json.dumps({'rooms': len(rooms), 'websocket_clients': 40, 'hands_completed': 20,
                      'all_balances_verified': True, 'elapsed_seconds': round(time.monotonic() - start, 2)}, ensure_ascii=False))


if __name__ == '__main__':
    asyncio.run(main())
