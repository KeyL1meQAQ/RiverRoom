import { test, expect } from "@playwright/test";
import type { Page, WebSocketRoute } from "@playwright/test";
import { execFileSync } from "node:child_process";
import type { Room } from "../src/types";

const fixtures: Record<string, Room> = JSON.parse(execFileSync(
  ".venv/bin/python", ["-m", "backend.tests.presentation_fixture"], { encoding: "utf8" },
));

function current(snapshot: Room) {
  const delta = Date.now() / 1000 - snapshot.server_time;
  const timestamps = new Set(["server_time", "start", "until", "base_until", "deadline", "reveal_until", "at", "offline"]);
  return JSON.parse(JSON.stringify(snapshot), (key, value) =>
    timestamps.has(key) && typeof value === "number" && value > 0 ? value + delta : value,
  ) as Room;
}

async function mount(page: Page, name: string | Room) {
  let state = current(typeof name === 'string' ? fixtures[name] : name);
  let socket: WebSocketRoute;
  await page.route("**/api/rooms/presentation", route => route.fulfill({ json: state }));
  await page.route("**/api/rooms/presentation/logs**", route => route.fulfill({ json: { logs: state.logs } }));
  await page.routeWebSocket("**/ws/presentation", ws => {
    socket = ws;
    ws.send(JSON.stringify({ type: "state", state }));
  });
  await page.goto("/r/presentation");
  await expect(page.locator(".connection")).toHaveClass(/connected/);
  return (name: string | Room) => {
    state = current(typeof name === 'string' ? fixtures[name] : name);
    socket.send(JSON.stringify({ type: "state", state }));
    return state;
  };
}

