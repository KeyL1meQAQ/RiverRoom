import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import type { Room } from '../src/types';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

const fixtures = JSON.parse(execFileSync('.venv/bin/python', ['-m', 'backend.tests.presentation_fixture'], { encoding: 'utf8' }));
const base = (): Room => {
  const state: Room = structuredClone(fixtures.preflop);
  state.legal = null;
  state.hand!.clock = null;
  state.hand!.action_events = [];
  return state;
};
function ownTurn(state: Room, seq: number) {
  state.phase = 'betting';
  state.hand!.seq = seq;
  state.hand!.clock = { pid: state.me, initial: 10, base_until: state.server_time + 20, until: state.server_time + 30 };
  state.legal = { fold: true, call: 2, can_call: true, can_raise: true, min_raise: 4, max_raise: 100 };
}
function event(state: Room, kind: 'chips' | 'check', seq: number, age = 0) {
  state.hand!.action_events!.push({ seq, kind, pid: state.players[1].id, at: state.server_time - age });
}
function current(state: Room) {
  const delta = Date.now() / 1000 - state.server_time;
  const timestamps = new Set(['server_time', 'start', 'until', 'base_until', 'deadline', 'reveal_until', 'at']);
  return JSON.parse(JSON.stringify(state), (key, value) =>
    timestamps.has(key) && typeof value === 'number' && value > 0 ? value + delta : value);
}
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.soundStarts = [];
    w.audioDecoded = 0;
    const createBuffer = AudioContext.prototype.createBuffer;
    AudioContext.prototype.createBuffer = function(...args: Parameters<typeof createBuffer>) {
      w.soundContext = this;
      return createBuffer.apply(this, args);
    };
    const decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function(...args: any[]) {
      return (decode as any).apply(this, args).then((buffer: AudioBuffer) => { w.audioDecoded++; return buffer; });
    };
    const start = AudioBufferSourceNode.prototype.start;
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.start = function(...args: Parameters<typeof start>) {
      const duration = this.buffer?.duration ?? 0;
      const record = { kind: duration < .1 ? 'deal' : duration < .32 ? 'chips' : duration < .4 ? 'check' : 'turn',
        at: args[0] ?? this.context.currentTime, now: this.context.currentTime, duration, stopped: false };
      (this as any).record = record;
      w.soundStarts.push(record);
      return start.apply(this, args);
    };
    AudioBufferSourceNode.prototype.stop = function(...args: Parameters<typeof stop>) {
      if ((this as any).record) (this as any).record.stopped = true;
      return stop.apply(this, args);
    };
  });
}
async function mount(page: Page, initial = base()) {
  await instrument(page);
  let state = current(initial);
  let socket: WebSocketRoute;
  await page.route('**/api/rooms/presentation', route => route.fulfill({ json: state }));
  await page.routeWebSocket('**/ws/presentation', ws => { socket = ws; ws.send(JSON.stringify({ type: 'state', state })); });
  await page.goto('/r/presentation');
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  await page.locator('.room-info h1').click();
  await expect.poll(() => page.evaluate(() => (window as any).audioDecoded)).toBe(2);
  return {
    async push(next: Room) {
      state = current(next);
      socket.send(JSON.stringify({ type: 'state', state }));
      await page.waitForTimeout(90);
    },
    reconnect(next: Room) {
      state = current(next);
      socket.close({ code: 1012, reason: 'sound test' });
    },
  };
}
async function starts(page: Page) { return page.evaluate(() => (window as any).soundStarts as { kind: string; at: number; now: number; duration: number; stopped: boolean }[]); }
async function kinds(page: Page) { return (await starts(page)).map(sound => sound.kind); }
async function visibility(page: Page, value: 'visible' | 'hidden') {
  await page.evaluate(value => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, value);
}

test('real recorded buffers play once for each authoritative action including batched final checks', async ({ page }) => {
  const state = base();
  const feed = await mount(page, state);
  event(state, 'chips', 1);
  event(state, 'check', 2);
  state.phase = 'action_hold';
  await feed.push(state);
  expect(await kinds(page)).toEqual(['chips', 'check']);
  const sounds = await starts(page);
  expect(sounds[1].at).toBeGreaterThanOrEqual(sounds[0].at + sounds[0].duration);
  await feed.push(state);
  expect(await kinds(page)).toEqual(['chips', 'check']);
  state.hand!.number++;
  state.hand!.action_events = [];
  event(state, 'chips', 1);
  await page.waitForTimeout(800);
  await feed.push(state);
  expect(await kinds(page)).toEqual(['chips', 'check', 'chips']);
});

test('turn reminder follows the action sound once, without delaying action controls', async ({ page }) => {
  const state = base();
  const feed = await mount(page);
  event(state, 'check', 1);
  ownTurn(state, 2);
  await feed.push(state);
  expect(await kinds(page)).toEqual(['check', 'turn']);
  const sounds = await starts(page);
  expect(sounds[1].at).toBeGreaterThanOrEqual(sounds[0].at + sounds[0].duration);
  await expect(page.getByRole('button', { name: '弃牌', exact: true })).toBeEnabled();
  await feed.push(state);
  state.hand!.clock!.base_until = state.server_time - 1;
  await feed.push(state);
  expect(await kinds(page)).toEqual(['check', 'turn']);
  ownTurn(state, 3);
  await feed.push(state);
  expect(await kinds(page)).toEqual(['check', 'turn', 'turn']);
});

