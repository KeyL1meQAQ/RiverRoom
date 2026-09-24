import { expect, test } from "@playwright/test";

test("seated players can send transient bubbles and throws across desktop and mobile", async ({ browser, baseURL }) => {
  const host = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const guest = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const observer = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const [a, b, c] = await Promise.all([host.newPage(), guest.newPage(), observer.newPage()]);
  const errors: string[] = [];
  for (const page of [a, b, c]) page.on("pageerror", error => errors.push(error.message));
  try {
    await a.goto(baseURL!);
    await a.getByLabel("房间名称").fill("互动测试");
    await a.getByRole("button", { name: "创建房间" }).click();
    await expect(a.getByRole("heading", { name: "互动测试" })).toBeVisible();
    await expect(a.locator(".connection")).toHaveClass(/connected/);
    const url = a.url();
    await a.getByRole("button", { name: "入座 1 号位" }).click();
    await a.getByLabel("昵称", { exact: true }).fill("房主");
    await a.getByLabel("买入筹码").fill("200");
    await a.getByRole("button", { name: "确认入座" }).click();

    await b.goto(url);
    await b.getByRole("button", { name: "入座 5 号位" }).click();
    await b.getByLabel("昵称", { exact: true }).fill("客人");
    await b.getByLabel("买入筹码").fill("200");
    await b.getByRole("button", { name: "提交入座申请" }).click();
    await a.getByRole("button", { name: "日志和统计" }).click();
    await a.getByRole("button", { name: "管理", exact: true }).click();
    await a.getByRole("button", { name: "批准 客人" }).click();
    await a.locator(".side-panel").getByRole("button", { name: "关闭侧栏" }).click();
    await c.goto(url);
    await expect(c.locator(".connection")).toHaveClass(/connected/);

    await a.getByRole("button", { name: "发送气泡" }).click();
    await a.getByRole("tab", { name: "短句" }).click();
    await a.getByRole("button", { name: "发送 我很抱歉" }).click();
    await expect(b.locator(".table-bubble")).toContainText("我很抱歉");
    await expect(c.locator(".table-bubble")).toContainText("我很抱歉");
    await expect(b.locator(".throw-flight")).toHaveCount(0);
    await b.screenshot({ path: "artifacts/interactions-bubble-mobile.png" });
    await a.getByRole("button", { name: "发送气泡" }).click();
    await expect(a.getByRole("button", { name: "发送 😏" })).toBeEnabled();
    await a.getByRole("button", { name: "发送 😏" }).click();
    await expect(b.locator(".table-bubble")).toHaveCount(1);
    await expect(b.locator(".table-bubble")).toContainText("😏");
    await c.reload();
    await expect(c.locator(".connection")).toHaveClass(/connected/);
    await expect(c.locator(".table-bubble")).toHaveCount(0);

    await b.locator(".seat.occupied").filter({ hasText: "房主" }).click();
    await b.getByRole("button", { name: "向 房主 十连投掷番茄" }).click();
    await expect(a.locator(".throw-flight")).toHaveCount(10);
    await expect(c.locator(".throw-flight")).toHaveCount(10);
    await b.waitForTimeout(550);
    await expect(b.locator(".throw-flight").first()).toHaveCSS("opacity", "1");
    await b.screenshot({ path: "artifacts/interactions-burst-mobile.png" });
    await a.screenshot({ path: "artifacts/interactions-burst-desktop.png" });
    await b.locator(".seat.occupied").filter({ hasText: "房主" }).click();
    await expect(b.getByRole("button", { name: "向 房主 扔一个番茄" })).toBeDisabled();
    await b.getByRole("button", { name: "关闭", exact: true }).click();

    await c.getByRole("button", { name: "隐藏互动" }).click();
    await expect(c.getByRole("button", { name: "显示互动" })).toBeVisible();
    await expect(a.getByRole("button", { name: "发送气泡" })).toBeEnabled();
    await a.getByRole("button", { name: "发送气泡" }).click();
    await a.getByRole("button", { name: "发送 😏" }).click();
    await expect(b.locator(".table-bubble")).toContainText("😏");
    await expect(c.locator(".table-bubble")).toHaveCount(0);

    await a.locator(".seat.occupied").filter({ hasText: "客人" }).click();
    await a.getByRole("button", { name: "移除玩家" }).click();
    await expect(a.getByRole("dialog")).toContainText("之后可重新申请入座");
    await a.getByRole("dialog").getByRole("button", { name: "确认" }).click();
    await expect(b.locator(".seat.occupied")).toHaveCount(1);
    await b.getByRole("button", { name: "入座 5 号位" }).click();
    await b.getByLabel("昵称", { exact: true }).fill("客人");
    await b.getByLabel("买入筹码").fill("200");
    await b.getByRole("button", { name: "提交入座申请" }).click();
    await a.getByRole("button", { name: "日志和统计" }).click();
    await a.getByRole("button", { name: "管理", exact: true }).click();
    await a.getByRole("button", { name: "批准 客人" }).click();
    await expect(b.locator(".seat.occupied")).toHaveCount(2);
    await b.setViewportSize({ width: 320, height: 740 });
    await b.getByRole("button", { name: "发送气泡" }).click();
    await b.getByRole("tab", { name: "短句" }).click();
    const picker = await b.locator(".interaction-picker").boundingBox();
    expect(picker).not.toBeNull();
    expect(picker!.x).toBeGreaterThanOrEqual(0);
    expect(picker!.x + picker!.width).toBeLessThanOrEqual(320);
    await b.screenshot({ path: "artifacts/interactions-picker-320.png" });
    await b.getByRole("button", { name: "关闭气泡菜单" }).click();
    await b.emulateMedia({ reducedMotion: "reduce" });
    await b.locator(".seat.occupied").filter({ hasText: "房主" }).click();
    const single = b.getByRole("button", { name: "向 房主 扔一个鸡蛋" });
    await expect(single).toBeEnabled();
    await single.click();
    await expect(b.locator(".throw-flight").first()).toHaveCSS("animation-name", "throw-reduced");
    expect(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
    expect(errors).toEqual([]);
  } finally {
    await Promise.allSettled([host.close(), guest.close(), observer.close()]);
  }
});
