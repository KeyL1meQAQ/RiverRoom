import { test, expect } from "@playwright/test";
import fs from "node:fs";

test("multi-browser room, approval, playing, refresh and recovery", async ({
  browser,
  baseURL,
}) => {
  const host = await browser.newContext({
    viewport: { width: 1440, height: 960 },
  });
  const guest = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const observer = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const pages = await Promise.all([
    host.newPage(),
    guest.newPage(),
    observer.newPage(),
  ]);
  const [a, b, c] = pages;
  const errors: string[] = [];
  pages.forEach((p) => p.on("pageerror", (e) => errors.push(e.message)));
  fs.mkdirSync("artifacts", { recursive: true });
  await a.goto(baseURL!);
  await expect(
    a.getByRole("heading", { name: "River Room", exact: true }),
  ).toBeVisible();
  await a.screenshot({ path: "artifacts/lobby-desktop.png", fullPage: true });
  await a.getByLabel("房间名称").fill("周三朋友局");
  await a.getByRole("button", { name: "创建房间", exact: true }).click();
  await expect(a.getByRole("heading", { name: "周三朋友局" })).toBeVisible();
  await expect(a.locator(".connection")).toHaveClass(/connected/);
  const url = a.url();
  await a.getByRole("button", { name: "入座 1 号位", exact: true }).click();
  await a.getByLabel("昵称", { exact: true }).fill("林舟");
  await a.getByLabel("买入筹码").fill("200");
  await a.getByRole("button", { name: "确认入座", exact: true }).click();
  await expect(a.locator(".occupied")).toHaveCount(1);

  await b.goto(url);
  await expect(b.locator(".connection")).toHaveClass(/connected/);
  await expect(b.locator(".my-status")).toContainText("观战中");
  await b.getByRole("button", { name: "入座 5 号位", exact: true }).click();
  await b.getByLabel("昵称", { exact: true }).fill("小满");
  await b.getByLabel("买入筹码").fill("200");
  await b.getByRole("button", { name: "提交入座申请" }).click();
  await expect(b.locator(".action-content")).toContainText("等待房主审批");
  await a.getByRole("button", { name: "日志和统计", exact: true }).click();
  await a.getByRole("button", { name: "管理", exact: true }).click();
  await a.getByRole("button", { name: "批准 小满", exact: true }).click();
  await a.locator('.side-panel').getByRole('button', { name: '关闭侧栏', exact: true }).click();
  await expect(b.locator(".occupied")).toHaveCount(2);
  await c.goto(url);
  await expect(c.locator(".connection")).toHaveClass(/connected/);
  await a.getByRole("button", { name: "开始游戏", exact: true }).click();
  await expect(a.locator(".table-toolbar")).toContainText("牌局进行中");
  await expect(a.locator(".bet-buttons")).toBeVisible();
  await expect(c.locator(".hole-cards .back")).toHaveCount(4);
  await a.screenshot({ path: "artifacts/room-desktop.png", fullPage: true });
  await b.screenshot({ path: "artifacts/room-mobile.png", fullPage: true });
  await b.reload();
  await expect(b.locator(".connection")).toHaveClass(/connected/);
  await expect(b.locator(".my-status")).toContainText("小满");
  await expect(b.locator(".occupied")).toHaveCount(2);
  await a.getByRole("button", { name: "跟注 1", exact: true }).click();
  await expect(b.locator(".bet-buttons")).toBeVisible();
  await b.getByRole("button", { name: "过牌", exact: true }).click();
  await expect(b.locator(".board .playing-card:not(.placeholder)")).toHaveCount(
    3,
  );
  await b.screenshot({
    path: "artifacts/room-mobile-flop.png",
    fullPage: true,
  });
  await b.getByRole("button", { name: "房间身份", exact: true }).click();
  const recallCode = await b.getByLabel("我的召回码").inputValue();
  await b.getByRole("button", { name: "关闭", exact: true }).click();
  await c.getByRole("button", { name: "房间身份", exact: true }).click();
  await c.getByRole("button", { name: "召回其他身份", exact: true }).click();
  await c.getByLabel("召回码", { exact: true }).fill(recallCode);
  await c.getByRole("button", { name: "召回并接管", exact: true }).click();
  await expect(c.locator(".my-status")).toContainText("小满");
  await expect(b.locator(".connection-banner")).toContainText(
    "身份已在另一设备召回",
  );
  await expect(c.locator(".bet-buttons")).toBeVisible();
  const noOverflow = await c.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth,
  );
  expect(noOverflow).toBeTruthy();
  expect(errors).toEqual([]);
  await Promise.all([host.close(), guest.close(), observer.close()]);
});

