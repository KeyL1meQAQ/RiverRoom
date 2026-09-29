import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import type { Room } from '../src/types';

const fixtures = JSON.parse(execFileSync('.venv/bin/python', ['-m', 'backend.tests.presentation_fixture'], { encoding: 'utf8' }));

async function mount(page: Page) {
  const state: Room = structuredClone(fixtures.preflop);
  state.legal = null;
  state.hand!.clock = null;
  state.hand!.action_events = [];
  const time = new Date(state.server_time * 1000);
  await page.clock.install({ time });
  await page.clock.pauseAt(time);
  let socket: WebSocketRoute;
  await page.route('**/api/rooms/impacts', route => route.fulfill({ json: state }));
  await page.routeWebSocket('**/ws/impacts', ws => {
    socket = ws;
    ws.send(JSON.stringify({ type: 'state', state }));
  });
  await page.goto('/r/impacts');
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  return async (item: 'tomato' | 'egg' | 'poop', count: 1 | 10 = 1) => {
    socket.send(JSON.stringify({ type: 'interaction', event: {
      kind: 'throw', id: crypto.randomUUID(), at: state.server_time, item, count,
      from: state.players[0].id, target: state.players[1].id,
    } }));
    await expect(page.locator('.throw-effect')).toHaveCount(count);
  };
}

async function seek(page: Page, ms: number) {
  await page.locator('.throw-effect').evaluateAll((nodes, time) => {
    for (const node of nodes) for (const animation of node.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = time;
    }
  }, ms);
}

