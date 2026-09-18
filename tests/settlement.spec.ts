import { test, expect } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import type { Room } from '../src/types';

const fixtures: Record<string, Room> = JSON.parse(execFileSync('.venv/bin/python',
  ['-m', 'backend.tests.presentation_fixture'], { encoding: 'utf8' }));
const times = new Set(['server_time', 'start', 'until', 'base_until', 'deadline', 'reveal_until',
  'reveal_start', 'split_at', 'pot_until', 'bounty_at', 'squid_at', 'at', 'offline']);

async function mount(page: Page, initial: Room) {
  await page.clock.install();
  let state: Room, socket: WebSocketRoute;
  const update = async (next: Room) => {
    const offset = await page.evaluate(() => Date.now() / 1000) - next.server_time;
    state = JSON.parse(JSON.stringify(next), (key, value) => times.has(key) && typeof value === 'number' && value > 0 ? value + offset : value);
  };
  await update(initial);
  await page.route('**/api/rooms/settlement', route => route.fulfill({ json: state }));
  await page.route('**/api/rooms/settlement/logs**', route => route.fulfill({ json: { logs: state.logs } }));
  await page.routeWebSocket('**/ws/settlement', ws => { socket = ws; ws.send(JSON.stringify({ type: 'state', state })); });
  await page.goto('/r/settlement');
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  return async (next: Room) => { await update(next); socket.send(JSON.stringify({ type: 'state', state })); };
}

function liveResult() {
  const result = structuredClone(fixtures.side_pots);
  result.server_time = result.hand!.presentation!.start;
  result.me = result.hand!.ids[0];
  const before = structuredClone(result);
  before.hand!.result = null;
  before.hand!.presentation = null;
  before.players.forEach(p => { p.stack = result.hand!.presentation!.accounts[p.id]?.before ?? p.stack; });
  return { before, result };
}

test('pot splits by recipient, lands before balances flip, then opens the full reveal window', async ({ page }) => {
  const { before, result } = liveResult();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const push = await mount(page, before);
  await push(result);
  const plan = result.hand!.presentation!;
  await expect(page.locator('.pot-capsule')).toBeVisible();
  await expect(page.locator('.seat-payout')).toHaveCount(0);
  await expect(page.locator('.reveal-countdown')).toHaveCount(0);
  const events = plan.events.filter(e => e.kind === 'pot');
  expect(events.length).toBe(2);
  await page.clock.runFor(1600);
  await expect(page.locator('.flying-chip.pot')).toHaveCount(events.length);
  for (const event of events) {
    await expect(page.locator(`[data-chip-target="${event.target}"]`)).toHaveAttribute('title', plan.accounts[event.target].before.toLocaleString('zh-CN'));
    await expect(page.locator(`.flying-chip[data-target="${event.target}"]`)).toContainText(event.amount.toLocaleString('zh-CN'));
  }
  const moving = await page.locator('.flying-chip').evaluateAll(nodes => nodes.every(node => node.getAnimations().length === 1));
  expect(moving).toBeTruthy();
  await page.screenshot({ path: 'artifacts/settlement-split-desktop.png' });
  await page.clock.runFor(900);
  await expect(page.locator('.flying-chip')).toHaveCount(0);
  await expect(page.locator('.digit-flaps')).not.toHaveCount(0);
  for (const event of events) {
    await expect(page.locator(`[data-chip-target="${event.target}"]`)).toHaveAttribute('title', (plan.accounts[event.target].before + event.amount).toLocaleString('zh-CN'));
  }
  await page.clock.runFor(500);
  await expect(page.locator('.reveal-countdown')).toContainText('5s');
  await expect(page.locator('.pot-capsule')).toHaveCount(0);
  expect(errors).toEqual([]);
});

function departedResult() {
  const result = structuredClone(fixtures.tie);
  const [payer, recipient, other] = result.players.filter(p => p.seat !== null);
  payer.seat = null; recipient.seat = null;
  payer.stack = 0; recipient.stack = 0;
  const start = result.server_time;
  result.hand!.presentation = {
    start, split_at: start, pot_until: start, bounty_at: start, squid_at: start + 1,
    until: start + 2.76,
    accounts: Object.fromEntries([payer, recipient, other].map(p => [p.id, { pid: p.id, name: p.name, seat: p.seat, before: 100 }])),
    events: [
      { kind: 'squid', source: payer.id, target: recipient.id, amount: 20, start: start + 1, until: start + 1.18 },
      { kind: 'squid', source: payer.id, target: other.id, amount: 30, start: start + 1.18, until: start + 1.36 },
    ],
  };
  result.hand!.reveal_start = start + 2.76; result.hand!.reveal_until = start + 7.76;
  const before = structuredClone(result);
  before.hand!.presentation = null; before.hand!.result = null;
  return { before, result, payer, recipient, other };
}

