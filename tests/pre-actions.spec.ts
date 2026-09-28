import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import type { Room } from '../src/types';

test.use({ launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } });

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const w = window as any;
    w.turnSounds = 0;
    w.audioDecoded = 0;
    const decode = AudioContext.prototype.decodeAudioData;
    AudioContext.prototype.decodeAudioData = function(...args: any[]) {
      return (decode as any).apply(this, args).then((buffer: AudioBuffer) => { w.audioDecoded++; return buffer; });
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function(...args: Parameters<typeof start>) {
      if (this.buffer && this.buffer.duration > .4) w.turnSounds++;
      return start.apply(this, args);
    };
  });
}
async function turnSounds(page: Page): Promise<number> { return page.evaluate(() => (window as any).turnSounds); }
const group = (page: Page) => page.getByRole('group', { name: '预行动', exact: true });
const button = (page: Page, name: string) => group(page).getByRole('button', { name, exact: true });

async function checkMobileLayout(page: Page) {
  const call = (await button(page, '跟注任意金额').boundingBox())!;
  const check = (await button(page, '过牌').boundingBox())!;
  const fold = (await button(page, '弃牌').boundingBox())!;
  const combo = (await button(page, '过牌或弃牌').boundingBox())!;
  expect(call.x).toBeLessThan(check.x);
  expect(check.x).toBeLessThan(fold.x);
  expect(call.y).toBe(check.y);
  expect(check.y).toBe(fold.y);
  expect(combo.y + combo.height).toBeLessThanOrEqual(call.y);
  expect(combo.height).toBeLessThan(call.height);
  expect(Math.abs(combo.x + combo.width - fold.x - fold.width)).toBeLessThan(2);
  expect(fold.x + fold.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const status = (await group(page).getByRole('status').boundingBox())!;
  const seat = (await page.locator('.own-seat').boundingBox())!;
  expect(status.x + status.width).toBeLessThan(seat.x);
  expect(combo.x).toBeGreaterThan(seat.x + seat.width);
}

test('live persisted preactions sync across windows, cancel on raises, suppress successful turn prompts and survive disconnect', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([0, 1, 2, 3].map(i => browser.newContext({
    viewport: i === 2 ? { width: 390, height: 844 } : { width: 1440, height: 960 },
  })));
  try {
    const created = await contexts[0].request.post(`${baseURL}/api/rooms`, { data: { name: '预行动验收' } });
    expect(created.ok()).toBeTruthy();
    const root = `${baseURL}/api/rooms/${(await created.json()).id}`;
    const state = async (i = 0): Promise<Room> => (await contexts[i].request.get(root)).json();
    const command = async (i: number, data: object) => {
      const result = await contexts[i].request.post(`${root}/commands`, { data: { ...data, command_id: crypto.randomUUID() } });
      expect(result.ok(), await result.text()).toBeTruthy();
    };
    for (let i = 0; i < 3; i++) {
      await state(i);
      await command(i, { type: 'request_seat', seat: i, name: `预选玩家${i}`, amount: 200 });
      if (i) await command(0, { type: 'approve', request: (await state()).requests[0].id });
    }
    const pages: Page[] = [];
    for (const context of contexts) {
      const page = await context.newPage();
      await instrument(page);
      await page.goto(root.replace('/api/rooms/', '/r/'));
      await expect(page.locator('.connection')).toHaveClass(/connected/);
      await page.locator('.room-info h1').click();
      await expect.poll(() => page.evaluate(() => (window as any).audioDecoded)).toBe(2);
      pages.push(page);
    }
    const mobile = pages[2];
    const mirror = await contexts[2].newPage();
    await mirror.setViewportSize({ width: 1440, height: 960 });
    await mirror.goto(root.replace('/api/rooms/', '/r/'));
    await expect(mirror.locator('.connection')).toHaveClass(/connected/);
    await command(0, { type: 'start' });
    await command(0, { type: 'pause' });
    await expect(group(mobile)).toBeVisible();
    await expect(button(mobile, '跟注任意金额')).toBeDisabled();
    await expect(group(pages[3])).toHaveCount(0);
    await checkMobileLayout(mobile);

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await mobile.route('**/commands', async route => { await gate; await route.continue(); });
    await button(mobile, '过牌').click();
    await expect(group(mobile)).toHaveAttribute('aria-busy', 'true');
    await expect(button(mobile, '过牌')).toHaveAttribute('aria-pressed', 'false');
    release();
    await expect(button(mobile, '过牌')).toHaveAttribute('aria-pressed', 'true');
    await expect(group(mobile)).toHaveAttribute('aria-busy', 'false');
    await mobile.unroute('**/commands');
    await expect(button(mirror, '过牌')).toHaveAttribute('aria-pressed', 'true');
    await mobile.screenshot({ path: 'artifacts/pre-actions/mobile-selected.png' });
    await mirror.screenshot({ path: 'artifacts/pre-actions/desktop-selected.png' });
    const stale = (await state(2)).pre_action!;
    const before = await state();
    await command(0, { type: 'act', action: 'raise', amount: 8, hand: before.number, seq: before.hand!.seq });
    await expect(button(mobile, '过牌')).toHaveAttribute('aria-pressed', 'false');
    await expect(button(mobile, '过牌')).toBeDisabled();
    await expect(button(mirror, '过牌')).toHaveAttribute('aria-pressed', 'false');
    expect(await turnSounds(mobile)).toBe(0);
    const rejected = await contexts[2].request.post(`${root}/commands`, { data: {
      type: 'pre_action', hand: stale.hand, street: stale.street, revision: stale.revision,
      action: 'fold', command_id: crypto.randomUUID(),
    } });
    expect(rejected.status()).toBe(400);
    await button(mobile, '过牌或弃牌').click();
    await expect(button(mobile, '过牌或弃牌')).toHaveAttribute('aria-pressed', 'true');
    await button(mobile, '过牌或弃牌').click();
    await expect(button(mobile, '过牌或弃牌')).toHaveAttribute('aria-pressed', 'false');
    const sb = await state(1);
    await command(1, { type: 'act', action: 'call', hand: sb.number, seq: sb.hand!.seq });
    await expect(group(mobile)).toHaveCount(0);
    await expect.poll(() => turnSounds(mobile)).toBe(1);
    const bb = await state(2);
    await command(2, { type: 'act', action: 'call', hand: bb.number, seq: bb.hand!.seq });
    await expect.poll(async () => (await state()).phase).toBe('betting');

    // The successful chain never broadcasts a pending manual turn for player 2.
    await button(mobile, '过牌').click();
    await expect(button(mobile, '过牌')).toHaveAttribute('aria-pressed', 'true');
    await button(pages[0], '过牌或弃牌').click();
    await expect(button(pages[0], '过牌或弃牌')).toHaveAttribute('aria-pressed', 'true');
    const flop = await state(1);
    await command(1, { type: 'act', action: 'call', hand: flop.number, seq: flop.hand!.seq });
    const held = await state();
    expect(held.phase).toBe('action_hold');
    expect(held.hand!.last_actions[bb.me]).toBe('过牌');
    expect(held.hand!.clock).toBeNull();
    expect(await turnSounds(mobile)).toBe(1);
    await expect.poll(async () => (await state()).phase).toBe('betting');
    expect(await turnSounds(mobile)).toBe(1);

    await button(mobile, '弃牌').click();
    await expect(button(mirror, '弃牌')).toHaveAttribute('aria-pressed', 'true');
    await mobile.close();
    await mirror.close();
    await expect.poll(async () => (await state()).players.find(p => p.id === bb.me)!.online).toBe(false);
    const turn = await state(1);
    await command(1, { type: 'act', action: 'call', hand: turn.number, seq: turn.hand!.seq });
    const disconnected = await state();
    expect(disconnected.hand!.last_actions[bb.me]).toBe('弃牌');
    expect(disconnected.hand!.clock!.pid).toBe(disconnected.me);
    const reconnect = await contexts[2].newPage();
    await reconnect.goto(root.replace('/api/rooms/', '/r/'));
    await expect(reconnect.locator('.connection')).toHaveClass(/connected/);
    await expect(group(reconnect)).toHaveCount(0);
    expect((await state(2)).pre_action).toBeNull();
    await command(0, { type: 'act', action: 'fold', hand: disconnected.number, seq: disconnected.hand!.seq });
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});

const fixtures = JSON.parse(execFileSync('.venv/bin/python', ['-m', 'backend.tests.presentation_fixture'], { encoding: 'utf8' }));
async function mountFixture(page: Page, recovery = false) {
  const state: Room = structuredClone(fixtures.preflop);
  const delta = Date.now() / 1000 - state.server_time;
  state.server_time += delta;
  state.legal = null;
  state.recovery = recovery;
  state.pre_action = { hand: state.number, street: 0, revision: 1, selected: 'check', options: recovery ? [] : ['check', 'fold', 'check_or_fold'] };
  state.hand!.clock = { pid: state.players.find(p => p.id !== state.me)!.id, initial: 10,
    base_until: state.server_time + 20, until: state.server_time + 30 };
  let socket!: WebSocketRoute;
  await page.route('**/api/rooms/pre-actions-fixture', route => route.fulfill({ json: state }));
  await page.routeWebSocket('**/ws/pre-actions-fixture', ws => { socket = ws; ws.send(JSON.stringify({ type: 'state', state })); });
  await page.goto('/r/pre-actions-fixture');
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  return { state, push: () => socket.send(JSON.stringify({ type: 'state', state })), close: () => socket.close() };
}

test('mobile recovery keeps selection cancellable and offline selection is retained but disabled', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const feed = await mountFixture(page, true);
  await expect(button(page, '过牌')).toBeEnabled();
  await expect(button(page, '弃牌')).toBeDisabled();
  await expect(button(page, '过牌或弃牌')).toBeDisabled();
  await checkMobileLayout(page);
  const commands: any[] = [];
  await page.route('**/commands', async route => {
    commands.push(route.request().postDataJSON());
    feed.state.pre_action!.selected = null;
    feed.state.pre_action!.revision++;
    feed.push();
    await route.fulfill({ json: { ok: true } });
  });
  await button(page, '过牌').click();
  await expect(group(page)).toHaveCount(0);
  expect(commands[0]).toMatchObject({ type: 'pre_action', action: null, revision: 1, street: 0 });
  feed.state.recovery = false;
  feed.state.pre_action!.selected = 'check';
  feed.state.pre_action!.options = ['check', 'fold', 'check_or_fold'];
  feed.push();
  await expect(button(page, '过牌')).toHaveAttribute('aria-pressed', 'true');
  feed.close();
  await expect(page.locator('.connection')).toHaveClass(/offline/);
  await expect(button(page, '过牌')).toHaveAttribute('aria-pressed', 'true');
  await expect(button(page, '过牌')).toBeDisabled();
});

for (const width of [320, 375, 430]) {
  test(`mobile two-row controls remain ordered and on screen at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mountFixture(page);
    await checkMobileLayout(page);
    await page.screenshot({ path: `artifacts/pre-actions/mobile-${width}.png` });
  });
}
