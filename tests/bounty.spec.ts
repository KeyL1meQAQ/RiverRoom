import { test, expect } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import type { Room } from '../src/types';

const fixtures: Record<string, Room> = JSON.parse(execFileSync(
  '.venv/bin/python', ['-m', 'backend.tests.bounty_fixture'], { encoding: 'utf8' },
));

async function mount(page: Page, initial: Room) {
  let state: Room;
  let socket: WebSocketRoute;
  function update(next: Room) {
    const offset = Date.now() / 1000 - next.server_time;
    const timestamps = new Set(['server_time', 'start', 'until', 'base_until', 'deadline', 'reveal_until', 'at', 'offline']);
    state = JSON.parse(JSON.stringify(next), (key, value) => timestamps.has(key) &&
      typeof value === 'number' && value > 0 ? value + offset : value);
  }
  update(initial);
  await page.route('**/api/rooms/bountytest', route => route.fulfill({ json: state }));
  await page.route('**/api/rooms/bountytest/logs**', route => route.fulfill({ json: { logs: state.logs } }));
  await page.routeWebSocket('**/ws/bountytest', ws => {
    socket = ws;
    ws.send(JSON.stringify({ type: 'state', state }));
  });
  await page.goto('/r/bountytest');
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  return {
    push(next: Room) { update(next); socket.send(JSON.stringify({ type: 'state', state })); },
    reconnect(next: Room) { update(next); socket.close({ code: 1012, reason: 'reconnect test' }); },
  };
}

test('create rules are mobile clickable and saved amounts survive toggles and blind edits', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const toggle = page.getByRole('switch', { name: '2–7 杂色奖励' });
  await expect(toggle).not.toBeChecked();
  await page.getByRole('button', { name: '2–7 奖励规则', exact: true }).click();
  await expect(page.locator('dialog')).toContainText('必须独赢两组主池');
  await expect(page.locator('dialog')).toContainText('余额');
  await expect(page).not.toHaveURL(/\/r\//);
  await page.screenshot({ path: 'artifacts/bounty-rules-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await page.getByLabel('大盲', { exact: true }).fill('4');
  await toggle.check();
  await expect(page.getByLabel('每人奖励筹码')).toHaveValue('4');
  await page.getByLabel('每人奖励筹码').fill('9');
  await toggle.uncheck();
  await page.getByLabel('大盲', { exact: true }).fill('8');
  await toggle.check();
  await expect(page.getByLabel('每人奖励筹码')).toHaveValue('9');
  await page.getByRole('button', { name: '创建房间', exact: true }).click();
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  await expect(page.locator('.bounty-tag')).toContainText('每人 9');
  const rid = page.url().split('/r/')[1];
  const state = await (await page.request.get(`/api/rooms/${rid}`)).json();
  expect(state.settings).toMatchObject({ bounty: true, bounty_amount: 9, bb: 8 });
  await page.getByRole('button', { name: '房间设置', exact: true }).first().click();
  await expect(page.getByLabel('每人奖励筹码')).toHaveValue('9');
  await page.getByRole('button', { name: '2–7 奖励规则', exact: true }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(page.getByRole('heading', { name: '房间设置' })).toBeVisible();
  await page.route('**/commands', route => route.fulfill({ status: 400,
    json: { detail: '配置保存失败，请重试' } }));
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.locator('dialog[open] .toast')).toContainText('配置保存失败，请重试');
  expect(errors).toEqual([]);
});

test('playing room can edit only bounty and sends a patch without overriding other settings', async ({ page }) => {
  const state = structuredClone(fixtures.paid_before);
  const { push } = await mount(page, state);
  let sent: Record<string, unknown> | undefined;
  await page.route('**/api/rooms/bountytest/commands', async route => {
    sent = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true } });
  });
  await page.getByRole('button', { name: '房间设置', exact: true }).first().click();
  await expect(page.getByLabel('大盲', { exact: true })).toBeDisabled();
  await expect(page.getByRole('switch', { name: '允许发两次牌' })).toBeDisabled();
  await expect(page.getByLabel('每人奖励筹码')).toBeEnabled();
  await page.getByLabel('每人奖励筹码').fill('12');
  await page.getByRole('button', { name: '保存奖励配置 · 下一手生效' }).click();
  expect(sent?.settings).toEqual({ bounty: true, bounty_amount: 12 });
  state.settings.bounty_amount = 12;
  push(state);
  await expect(page.locator('.bounty-tag')).toContainText('每人 5');
  await expect(page.locator('.bounty-pending')).toContainText('每人 12');
  state.phase = 'straddle';
  push(state);
  await expect(page.locator('.bounty-pending')).toContainText('正在询问 Straddle 的一手保持原规则');
  await page.locator('.bounty-tag').click();
  await expect(page.locator('dialog')).toContainText('不足就付清剩余筹码');
});

