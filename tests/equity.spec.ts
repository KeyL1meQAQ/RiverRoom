import { expect, test } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import type { Room } from '../src/types';

const fixtures: Record<string, Room> = JSON.parse(execFileSync('.venv/bin/python',
  ['-m', 'backend.tests.equity_fixture'], { encoding: 'utf8' }));
const times = new Set(['server_time', 'start', 'until', 'base_until', 'deadline', 'reveal_until',
  'reveal_start', 'split_at', 'pot_until', 'bounty_at', 'squid_at', 'at', 'offline']);

async function mount(page: Page, initial: Room) {
  const date = new Date('2026-09-19T00:00:00Z');
  await page.clock.install({ time: date });
  await page.clock.pauseAt(date);
  let state: Room, socket: WebSocketRoute;
  const update = async (next: Room) => {
    const offset = await page.evaluate(() => Date.now() / 1000) - next.server_time;
    state = JSON.parse(JSON.stringify(next), (key, value) => times.has(key) && typeof value === 'number' && value > 0 ? value + offset : value);
  };
  await update(initial);
  await page.route('**/api/rooms/equity', route => route.fulfill({ json: state }));
  await page.route('**/api/rooms/equity/logs**', route => route.fulfill({ json: { logs: state.logs } }));
  await page.routeWebSocket('**/ws/equity', ws => { socket = ws; ws.send(JSON.stringify({ type: 'state', state })); });
  await page.goto('/r/equity');
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  return {
    async push(next: Room) { await update(next); socket.send(JSON.stringify({ type: 'state', state })); },
    async reconnect(next: Room) { await update(next); socket.close({ code: 1012, reason: 'test reconnect' }); },
  };
}

function ownProbability(snapshot: Room, count: number) {
  const frame = snapshot.hand!.runout_equity!.frames[String(count)];
  return frame.wins[snapshot.me] * 100 / frame.total;
}