test('mute consumes events and reminders, persists, and never replays on unmute', async ({ page }) => {
  const state = base();
  const feed = await mount(page);
  await page.getByRole('button', { name: '关闭音效' }).click();
  event(state, 'chips', 1); ownTurn(state, 2);
  await feed.push(state);
  expect(await kinds(page)).toEqual([]);
  await page.getByRole('button', { name: '开启音效' }).click();
  await feed.push(state);
  expect(await kinds(page)).toEqual([]);
  ownTurn(state, 3);
  await feed.push(state);
  expect(await kinds(page)).toEqual(['turn']);
  await page.getByRole('button', { name: '关闭音效' }).click();
  await page.reload();
  await expect(page.getByRole('button', { name: '开启音效' })).toBeVisible();
  expect(await kinds(page)).toEqual([]);
});

test('simulated hidden page keeps only personal reminders and does not replay on return', async ({ page }) => {
  const state = base();
  const feed = await mount(page);
  await visibility(page, 'hidden');
  event(state, 'chips', 1); event(state, 'check', 2); ownTurn(state, 3);
  await feed.push(state);
  expect(await kinds(page)).toEqual(['turn']);
  await visibility(page, 'visible');
  await feed.push(state);
  expect(await kinds(page)).toEqual(['turn']);
});

test('fresh connection ignores old actions but reminds the current actor on enter, reload and reconnect', async ({ page }) => {
  const state = base();
  event(state, 'chips', 1); ownTurn(state, 2);
  const feed = await mount(page, state);
  expect(await kinds(page)).toEqual(['turn']);
  await page.reload();
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  await expect.poll(() => kinds(page)).toEqual(['turn']);
  feed.reconnect(state);
  await expect(page.locator('.connection')).toHaveClass(/offline/);
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  await expect.poll(() => kinds(page)).toEqual(['turn', 'turn']);
});

test('pending reminders stop when the turn expires, connection drops or mute is enabled', async ({ page }) => {
  const state = base();
  const feed = await mount(page);
  event(state, 'check', 1); ownTurn(state, 2);
  await feed.push(state);
  state.hand!.clock = null; state.legal = null; state.phase = 'action_hold';
  await feed.push(state);
  expect((await starts(page)).find(sound => sound.kind === 'turn')!.stopped).toBeTruthy();
  await page.waitForTimeout(500);
  state.hand!.action_events = [];
  event(state, 'check', 3); ownTurn(state, 4);
  await feed.push(state);
  await page.getByRole('button', { name: '关闭音效' }).click();
  expect((await starts(page)).slice(-2).every(sound => sound.stopped)).toBeTruthy();
  await page.getByRole('button', { name: '开启音效' }).click();
  event(state, 'chips', 5); ownTurn(state, 6);
  await feed.push(state);
  feed.reconnect(base());
  await expect(page.locator('.connection')).toHaveClass(/offline/);
  expect((await starts(page)).slice(-2).every(sound => sound.stopped)).toBeTruthy();
});

test('expired actions, recovery, votes and observers cannot trigger personal reminders', async ({ page }) => {
  const state = base();
  const feed = await mount(page);
  event(state, 'chips', 1, 5);
  await feed.push(state);
  expect(await kinds(page)).toEqual([]);
  ownTurn(state, 2); state.recovery = true;
  await feed.push(state);
  state.recovery = false; state.phase = 'runout';
  await feed.push(state);
  state.phase = 'straddle';
  await feed.push(state);
  state.phase = 'betting'; state.legal = null;
  await feed.push(state);
  expect(await kinds(page)).toEqual([]);
  event(state, 'check', 3);
  await feed.push(state);
  expect(await kinds(page)).toEqual(['check']);
});

test('missing recordings do not block actions or the synthesized turn reminder', async ({ page }) => {
  await page.route('**/audio/*.wav', route => route.fulfill({ status: 404 }));
  await instrument(page);
  const state = current(base());
  let socket: WebSocketRoute;
  await page.route('**/api/rooms/presentation', route => route.fulfill({ json: state }));
  await page.routeWebSocket('**/ws/presentation', ws => { socket = ws; ws.send(JSON.stringify({ type: 'state', state })); });
  await page.goto('/r/presentation');
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  await page.locator('.room-info h1').click();
  event(state, 'chips', 1); ownTurn(state, 2);
  socket!.send(JSON.stringify({ type: 'state', state }));
  await expect.poll(() => kinds(page)).toEqual(['turn']);
  await expect(page.getByRole('button', { name: '弃牌', exact: true })).toBeEnabled();
});