for (const key of ['paid', 'zero']) {
  test(`${key} reward uses the same central badge and never replays on refresh or reconnect`, async ({ page }) => {
    const { push, reconnect } = await mount(page, fixtures[key + '_before']);
    const award = fixtures[key].hand!.bounty!;
    await expect(page.locator('.bounty-celebration')).toHaveCount(0);
    push(fixtures[key]);
    const badge = page.locator('.bounty-celebration');
    await expect(badge).toBeVisible();
    await expect(badge.locator('.bounty-total')).toHaveText(`+${award.total}`);
    await expect(badge.locator('.bounty-emblem')).toBeVisible();
    expect(await badge.evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
    // A dialog can still be opened through the nonblocking celebration.
    await page.getByRole('button', { name: '房间身份', exact: true }).click();
    await expect(page.locator('dialog')).toBeVisible();
    await page.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(badge).toHaveCount(0, { timeout: 4500 });
    push(fixtures[key]);
    await expect(badge).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.connection')).toHaveClass(/connected/);
    await expect(badge).toHaveCount(0);
    reconnect(fixtures[key]);
    await expect(page.locator('.connection')).toHaveClass(/offline/);
    await expect(page.locator('.connection')).toHaveClass(/connected/);
    await expect(badge).toHaveCount(0);
  });
}

test('observer sees live reward, persisted payment detail and net results', async ({ page }) => {
  const before = structuredClone(fixtures.paid_before);
  before.me = fixtures.paid_observer.me;
  const { push } = await mount(page, before);
  push(fixtures.paid_observer);
  await expect(page.locator('.bounty-celebration')).toContainText('获得2-7奖励');
  await page.getByRole('button', { name: '日志和统计', exact: true }).click();
  await page.getByRole('button', { name: '手牌', exact: true }).click();
  await page.locator('.history-toggle').click();
  await expect(page.locator('.bounty-history')).toContainText('实收 10');
  await expect(page.locator('.bounty-history p')).toHaveCount(3);
  await expect(page.locator('.history-player').filter({ hasText: fixtures.paid.hand!.bounty!.name })).toContainText('+11');
});

test('badge remains centered with complete amounts on narrow and wide screens and respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { push } = await mount(page, fixtures.paid_before);
  for (const width of [320, 360, 390, 760, 761, 1440]) {
    await page.setViewportSize({ width, height: width < 761 ? 844 : 960 });
    const state = structuredClone(fixtures.paid);
    state.hand!.bounty!.id += `-${width}`;
    state.hand!.bounty!.name = '长昵称测试玩家一二三四五六七八九十';
    state.hand!.bounty!.total = Number.MAX_SAFE_INTEGER;
    push(state);
    const badge = page.locator('.bounty-celebration');
    await expect(badge).toBeVisible();
    await expect(badge.locator('.bounty-total')).toHaveText('+9,007,199,254,740,991');
    const box = (await badge.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - width / 2)).toBeLessThan(1);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(await badge.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
    expect(await badge.locator('.bounty-total').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await badge.locator('.bounty-total').evaluate(el => el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) + 1)).toBe(true);
    await page.screenshot({ path: `artifacts/bounty-${width}.png` });
    // New bottom cards clear the old event immediately, without prolonging the hand.
    push(fixtures.paid_before);
    await expect(badge).toHaveCount(0);
  }
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 960 });
    push(fixtures.paid);
    await expect(page.locator('.bounty-total')).toHaveText('+10');
    await page.screenshot({ path: `artifacts/bounty-paid-${width}.png` });
    push(fixtures.paid_before);
    await expect(page.locator('.bounty-celebration')).toHaveCount(0);
  }
  push(fixtures.zero);
  await expect(page.locator('.bounty-total')).toHaveText('+0');
  await page.screenshot({ path: 'artifacts/bounty-zero.png' });
  await expect(page.locator('.bounty-celebration')).toHaveCount(0, { timeout: 4500 });
});
