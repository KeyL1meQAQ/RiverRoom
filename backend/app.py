import asyncio
import copy
import csv
import hashlib
import io
import logging
import os
import secrets
import time
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import game
from .store import Store

logger = logging.getLogger('river')


def browser_hash(value):
    return hashlib.sha256(value.encode()).hexdigest()


def valid_origin(origin, host):
    allowed = {v.strip() for v in os.getenv('ALLOWED_ORIGINS', '').split(',') if v.strip()}
    return not origin or urlparse(origin).netloc == host or origin in allowed


class Service:
    def __init__(self, store):
        self.store = store
        self.rooms = {r['id']: r for r in store.all()}
        self.locks = defaultdict(asyncio.Lock)
        self.connections = defaultdict(dict)
        self.limits = defaultdict(deque)
        now = time.time()
        for room in self.rooms.values():
            old = room['version']
            migrated = game.migrate_reveals(room)
            if room['closed_at']:
                if migrated:
                    room['version'] += 1
                    store.save(room, old)
                continue
            for p in room['players'].values():
                if p['online']:
                    p.update(online=False, offline=p.get('last_seen', now))
            if room['empty_since'] is None:
                room['empty_since'] = max((p.get('last_seen', now) for p in room['players'].values()), default=now)
            if room['started']:
                if not room['recovery']:
                    room['resume_phase'] = room['phase']
                    room['remaining'] = max(0, (room['deadline'] or now) - now)
                room.update(recovery=True, paused=True)
                game.log(room, '服务已恢复，等待房主继续游戏', now, 'room')
            room['version'] += 1
            store.save(room, old)

    def limit(self, key, maximum, seconds=60):
        now = time.monotonic()
        q = self.limits[key]
        while q and q[0] < now - seconds:
            q.popleft()
        if len(q) >= maximum:
            raise HTTPException(429, '操作过于频繁，请稍后再试')
        q.append(now)

    def room(self, rid):
        if rid not in self.rooms:
            raise HTTPException(404, '房间不存在或记录已过期')
        return self.rooms[rid]

    def player(self, room, sid):
        digest = browser_hash(sid)
        p = next((p for p in room['players'].values() if p['browser'] == digest), None)
        if not p:
            raise HTTPException(401, '身份已被其他设备接管，请重新进入房间')
        return p

    async def mutate(self, rid, fn):
        async with self.locks[rid]:
            room = self.room(rid)
            previous = copy.deepcopy(room)
            try:
                result = fn(room)
                if room != previous:
                    room['version'] = previous['version'] + 1
                    self.store.save(room, previous['version'])
            except Exception:
                self.rooms[rid] = previous
                raise
        await self.publish(rid)
        return result

    async def publish(self, rid):
        room = self.rooms.get(rid)
        if not room:
            return
        cache = {}
        for ws, (pid, browser) in list(self.connections[rid].items()):
            try:
                if room['players'][pid]['browser'] != browser:
                    await asyncio.wait_for(ws.send_json({'type': 'revoked'}), 2)
                    await ws.close(code=1008)
                    self.connections[rid].pop(ws, None)
                    continue
                if pid not in cache:
                    cache[pid] = game.view(room, pid, time.time())
                await asyncio.wait_for(ws.send_json({'type': 'state', 'state': cache[pid]}), 2)
            except Exception:
                self.connections[rid].pop(ws, None)

    async def loop(self):
        while True:
            await asyncio.sleep(0.5)
            now = time.time()
            for rid in list(self.rooms):
                room = self.rooms[rid]
                if room['closed_at'] and now - room['closed_at'] >= 30 * 86400:
                    self.store.remove(rid)
                    self.rooms.pop(rid, None)
                    continue
                if room['closed_at']:
                    continue
                try:
                    def update(r):
                        for p in r['players'].values():
                            if p['online'] and now - p['last_seen'] > 20:
                                p.update(online=False, offline=p['last_seen'] + 20)
                                game.log(r, f"{p['name']} 离线", now, 'room')
                        if not any(p['online'] for p in r['players'].values()) and r['empty_since'] is None:
                            r['empty_since'] = now
                        game.tick(r, now)
                    await self.mutate(rid, update)
                except Exception:
                    logger.exception('Room tick failed for %s', rid)


