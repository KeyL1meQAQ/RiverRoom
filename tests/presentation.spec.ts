import { test, expect } from "@playwright/test";
import type { Page, WebSocketRoute } from "@playwright/test";
import { execFileSync } from "node:child_process";
import type { Room } from "../src/types";

const fixtures: Record<string, Room> = JSON.parse(execFileSync(
  ".venv/bin/python", ["-m", "backend.tests.presentation_fixture"], { encoding: "utf8" },
));

function current(snapshot: Room) {
  const delta = Date.now() / 1000 - snapshot.server_time;
  const timestamps = new Set(["server_time", "start", "until", "base_until", "deadline", "reveal_until", "reveal_start", "split_at", "pot_until", "bounty_at", "squid_at", "at", "offline"]);
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
  const push = (name: string | Room) => {
    state = current(typeof name === 'string' ? fixtures[name] : name);
    socket.send(JSON.stringify({ type: "state", state }));
    return state;
  };
  return Object.assign(push, {
    reconnectWith(name: string | Room) {
      state = current(typeof name === 'string' ? fixtures[name] : name);
      socket.close({ code: 1012, reason: 'test reconnect' });
    },
  });
}

test('settled results survive the reveal deadline, reload, and the next straddle offer', async ({ page }) => {
  const state = structuredClone(fixtures.twice);
  state.phase = 'between'; state.paused = true; state.rebuy = [];
  state.hand!.reveal_until = state.server_time - 1;
  const push = await mount(page, state);
  await expect(page.locator('.seat-payout')).toHaveCount(0);
  await expect(page.locator('.winning-seat')).not.toHaveCount(0);
  await expect(page.locator('.table-status')).toHaveText('后续发牌已暂停');
  await expect(page.locator('.reveal-card')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.seat-payout')).toHaveCount(0);
  state.phase = 'straddle'; state.straddle = state.me; state.deadline = state.server_time + 5;
  push(state);
  await expect(page.locator('.table-status')).toContainText('UTG 选择 Straddle');
  await expect(page.locator('.seat-payout')).toHaveCount(0);
  push('preflop');
  await expect(page.locator('.seat-payout')).toHaveCount(0);
  await expect(page.locator('.winning-seat')).toHaveCount(0);
});

test('reloading during the last-action hold retains the check and only waits the remaining server time', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const snapshot = structuredClone(fixtures.last_check);
  snapshot.server_time += 1;
  const checker = snapshot.players.find(p => snapshot.hand!.last_actions[p.id] === '过牌')!;
  const push = await mount(page, snapshot);
  await expect(page.getByLabel(`${checker.name} 过牌`, { exact: true })).toHaveText('过牌');
  await expect(page.locator('.seat.acting')).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel(`${checker.name} 过牌`, { exact: true })).toBeVisible();
  await expect(page.locator('.boards .playing-card:not(.placeholder)')).toHaveCount(0);
  push('flop');
  await expect(page.getByLabel(`${checker.name} 过牌`, { exact: true })).toHaveCount(0);
  await expect(page.locator('.boards .playing-card:not(.placeholder)')).toHaveCount(3);
  push('flop_done');
  await expect(page.locator('.seat.acting')).toHaveCount(1);
});

test('expired result seats use current occupants and never give a newcomer old cards or winnings', async ({ page }) => {
  const state = structuredClone(fixtures.twice);
  state.hand!.reveal_until = state.server_time - 1;
  const leaving = state.players.find(p => state.hand!.result!.some(r => r.pid === p.id && r.won > 0) && p.id !== state.me)!;
  const oldSeat = leaving.seat;
  leaving.seat = null;
  const newcomer = structuredClone(leaving);
  Object.assign(newcomer, { id: 'newcomer', name: '新入座玩家', seat: oldSeat, cards: [], achievements: { wins: 0, busts: 0 } });
  state.players.push(newcomer);
  const push = await mount(page, state);
  const seat = page.getByRole('button', { name: `新入座玩家，筹码 ${newcomer.stack}`, exact: true });
  await expect(seat).toBeVisible();
  await expect(seat).not.toHaveClass(/winning-seat/);
  await expect(seat.locator('..').locator('.playing-card, .seat-payout, .seat-hand-label')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `${leaving.name}，筹码 ${leaving.stack}`, exact: true })).toHaveCount(0);
  const me = state.players.find(p => p.id === state.me)!;
  me.seat = 7;
  push(state);
  await expect(page.locator('.own-seat')).toHaveClass(/position-0/);
  await expect(page.locator('.own-seat .seat-hand-label')).toBeVisible();
});

