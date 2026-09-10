import { expect, test, type Page } from "@playwright/test";

type CopyWindow = Window & { readCopiedText: () => Promise<string> };
type CopyMode = "native" | "unavailable" | "denied" | "blocked" | "throws";

async function configureClipboard(page: Page, mode: CopyMode) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.addInitScript((mode) => {
    (window as unknown as CopyWindow).readCopiedText =
      navigator.clipboard.readText.bind(navigator.clipboard);
    if (mode === "denied") {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) },
      });
    } else if (mode !== "native") {
      Object.defineProperty(navigator, "clipboard", { value: undefined });
    }
    if (mode === "blocked" || mode === "throws") {
      document.execCommand = () => {
        if (mode === "throws") throw new DOMException("Denied", "NotAllowedError");
        return false;
      };
    }
  }, mode);
}

async function openRoom(page: Page) {
  const response = await page.request.post("/api/rooms", {
    data: { name: "复制邀请验收", settings: {} },
  });
  expect(response.ok()).toBeTruthy();
  const room = await response.json();
  await page.goto(`/r/${room.id}`);
  await expect(page.locator(".connection")).toHaveClass(/connected/);
}

async function expectClearToast(page: Page, message: string) {
  const dialog = page.locator("dialog[open]");
  const status = dialog.getByRole("status");
  await expect(status).toHaveText(message);
  await expect(status).toBeInViewport();
  await expect(page.getByRole("status")).toHaveCount(1);
  expect(await status.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const modal = element.closest("dialog")!.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const field = element.closest("dialog")!.querySelector(".copy-field")?.getBoundingClientRect();
    return !!hit && element.contains(hit) && bounds.left >= modal.left &&
      bounds.right <= modal.right && bounds.bottom <= modal.bottom &&
      (!field || field.bottom <= bounds.top);
  })).toBeTruthy();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
}

for (const viewport of [{ width: 1440, height: 960 }, { width: 320, height: 568 }]) {
  for (const mode of ["native", "unavailable", "denied", "blocked", "throws"] as const) {
    test(`invitation and recovery copy: ${mode}, ${viewport.width}px`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.setViewportSize(viewport);
      await configureClipboard(page, mode);
      await openRoom(page);
      const state = await (await page.request.get(`/api/rooms/${page.url().split("/").pop()}`)).json();
      const failed = mode === "blocked" || mode === "throws";
      const message = failed ? "请长按或手动复制" : "已复制";

      for (const field of [
        { open: "邀请朋友", label: "邀请链接", button: "复制邀请链接", value: page.url() },
        { open: "房间身份", label: "我的召回码", button: "复制召回码", value: state.recovery_code },
      ]) {
        await page.getByRole("button", { name: field.open, exact: true }).click();
        await page.getByRole("button", { name: field.button, exact: true }).click();
        await expectClearToast(page, message);
        if (failed) {
          const input = page.getByRole("textbox", { name: field.label, exact: true });
          await expect(input).toBeFocused();
          expect(await input.evaluate((element: HTMLInputElement) =>
            element.selectionStart === 0 && element.selectionEnd === element.value.length,
          )).toBeTruthy();
        } else {
          expect(await page.evaluate(() => (window as unknown as CopyWindow).readCopiedText())).toBe(field.value);
        }
        await expect(page.locator("dialog textarea")).toHaveCount(0);
        if (field.label === "邀请链接" && (mode === "native" || mode === "blocked")) {
          await page.screenshot({ path: `artifacts/copy-${mode}-${viewport.width}.png`, fullPage: true });
        }
        await page.getByRole("button", { name: "关闭提示", exact: true }).click();
        await expect(page.getByRole("status")).toHaveCount(0);
        await expect(page.locator("dialog[open]")).toBeVisible();
        await page.getByRole("button", { name: "关闭", exact: true }).click();
      }
      expect(errors).toEqual([]);
    });
  }
}

test("toast follows the active modal and repeated messages restart its timer", async ({ page }) => {
  await configureClipboard(page, "native");
  await openRoom(page);
  await page.clock.install();
  await page.getByRole("button", { name: "邀请朋友", exact: true }).click();
  await page.getByRole("button", { name: "复制邀请链接", exact: true }).click();
  await expectClearToast(page, "已复制");
  await page.clock.fastForward(3000);
  await page.getByRole("button", { name: "复制邀请链接", exact: true }).click();
  await page.clock.fastForward(2000);
  await expectClearToast(page, "已复制");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.locator("body > .toast")).toHaveText("已复制");
  await page.getByRole("button", { name: "房间身份", exact: true }).click();
  await expectClearToast(page, "已复制");
  await page.clock.fastForward(2600);
  await expect(page.getByRole("status")).toHaveCount(0);

  await page.getByRole("button", { name: "召回其他身份", exact: true }).click();
  await page.getByRole("textbox", { name: "召回码", exact: true }).fill("INVALID");
  await page.getByRole("button", { name: "召回并接管", exact: true }).click();
  await expect(page.locator("dialog[open]").getByRole("status")).toBeVisible();
  await page.getByRole("button", { name: "关闭提示", exact: true }).click();
  await expect(page.locator("dialog[open]")).toBeVisible();
});
