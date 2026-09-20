import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

async function command(page: Page, rid: string, body: Record<string, unknown>) {
  const response = await page.request.post(`/api/rooms/${rid}/commands`, {
    data: { ...body, command_id: randomUUID() },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function state(page: Page, rid: string) {
  return (await page.request.get(`/api/rooms/${rid}`)).json();
}

test('short deck rules and mutual exclusion fit desktop and mobile creation', async ({ page }) => {
  for (const width of [320, 360, 390, 760, 761, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const mode = page.getByRole('switch', { name: '短牌模式', exact: true });
    const bounty = page.getByRole('switch', { name: '2–7 杂色奖励', exact: true });
    await expect(mode).not.toBeChecked();
    await bounty.check();
    await page.getByLabel('每人奖励筹码').fill('17');
    const info = page.getByRole('button', { name: '短牌规则', exact: true });
    const [a, b] = await Promise.all([info.boundingBox(), mode.boundingBox()]);
    expect(a!.x + a!.width).toBeLessThanOrEqual(b!.x);
    expect(Math.abs(a!.y + a!.height / 2 - b!.y - b!.height / 2)).toBeLessThanOrEqual(1);
    await info.click();
    await expect(page.locator('dialog')).toContainText('同花大于葫芦，顺子大于三条');
    await expect(page.locator('dialog')).toContainText('A-6-7-8-9');
    await expect(page).not.toHaveURL(/\/r\//);
    await page.screenshot({ path: `artifacts/short-deck-rules-${width}.png`, fullPage: true, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(mode).not.toBeChecked();
    await page.getByText('短牌模式', { exact: true }).click();
    await expect(mode).toBeChecked();
    await expect(bounty).not.toBeChecked();
    await expect(bounty).toBeDisabled();
    await expect(page.getByRole('status')).toContainText('2–7 奖励自动关闭');
    await page.screenshot({ path: `artifacts/short-deck-create-${width}.png`, fullPage: true, animations: 'disabled' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await mode.uncheck();
    await expect(bounty).toBeEnabled();
    await expect(bounty).not.toBeChecked();
    await bounty.check();
    await expect(page.getByLabel('每人奖励筹码')).toHaveValue('17');
  }
});

test('create short deck and preserve mode across reload and nested rule dialogs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('switch', { name: '短牌模式', exact: true }).check();
  await page.getByRole('button', { name: '创建房间', exact: true }).click();
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  const rid = page.url().split('/r/')[1];
  expect((await state(page, rid)).settings).toMatchObject({ short_deck: true, bounty: false });
  await page.reload();
  await expect(page.locator('.short-deck-status')).toContainText('模式：短牌');
  await page.getByRole('button', { name: '房间设置', exact: true }).first().click();
  await expect(page.getByRole('switch', { name: '短牌模式', exact: true })).toBeChecked();
  await page.getByRole('button', { name: '短牌规则', exact: true }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await page.getByRole('switch', { name: '短牌模式', exact: true }).uncheck();
  await page.route('**/commands', route => route.fulfill({ status: 400, json: { detail: '测试保存失败' } }));
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.locator('dialog[open] .toast')).toContainText('测试保存失败');
  expect((await state(page, rid)).settings.short_deck).toBe(true);
  await page.unroute('**/commands');
  await page.keyboard.press('Escape');
  await command(page, rid, { type: 'end' });
});

test('live owner switches both ways while players and observer keep current hand mode', async ({ browser, baseURL }) => {
  const contexts = await Promise.all([1440, 390, 320].map(width => browser.newContext({
    baseURL, viewport: { width, height: 900 },
  })));
  const [owner, guest, observer] = await Promise.all(contexts.map(context => context.newPage()));
  const errors: string[] = [];
  for (const page of [owner, guest, observer]) page.on('pageerror', error => errors.push(error.message));
  try {
    await owner.goto('/');
    await owner.getByLabel('房间名称').fill('短牌与普通模式切换测试房间');
    await owner.getByRole('switch', { name: '允许发两次牌' }).check();
    await owner.getByRole('switch', { name: '允许 UTG Straddle' }).check();
    await owner.getByRole('switch', { name: '2–7 杂色奖励', exact: true }).check();
    await owner.getByLabel('每人奖励筹码').fill('9');
    await owner.getByRole('button', { name: '创建房间', exact: true }).click();
    await expect(owner.locator('.connection')).toHaveClass(/connected/);
    const rid = owner.url().split('/r/')[1];
    await Promise.all([guest.goto(`/r/${rid}`), observer.goto(`/r/${rid}`)]);
    await expect(guest.locator('.connection')).toHaveClass(/connected/);
    await expect(observer.locator('.connection')).toHaveClass(/connected/);
    await command(owner, rid, { type: 'request_seat', seat: 0, name: '房主', amount: 100 });
    await command(guest, rid, { type: 'request_seat', seat: 1, name: '玩家', amount: 100 });
    await command(owner, rid, { type: 'approve', request: (await state(owner, rid)).requests[0].id });
    await command(owner, rid, { type: 'start' });
    const initial = await state(owner, rid);
    const ownerId = initial.me;
    await owner.getByRole('button', { name: '房间设置', exact: true }).first().click();
    await expect(owner.getByLabel('大盲', { exact: true })).toBeDisabled();
    await owner.getByRole('switch', { name: '短牌模式', exact: true }).check();
    await expect(owner.getByRole('switch', { name: '2–7 杂色奖励', exact: true })).toBeDisabled();
    await owner.getByRole('button', { name: '保存规则配置 · 下一手生效' }).click();
    for (const page of [owner, guest, observer]) {
      await expect(page.locator('.short-deck-status')).toContainText('本手：普通');
      await expect(page.locator('.short-deck-status')).toContainText('下一手：短牌');
    }
    const pending = await state(owner, rid);
    expect(pending.settings).toMatchObject({ short_deck: true, bounty: false, bounty_amount: 9 });
    expect(pending.hand.short_deck).toBe(false);
    expect(pending.hand.bounty_rule.enabled).toBe(true);
    await observer.getByRole('button', { name: '当前模式：普通，查看短牌规则' }).click();
    await expect(observer.locator('dialog')).toContainText('36 张牌');
    await observer.keyboard.press('Escape');
    for (const [page, width] of [[owner, 1440], [guest, 390], [observer, 320]] as const) {
      const [info, mode] = await Promise.all([
        page.locator('.room-info').boundingBox(), page.locator('.short-deck-tag').boundingBox(),
      ]);
      expect(mode!.y).toBeGreaterThanOrEqual(info!.y);
      expect(mode!.y + mode!.height).toBeLessThanOrEqual(info!.y + info!.height);
      await page.screenshot({ path: `artifacts/short-deck-pending-${width}.png`, fullPage: true, animations: 'disabled' });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    }
    async function foldCurrent() {
      const current = await state(owner, rid);
      await command(current.hand.clock.pid === ownerId ? owner : guest, rid,
        { type: 'act', hand: current.hand.number, seq: current.hand.seq, action: 'fold' });
    }
    await foldCurrent();
    await expect.poll(async () => (await state(owner, rid)).hand.number, { timeout: 15000 }).toBe(2);
    const short = await state(owner, rid);
    expect(short.hand.short_deck).toBe(true);
    expect(short.hand.bounty_rule.enabled).toBe(false);
    expect(short.hand.cards[ownerId].every((card: string) => '6789TJQKA'.includes(card[0]))).toBe(true);
    await expect(guest.locator('.short-deck-status')).toHaveText(/本手：短牌/);
    await owner.getByRole('button', { name: '房间设置', exact: true }).first().click();
    await owner.getByRole('switch', { name: '短牌模式', exact: true }).uncheck();
    await expect(owner.getByRole('switch', { name: '2–7 杂色奖励', exact: true })).not.toBeChecked();
    await owner.getByRole('button', { name: '保存规则配置 · 下一手生效' }).click();
    await expect(observer.locator('.short-deck-status')).toContainText('下一手：普通');
    await foldCurrent();
    await expect.poll(async () => (await state(owner, rid)).hand.number, { timeout: 15000 }).toBe(3);
    const ordinary = await state(owner, rid);
    expect(ordinary.hand.short_deck).toBe(false);
    expect(ordinary.settings.bounty).toBe(false);
    expect(ordinary.history.map((hand: { short_deck: boolean }) => hand.short_deck)).toEqual([false, true]);
    await owner.reload();
    await expect(owner.locator('.short-deck-status')).toContainText('本手：普通');
    await owner.getByRole('button', { name: '日志和统计', exact: true }).click();
    await owner.getByRole('button', { name: '手牌', exact: true }).click();
    await expect(owner.locator('.history-toggle').first()).toContainText('短牌');
    await expect(owner.locator('.history-toggle').nth(1)).toContainText('普通');
    await command(owner, rid, { type: 'end' });
    await foldCurrent();
    await expect.poll(async () => (await state(owner, rid)).closed_at, { timeout: 15000 }).toBeTruthy();
    expect(errors).toEqual([]);
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
});
