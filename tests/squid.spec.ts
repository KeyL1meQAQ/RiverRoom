import { test, expect } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import type { Room } from '../src/types';

const fixtures: Record<string, Room> = JSON.parse(execFileSync('.venv/bin/python',
  ['-m', 'backend.tests.squid_fixture'], { encoding: 'utf8' }));

async function mount(page: Page, initial: Room) {
  let state: Room;
  let socket: WebSocketRoute;
  function update(next: Room) {
    const offset = Date.now() / 1000 - next.server_time;
    const times = new Set(['server_time', 'start', 'until', 'base_until', 'deadline', 'reveal_until', 'reveal_start', 'split_at', 'pot_until', 'bounty_at', 'squid_at', 'at', 'finished_at', 'offline']);
    state = JSON.parse(JSON.stringify(next), (k, v) => times.has(k) && typeof v === 'number' && v > 0 ? v + offset : v);
  }
  update(initial);
  await page.route('**/api/rooms/squidtest', r => r.fulfill({ json: state }));
  await page.route('**/api/rooms/squidtest/logs**', r => r.fulfill({ json: { logs: state.logs } }));
  await page.routeWebSocket('**/ws/squidtest', ws => { socket = ws; ws.send(JSON.stringify({ type: 'state', state })); });
  await page.goto('/r/squidtest');
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  return { push(next: Room) { update(next); socket.send(JSON.stringify({ type: 'state', state })); },
    reconnect() { socket.close({ code: 1012, reason: 'reconnect test' }); } };
}

test('create persists squid price, optional reveal, and fixed-price defaults', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const toggle = page.getByRole('switch', { name: '鱿鱼游戏', exact: true });
  await expect(toggle).not.toBeChecked();
  await page.getByRole('button', { name: '鱿鱼游戏规则', exact: true }).click();
  await expect(page.locator('dialog')).toContainText('只看第一组主池');
  await expect(page.locator('dialog')).toContainText('离座、AWAY、断线不免除本轮责任');
  await page.screenshot({ path: 'artifacts/squid-rules-390.png', fullPage: true });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await page.getByLabel('大盲', { exact: true }).fill('4');
  await toggle.check();
  await expect(page.getByLabel('鱿鱼价格 / 筹码')).toHaveValue('4');
  await page.getByLabel('鱿鱼价格 / 筹码').fill('20');
  await expect(page.getByRole('switch', { name: '获得鱿鱼时自动亮出两张底牌' })).not.toBeChecked();
  await page.getByRole('switch', { name: '获得鱿鱼时自动亮出两张底牌' }).check();
  await toggle.uncheck();
  await page.getByLabel('大盲', { exact: true }).fill('8');
  await toggle.check();
  await expect(page.getByLabel('鱿鱼价格 / 筹码')).toHaveValue('20');
  await page.getByRole('button', { name: '创建房间', exact: true }).click();
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  const rid = page.url().split('/r/')[1];
  expect((await (await page.request.get(`/api/rooms/${rid}`)).json()).settings).toMatchObject({ squid: true, squid_amount: 20, squid_reveal: true });
  await expect(page.locator('.squid-tag')).toContainText('每个 20');
});