for (const mobile of [false, true]) {
  test(`three distinct impacts follow arrival and leave no residue on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const send = await mount(page);
    const colors = new Set<string>();
    for (const item of ['tomato', 'egg', 'poop'] as const) {
      await send(item);
      await seek(page, 400);
      await expect(page.locator('.throw-flight')).toHaveCSS('opacity', '1');
      await expect(page.locator('.throw-impact-core')).toHaveCSS('opacity', '0');
      await seek(page, 790);
      await expect(page.locator('.throw-flight')).toHaveCSS('opacity', '0');
      await expect(page.locator('.throw-impact-core')).toHaveCSS('opacity', '1');
      await expect(page.locator('.throw-impact-particle').first()).toHaveCSS('opacity', '1');
      await expect(page.locator('.throw-impact-shell')).toHaveCount(item === 'egg' ? 4 : 0);
      colors.add(await page.locator('.throw-impact-core').evaluate(node => getComputedStyle(node).backgroundColor));
      const bounds = await page.locator('.throw-impact').boundingBox();
      expect(bounds!.width).toBeCloseTo(mobile ? 60 : 80);
      const target = await page.locator('.throw-flight').evaluate(node => {
        const css = getComputedStyle(node);
        const parent = (node as HTMLElement).offsetParent!.getBoundingClientRect();
        return { x: parent.left + parseFloat(css.left), y: parent.top + parseFloat(css.top) };
      });
      expect(bounds!.x + bounds!.width / 2).toBeCloseTo(target.x, 0);
      expect(bounds!.y + bounds!.height / 2).toBeCloseTo(target.y, 0);
      await expect(page.locator('.throw-impact')).toHaveCSS('pointer-events', 'none');
      await page.screenshot({ path: `artifacts/impact-${item}-${mobile ? 'mobile' : 'desktop'}.png` });
      await seek(page, 1000);
      await expect(page.locator('.throw-impact-core')).toHaveCSS('opacity', '0');
      await expect(page.locator('.throw-impact-particle').first()).toHaveCSS('opacity', '0');
      await page.clock.runFor(1100);
      await expect(page.locator('.throw-effect')).toHaveCount(0);
    }
    expect(colors.size).toBe(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  });
}

test('ten throws impact in sequence, finish within five seconds, and respect local hiding', async ({ page }) => {
  const send = await mount(page);
  await send('tomato', 10);
  await seek(page, 790);
  await expect(page.locator('.throw-impact-core').first()).toHaveCSS('opacity', '1');
  await expect(page.locator('.throw-impact-core').nth(1)).toHaveCSS('opacity', '0');
  await seek(page, 4660);
  await expect(page.locator('.throw-impact-core').last()).toHaveCSS('opacity', '1');
  await seek(page, 4870);
  expect(await page.locator('.throw-impact-core, .throw-impact-particle').evaluateAll(nodes =>
    nodes.every(node => getComputedStyle(node).opacity === '0'))).toBeTruthy();
  await page.clock.runFor(5000);
  await expect(page.locator('.throw-effect')).toHaveCount(0);
  await send('egg', 10);
  await page.getByRole('button', { name: '隐藏互动' }).click();
  await expect(page.locator('.throw-effect')).toHaveCount(0);
});

test('reduced motion suppresses every impact and keeps ten throws staggered', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const send = await mount(page);
  for (const item of ['tomato', 'egg', 'poop'] as const) {
    await send(item, 10);
    await seek(page, 250);
    await expect(page.locator('.throw-flight').first()).toHaveCSS('opacity', '1');
    await expect(page.locator('.throw-flight').nth(1)).toHaveCSS('opacity', '0');
    await seek(page, 790);
    expect(await page.locator('.throw-impact').evaluateAll(nodes => nodes.every(node =>
      getComputedStyle(node).display === 'none' && node.getAnimations({ subtree: true }).length === 0))).toBeTruthy();
    await page.clock.runFor(5000);
    await expect(page.locator('.throw-effect')).toHaveCount(0);
  }
});

test('live mobile throws broadcast impacts to the sender, target and observer', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([0, 1, 2].map(index => browser.newContext({
    viewport: index === 1 ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  })));
  try {
    const created = await contexts[0].request.post(`${baseURL}/api/rooms`, { data: { name: '命中特效验收' } });
    expect(created.ok()).toBeTruthy();
    const root = `${baseURL}/api/rooms/${(await created.json()).id}`;
    const state = async (index = 0): Promise<Room> => (await contexts[index].request.get(root)).json();
    const command = async (index: number, data: object) => {
      const response = await contexts[index].request.post(`${root}/commands`, {
        data: { ...data, command_id: crypto.randomUUID() },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
    };
    for (let index = 0; index < 2; index++) {
      await state(index);
      await command(index, { type: 'request_seat', seat: index * 4, name: index ? '客人' : '房主', amount: 200 });
      if (index) await command(0, { type: 'approve', request: (await state()).requests[0].id });
    }
    const pages = await Promise.all(contexts.map(async context => {
      const page = await context.newPage();
      // Capture actual animation starts so assertions cannot miss the brief impact window.
      await page.addInitScript(() => {
        (window as any).impactStarts = [];
        document.addEventListener('animationstart', event => {
          if (event.animationName === 'throw-impact-burst') {
            (window as any).impactStarts.push((event.target as HTMLElement).parentElement!.className);
          }
        });
      });
      await page.goto(root.replace('/api/rooms/', '/r/'));
      await expect(page.locator('.connection')).toHaveClass(/connected/);
      return page;
    }));
    for (const [index, label] of ['番茄', '鸡蛋', '大便'].entries()) {
      await pages[1].locator('.seat.occupied').filter({ hasText: '房主' }).click();
      await pages[1].getByRole('button', { name: `向 房主 扔一个${label}` }).click();
      for (const page of pages) {
        await expect.poll(() => page.evaluate(() => (window as any).impactStarts.length)).toBe(index + 1);
        await expect(page.locator('.throw-effect')).toHaveCount(0);
      }
    }
    const recorded = await pages[0].evaluate(() => (window as any).impactStarts);
    expect(recorded).toEqual(['throw-impact throw-impact-tomato', 'throw-impact throw-impact-egg', 'throw-impact throw-impact-poop']);
    for (const page of pages.slice(1)) {
      expect(await page.evaluate(() => (window as any).impactStarts)).toEqual(recorded);
    }
    expect((await state()).players.filter(player => player.seat !== null).map(player => player.stack)).toEqual([200, 200]);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