test('vote hides cards and odds; each visible card selects its own exact prefix, river hides', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const { push } = await mount(page, fixtures.vote);
  await expect(page.locator('.runout-equity')).toHaveCount(0);
  await expect(page.locator('.hole-cards .playing-card:not(.back)')).toHaveCount(2);
  await push(fixtures.reveal);
  await expect(page.locator('.runout-equity')).toHaveCount(9);
  await expect(page.locator('.hole-cards .playing-card:not(.back)')).toHaveCount(18);
  await expect(page.locator('.boards .playing-card:not(.placeholder)')).toHaveCount(0);
  await expect(page.locator('.own-seat .runout-equity')).toHaveAttribute('data-value', String(ownProbability(fixtures.reveal, 0)));
  // Real payload already includes all three flop cards; only visible prefixes count.
  await page.clock.runFor(800);
  for (let count = 1; count <= 3; count++) {
    await expect(page.locator('.boards .playing-card:not(.placeholder)')).toHaveCount(count);
    await expect(page.locator('.own-seat .runout-equity')).toHaveAttribute('data-value', String(ownProbability(fixtures.flop, count)));
    if (count < 3) await page.clock.runFor(250);
  }
  await push(fixtures.turn);
  await expect(page.locator('.boards .playing-card:not(.placeholder)')).toHaveCount(4);
  await expect(page.locator('.own-seat .runout-equity')).toHaveAttribute('data-value', String(ownProbability(fixtures.turn, 4)));
  await push(fixtures.river);
  await expect(page.locator('.boards .playing-card:not(.placeholder)')).toHaveCount(5);
  await expect(page.locator('.runout-equity')).toHaveCount(0);
  await push(fixtures.first_result);
  await expect(page.locator('.runout-equity')).toHaveCount(0);
  await push(fixtures.second);
  await expect(page.locator('.board-number')).toHaveText('2');
  await expect(page.locator('.runout-equity')).toHaveCount(9);
  await expect(page.locator('.own-seat .runout-equity')).toHaveAttribute('data-value', String(ownProbability(fixtures.second, 0)));
  await push(fixtures.finished);
  await expect(page.locator('.runout-equity')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('completed flop and turn keep their odds throughout the server reading pause and reload', async ({ page }) => {
  const flop = structuredClone(fixtures.flop);
  flop.server_time = flop.hand!.deal!.start + .75;
  expect(flop.deadline! - flop.server_time).toBeCloseTo(1.5);
  const { push } = await mount(page, flop);
  await page.clock.runFor(1499);
  await expect(page.locator('.boards .playing-card:not(.placeholder)')).toHaveCount(3);
  await expect(page.locator('.own-seat .runout-equity')).toHaveAttribute('data-value', String(ownProbability(flop, 3)));
  const turn = structuredClone(fixtures.turn);
  turn.server_time = turn.hand!.deal!.start + .25;
  expect(turn.deadline! - turn.server_time).toBeCloseTo(1.5);
  await push(turn);
  await page.reload();
  await page.clock.runFor(1499);
  await expect(page.locator('.boards .playing-card:not(.placeholder)')).toHaveCount(4);
  await expect(page.locator('.own-seat .runout-equity')).toHaveAttribute('data-value', String(ownProbability(turn, 4)));
  await expect(page.locator('.boards .card-dealt')).toHaveCount(0);
  await push(fixtures.river);
  await expect(page.locator('.boards .playing-card:not(.placeholder)')).toHaveCount(5);
  await expect(page.locator('.runout-equity')).toHaveCount(0);
});

test('card faces, backs and placeholders retain 5:7 across width and height breakpoints', async ({ page }) => {
  const { push } = await mount(page, fixtures.vote);
  const sizes = [[320, 568], [340, 740], [360, 740], [380, 844], [390, 844],
    [760, 900], [761, 800], [1024, 800], [1100, 850], [1101, 850],
    [1366, 768], [1440, 850], [1440, 851], [1440, 960], [1920, 960], [2048, 1024]];
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    for (const state of [fixtures.vote, fixtures.river]) {
      await push(state);
      await expect(page.locator('.boards .playing-card')).toHaveCount(5);
      const cards = await page.locator('.playing-card').evaluateAll(nodes => nodes.map(node => {
        // CSS dimensions exclude the intentional fan rotation and winner lift.
        const style = getComputedStyle(node);
        return { kind: node.className, width: parseFloat(style.width), height: parseFloat(style.height) };
      }));
      expect(cards.length).toBeGreaterThanOrEqual(23);
      for (const card of cards) {
        expect(Math.abs(card.width / card.height - 5 / 7), `${width}x${height}: ${JSON.stringify(card)}`).toBeLessThan(.001);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    }
    if ([320, 390, 1366, 1920].includes(width)) {
      await page.screenshot({ path: `artifacts/cards-ratio-${width}.png`, fullPage: true });
    }
  }
});

function withCounts(counts: number[], total = 10000) {
  const snapshot = structuredClone(fixtures.reveal);
  snapshot.hand!.deal!.start = snapshot.server_time + 20;
  snapshot.hand!.deal!.until = snapshot.server_time + 21;
  const ids = snapshot.hand!.ids;
  snapshot.hand!.runout_equity!.frames['0'] = {
    total, wins: Object.fromEntries(ids.map((pid, i) => [pid, counts[i] || 0])),
  };
  return snapshot;
}

test('exact ranks set green/red/neutral, ties and boundary labels survive rounding and motion', async ({ page }) => {
  const state = withCounts([5001, 4999]);
  const { push } = await mount(page, state);
  await expect(page.locator('.runout-equity.leading')).toHaveCount(1);
  await expect(page.locator('.runout-equity.trailing')).toHaveCount(8);
  await expect(page.locator('.runout-equity.leading')).toHaveText('50%');
  await expect(page.locator('.runout-equity.trailing').filter({ hasText: '50%' })).toHaveCount(1);
  await push(withCounts([4900, 4900, 200]));
  await expect(page.locator('.runout-equity.leading')).toHaveCount(2);
  await expect(page.locator('.runout-equity.trailing')).toHaveCount(7);
  await push(withCounts([0]));
  await expect(page.locator('.runout-equity.tied')).toHaveCount(9);
  await expect(page.locator('.runout-equity').filter({ hasText: /^0%$/ })).toHaveCount(9);
  await push(withCounts(Array(9).fill(100), 900));
  await expect(page.locator('.runout-equity.tied')).toHaveCount(9);
  await page.clock.runFor(250);
  await expect(page.locator('.runout-equity').first()).toHaveText('11%');
  await push(withCounts([9999, 1]));
  await expect(page.locator('.runout-equity.leading')).toHaveText('>99%');
  await expect(page.locator('.runout-equity').filter({ hasText: '<1%' })).toHaveCount(1);
  await push(withCounts([10000]));
  await expect(page.locator('.runout-equity.leading')).toHaveText('100%');
  await expect(page.locator('.runout-equity.trailing').filter({ hasText: /^0%$/ })).toHaveCount(8);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await push(withCounts([2000, 8000]));
  await expect(page.locator('.runout-equity.leading')).toHaveText('80%');
  await expect(page.locator('.runout-equity.leading')).toHaveCSS('background-color', 'rgb(35, 114, 71)');
  await expect(page.locator('.runout-equity.trailing').first()).toHaveCSS('background-color', 'rgb(170, 56, 59)');
});

test('reload and reconnect start at the visible current probability without replay', async ({ page }) => {
  const state = structuredClone(fixtures.flop);
  state.server_time += .3; // Two visible flop cards on entry.
  const { reconnect } = await mount(page, state);
  const badge = page.locator('.own-seat .runout-equity');
  const expected = String(ownProbability(state, 2));
  await expect(page.locator('.boards .playing-card:not(.placeholder)')).toHaveCount(2);
  await expect(badge).toHaveAttribute('data-value', expected);
  const label = await badge.innerText();
  await page.reload();
  await expect(badge).toHaveText(label);
  const next = withCounts([2000, 8000]);
  await reconnect(next);
  await page.clock.runFor(1500);
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  await expect(page.locator('.runout-equity.leading')).toHaveText('80%');
});

for (const width of [1440, 390, 320]) test(`nine-player odds overlap only the card edge at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 960 });
  const { push } = await mount(page, fixtures.reveal);
  await expect(page.locator('.runout-equity')).toHaveCount(9);
  const geometry = await page.locator('.hole-cards:has(.runout-equity)').evaluateAll(groups => groups.map(group => {
    const box = group.getBoundingClientRect();
    const badge = group.querySelector('.runout-equity')!.getBoundingClientRect();
    const overlap = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) > Math.max(a.left, b.left)
      && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
    const indices = [...group.querySelectorAll('.playing-card > b, .playing-card > span')];
    return { top: badge.top < box.top, right: badge.right > box.right,
      overlaps: [...group.querySelectorAll('.playing-card')].some(card => overlap(card.getBoundingClientRect(), badge)),
      blocksIndex: indices.some(index => overlap(index.getBoundingClientRect(), badge)),
      transformed: [...group.querySelectorAll(':scope > .playing-card')].map(card => getComputedStyle(card).transform),
      badgeTransform: getComputedStyle(group.querySelector('.runout-equity')!).transform };
  }));
  for (const item of geometry) {
    expect(item.top && item.right && item.overlaps).toBeTruthy();
    expect(item.blocksIndex).toBeFalsy();
    expect(item.transformed.every(value => value !== 'none')).toBeTruthy();
    expect(item.badgeTransform).toBe('none');
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `artifacts/runout-equity-${width}.png`, fullPage: true });
  const wide = withCounts(fixtures.reveal.hand!.ids.map(pid => pid === fixtures.reveal.me ? 10000 : 0));
  wide.players.find(p => p.id === wide.me)!.cards = ['Tc', 'Td'];
  wide.hand!.cards[wide.me] = ['Tc', 'Td'];
  await push(wide);
  await expect(page.locator('.own-seat .runout-equity')).toHaveText('100%');
  const blocksOwnIndex = await page.locator('.own-seat .hole-cards').evaluate(group => {
    const badge = group.querySelector('.runout-equity')!.getBoundingClientRect();
    return [...group.querySelectorAll('.playing-card > b, .playing-card > span')].some(index => {
      const box = index.getBoundingClientRect();
      return Math.min(box.right, badge.right) > Math.max(box.left, badge.left)
        && Math.min(box.bottom, badge.bottom) > Math.max(box.top, badge.top);
    });
  });
  expect(blocksOwnIndex).toBeFalsy();
  await push(fixtures.observer);
  await expect(page.locator('.runout-equity')).toHaveCount(9);
  await expect(page.locator('.own-seat .runout-equity')).toHaveCount(0);
});

test('live room broadcasts vote privacy, identical odds and both runouts to players and observer', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext()));
  let root = '';
  const state = async (i = 0): Promise<Room> => (await contexts[i].request.get(root)).json();
  const command = async (i: number, body: object) => {
    const response = await contexts[i].request.post(`${root}/commands`, { data: { ...body, command_id: crypto.randomUUID() } });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  try {
    const created = await contexts[0].request.post(`${baseURL}/api/rooms`, { data: { name: '跑马概率验收', settings: { twice: true } } });
    expect(created.ok()).toBeTruthy();
    const rid = (await created.json()).id;
    root = `${baseURL}/api/rooms/${rid}`;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push((await state(i)).me);
      if (i === 2) continue;
      await command(i, { type: 'request_seat', seat: i, name: `跑马玩家${i}`, amount: 100 });
      if (i) await command(0, { type: 'approve', request: (await state()).requests[0].id });
    }
    const pages = await Promise.all(contexts.map(async context => {
      const page = await context.newPage();
      await page.goto(`${baseURL}/r/${rid}`);
      await expect(page.locator('.connection')).toHaveClass(/connected/);
      return page;
    }));
    await command(0, { type: 'start' });
    await command(0, { type: 'pause' });
    for (let turn = 0; turn < 2; turn++) {
      const s = await state();
      const actor = ids.indexOf(s.hand!.clock!.pid);
      await command(actor, { type: 'act', action: turn === 0 ? 'raise' : 'call', amount: 100, hand: s.number, seq: s.hand!.seq });
    }
    expect((await state()).phase).toBe('runout');
    expect((await state(2)).hand!.cards).toEqual({});
    for (const page of pages) await expect(page.locator('.runout-equity')).toHaveCount(0);
    await command(0, { type: 'vote', value: true });
    expect((await state(2)).hand!.cards).toEqual({});
    await command(1, { type: 'vote', value: true });
    for (const page of pages) await expect(page.locator('.runout-equity')).toHaveCount(2);
    const views = await Promise.all([0, 1, 2].map(state));
    expect(views[0].hand!.runout_equity).toEqual(views[1].hand!.runout_equity);
    expect(views[0].hand!.runout_equity).toEqual(views[2].hand!.runout_equity);
    expect(Object.keys(views[2].hand!.cards).sort()).toEqual(ids.slice(0, 2).sort());
    await expect(pages[2].locator('.board-number')).toHaveText('2', { timeout: 10000 });
    await expect.poll(async () => (await state()).hand!.result, { timeout: 15000 }).not.toBeNull();
    for (const page of pages) await expect(page.locator('.runout-equity')).toHaveCount(0);
  } finally {
    if (root) await command(0, { type: 'end' });
    await Promise.all(contexts.map(context => context.close()));
  }
});