test('midhand settings send squid fields and show effective and pending rules', async ({ page }) => {
  const state = structuredClone(fixtures.before);
  const { push } = await mount(page, state);
  let sent: Record<string, unknown> | undefined;
  await page.route('**/commands', r => { sent = r.request().postDataJSON(); return r.fulfill({ json: { ok: true } }); });
  await page.getByRole('button', { name: '房间设置', exact: true }).first().click();
  await expect(page.getByLabel('大盲', { exact: true })).toBeDisabled();
  await page.getByLabel('鱿鱼价格 / 筹码').fill('25');
  await page.getByRole('switch', { name: '获得鱿鱼时自动亮出两张底牌' }).check();
  await page.getByRole('button', { name: '鱿鱼游戏规则', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await page.getByRole('button', { name: '保存奖励配置 · 下一手生效' }).click();
  expect(sent?.settings).toEqual({ bounty: false, bounty_amount: null, squid: true, squid_amount: 25, squid_reveal: true });
  state.settings.squid_amount = 25;
  state.settings.squid_reveal = true;
  push(state);
  await expect(page.locator('.squid-tag')).toContainText('每个 10');
  await expect(page.locator('.squid-status')).toContainText('下一手开启 · 单价 25 · 自动亮牌');
});

test('held funds and return without duplicate buyin are clear on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await mount(page, fixtures.held);
  await page.locator('.squid-tag').click();
  await expect(page.locator('.squid-details')).toContainText('已离座 · 待结算筹码');
  await page.screenshot({ path: 'artifacts/squid-held-320.png', fullPage: true });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '入座 1 号位', exact: true }).click();
  await expect(page.getByLabel('额外买入筹码（可为 0）')).toHaveValue('0');
  await expect(page.locator('dialog')).toContainText('本轮鱿鱼标记和责任保留');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('round payout includes departed players, and notification never replays on refresh or reconnect', async ({ page }) => {
  const { push, reconnect } = await mount(page, fixtures.last_before);
  push(fixtures.settled);
  await expect(page.locator('.squid-notice')).toContainText('第 1 轮已结算');
  await page.locator('.squid-tag').click();
  await expect(page.locator('.squid-settlement')).toContainText(fixtures.settled.players.find(p => p.id === fixtures.settled.me)!.name);
  await expect(page.locator('.squid-settlement')).toContainText('实付 20 / 应付 20');
  await page.screenshot({ path: 'artifacts/squid-settlement.png', fullPage: true });
  await page.reload();
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  await expect(page.locator('.squid-notice')).toHaveCount(0);
  reconnect();
  await expect(page.locator('.connection')).not.toHaveClass(/connected/);
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  await expect(page.locator('.squid-notice')).toHaveCount(0);
});

test('real two-browser hand awards a squid and settles without an extra buyin', async ({ browser, baseURL }) => {
  const host = await browser.newContext();
  const guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
  try {
    const a = await host.newPage(); const b = await guest.newPage();
    await a.goto(baseURL!);
    await a.getByRole('switch', { name: '鱿鱼游戏', exact: true }).check();
    await a.getByLabel('鱿鱼价格 / 筹码').fill('10');
    await a.getByRole('button', { name: '创建房间', exact: true }).click();
    await expect(a.locator('.connection')).toHaveClass(/connected/);
    await a.getByRole('button', { name: '入座 1 号位', exact: true }).click();
    await a.getByLabel('昵称', { exact: true }).fill('房主');
    await a.getByLabel('买入筹码', { exact: true }).fill('100');
    await a.getByRole('button', { name: '确认入座', exact: true }).click();
    await b.goto(a.url());
    await expect(b.locator('.connection')).toHaveClass(/connected/);
    await b.getByRole('button', { name: '入座 5 号位', exact: true }).click();
    await b.getByLabel('昵称', { exact: true }).fill('客人');
    await b.getByLabel('买入筹码', { exact: true }).fill('100');
    await b.getByRole('button', { name: '提交入座申请' }).click();
    await a.getByRole('button', { name: '日志和统计', exact: true }).click();
    await a.getByRole('button', { name: '管理', exact: true }).click();
    await a.getByRole('button', { name: '批准 客人', exact: true }).click();
    await a.locator('.side-panel').getByRole('button', { name: '关闭侧栏', exact: true }).click();
    await a.getByRole('button', { name: '开始游戏', exact: true }).click();
    await expect(a.locator('.achievement-badge.squid')).toHaveCount(2);
    await a.getByRole('button', { name: '弃牌', exact: true }).click();
    await expect(b.locator('.squid-notice')).toContainText('第 1 轮已结算');
    const rid = a.url().split('/r/')[1];
    const state = await (await a.request.get(`/api/rooms/${rid}`)).json() as Room;
    expect(state.squid_history![0].payments[0].amount).toBe(10);
    expect(state.players.reduce((s, p) => s + p.holding, 0)).toBe(200);
    expect(state.ledger.filter(e => e.kind === 'buyin')).toHaveLength(2);
  } finally { await host.close(); await guest.close(); }
});
