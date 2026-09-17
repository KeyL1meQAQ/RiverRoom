import { test, expect } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import type { Room } from '../src/types';

const fixtures: Record<string, Room> = JSON.parse(execFileSync(
  '.venv/bin/python', ['-m', 'backend.tests.presentation_fixture'], { encoding: 'utf8' },
));

async function mount(page: Page, snapshot: Room) {
  let state: Room;
  let socket: WebSocketRoute;
  function update(next: Room) {
    const delta = Date.now() / 1000 - next.server_time;
    const timestamps = new Set(['server_time', 'start', 'until', 'base_until', 'deadline', 'reveal_until', 'at', 'offline']);
    state = JSON.parse(JSON.stringify(next), (key, value) =>
      timestamps.has(key) && typeof value === 'number' && value > 0 ? value + delta : value,
    );
  }
  update(snapshot);
  await page.route('**/api/rooms/achievements', route => route.fulfill({ json: state }));
  await page.routeWebSocket('**/ws/achievements', ws => {
    socket = ws;
    ws.send(JSON.stringify({ type: 'state', state }));
  });
  await page.goto('/r/achievements');
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  return (next: Room) => { update(next); socket.send(JSON.stringify({ type: 'state', state })); };
}

test('badge counts stay integrated, update live, and explain exact totals and partial history', async ({ page }) => {
  const state = structuredClone(fixtures.table_actions);
  state.players.forEach(p => p.achievements = { wins: 0, busts: 0 });
  const me = state.players.find(p => p.id === state.me)!;
  const push = await mount(page, state);
  await expect(page.locator('.achievement-badge')).toHaveCount(0);
  me.achievements = { wins: 99, busts: 1 };
  push(state);
  const own = page.locator('.own-seat');
  await expect(own.locator('.achievement-badge svg text')).toHaveText(['99', '1']);
  me.achievements = { wins: 123456, busts: 100 };
  state.achievement_since = { wins: 3, busts: 1 };
  push(state);
  await expect(own.locator('.achievement-badge svg text')).toHaveText(['99+', '99+']);
  await expect(own.getByRole('img', { name: '赢池 123,456 次', exact: true })).toBeVisible();
  await own.locator('.seat.occupied').click();
  const details = page.getByRole('region', { name: '玩家成就' });
  await expect(details.locator('.wins strong')).toHaveText('123,456 次');
  await expect(details.locator('.busts strong')).toHaveText('100 次');
  await expect(details).toContainText('从第 3 手起统计');
  await expect(details).toContainText('独赢两组主池');
  await expect(details).toContainText('补码前筹码归零');
  await expect(page.locator('.personal-actions').getByRole('button', { name: '补码' })).toBeVisible();
  me.achievements.wins = 123457;
  push(state);
  await expect(details.locator('.wins strong')).toHaveText('123,457 次');
  await page.reload();
  await expect(own.locator('.achievement-badge svg text')).toHaveText(['99+', '99+']);
  me.achievements.wins = 0;
  push(state);
  await expect(own.locator('.achievement-badge')).toHaveCount(1);
  await expect(own.locator('.achievement-badge')).toHaveClass(/busts/);
});