for (const width of [390, 1440]) test(`departed payer and recipient are simultaneous at ${width}px, transfer balances once`, async ({ page }) => {
  await page.setViewportSize({ width, height: 960 });
  const { before, result, payer, recipient, other } = departedResult();
  const push = await mount(page, before);
  await push(result);
  await page.clock.runFor(1050);
  await expect(page.locator('.departed-account')).toHaveCount(2);
  await expect(page.locator('.departed-transfer')).toHaveCSS('flex-direction', width < 760 ? 'column' : 'row');
  const rects = await page.locator('.departed-account').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().toJSON()));
  if (width < 760) expect(rects[1].top).toBeGreaterThanOrEqual(rects[0].bottom);
  else expect(rects[1].left).toBeGreaterThanOrEqual(rects[0].right);
  await expect(page.locator(`[data-chip-target="${payer.id}"] .flip-number`)).toHaveAttribute('aria-label', '80');
  await expect(page.locator(`[data-chip-target="${recipient.id}"] .flip-number`)).toHaveAttribute('aria-label', '100');
  await page.screenshot({ path: `artifacts/settlement-departed-${width}.png` });
  await page.clock.runFor(160);
  await expect(page.locator('.departed-account')).toHaveCount(1);
  await expect(page.locator('.flying-chip')).toHaveAttribute('data-target', other.id);
  await expect(page.locator(`[data-chip-target="${payer.id}"] .flip-number`)).toHaveAttribute('aria-label', '50');
  await page.clock.runFor(250);
  await expect(page.locator(`[data-chip-target="${other.id}"]`)).toHaveAttribute('title', '130');
  await expect(page.locator('.flying-chip')).toHaveCount(0);
  // A duplicate state still uses the same absolute transfer records, never applies a second debit.
  result.server_time += 1.46;
  await push(result);
  await expect(page.locator(`[data-chip-target="${other.id}"]`)).toHaveAttribute('title', '130');
});

test('first runout highlights only its result, second replaces it, final history retains both', async ({ page }) => {
  const first = structuredClone(fixtures.twice);
  first.hand!.result = null; first.hand!.presentation = null;
  first.hand!.active_board = 0;
  first.hand!.runout_result = first.hand!.showdown_results!.filter(g => g.board === 0);
  first.hand!.boards[1] = [];
  const push = await mount(page, first);
  await expect(page.locator('.board')).toHaveCount(1);
  await expect(page.locator('.board-number')).toHaveText('1');
  await expect(page.locator('.won-main')).not.toHaveCount(0);
  const second = structuredClone(first);
  second.hand!.runout_result = []; second.hand!.active_board = 1;
  second.hand!.boards[1] = fixtures.twice.hand!.boards[1].slice(0, 3);
  await push(second);
  await expect(page.locator('.board-number')).toHaveText('2');
  await expect(page.locator('.boards .playing-card:not(.placeholder)')).toHaveCount(3);
  await expect(page.locator('.won-main')).toHaveCount(0);
  await expect(page.locator('.seat-hand-label [data-board="0"]')).toHaveCount(0);
  await push(fixtures.twice);
  await expect(page.locator('.board')).toHaveCount(1);
  await expect(page.locator('.board-number')).toHaveText('2');
  await expect(page.locator('.boards .playing-card:not(.placeholder)')).toHaveCount(5);
});

test('reload during flight skips missed motion; reduced motion uses static balances', async ({ page }) => {
  const { result } = liveResult();
  result.server_time += 1.9;
  await mount(page, result);
  await expect(page.locator('.flying-chip')).toHaveCount(0);
  await page.clock.runFor(600);
  await expect(page.locator('.flying-chip')).toHaveCount(0);
  const { before, result: next } = liveResult();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // A separate navigation provides a fresh before/result sequence under reduced motion.
  await page.unrouteAll();
  const push = await mount(page, before);
  await push(next);
  await page.clock.runFor(1900);
  await expect(page.locator('.flying-chip')).toHaveCount(0);
  await page.clock.runFor(1200);
  for (const event of next.hand!.presentation!.events) {
    await expect(page.locator(`[data-chip-target="${event.target}"]`)).toHaveAttribute('title',
      (next.hand!.presentation!.accounts[event.target].before + event.amount).toLocaleString('zh-CN'));
  }
});