test("mobile lobby fits a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await page.screenshot({ path: "artifacts/lobby-mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.getByRole("tab", { name: "加入牌桌", exact: true }).click();
  await expect(page.getByLabel("房间链接或编码")).toBeVisible();
});

test("nine seats render across desktop and mobile without control overlap", async ({
  browser,
  baseURL,
}) => {
  const contexts = await Promise.all(
    Array.from({ length: 9 }, () =>
      browser.newContext({ viewport: { width: 1440, height: 960 } }),
    ),
  );
  const names = [
    "林舟",
    "小满",
    "阿青",
    "周周",
    "远山",
    "木子",
    "陈一",
    "七月",
    "向晚",
  ];
  const host = contexts[0];
  const created = await host.request.post(`${baseURL}/api/rooms`, {
    data: { name: "九人牌桌验收", settings: { straddle: true, twice: true } },
  });
  expect(created.ok()).toBeTruthy();
  const rid = (await created.json()).id;
  const root = `${baseURL}/api/rooms/${rid}`;
  const command = async (index: number, body: object) => {
    const r = await contexts[index].request.post(`${root}/commands`, {
      data: { ...body, command_id: crypto.randomUUID() },
    });
    expect(r.ok(), await r.text()).toBeTruthy();
  };
  for (let i = 0; i < 9; i++) {
    await contexts[i].request.get(root);
    await command(i, {
      type: "request_seat",
      name: names[i],
      seat: i,
      amount: 200 + i * 25,
    });
    if (i) {
      const state = await (await host.request.get(root)).json();
      await command(0, { type: "approve", request: state.requests[0].id });
    }
  }
  const pages = await Promise.all(contexts.map((c) => c.newPage()));
  await Promise.all(pages.map((p) => p.goto(`${baseURL}/r/${rid}`)));
  await Promise.all(
    pages.map((p) => expect(p.locator(".connection")).toHaveClass(/connected/)),
  );
  await command(0, { type: "start" });
  const state = await (await host.request.get(root)).json();
  expect(state.phase).toBe("straddle");
  const utg = state.players.find(
    (p: { id: string }) => p.id === state.straddle,
  );
  await command(utg.seat, { type: "straddle", value: true });
  const page = pages[0];
  await expect(page.locator(".occupied")).toHaveCount(9);
  await expect(page.locator(".hole-cards .playing-card")).toHaveCount(18);
  await page.screenshot({
    path: "artifacts/full-table-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".side-panel")).not.toBeInViewport();
  await page.screenshot({
    path: "artifacts/full-table-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 360, height: 740 });
  await page.screenshot({
    path: "artifacts/full-table-narrow.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  const overlaps = await page.evaluate(() => {
    const seats = [...document.querySelectorAll(".occupied")];
    const intersects = (a: DOMRect, b: DOMRect) =>
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1 &&
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1;
    const cards = seats.map((s) =>
      s.parentElement!.querySelector(".hole-cards")!.getBoundingClientRect(),
    );
    const text = seats.flatMap((s) =>
      [...s.querySelectorAll(".stack,.seat-top,.seat-bottom")].map((x) =>
        x.getBoundingClientRect(),
      ),
    );
    return cards.filter((c) => c.height && text.some((t) => intersects(c, t)))
      .length;
  });
  expect(overlaps).toBe(0);
  await Promise.all(contexts.map((c) => c.close()));
});