test('table actions and full street amounts fit nine seats at desktop and mobile sizes', async ({ page }) => {
  const push = await mount(page, 'table_actions');
  const labels = page.locator('.seat-bet .bet-action');
  await expect(labels).toHaveText(['过牌', '过牌', '下注', '跟注', '加注', '弃牌', '全下', '全下']);
  await expect(page.locator('.seat-bottom').filter({ hasText: /^(过牌|下注|跟注|加注|全下|弃牌)$/ })).toHaveCount(0);
  const initial = structuredClone(fixtures.table_actions);
  const huge = structuredClone(initial);
  for (const player of huge.players) {
    if (player.bet > 0) player.bet = 123456789;
  }
  for (const [name, width, height] of [
    ['desktop', 1440, 960], ['laptop', 1366, 768], ['tablet', 1024, 800],
    ['small-desktop', 800, 800], ['desktop-boundary', 761, 800], ['mobile', 390, 844],
    ['narrow', 360, 740], ['compact', 320, 568],
  ] as const) {
    await page.setViewportSize({ width, height });
    await expect(page.locator('.side-panel')).not.toBeInViewport();
    for (const large of [false, true]) {
      const snapshot = structuredClone(large ? huge : initial);
      if (width > 760) {
        snapshot.hand!.clock = null;
        snapshot.hand!.last_actions[snapshot.me] = '跟注';
        snapshot.players.find(player => player.id === snapshot.me)!.bet = large ? 123456789 : 20;
      }
      push(snapshot);
      if (large) await expect(page.locator('.bet-amount').first()).toHaveText('123,456,789');
      else await expect(page.locator('.bet-amount').first()).not.toHaveText('123,456,789');
      await page.screenshot({ path: `artifacts/table-actions-${name}${large ? '-large' : ''}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      const issues = await page.evaluate(() => {
        const badges = [...document.querySelectorAll('.seat-bet')];
        const blockers = [...document.querySelectorAll('.occupied, .seat-name, .stack, .seat-bottom, .hole-cards, .boards, .own-hand-label, .table-status, .pot-label')];
        const intersects = (a: DOMRect, b: DOMRect) =>
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1 &&
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1;
        return badges.flatMap((badge, index) => {
          const rect = badge.getBoundingClientRect();
          const seat = badge.parentElement!.querySelector('.occupied')!.getBoundingClientRect();
          const overlap = Math.min(
            Math.min(rect.right, seat.right) - Math.max(rect.left, seat.left),
            Math.min(rect.bottom, seat.bottom) - Math.max(rect.top, seat.top),
          );
          const collisions = [...blockers, ...badges.slice(index + 1)].filter(other => {
            if (innerWidth > 760 && other.matches('.occupied') && other.parentElement === badge.parentElement) return false;
            const otherRect = other.getBoundingClientRect();
            return otherRect.width && otherRect.height && intersects(rect, otherRect);
          });
          const textOverflow = [...badge.children].some(child => {
            const text = document.createRange();
            text.selectNodeContents(child);
            const bounds = text.getBoundingClientRect();
            return bounds.left < rect.left || bounds.right > rect.right || bounds.top < rect.top || bounds.bottom > rect.bottom;
          });
          return [
            ...collisions.map(other => `${badge.parentElement!.className}: ${badge.textContent} overlaps ${other.className}`),
            ...(textOverflow ? [`${badge.textContent} text overflow`] : []),
            ...(innerWidth > 760 && Math.abs(overlap - 8) > 1
              ? [`${badge.parentElement!.className} overlap is ${overlap}px`] : []),
            ...(innerWidth > 760 && badge.children.length === 2 &&
              Math.abs(badge.children[0].getBoundingClientRect().top - badge.children[1].getBoundingClientRect().top) > 1
              ? [`${badge.textContent} is not on one line`] : []),
          ];
        });
      });
      expect.soft(issues, `${name}, large=${large}`).toEqual([]);
      if (!large) {
        await expect(page.locator('.bet-amount').first()).toHaveCSS('font-size', width <= 760 ? '16px' : '18px');
      }
      if (width > 760) {
        const ownHint = await page.locator('.own-hand-label').boundingBox();
        const controls = await page.locator('.action-bar').boundingBox();
        expect(ownHint!.y + ownHint!.height, `${name} own cards stay above controls`).toBeLessThanOrEqual(controls!.y);
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 960 });
  push(initial);
  await page.getByRole('button', { name: '日志和统计', exact: true }).click();
  await expect(page.locator('.side-panel')).toBeInViewport();
  await page.locator('.side-panel').getByRole('button', { name: '关闭侧栏', exact: true }).click();
  await expect(page.locator('.side-panel')).not.toBeInViewport();
  const desktopCards = await page.locator('.position-0 .hole-cards').boundingBox();
  const desktopInfo = await page.locator('.position-0 .seat-top').boundingBox();
  expect(desktopCards!.x + desktopCards!.width).toBeLessThan(desktopInfo!.x);
  expect(Math.abs(desktopCards!.y - desktopInfo!.y)).toBeLessThan(30);
  await page.setViewportSize({ width: 320, height: 568 });
  const ownAction = structuredClone(initial);
  ownAction.me = ownAction.players.find(player => ownAction.hand!.last_actions[player.id] === '加注')!.id;
  push(ownAction);
  await expect(page.locator('.position-0 .seat-bet')).toHaveText('加注100');
  const ownBadge = await page.locator('.position-0 .seat-bet').boundingBox();
  const ownCards = await page.locator('.position-0 .hole-cards').boundingBox();
  expect(ownBadge!.x + ownBadge!.width).toBeLessThan(ownCards!.x);
  const nextTurn = structuredClone(initial);
  const checker = nextTurn.players.find(player => nextTurn.hand!.last_actions[player.id] === '过牌')!;
  nextTurn.hand!.clock!.pid = checker.id;
  delete nextTurn.hand!.last_actions[checker.id];
  push(nextTurn);
  await expect(page.getByLabel(`${checker.name} 过牌`, { exact: true })).toHaveCount(0);
  const nextStreet = structuredClone(nextTurn);
  nextStreet.hand!.last_actions = {};
  nextStreet.players.forEach(player => { player.bet = 0; });
  push(nextStreet);
  await expect(page.locator('.seat-bet')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  await expect(page.locator('.seat-bet')).toHaveCount(0);
  push('tie');
  await expect(page.locator('.seat-bet')).toHaveCount(0);
});

test("flop appears one card at a time with one sound each; reconnect and mute do not replay", async ({ page }) => {
  await page.addInitScript(() => {
    const original = AudioBufferSourceNode.prototype.start;
    (window as any).dealSounds = 0;
    AudioBufferSourceNode.prototype.start = function(...args: Parameters<typeof original>) {
      (window as any).dealSounds++;
      return original.apply(this, args);
    };
  });
  const push = await mount(page, "preflop");
  await page.locator(".room-info h1").click();
  await page.evaluate(() => {
    (window as any).boardFrames = [];
    let previous = 0;
    new MutationObserver(() => {
      const count = document.querySelectorAll(".boards .playing-card:not(.placeholder)").length;
      if (count !== previous) (window as any).boardFrames.push({ count, at: performance.now() });
      previous = count;
    }).observe(document.querySelector(".boards")!, { subtree: true, childList: true, attributes: true });
  });
  push("flop");
  await expect(page.locator(".boards .playing-card:not(.placeholder)")).toHaveCount(3);
  const frames = await page.evaluate(() => (window as any).boardFrames);
  expect(frames.map((frame: any) => frame.count)).toEqual([1, 2, 3]);
  expect(frames[1].at - frames[0].at).toBeGreaterThan(120);
  expect(frames[2].at - frames[1].at).toBeGreaterThan(120);
  await expect.poll(() => page.evaluate(() => (window as any).dealSounds)).toBe(3);
  await expect(page.locator(".seat.acting")).toHaveCount(0);
  push("flop_done");
  await expect(page.locator(".seat.acting")).toHaveCount(1);
  await page.reload();
  await expect(page.locator(".boards .card-dealt")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).dealSounds)).toBe(0);
  await page.getByRole("button", { name: "关闭发牌音效" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "开启发牌音效" })).toBeVisible();
  push("preflop");
  await expect(page.locator(".boards .playing-card:not(.placeholder)")).toHaveCount(0);
  push("flop");
  await expect(page.locator(".boards .playing-card:not(.placeholder)")).toHaveCount(3);
  expect(await page.evaluate(() => (window as any).dealSounds)).toBe(0);
});

test("nine tied winners highlight only the board, remain inspectable in history, and fit desktop and mobile", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const push = await mount(page, "tie");
  await expect(page.locator(".boards .winning-card")).toHaveCount(5);
  await expect(page.locator(".hole-cards .winning-card")).toHaveCount(0);
  await expect(page.locator(".winning-seat")).toHaveCount(9);
  await expect(page.locator(".showdown-result .winning-hand")).toHaveCount(9);
  await expect(page.getByLabel("本人成牌")).toHaveText("皇家同花顺");
  for (const [name, width, height] of [["desktop", 1440, 960], ["mobile", 390, 844], ["narrow", 360, 740], ["compact", 320, 568]] as const) {
    await page.setViewportSize({ width, height });
    if (width < 760) await expect(page.locator(".side-panel")).not.toBeInViewport();
    push("tie");
    if (height < 700) await page.getByLabel("本人成牌").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/presentation-tie-${name}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    const collision = await page.evaluate(() => {
      return [".boards", ".showdown-result", ".own-hand-label"].some(selector => {
        const content = document.querySelector(selector)!.getBoundingClientRect();
        return [...document.querySelectorAll(".seat.occupied")].some(seat => {
          const rect = seat.getBoundingClientRect();
          return content.left < rect.right && content.right > rect.left && content.top < rect.bottom && content.bottom > rect.top;
        });
      });
    });
    expect(collision).toBeFalsy();
    const hintOverlapsResult = await page.evaluate(() => {
      const hint = document.querySelector(".own-hand-label")!.getBoundingClientRect();
      const result = document.querySelector(".showdown-result")!.getBoundingClientRect();
      return hint.top < result.bottom && hint.bottom > result.top;
    });
    expect(hintOverlapsResult).toBeFalsy();
    const hint = await page.getByLabel("本人成牌").boundingBox();
    const controls = await page.locator(".action-bar").boundingBox();
    expect(hint!.y + hint!.height).toBeLessThanOrEqual(controls!.y);
  }
  await page.getByRole("button", { name: "日志和统计", exact: true }).click();
  await page.getByRole("button", { name: "手牌", exact: true }).click();
  await page.locator(".history-toggle").click();
  await expect(page.locator(".history-pot-result .winning-hand")).toHaveCount(9);
  await expect(page.locator(".history-pot-result .playing-card")).toHaveCount(45);
  expect(errors).toEqual([]);
});

test("two runouts and side pots switch the complete winner group", async ({ page }) => {
  const push = await mount(page, "twice");
  const groups = fixtures.twice.hand!.showdown_results!;
  expect(groups.length).toBeGreaterThanOrEqual(4);
  const select = page.getByRole("combobox", { name: "底池结果" });
  for (let index = 0; index < groups.length; index++) {
    push("twice");
    await select.selectOption(String(index));
    await expect(page.locator(".showdown-result .winning-hand")).toHaveCount(groups[index].winners.length);
    await expect(page.locator(".winning-seat")).toHaveCount(groups[index].winners.length);
    const displayed = await page.locator(".showdown-result .playing-card").evaluateAll(cards => cards.map(card => card.getAttribute("aria-label")));
    expect(displayed).toEqual(groups[index].winners.flatMap(winner => winner.cards));
    const boardCards = fixtures.twice.hand!.boards[groups[index].board];
    const expected = new Set(groups[index].winners.flatMap(winner => winner.cards).filter(card => boardCards.includes(card)));
    await expect(page.locator(".boards .winning-card")).toHaveCount(expected.size);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".side-panel")).not.toBeInViewport();
  push("twice");
  await expect(page.getByLabel("本人成牌")).toContainText("第一次：");
  await expect(page.getByLabel("本人成牌")).toContainText("第二次：");
  await page.screenshot({ path: "artifacts/presentation-twice-mobile.png", fullPage: true });
});

test("folded personal hand keeps updating while spectators receive no hint", async ({ page }) => {
  const push = await mount(page, "folded_before");
  await expect(page.getByLabel("本人成牌")).toHaveText("一对[Q]");
  push("folded_after");
  await expect(page.getByLabel("本人成牌")).toHaveText("三条[Q]");
  push("tie_observer");
  await expect(page.getByLabel("本人成牌")).toHaveCount(0);
});