def create_app(store=None):
    @asynccontextmanager
    async def lifespan(app):
        app.state.service = Service(store or Store())
        task = asyncio.create_task(app.state.service.loop())
        yield
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    app = FastAPI(lifespan=lifespan)

    @app.exception_handler(game.GameError)
    async def game_error(request, exc):
        return JSONResponse({'detail': str(exc)}, status_code=400)

    @app.middleware('http')
    async def guard(request: Request, call_next):
        if request.method not in {'GET', 'HEAD', 'OPTIONS'}:
            origin = request.headers.get('origin')
            if not valid_origin(origin, request.headers.get('host')):
                return JSONResponse({'detail': '请求来源不受信任'}, status_code=403)
            if int(request.headers.get('content-length', '0')) > 16384:
                return JSONResponse({'detail': '请求过大'}, status_code=413)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'same-origin'
        response.headers['X-Frame-Options'] = 'DENY'
        if request.url.path.startswith('/api'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    def identity(request):
        sid = request.cookies.get('river_browser')
        return sid if sid and 20 <= len(sid) <= 128 else secrets.token_urlsafe(32)

    def with_cookie(result, sid, request):
        response = JSONResponse(result)
        response.set_cookie('river_browser', sid, max_age=365 * 86400, httponly=True,
                            samesite='lax', secure=request.url.scheme == 'https')
        return response

    @app.get('/api/health')
    async def health():
        return {'ok': True}

    @app.post('/api/rooms')
    async def create(request: Request):
        service = request.app.state.service
        service.limit(('create', request.client.host), 30)
        require_capacity = sum(r['closed_at'] is None for r in service.rooms.values()) < 200
        game.require(require_capacity, '当前房间数量已达上限')
        body = await request.json()
        sid = identity(request)
        room = game.create_room(body.get('name', ''), body.get('settings', {}), browser_hash(sid))
        service.store.save(room)
        service.rooms[room['id']] = room
        return with_cookie({'id': room['id']}, sid, request)

    @app.get('/api/rooms/{rid}')
    async def join(rid: str, request: Request):
        service = request.app.state.service
        service.limit(('join', request.client.host), 600)
        sid = identity(request)
        def enter(room):
            p = game.add_player(room, browser_hash(sid), time.time())
            return game.view(room, p['id'], time.time())
        result = await service.mutate(rid, enter)
        return with_cookie(result, sid, request)

    @app.post('/api/rooms/{rid}/recover')
    async def recover(rid: str, request: Request):
        service = request.app.state.service
        service.limit(('recover', request.client.host), 10, 300)
        body = await request.json()
        code = str(body.get('code', '')).replace('-', '').replace(' ', '').upper()
        sid = identity(request)
        digest = browser_hash(sid)
        def take(room):
            target = next((p for p in room['players'].values() if secrets.compare_digest(p['code'], code)), None)
            game.require(target is not None, '召回码无效')
            current = next((p for p in room['players'].values() if p['browser'] == digest), None)
            game.require(current is None or current['id'] == target['id'] or current['seat'] is None, '请先将当前身份离座')
            if current and current['id'] != target['id']:
                current.update(browser=None, online=False, offline=time.time())
                room['requests'] = [r for r in room['requests'] if r['pid'] != current['id']]
            target.update(browser=digest, code=secrets.token_hex(8).upper(), online=False, offline=time.time())
            game.log(room, f"{target['name']} 已在另一设备召回身份", time.time(), 'room')
            return {'ok': True}
        return with_cookie(await service.mutate(rid, take), sid, request)

    @app.post('/api/rooms/{rid}/commands')
    async def commands(rid: str, request: Request):
        service = request.app.state.service
        service.limit(('command', request.client.host), 600)
        sid = request.cookies.get('river_browser', '')
        body = await request.json()
        key = body.get('command_id')
        game.require(isinstance(key, str) and 8 <= len(key) <= 80, '命令标识无效')
        def execute(room):
            p = service.player(room, sid)
            if key in p['seen']:
                return {'ok': True, 'duplicate': True}
            game.command(room, p['id'], body, time.time())
            p['seen'] = (p['seen'] + [key])[-128:]
            return {'ok': True}
        return await service.mutate(rid, execute)

    @app.get('/api/rooms/{rid}/stats.csv')
    async def stats(rid: str, request: Request):
        room = request.app.state.service.room(rid)
        stream = io.StringIO()
        writer = csv.writer(stream)
        writer.writerow(['昵称', '累计买入', '累计买出', '当前持有', '净输赢'])
        for p in room['players'].values():
            if p['first_seat']:
                continue
            name = p['name']
            if name.startswith(('=', '+', '-', '@', '\t', '\r')):
                name = "'" + name
            # During a hand the last settled stack includes committed chips.
            writer.writerow([name, p['buyin'], p['buyout'], p['stack'], p['profit']])
        return Response('\ufeff' + stream.getvalue(), media_type='text/csv; charset=utf-8',
                        headers={'Content-Disposition': 'attachment; filename="poker-statistics.csv"'})

    @app.get('/api/rooms/{rid}/history')
    async def history(rid: str, request: Request, before: int = 2**31):
        service = request.app.state.service
        room = service.room(rid)
        viewer = service.player(room, request.cookies.get('river_browser', ''))['id']
        hands = [h for h in room['history'] if h['number'] < before][-50:]
        return {'hands': [game.public_hand(h, viewer) for h in hands]}

    @app.get('/api/rooms/{rid}/logs')
    async def logs(rid: str, request: Request, hand: int | None = None, before: int = 2**31):
        room = request.app.state.service.room(rid)
        records = [e for e in room['logs'] if e['id'] < before and (hand is None or e['hand'] == hand)]
        return {'logs': records[-500:]}

    @app.websocket('/ws/{rid}')
    async def socket(ws: WebSocket, rid: str):
        service = ws.app.state.service
        origin = ws.headers.get('origin')
        if not valid_origin(origin, ws.headers.get('host')):
            await ws.close(code=1008)
            return
        sid = ws.cookies.get('river_browser', '')
        try:
            room = service.room(rid)
            p = service.player(room, sid)
        except HTTPException:
            await ws.close(code=1008)
            return
        pid, digest = p['id'], browser_hash(sid)
        await ws.accept()
        service.connections[rid][ws] = (pid, digest)
        def connected(room):
            p = service.player(room, sid)
            if not p['online']:
                game.log(room, f"{p['name']} 已连接", time.time(), 'room')
            p.update(online=True, last_seen=time.time())
            room['empty_since'] = None
        try:
            await service.mutate(rid, connected)
            while True:
                message = await asyncio.wait_for(ws.receive_text(), 25)
                if message != 'ping':
                    continue
                def heartbeat(room):
                    p = service.player(room, sid)
                    p.update(online=True, last_seen=time.time())
                    room['empty_since'] = None
                await service.mutate(rid, heartbeat)
        except (WebSocketDisconnect, asyncio.TimeoutError, HTTPException, RuntimeError):
            pass
        finally:
            service.connections[rid].pop(ws, None)
            if rid in service.rooms:
                def disconnected(room):
                    p = room['players'][pid]
                    others = any(pair == (pid, digest) for pair in service.connections[rid].values())
                    if p['browser'] == digest and not others:
                        p.update(online=False, offline=time.time())
                        if not any(x['online'] for x in room['players'].values()):
                            room['empty_since'] = time.time()
                        game.log(room, f"{p['name']} 离线", time.time(), 'room')
                await service.mutate(rid, disconnected)

    dist = Path(__file__).resolve().parent.parent / 'dist'
    if dist.exists():
        app.mount('/assets', StaticFiles(directory=dist / 'assets'), name='assets')

        @app.get('/{path:path}')
        async def frontend(path: str):
            candidate = (dist / path).resolve()
            if candidate.is_relative_to(dist) and candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(dist / 'index.html')

    return app


app = create_app()