test('mobile result location is opt-in and preserves readable results after the reveal window', async ({ page }) => {
  const state = structuredClone(fixtures.nine_twice);
  state.hand!.reveal_until = state.server_time - 1;
  await page.setViewportSize({ width: 320, height: 568 });
  await mount(page, state);
  const main = page.locator('.room-main');
  const before = await main.evaluate(el => el.scrollTop);
  const hint = page.getByRole('button', { name: '查看我的结果' });
  await expect(hint).toBeVisible();
  expect(await main.evaluate(el => el.scrollTop)).toBe(before);
  await hint.click();
  await expect(hint).toBeHidden();
  await expect.poll(() => main.evaluate(el => el.scrollTop)).toBeGreaterThan(before);
  const seat = await page.locator('.own-seat .occupied').boundingBox();
  const controls = await page.locator('.action-bar').boundingBox();
  expect(seat!.y + seat!.height).toBeLessThanOrEqual(controls!.y);
  await expect(page.locator('.own-seat .seat-hand-label')).toBeInViewport();
  await page.screenshot({ path: 'artifacts/remediation-result-320.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(hint).toBeHidden();
});

test('history separates net result from pot receipts and shows stable pot eligibility', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = structuredClone(fixtures.twice);
  state.hand!.reveal_until = state.server_time - 1;
  await mount(page, state);
  await page.getByRole('button', { name: '日志和统计', exact: true }).click();
  await page.getByRole('button', { name: '手牌', exact: true }).click();
  await page.locator('.history-toggle').click();
  await expect(page.locator('.history-result-heading')).toHaveText('本手净输赢');
  await expect(page.locator('.history-pot-definition')).toHaveCount(state.hand!.pots!.length);
  await expect(page.locator('.history-pot-definition').first()).toContainText('争夺资格');
  await expect(page.locator('.history-pot-result').first()).toContainText('第 1 组');
  await expect(page.locator('.winning-hand-heading').first()).toContainText('获池金额');
  await page.screenshot({ path: 'artifacts/remediation-history-390.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('table actions and full street amounts fit nine seats at desktop and mobile sizes', async ({ page }) => {
  const push = await mount(page, 'table_actions');
  const labels = page.locator('.seat-bet .bet-action');
  await expect(labels).toHaveText(['过牌', '过牌', '弃牌']);
  await expect(page.locator('.seat-top, .seat-stack-row').filter({ hasText: /^(过牌|下注|跟注|加注|全下|弃牌)$/ })).toHaveCount(0);
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
      {
        snapshot.hand!.clock = null;
        snapshot.hand!.last_actions[snapshot.me] = '跟注';
        snapshot.players.find(player => player.id === snapshot.me)!.bet = large ? 123456789 : 20;
      }
      push(snapshot);
      if (large) await expect(page.locator('.bet-amount').first()).toHaveText('123,456,789');
      else await expect(page.locator('.bet-amount').first()).not.toHaveText('123,456,789');
      await page.screenshot({ path: `artifacts/mobile-frame-actions-${name}${large ? '-large' : ''}.png`, fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
      const issues = await page.evaluate(() => {
        const badges = [...document.querySelectorAll('.seat-bet')];
        const blockers = [...document.querySelectorAll('.occupied, .seat-name, .stack, .seat-payout, .hole-cards, .boards, .seat-hand-label, .table-status, .pot-label, .dealer')];
        const intersects = (a: DOMRect, b: DOMRect) =>
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1 &&
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1;
        return badges.flatMap((badge, index) => {
          const rect = badge.getBoundingClientRect();
          const seat = badge.parentElement!.querySelector('.occupied')!.getBoundingClientRect();
          const gap = Math.max(seat.left - rect.right, rect.left - seat.right, seat.top - rect.bottom, rect.top - seat.bottom);
          const position = Number(badge.parentElement!.className.match(/position-(\d)/)![1]);
          const cards = badge.parentElement!.querySelector('.hole-cards')!.getBoundingClientRect();
          const cornerSeat = innerWidth > 760 && [1, 3, 6, 8].includes(position);
          // Folded seats retain the same card slot with frosted placeholders.
          const cardBottom = cards.bottom;
          const inward = cornerSeat
            ? [6, 8].includes(position)
              ? Math.abs(rect.right - (cards.left - 8)) <= 1 &&
                (position === 8 ? Math.abs(rect.bottom - (cards.top - 8)) <= 1 : rect.top >= cardBottom + 7)
              : rect.left >= seat.right + 7 && (position === 1 ? rect.bottom <= seat.top - 7 : rect.top >= seat.bottom + 7)
            : [4, 5].includes(position) ? rect.top >= seat.bottom
            : position === 0 ? rect.bottom <= Math.min(seat.top, cards.top)
            : position < 4 ? rect.left >= seat.right : rect.right <= seat.left;

          const mobileSide = innerWidth <= 760 && [1, 2, 3, 6, 7, 8].includes(position);
          const mobileAnchor = !mobileSide || ([1, 8].includes(position)
            ? Math.abs(rect.bottom - (seat.top - 6)) <= 1
            : [3, 6].includes(position) ? Math.abs(rect.top - (seat.bottom + 6)) <= 1
            : Math.abs((rect.top + rect.bottom) / 2 - (seat.top + seat.bottom) / 2) <= 1);
          const peerPosition = ({ 1: 8, 8: 1, 2: 7, 7: 2, 3: 6, 6: 3 } as Record<number, number>)[position];
          const peer = cornerSeat ? document.querySelector(`.position-${peerPosition} .seat-bet`) : null;
          const aligned = !peer || Math.abs(rect.top - peer.getBoundingClientRect().top) <= 1;
          const collisions = [...blockers, ...badges.slice(index + 1)].filter(other => {
            const otherRect = other.getBoundingClientRect();
            return otherRect.width && otherRect.height && intersects(rect, otherRect);
          });
          const textOverflow = [...badge.children].filter(child => child.textContent).some(child => {
            const text = document.createRange();
            text.selectNodeContents(child);
            const bounds = text.getBoundingClientRect();
            return bounds.left < rect.left || bounds.right > rect.right || bounds.top < rect.top || bounds.bottom > rect.bottom;
          });
          return [
            ...collisions.map(other => `${badge.parentElement!.className}: ${badge.textContent} overlaps ${other.className}`),
            ...(textOverflow ? [`${badge.textContent} text overflow`] : []),
            ...(!inward ? [`${badge.parentElement!.className} is not on the inward side`] : []),
            ...(!mobileAnchor ? [`${badge.parentElement!.className} does not follow its frame corner or middle line`] : []),
            ...(!aligned ? [`${badge.parentElement!.className} is not level with position-${peerPosition}`] : []),
            ...(gap < (innerWidth > 760 ? 7 : 5)
              ? [`${badge.parentElement!.className} gap is only ${gap}px`] : []),
            ...(innerWidth > 760 && badge.children.length === 2 &&
              Math.abs((badge.children[0].getBoundingClientRect().top + badge.children[0].getBoundingClientRect().bottom) / 2 - (badge.children[1].getBoundingClientRect().top + badge.children[1].getBoundingClientRect().bottom) / 2) > 1
              ? [`${badge.textContent} is not on one line`] : []),
          ];
        });
      });
      expect.soft(issues, `${name}, large=${large}`).toEqual([]);
      if (!large) {
        await expect(page.locator('.bet-amount').first()).toHaveCSS('font-size', width <= 760 ? '12px' : '14px');
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
  const desktopFrame = await page.locator('.position-0 .seat.occupied').boundingBox();
  expect(desktopCards!.x).toBeLessThan(desktopFrame!.x);
  expect(desktopCards!.x + desktopCards!.width - desktopFrame!.x).toBeCloseTo(8, 0);
  expect(Math.min(desktopCards!.y + desktopCards!.height, desktopFrame!.y + desktopFrame!.height) -
    Math.max(desktopCards!.y, desktopFrame!.y)).toBeGreaterThan(20);
  await page.setViewportSize({ width: 320, height: 568 });
  const ownAction = structuredClone(initial);
  ownAction.me = ownAction.players.find(player => ownAction.hand!.last_actions[player.id] === '加注')!.id;
  push(ownAction);
  await expect(page.locator('.position-0 .seat-bet')).toHaveText('100');
  const ownBadge = await page.locator('.position-0 .seat-bet').boundingBox();
  const ownCards = await page.locator('.position-0 .hole-cards').boundingBox();
  expect(ownBadge!.y + ownBadge!.height).toBeLessThan(ownCards!.y);
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
  await expect(page.locator(".seat-hand-label")).toHaveCount(9);
  await expect(page.locator(".showdown-result")).toHaveCount(0);
  for (const [name, width, height] of [["desktop", 1440, 960], ["mobile", 390, 844], ["narrow", 360, 740], ["compact", 320, 568]] as const) {
    await page.setViewportSize({ width, height });
    if (width < 760) await expect(page.locator(".side-panel")).not.toBeInViewport();
    push("tie");
    if (height < 700) await page.locator(".own-seat").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/presentation-tie-${name}.png`, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    const collision = await page.evaluate(() => {
      return [".boards"].some(selector => {
        const content = document.querySelector(selector)!.getBoundingClientRect();
        return [...document.querySelectorAll(".seat.occupied")].some(seat => {
          const rect = seat.getBoundingClientRect();
          return content.left < rect.right && content.right > rect.left && content.top < rect.bottom && content.bottom > rect.top;
        });
      });
    });
    expect(collision).toBeFalsy();
    const hint = await page.locator(".own-seat").boundingBox();
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

test("final runout alone highlights its main-pot winners; payouts are absent from player frames", async ({ page }) => {
  const push = await mount(page, "twice");
  const groups = fixtures.twice.hand!.showdown_results!;
  expect(groups.length).toBeGreaterThanOrEqual(4);
  const main = groups.filter(group => group.pot === 0 && group.board === 1);
  const mainIds = new Set(main.flatMap(group => group.winners.map(winner => winner.pid)));
  await expect(page.getByRole("combobox", { name: "底池结果" })).toHaveCount(0);
  await expect(page.locator(".winning-seat")).toHaveCount(mainIds.size);
  for (const player of fixtures.twice.players.filter(player => player.seat !== null)) {
    const seat = page.getByRole('button', { name: `${player.name}，筹码 ${player.stack}`, exact: true });
    if (mainIds.has(player.id)) await expect(seat).toHaveClass(/winning-seat/);
    else await expect(seat).not.toHaveClass(/winning-seat/);
    for (let board = 1; board < 2; board++) {
      const row = seat.locator('..').locator(`.seat-hand-label > span[data-board="${board}"]`);
      await expect(row).toContainText(fixtures.twice.hand!.public_hand_labels![player.id][board]);
    }
    await expect(seat.locator('.seat-payout')).toHaveCount(0);
    const expectedHoles = new Set(main.flatMap(group => group.winners.filter(w => w.pid === player.id).flatMap(w => w.cards)).filter(card => player.cards.includes(card)));
    await expect(seat.locator('..').locator('.hole-cards .winning-card')).toHaveCount(expectedHoles.size);
  }
  for (let board = 1; board < 2; board++) {
    const expected = new Set(main.filter(group => group.board === board).flatMap(group => group.winners.flatMap(w => w.cards)).filter(card => fixtures.twice.hand!.boards[board].includes(card)));
    await expect(page.locator('.board').first().locator('.winning-card')).toHaveCount(expected.size);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".side-panel")).not.toBeInViewport();
  push("twice");
  await expect(page.locator('.own-seat .seat-hand-label > span')).toHaveCount(1);
  await page.screenshot({ path: "artifacts/presentation-twice-mobile.png", fullPage: true });
});

test("folded personal hand keeps updating while spectators receive no hint", async ({ page }) => {
  const push = await mount(page, "folded_before");
  await expect(page.locator('.hole-cards.folded .playing-card')).toHaveCount(2);
  await expect(page.locator('.hole-cards.folded')).toHaveCSS('filter', 'brightness(0.55)');
  await expect(page.getByLabel("本人成牌")).toHaveText("一对[Q]");
  push("folded_after");
  await expect(page.locator('.hole-cards.folded')).toHaveCSS('filter', 'brightness(0.55)');
  await expect(page.getByLabel("本人成牌")).toHaveText("三条[Q]");
  push("tie_observer");
  await expect(page.getByLabel("本人成牌")).toHaveCount(0);
});

test('side-pot-only winner is visible without a winning frame or highlighted hole cards', async ({ page }) => {
  await mount(page, 'side_pots');
  const hand = fixtures.side_pots.hand!;
  const mainIds = hand.showdown_results!.filter(g => g.pot === 0).flatMap(g => g.winners.map(w => w.pid));
  const sideWinner = hand.showdown_results!.filter(g => g.pot > 0).flatMap(g => g.winners).find(w => !mainIds.includes(w.pid))!;
  expect(sideWinner).toBeTruthy();
  const player = fixtures.side_pots.players.find(p => p.id === sideWinner.pid)!;
  const seat = page.getByRole('button', { name: `${player.name}，筹码 ${player.stack}`, exact: true });
  await expect(seat).not.toHaveClass(/winning-seat/);
  await expect(seat.locator('..').locator('.seat-hand-label')).toContainText(sideWinner.label);
  await expect(seat.locator('.seat-payout')).toHaveCount(0);
  await expect(seat.locator('..').locator('.hole-cards .winning-card')).toHaveCount(0);
});

test('nine-player double runout and ordinary play fit with readable cards and seat results', async ({ page }) => {
  const push = await mount(page, 'nine_twice');
  for (const [name, width, height] of [
    ['desktop', 1440, 960], ['laptop', 1366, 768], ['small-desktop', 800, 800],
    ['mobile', 390, 844], ['narrow', 360, 740], ['compact', 320, 568],
  ] as const) {
    await page.setViewportSize({ width, height });
    for (const fixture of ['nine_twice', 'table_actions'] as const) {
      push(fixture);
      await expect(page.locator('.seat.occupied')).toHaveCount(9);
      await expect(page.locator('.table-stage .seat-avatar, .table-stage .seat-bottom')).toHaveCount(0);
      await expect(page.locator('.table-stage .seat-top')).toHaveCount(9);
      await expect(page.locator('.table-stage .seat-stack-row')).toHaveCount(9);
      if (fixture === 'nine_twice') {
        await expect(page.locator('.seat-hand-label > span')).toHaveCount(9);
        await expect(page.locator('.boards .winning-card')).toHaveCount(5);
        await expect(page.locator('.seat-payout')).toHaveCount(0);
      }
      const issues = await page.evaluate(() => {
        const overlaps = (a: DOMRect, b: DOMRect) =>
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1 &&
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1;
        const cards = [...document.querySelectorAll('.hole-cards')];
        const texts = [...document.querySelectorAll('.seat-top, .stack, .seat-payout')]
          .filter(node => node.getBoundingClientRect().height > 0);
        const boards = document.querySelector('.boards')!.getBoundingClientRect();
        const issues = cards.flatMap(card => texts.filter(text => overlaps(card.getBoundingClientRect(), text.getBoundingClientRect()))
          .map(text => `${card.parentElement!.className} cards overlap ${text.parentElement!.className} ${text.className}`));
        for (const seat of document.querySelectorAll('.seat.occupied')) {
          if (overlaps(boards, seat.getBoundingClientRect())) issues.push('board overlaps seat');
          const stack = seat.querySelector('.stack')!;
          const stackText = document.createRange();
          stackText.selectNodeContents(stack);
          const textBounds = stackText.getBoundingClientRect();
          const stackBounds = stack.getBoundingClientRect();
          if (textBounds.height > stackBounds.height + 1) issues.push('stack text vertically clipped');
        }
        for (const wrap of document.querySelectorAll('.seat-wrap:has(.seat.occupied)')) {
          const frame = wrap.querySelector('.seat.occupied')!.getBoundingClientRect();
          const cards = wrap.querySelector('.hole-cards')?.getBoundingClientRect();
          const label = wrap.querySelector('.seat-hand-label')?.getBoundingClientRect();
          if (label) {
            if (label.left < frame.left - 1 || label.right > frame.right + 1 || label.top < frame.top || label.bottom > frame.bottom) issues.push(`${wrap.className} hand label leaves frame`);
            for (const content of wrap.querySelectorAll('.seat-top, .stack, .seat-payout')) {
              if (overlaps(label, content.getBoundingClientRect())) issues.push(`${wrap.className} hand label overlaps ${content.className}`);
            }
          }
          if (cards?.width) {
            if (innerWidth > 760) {
              const cardOverlap = cards.right - frame.left;
              if (Math.abs(cardOverlap - 8) > 1) issues.push(`${wrap.className} card overlap is ${cardOverlap}px`);
            } else {
              const cardOverlap = cards.bottom - frame.top;
              if (Math.abs(cardOverlap - 2) > 1) issues.push(`${wrap.className} mobile card overlap is ${cardOverlap}px`);
              if (label?.left < 0 || label?.right > innerWidth) issues.push(`${wrap.className} hand label leaves viewport`);
            }
          }
        }
        const hint = document.querySelector('.own-hand-label');
        if (hint) for (const text of hint.parentElement!.querySelectorAll('.seat-top, .stack, .seat-payout')) {
          if (overlaps(hint.getBoundingClientRect(), text.getBoundingClientRect())) issues.push(`own hint overlaps ${text.className}`);
        }
        if (document.documentElement.scrollWidth > innerWidth) issues.push('horizontal overflow');
        if (innerWidth <= 760 && innerHeight >= 740 && document.querySelectorAll('.showing-result .seat-wrap.has-result').length < 9) {
          const main = document.querySelector('.room-main')!;
          if (main.scrollHeight > main.clientHeight + 1) issues.push('table needs scrolling');
          const footer = document.querySelector('.action-bar')!.getBoundingClientRect();
          for (const seat of document.querySelectorAll('.seat-wrap')) {
            if (seat.getBoundingClientRect().bottom > footer.top) issues.push('seat covered by controls');
          }
        }
        return issues;
      });
      expect.soft(issues, `${name} ${fixture}`).toEqual([]);
      await page.screenshot({ path: `artifacts/mobile-frame-${fixture}-${name}.png`, fullPage: true });
      if (width > 340 && width <= 760) {
        const card = await page.locator('.position-4 .hole-cards .playing-card').first().boundingBox();
        expect(card!.width).toBeGreaterThanOrEqual(28);
        expect(card!.height).toBeGreaterThanOrEqual(40);
      }
    }
  }
});

test('mobile controls remain stable between turns and personal tools use live player state', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const push = await mount(page, 'table_actions');
  const before = await page.locator('.action-bar').boundingBox();
  await expect(page.getByLabel('加注金额', { exact: true })).toBeVisible();
  const waiting = structuredClone(fixtures.table_actions);
  waiting.legal = null;
  waiting.hand!.clock!.pid = waiting.players.find(p => p.id !== waiting.me && p.seat !== null)!.id;
  push(waiting);
  await expect(page.getByLabel('加注金额', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('加注滑块', { exact: true })).toBeDisabled();
  expect(await page.locator('.action-bar').boundingBox()).toEqual(before);
  await page.locator('.own-seat .occupied').click();
  await expect(page.getByRole('dialog').getByRole('button', { name: '补码', exact: true })).toBeVisible();
  const updated = structuredClone(waiting);
  updated.players.find(p => p.id === updated.me)!.away = true;
  push(updated);
  await expect(page.getByRole('dialog').getByRole('button', { name: '回到游戏', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: '离座', exact: true })).toBeVisible();
  const me = updated.players.find(p => p.id === updated.me)!;
  updated.requests = [{ id: 'pending-topup', kind: 'topup', pid: me.id, name: me.name,
    seat: me.seat!, amount: 200, approved: false }];
  push(updated);
  await expect(page.getByRole('dialog').getByText('等待房主审批', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: '取消申请', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('button', { name: '补码', exact: true })).toBeDisabled();
});

test('mobile approval shortcut counts actionable requests and opens management', async ({ page }) => {
  const state = structuredClone(fixtures.table_actions);
  state.requests = state.players.filter(p => p.seat !== null && p.id !== state.me).slice(0, 2).map((p, i) => ({
    id: `request-${i}`, kind: 'topup', pid: p.id, name: p.name, seat: p.seat!, amount: 200, approved: i === 1,
  }));
  const push = await mount(page, state);
  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: 740 });
    push(state);
    await expect(page.getByRole('button', { name: '待审批 1 项', exact: true })).toBeVisible();
    const left = await page.locator('.header-left').boundingBox();
    const right = await page.locator('.header-right').boundingBox();
    expect(left!.x + left!.width).toBeLessThanOrEqual(right!.x + 1);
    expect(right!.x + right!.width).toBeLessThanOrEqual(width);
  }
  await page.getByRole('button', { name: '待审批 1 项', exact: true }).click();
  await expect(page.locator('.side-panel')).toBeInViewport();
  await expect(page.getByRole('button', { name: `批准 ${state.requests[0].name}`, exact: true })).toBeVisible();
});

test('player frames keep names, progress and complete winnings readable through crowded states', async ({ page }) => {
  const initial = structuredClone(fixtures.table_actions);
  initial.players.forEach((player, index) => { player.name = `长昵称玩家${index}二十个字符需要省略展示`; });
  initial.players.find(player => player.id === initial.me)!.online = false;
  initial.players.find(player => player.id === initial.me)!.leave = true;
  const push = await mount(page, initial);
  for (const [width, height] of [[1440, 960], [1366, 768], [1024, 800], [800, 800], [761, 800], [390, 844], [360, 740], [320, 568]]) {
    await page.setViewportSize({ width, height });
    push(initial);
    await expect(page.locator('.seat-timer, .seat-bank')).toHaveCount(0);
    const name = page.locator('.own-seat .seat-name');
    const before = await name.boundingBox();
    expect(before!.width, `${width} nickname remains readable with owner, offline and leaving status`).toBeGreaterThanOrEqual(24);
    await expect(page.locator('.turn-track')).toHaveCount(1);
    const bank = structuredClone(initial);
    bank.hand!.clock!.base_until = bank.server_time - 1;
    bank.hand!.clock!.until = bank.server_time + 9;
    bank.hand!.clock!.initial = 10;
    push(bank);
    await expect(page.locator('.turn-progress')).toHaveClass(/bank/);
    expect(await name.boundingBox()).toEqual(before);
    for (let dealer = 0; dealer < 9; dealer++) {
      const dealerState = structuredClone(bank);
      dealerState.button = dealer;
      push(dealerState);
      await expect(page.locator(`.position-${dealer} .dealer`)).toHaveCount(1);
      const dealerIssues = await page.evaluate(() => {
        const marker = document.querySelector('.dealer')!.getBoundingClientRect();
        return [...document.querySelectorAll('.seat-name, .seat-state, .seat-owner, .offline-icon, .stack, .seat-payout, .seat-hand-label, .hole-cards, .seat-bet, .boards')].filter(item => {
          const rect = item.getBoundingClientRect();
          return Math.min(rect.right, marker.right) - Math.max(rect.left, marker.left) > 1 && Math.min(rect.bottom, marker.bottom) - Math.max(rect.top, marker.top) > 1;
        }).map(item => item.className);
      });
      expect.soft(dealerIssues, `${width} dealer at ${dealer}`).toEqual([]);
    }
    const nextStreet = structuredClone(bank);
    nextStreet.players.forEach(player => { player.bet = 0; });
    nextStreet.hand!.last_actions = {};
    push(nextStreet);
    await expect(page.locator('.seat-state.all-in')).toHaveCount(2);
    const result = structuredClone(fixtures.nine_twice);
    result.players.forEach(player => { player.name = initial.players.find(p => p.id === player.id)?.name || '很长的玩家昵称'; player.stack = 123456789; });
    result.hand!.result!.forEach(row => { if (row.won) row.won = 987654321; });
    push(result);
    await expect(page.locator('.turn-track')).toHaveCount(0);
    await expect(page.locator('.seat-payout')).toHaveCount(0);
    await expect(page.locator('.seat-hand-label > span')).toHaveCount(9);
    const issues = await page.evaluate(() => {
      const intersects = (a: DOMRect, b: DOMRect) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1 && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1;
      const issues: string[] = [];
      const frames = [...document.querySelectorAll('.seat.occupied')];
      for (const [i, seat] of frames.entries()) {
        const frame = seat.getBoundingClientRect();
        const name = seat.querySelector('.seat-name')!;
        if (name.getBoundingClientRect().width < 24) issues.push('nickname has less than two characters of space');
        const elements = [...seat.querySelectorAll('.seat-name, .seat-state, .seat-owner, .offline-icon, .stack, .seat-payout, .seat-hand-label')];
        for (const [j, element] of elements.entries()) {
          const rect = element.getBoundingClientRect();
          if (elements.slice(j + 1).some(other => intersects(rect, other.getBoundingClientRect()))) issues.push(`${element.className} overlaps another item`);
          if (rect.left < frame.left || rect.right > frame.right || rect.bottom > frame.bottom) issues.push(`${element.className} leaves frame`);
          if (element.matches('.stack, .seat-payout, .seat-hand-label')) {
            const range = document.createRange();
            range.selectNodeContents(element);
            for (const text of range.getClientRects()) {
              if (text.left < frame.left || text.right > frame.right || text.bottom > frame.bottom) issues.push(`${element.className} text clipped`);
            }
            if (element.matches('.stack, .seat-payout') && range.getBoundingClientRect().height > parseFloat(getComputedStyle(element).lineHeight)) {
              issues.push(`${element.className} amount split across lines`);
            }
          }
        }
        for (const other of frames.slice(i + 1)) if (intersects(frame, other.getBoundingClientRect())) issues.push('player frames overlap');
        for (const cards of document.querySelectorAll('.hole-cards')) {
          if (cards.parentElement === seat.parentElement) continue;
          if (intersects(frame, cards.getBoundingClientRect())) issues.push(`${seat.parentElement!.className} overlaps ${cards.parentElement!.className} cards`);
        }
        if (intersects(frame, document.querySelector('.boards')!.getBoundingClientRect())) issues.push('frame overlaps board');
      }
      if (document.documentElement.scrollWidth > innerWidth) issues.push('horizontal overflow');
      return issues;
    });
    expect.soft(issues, `${width} crowded results`).toEqual([]);
    await page.locator('.own-seat .seat-hand-label').scrollIntoViewIfNeeded();
    await expect(page.locator('.own-seat .seat-hand-label')).toBeInViewport();
    await expect(page.locator('.action-bar')).toBeInViewport();
    await page.screenshot({ path: `artifacts/player-polish-crowded-${width}.png`, fullPage: true });
  }
});

test('settlement raises whole winning cards once and dims only visible non-winning faces', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const result = structuredClone(fixtures.side_pots);
  const before = structuredClone(result);
  before.hand!.result = null;
  const push = await mount(page, before);
  await page.evaluate(() => {
    (window as any).winningAnimations = 0;
    document.addEventListener('animationstart', event => {
      if (event.animationName === 'winning-card-rise') (window as any).winningAnimations++;
    });
  });
  push(result);
  await expect.poll(() => page.evaluate(() => (window as any).winningAnimations)).toBeGreaterThan(0);
  const winners = page.locator('.table-stage .playing-card.winning-card');
  await expect(winners.first()).toHaveCSS('translate', '0px -8px');
  await expect(page.locator('.hole-cards .winning-card').first()).toHaveCSS('translate', '0px -6px');
  await expect(winners.first()).toHaveCSS('background-color', 'rgb(255, 244, 201)');
  await expect(page.locator('.winning-card-enter')).toHaveCount(0);
  const count = await page.evaluate(() => (window as any).winningAnimations);
  expect(count).toBe(await winners.count());
  const cards = await page.locator('.table-stage .playing-card').evaluateAll(nodes => nodes.map(node => ({
    winning: node.classList.contains('winning-card'),
    dimmed: node.classList.contains('dimmed-card'),
    filter: getComputedStyle(node).filter,
  })));
  expect(cards.some(card => card.dimmed)).toBeTruthy();
  expect(cards.every(card => card.winning ? !card.dimmed : card.dimmed && card.filter === 'brightness(0.55)')).toBeTruthy();
  await page.screenshot({ path: 'artifacts/ui-20260917-winning-mobile.png', fullPage: true });
  push(result);
  const expired = structuredClone(result);
  expired.hand!.reveal_until = expired.server_time - 1;
  push(expired);
  await expect(page.locator('.table-stage')).toHaveClass(/showing-result/);
  await expect(page.locator('.seat-payout')).toHaveCount(0);
  await expect(page.locator('.winning-seat').first()).toBeVisible();
  await expect(page.locator('.reveal-card')).toHaveCount(0);
  await expect(winners).toHaveCount(count);
  expect(await page.evaluate(() => (window as any).winningAnimations)).toBe(count);
  await page.reload();
  await expect(winners).toHaveCount(count);
  await expect(page.locator('.winning-card-enter')).toHaveCount(0);
  await expect(winners.first()).toHaveCSS('translate', '0px -8px');
});

test('reconnecting to a hand settled while offline does not replay winning animations', async ({ page }) => {
  const before = structuredClone(fixtures.side_pots);
  before.hand!.result = null;
  const push = await mount(page, before);
  await page.evaluate(() => {
    (window as any).winningAnimations = 0;
    document.addEventListener('animationstart', event => {
      if (event.animationName === 'winning-card-rise') (window as any).winningAnimations++;
    });
  });
  push.reconnectWith('side_pots');
  await expect(page.locator('.connection')).toHaveClass(/offline/);
  await expect(page.locator('.connection')).toHaveClass(/connected/);
  await expect(page.locator('.boards .winning-card').first()).toHaveCSS('translate', '0px -8px');
  await expect(page.locator('.winning-card-enter')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).winningAnimations)).toBe(0);
});

test('result dimming respects hidden cards, folded brightness, no-showdown wins and reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const before = structuredClone(fixtures.folded_after);
  before.hand!.result = null;
  const push = await mount(page, before);
  push('folded_after');
  await expect(page.locator('.boards .winning-card').first()).toHaveCSS('animation-name', 'none');
  await expect(page.locator('.boards .winning-card').first()).toHaveCSS('translate', '0px -8px');
  await expect(page.locator('.hole-cards.folded')).toHaveCSS('filter', 'brightness(0.55)');
  for (const card of await page.locator('.hole-cards.folded .playing-card').all()) await expect(card).toHaveCSS('filter', 'none');
  const hidden = structuredClone(fixtures.side_pots);
  const loser = hidden.players.find(player => player.seat !== null && !hidden.hand!.showdown_results!.some(group => group.pot === 0 && group.winners.some(w => w.pid === player.id)))!;
  loser.cards = [null, null];
  push(hidden);
  await expect(page.locator('.hole-cards .back')).toHaveCount(2);
  await expect(page.locator('.back.dimmed-card, .back.winning-card')).toHaveCount(0);
  const uncontested = structuredClone(hidden);
  uncontested.hand!.showdown_results = [];
  push(uncontested);
  await expect(page.locator('.winning-card, .dimmed-card')).toHaveCount(0);
  const next = structuredClone(fixtures.preflop);
  next.number = next.hand!.number = hidden.number + 1;
  push(next);
  await expect(page.locator('.winning-card, .dimmed-card')).toHaveCount(0);
});

test('mobile overlapping hole cards preserve both independent reveal targets', async ({ page }) => {
  const commands: number[][] = [];
  await page.route('**/api/rooms/presentation/commands', route => {
    commands.push(route.request().postDataJSON().cards);
    return route.fulfill({ json: { ok: true } });
  });
  const push = await mount(page, 'folded_after');
  for (const width of [320, 360, 390, 760]) {
    await page.setViewportSize({ width, height: 844 });
    push('folded_after');
    const pair = page.locator('.own-seat .hole-cards .reveal-card');
    await expect(pair).toHaveCount(2);
    const left = (await pair.nth(0).boundingBox())!;
    const right = (await pair.nth(1).boundingBox())!;
    expect(right.x).toBeGreaterThan(left.x);
    expect(right.x).toBeLessThan(left.x + left.width);
    await pair.nth(0).click();
    await pair.nth(1).click();
    expect(commands.slice(-2)).toEqual([[0], [1]]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
  const waiting = structuredClone(fixtures.preflop);
  waiting.started = false;
  waiting.hand = null;
  waiting.players.forEach(player => { player.cards = []; });
  push(waiting);
  await expect(page.locator('.hole-card-outline')).toHaveCount(4);
  await expect(page.locator('.hole-card-outline').first()).not.toHaveCSS('transform', 'none');
});

test('mobile hole-card ranks and suits remain visible above overlapping cards and player frames', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const snapshot = structuredClone(fixtures.tie);
  snapshot.players.filter(player => player.seat !== null).forEach((player, index) => {
    player.cards = [`T${['c', 's', 'h', 'd'][index % 4]}`, 'Ad'];
  });
  const push = await mount(page, snapshot);
  // Include non-interactive card faces in hit testing without changing their paint order.
  await page.addStyleTag({ content: '.hole-cards, .hole-cards * { pointer-events: auto !important; }' });
  for (const width of [320, 360, 390, 760]) {
    await page.setViewportSize({ width, height: 844 });
    push(snapshot);
    const glyphs = page.locator('.hole-cards .playing-card > b, .hole-cards .playing-card > span');
    for (const glyph of await glyphs.all()) {
      await glyph.scrollIntoViewIfNeeded();
      const hidden = await glyph.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const card = node.closest('.playing-card')!;
        const points = [
          [rect.left + 2, rect.top + rect.height / 2],
          [rect.right - 2, rect.top + rect.height / 2],
          [rect.left + rect.width / 2, rect.bottom - 2],
        ];
        return points.filter(([x, y]) => !card.contains(document.elementFromPoint(x, y))).map(() =>
          `${card.closest('.seat-wrap')!.className}: ${node.textContent}`);
      });
      expect.soft(hidden, `${width}px glyph occlusion`).toEqual([]);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  push('tie');
  await expect(page.locator('.own-seat .playing-card > b').first()).toHaveText(
    fixtures.tie.players.find(player => player.id === fixtures.tie.me)!.cards[0]![0]);
  await page.locator('.table-toolbar').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'artifacts/ui-20260917-suits-mobile-fixed.png', fullPage: true });
});

test('settled stacks remain on one line without a payout capsule at all breakpoints', async ({ page }) => {
  const result = structuredClone(fixtures.tie);
  result.players.forEach(player => { player.stack = 200; });
  result.hand!.result!.forEach(row => { row.won = 123; });
  const push = await mount(page, result);
  for (const width of [320, 360, 390, 760, 761, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    push(result);
    await expect(page.locator('.seat-payout')).toHaveCount(0);
    const issues = await page.locator('.seat-stack-row').evaluateAll(rows => rows.flatMap(row => {
      const stack = row.querySelector('.stack')!.getBoundingClientRect();
      const bounds = row.getBoundingClientRect();
      return stack.left < bounds.left - 1 || stack.right > bounds.right + 1 ? ['stack overflows row'] : [];
    }));
    expect(issues, `${width}px`).toEqual([]);
  }
});
