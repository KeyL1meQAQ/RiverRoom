import { test, expect } from "@playwright/test";
import type { Browser, BrowserContext } from "@playwright/test";
import type { Room } from "../src/types";

async function roomWithPlayers(browser: Browser, baseURL: string, count: number) {
  const contexts: BrowserContext[] = [];
  for (let i = 0; i <= count; i++) {
    contexts.push(await browser.newContext({
      viewport: i === 0 ? { width: 390, height: 844 } : { width: 1440, height: 960 },
    }));
  }
  const created = await contexts[0].request.post(`${baseURL}/api/rooms`, {
    data: { name: "摊牌验收", settings: {} },
  });
  expect(created.ok()).toBeTruthy();
  const rid = (await created.json()).id;
  const root = `${baseURL}/api/rooms/${rid}`;
  const state = async (index = 0): Promise<Room> => (await contexts[index].request.get(root)).json();
  const command = async (index: number, body: object) => {
    const response = await contexts[index].request.post(`${root}/commands`, {
      data: { ...body, command_id: crypto.randomUUID() },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  for (let i = 0; i < count; i++) {
    await state(i);
    await command(i, { type: "request_seat", seat: i, name: `玩家${i}`, amount: 200 });
    if (i) await command(0, { type: "approve", request: (await state()).requests[0].id });
  }
  const pages = [];
  for (const context of contexts) {
    const page = await context.newPage();
    await page.goto(`${baseURL}/r/${rid}`);
    await expect(page.locator(".connection")).toHaveClass(/connected/);
    pages.push(page);
  }
  return { contexts, pages, state, command };
}

test("folded player reveals one card then all, visible to observer, window expires", async ({ browser, baseURL }) => {
  const { contexts, pages, state, command } = await roomWithPlayers(browser, baseURL!, 2);
  try {
    const [host, , observer] = pages;
    await command(0, { type: "start" });
    await command(0, { type: "pause" });
    const before = await state();
    const me = before.me;
    const cards = before.hand!.cards[me];
    expect(before.hand!.clock!.pid).toBe(me);
    await host.getByRole("button", { name: "弃牌", exact: true }).click();
    await command(0, { type: "leave" });
    const controls = host.getByRole("group", { name: "本手亮牌" });
    await expect(controls).toBeVisible();
    expect((await state(2)).hand!.cards).toEqual({});
    await controls.getByRole("button", { name: `亮出 ${cards[1]}`, exact: true }).click();
    await expect(observer.locator(".hole-cards .playing-card:not(.back)")).toHaveCount(1);
    await expect(observer.locator(".hole-cards .back")).toHaveCount(1);
    const partial = await state(2);
    expect(partial.hand!.cards[me]).toEqual([null, cards[1]]);
    expect(partial.history[0].cards[me]).toEqual([null, cards[1]]);
    await host.screenshot({ path: "artifacts/showdown-mobile.png", fullPage: true });
    await observer.screenshot({ path: "artifacts/showdown-observer.png", fullPage: true });
    await controls.getByRole("button", { name: "亮出全部", exact: true }).click();
    await expect(observer.locator(".hole-cards .playing-card:not(.back)")).toHaveCount(2);
    expect((await state(2)).hand!.cards[me]).toEqual(cards);
    await expect(controls.getByRole("button", { name: "亮出全部", exact: true })).toBeDisabled();
    expect(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    await expect(controls).toHaveCount(0, { timeout: 7000 });
    expect((await state()).number).toBe(1);
    await observer.getByRole("button", { name: "日志和统计", exact: true }).click();
    await observer.getByRole("button", { name: "手牌", exact: true }).click();
    await observer.locator(".history-toggle").click();
    await expect(observer.locator(".history-player .playing-card:not(.back)")).toHaveCount(2);
    await command(0, { type: "end" });
  } finally {
    for (const context of contexts) await context.close();
  }
});

test("normal showdown broadcasts the complete ordered prefix together", async ({ browser, baseURL }) => {
  const { contexts, pages, state, command } = await roomWithPlayers(browser, baseURL!, 4);
  try {
    const observer = pages[4];
    const errors: string[] = [];
    pages.forEach(page => page.on("pageerror", error => errors.push(error.message)));
    await command(0, { type: "start" });
    await command(0, { type: "pause" });
    let current = await state();
    while (current.hand!.result === null) {
      if (current.phase === "dealing") {
        await expect.poll(async () => (await state()).phase).not.toBe("dealing");
        current = await state();
        continue;
      }
      const player = current.players.find(p => p.id === current.hand!.clock!.pid)!;
      await command(player.seat!, { type: "act", action: "call", hand: current.number, seq: current.hand!.seq });
      current = await state();
    }
    const result = current.hand!.result!;
    const ids = current.hand!.ids;
    const lastWinner = Math.max(...result.filter(r => r.won > 0).map(r => ids.indexOf(r.pid)));
    const expected = ids.slice(0, lastWinner + 1);
    const publicState = await state(4);
    expect(publicState.hand!.revealed).toEqual(expected);
    expect(Object.keys(publicState.hand!.cards)).toEqual(expected);
    await expect(observer.locator(".hole-cards .playing-card:not(.back)")).toHaveCount(expected.length * 2);
    await observer.screenshot({ path: "artifacts/showdown-desktop.png", fullPage: true });
    await observer.setViewportSize({ width: 360, height: 740 });
    await expect(observer.locator(".side-panel")).not.toBeInViewport();
    await observer.screenshot({ path: "artifacts/showdown-narrow.png", fullPage: true });
    expect(await observer.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    expect(errors).toEqual([]);
    await command(0, { type: "end" });
  } finally {
    for (const context of contexts) await context.close();
  }
});