test('suspended audio cancels queued sounds and consumes events without a later burst', async ({ page }) => {
  const state = base();
  const feed = await mount(page);
  event(state, 'check', 1); ownTurn(state, 2);
  await feed.push(state);
  await page.evaluate(() => (window as any).soundContext.suspend());
  await expect.poll(async () => (await starts(page)).every(sound => sound.stopped)).toBeTruthy();
  event(state, 'chips', 3); ownTurn(state, 4);
  await feed.push(state);
  expect(await kinds(page)).toEqual(['check', 'turn']);
  await page.evaluate(() => (window as any).soundContext.resume());
  await feed.push(state);
  expect(await kinds(page)).toEqual(['check', 'turn']);
});

test('rapid actions have a bounded queue and becoming hidden cancels queued table sounds', async ({ page }) => {
  const state = base();
  const feed = await mount(page);
  for (let seq = 1; seq <= 12; seq++) event(state, 'chips', seq);
  ownTurn(state, 13);
  await feed.push(state);
  const sounds = await starts(page);
  expect(sounds.filter(sound => sound.kind === 'chips').length).toBeLessThanOrEqual(3);
  expect(sounds.at(-1)!.kind).toBe('turn');
  expect(sounds.at(-1)!.at - sounds.at(-1)!.now).toBeLessThan(1.2);
  await visibility(page, 'hidden');
  expect((await starts(page)).filter(sound => sound.kind === 'chips').every(sound => sound.stopped)).toBeTruthy();
  await visibility(page, 'visible');
  await feed.push(state);
  expect((await starts(page)).length).toBe(sounds.length);
});

test('mobile viewport uses the same sound and mute controls', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = base();
  const feed = await mount(page);
  event(state, 'chips', 1); ownTurn(state, 2);
  await feed.push(state);
  expect(await kinds(page)).toEqual(['chips', 'turn']);
  await page.getByRole('button', { name: '关闭音效' }).click();
  await expect(page.getByRole('button', { name: '开启音效' })).toBeVisible();
});

test('live room broadcasts successful actions to both players and observer; duplicates and rejection stay silent', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([0, 1, 2].map(i => browser.newContext({
    viewport: i === 1 ? { width: 390, height: 844 } : { width: 1440, height: 960 },
  })));
  try {
    const created = await contexts[0].request.post(`${baseURL}/api/rooms`, { data: { name: '行动音效验收' } });
    expect(created.ok()).toBeTruthy();
    const root = `${baseURL}/api/rooms/${(await created.json()).id}`;
    const state = async (i = 0): Promise<Room> => (await contexts[i].request.get(root)).json();
    const send = (i: number, data: object) => contexts[i].request.post(`${root}/commands`, { data });
    const command = async (i: number, data: object) => {
      const response = await send(i, { ...data, command_id: crypto.randomUUID() });
      expect(response.ok(), await response.text()).toBeTruthy();
    };
    for (let i = 0; i < 2; i++) {
      await state(i);
      await command(i, { type: 'request_seat', seat: i, name: `音效玩家${i}`, amount: 200 });
      if (i) await command(0, { type: 'approve', request: (await state()).requests[0].id });
    }
    const pages = [];
    for (const context of contexts) {
      const page = await context.newPage();
      await instrument(page);
      await page.goto(root.replace('/api/rooms/', '/r/'));
      await expect(page.locator('.connection')).toHaveClass(/connected/);
      await page.locator('.room-info h1').click();
      await expect.poll(() => page.evaluate(() => (window as any).audioDecoded)).toBe(2);
      pages.push(page);
    }
    await command(0, { type: 'start' });
    await command(0, { type: 'pause' });
    await expect.poll(() => kinds(pages[0])).toEqual(['turn']);
    expect(await kinds(pages[1])).toEqual([]);
    expect(await kinds(pages[2])).toEqual([]);
    const before = await state();
    const bad = await send(1, { type: 'act', action: 'raise', amount: 4, hand: before.number,
      seq: before.hand!.seq, command_id: crypto.randomUUID() });
    expect(bad.status()).toBe(400);
    const data = { type: 'act', action: 'call', hand: before.number, seq: before.hand!.seq, command_id: crypto.randomUUID() };
    expect((await send(0, data)).ok()).toBeTruthy();
    expect((await (await send(0, data)).json()).duplicate).toBeTruthy();
    await expect.poll(() => kinds(pages[0])).toEqual(['turn', 'chips']);
    await expect.poll(() => kinds(pages[1])).toEqual(['chips', 'turn']);
    await expect.poll(() => kinds(pages[2])).toEqual(['chips']);
    const next = await state(1);
    await command(1, { type: 'act', action: 'call', hand: next.number, seq: next.hand!.seq });
    for (const page of pages) {
      await expect.poll(async () => (await kinds(page)).filter(kind => kind === 'check').length).toBe(1);
    }
    const snapshot = await state(2);
    expect(snapshot.phase).toBe('action_hold');
    expect(snapshot.hand!.action_events!.map(event => event.kind)).toEqual(['chips', 'check']);
    await expect.poll(async () => (await state()).phase).toBe('betting');
    await command(0, { type: 'end' });
    const last = await state();
    const actor = last.players.find(player => player.id === last.hand!.clock!.pid)!;
    await command(actor.seat!, { type: 'act', action: 'fold', hand: last.number, seq: last.hand!.seq });
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