test('nine-seat badges fit cards, player information, and action capsules at all widths', async ({ page }) => {
  const initial = structuredClone(fixtures.table_actions);
  const push = await mount(page, initial);
  for (const [width, height] of [[320, 568], [360, 740], [390, 844], [760, 960], [761, 960], [1440, 960]]) {
    await page.setViewportSize({ width, height });
    for (const scenario of ['table_actions', 'tie', 'nine_twice', 'large_result']) {
      const state = structuredClone(fixtures[scenario === 'large_result' ? 'nine_twice' : scenario]);
      state.players.forEach((p, i) => {
        p.achievements = { wins: 0, busts: 0 };
        p.name = i === 0 ? '长昵称测试玩家十二号' : p.name;
        if (scenario === 'table_actions') { p.online = i % 3 !== 0; p.away = i === 2; }
        if (scenario === 'large_result') p.stack = 123456789;
      });
      if (scenario === 'large_result') state.hand!.result!.forEach(r => { if (r.won) r.won = 987654321; });
      push(state);
      await expect(page.locator('.achievement-badges')).toHaveCount(0);
      const frameHeights = await page.locator('.seat.occupied').evaluateAll(seats => seats.map(seat => seat.getBoundingClientRect().height));
      const cardTopOffsets = await page.locator('.seat-wrap:has(.occupied)').evaluateAll(wraps => wraps.map(wrap =>
        wrap.querySelector('.hole-cards')!.getBoundingClientRect().top - wrap.querySelector('.seat')!.getBoundingClientRect().top));
      state.players.forEach((p, i) => { p.achievements = { wins: i % 2 ? 99 : 100, busts: i % 2 ? 100 : 99 }; });
      push(state);
      await expect(page.locator('.achievement-badges')).toHaveCount(9);
      expect(await page.locator('.seat.occupied').evaluateAll(seats => seats.map(seat => seat.getBoundingClientRect().height))).toEqual(frameHeights);
      expect(await page.locator('.seat-wrap:has(.occupied)').evaluateAll(wraps => wraps.map(wrap =>
        wrap.querySelector('.hole-cards')!.getBoundingClientRect().top - wrap.querySelector('.seat')!.getBoundingClientRect().top)),
      'badges must not lift hole cards relative to their player frame').toEqual(cardTopOffsets);
      await page.screenshot({ path: `artifacts/badges-${scenario}-${width}.png`, fullPage: true });
      const issues = await page.evaluate(() => {
        const visible = (el: Element) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== 'hidden';
        const intersects = (a: DOMRect, b: DOMRect) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
        const blockers = [...document.querySelectorAll('.seat-top, .seat-stack-row, .seat-hand-label, .hole-cards .playing-card, .seat-bet, .dealer, .boards, .pot-label')].filter(visible);
        const visibleBounds = (el: Element) => {
          const rect = el.getBoundingClientRect();
          // Mobile cards already tuck behind their own opaque player frame.
          if (innerWidth <= 760 && el.matches('.hole-cards .playing-card')) {
            const frame = el.closest('.seat-wrap')!.querySelector('.seat')!.getBoundingClientRect();
            return new DOMRect(rect.x, rect.y, rect.width, Math.max(0, Math.min(rect.bottom, frame.top) - rect.top));
          }
          return rect;
        };
        const issues = [...document.querySelectorAll('.achievement-badges')].flatMap(badges => {
          const bounds = badges.getBoundingClientRect();
          const frame = badges.closest('.seat-wrap')!.querySelector('.seat')!.getBoundingClientRect();
          const owner = badges.closest('.seat-wrap')!.className;
          const badgeRects = [...badges.children].map(badge => badge.getBoundingClientRect());
          const separated = badgeRects.every((rect, i) => !i || rect.left - badgeRects[i - 1].right >= 2);
          const compact = badgeRects.every(rect => rect.width <= (innerWidth <= 760 ? 14 : 19) && rect.height <= (innerWidth <= 760 ? 14 : 18));
          const hits = blockers.filter(blocker => intersects(bounds, visibleBounds(blocker)));
          const digits = [...badges.querySelectorAll('text')].filter(text => {
            const r = text.getBoundingClientRect();
            const svg = text.closest('svg')!.getBoundingClientRect();
            return r.left < svg.left || r.right > svg.right || r.top < svg.top || r.bottom > svg.bottom;
          });
          return [...hits.map(hit => `${owner}: badge overlaps ${hit.className}`),
            ...(!separated ? [`${owner}: badges must have a visible gap`] : []),
            ...(!compact ? [`${owner}: badges exceed compact size`] : []),
            ...(bounds.top >= frame.top || bounds.bottom <= frame.top || bounds.bottom > frame.top + 6
              ? [`${owner}: badge does not hang over the top edge`] : []),
            ...digits.map(() => `${owner}: count overflows badge`),
            ...(bounds.right > innerWidth || bounds.left < 0 ? [`${owner}: outside viewport`] : [])];
        });
        const frames = [...document.querySelectorAll('.seat.occupied')];
        const cards = [...document.querySelectorAll('.hole-cards .playing-card')];
        for (const card of cards) {
          const bounds = visibleBounds(card);
          if (bounds.left < 0 || bounds.right > innerWidth) issues.push(`${card.closest('.seat-wrap')!.className}: cards outside viewport`);
          if (innerWidth <= 760) {
            const frame = card.closest('.seat-wrap')!.querySelector('.seat')!.getBoundingClientRect();
            if (bounds.left < frame.left || bounds.right > frame.right) issues.push(`${card.closest('.seat-wrap')!.className}: cards exceed player frame horizontally`);
          }
        }
        for (const frame of frames) {
          const bounds = frame.getBoundingClientRect();
          const wrap = frame.closest('.seat-wrap');
          for (const other of [...frames, ...cards]) {
            if (other.closest('.seat-wrap') !== wrap && intersects(bounds, visibleBounds(other))) {
              issues.push(`${wrap!.className}: player frame overlaps ${other.closest('.seat-wrap')!.className}`);
            }
          }
        }
        return issues;
      });
      expect.soft(issues, `${scenario} at ${width}`).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    }
  }
});
