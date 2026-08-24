import { expect, test } from "@playwright/test";

// Telegram Mini App shaped checks for the 5-step checkout: a genuine
// window.Telegram.WebApp with initData (so initializeTelegramMiniApp
// actually activates -- see src/telegramMiniApp.ts), a typical in-app
// browser viewport, and the native BackButton.
async function installTelegramWebApp(page: import("@playwright/test").Page) {
  // index.html loads the real telegram-web-app.js from telegram.org --
  // outside an actual Telegram client it would set window.Telegram.WebApp
  // with an EMPTY initData, executing after (and overwriting) the mock
  // this function installs via addInitScript. Block it so the mock below
  // is what main.tsx's initializeTelegramMiniApp() actually sees.
  await page.route("https://telegram.org/js/telegram-web-app.js*", (route) => route.abort());
  await page.addInitScript(() => {
    const backButtonClickHandlers: Array<() => void> = [];
    (window as unknown as { Telegram: unknown }).Telegram = {
      WebApp: {
        initData: "auth_date=1&hash=test-signed-hash",
        platform: "ios",
        colorScheme: "light",
        themeParams: {},
        ready: () => {},
        expand: () => {},
        setHeaderColor: () => {},
        setBackgroundColor: () => {},
        BackButton: {
          isVisible: false,
          show() {
            this.isVisible = true;
          },
          hide() {
            this.isVisible = false;
          },
          onClick(cb: () => void) {
            backButtonClickHandlers.push(cb);
          },
          offClick(cb: () => void) {
            const index = backButtonClickHandlers.indexOf(cb);
            if (index >= 0) backButtonClickHandlers.splice(index, 1);
          },
        },
      },
    };
    (window as unknown as { __zaytunTelegramBackButtonTap: () => void }).__zaytunTelegramBackButtonTap = () => {
      for (const cb of [...backButtonClickHandlers]) cb();
    };
  });
}

const tapTelegramBackButton = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __zaytunTelegramBackButtonTap: () => void }).__zaytunTelegramBackButtonTap());

async function openCheckout(page: import("@playwright/test").Page) {
  await page.goto("/menu/chicken");
  await page.getByRole("button", { name: "+" }).click();
  await page.getByTestId("buy-now").click();
  await page.waitForURL("**/checkout");
}

test.describe("Telegram Mini App shaped checkout", () => {
  test.use({ viewport: { width: 390, height: 700 } }); // a typical in-app browser viewport, shorter than a full-screen mobile browser

  test("the basket shows a complete free-delivery goal before checkout", async ({ page }) => {
    await installTelegramWebApp(page);
    await page.goto("/menu/chicken");
    await page.getByRole("button", { name: "+" }).click();
    await page.getByTestId("add-to-cart").click();
    await page.getByTestId("cart-pill").click();
    await expect(page.getByTestId("cart-delivery-progress")).toContainText(/Bepul yetkazishgacha|Yetkazib berish bepul/);
    await expect(page.getByTestId("cart-delivery-progress")).not.toHaveCSS("overflow", "hidden");
  });

  test("deliberate horizontal swipes move forward and backward through the three customer tabs", async ({ page }) => {
    await installTelegramWebApp(page);
    const swipe = async (fromX: number, toX: number) => {
      const target = page.locator("main").first();
      await target.dispatchEvent("touchstart", { touches: [{ identifier: 1, clientX: fromX, clientY: 420 }] });
      await target.dispatchEvent("touchend", { changedTouches: [{ identifier: 1, clientX: toX, clientY: 424 }] });
    };
    await page.goto("/menu");
    await swipe(340, 35);
    await expect(page).toHaveURL(/\/cart$/);
    await swipe(340, 35);
    await expect(page).toHaveURL(/\/orders$/);
    await swipe(35, 340);
    await expect(page).toHaveURL(/\/cart$/);
    await swipe(35, 340);
    await expect(page).toHaveURL(/\/menu$/);
  });

  test("the telegram-mini-app class activates and the Telegram BackButton steps backward through the wizard, then returns to the cart from Step 1", async ({ page }) => {
    await installTelegramWebApp(page);
    await openCheckout(page);
    await expect(page.locator("html.telegram-mini-app")).toHaveCount(1);
    await expect(page.getByTestId("checkout-step-1")).toBeVisible();

    await page.getByTestId("type-pickup").click();
    await page.getByLabel("Ism *").fill("Telegram Mijoz");
    await page.getByLabel("Telefon *").fill("+998901112233");
    await page.getByTestId("checkout-continue").click();
    await expect(page.getByTestId("checkout-step-4")).toBeVisible();

    // The native BackButton (not the on-page "Orqaga" button) steps back
    // exactly one wizard step, same as the on-page control.
    await tapTelegramBackButton(page);
    await expect(page.getByTestId("checkout-step-1")).toBeVisible();
    // Preserved across the BackButton navigation, same as the on-page Back.
    await expect(page.getByLabel("Ism *")).toHaveValue("Telegram Mijoz");

    // From Step 1, the BackButton returns to the cart -- it must never
    // silently close the Mini App while checkout is genuinely in progress.
    await tapTelegramBackButton(page);
    await expect(page).toHaveURL(/\/cart$/);
  });

  test("no horizontal overflow at the Telegram in-app viewport across Step 1 and the full-screen map step", async ({ page }) => {
    await installTelegramWebApp(page);
    await openCheckout(page);
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const documentScroll = () => page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);
    expect(await overflow()).toBe(0);
    expect(await documentScroll()).toBeLessThanOrEqual(0);

    await page.getByLabel("Ism *").fill("Telegram Mijoz");
    await page.getByLabel("Telefon *").fill("+998901112233");
    await page.getByTestId("checkout-continue").click();
    await expect(page.getByTestId("checkout-step-map")).toBeVisible();
    expect(await overflow()).toBe(0);
    expect(await documentScroll()).toBeLessThanOrEqual(0);
  });

  test("a shrunk viewport (simulating the iOS keyboard covering part of the screen) still keeps the focused field and the Continue action reachable", async ({ page }) => {
    await installTelegramWebApp(page);
    await openCheckout(page);
    // Roughly what remains above a real iOS keyboard on a 700px-tall
    // in-app browser viewport.
    await page.setViewportSize({ width: 390, height: 380 });
    const nameField = page.getByLabel("Ism *");
    await nameField.click();
    await nameField.fill("Telegram Mijoz");
    await expect(nameField).toBeInViewport();
    // The sticky Continue action never becomes permanently unreachable --
    // it can still be scrolled into view and clicked.
    const continueButton = page.getByTestId("checkout-continue");
    await continueButton.scrollIntoViewIfNeeded();
    await expect(continueButton).toBeVisible();
  });

  test("prefers-reduced-motion disables the step-transition animation", async ({ page }) => {
    await installTelegramWebApp(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openCheckout(page);
    const animationName = await page.locator(".checkout-step-body").evaluate((el) => getComputedStyle(el).animationName);
    expect(animationName).toBe("none");
  });

  test("the normal browser back button (not Telegram's) still leaves the checkout page in a safe, non-crashing state", async ({ page }) => {
    await installTelegramWebApp(page);
    await openCheckout(page);
    await page.getByLabel("Ism *").fill("Browser Back Mijoz");
    await page.goBack();
    await expect(page).toHaveURL(/\/menu\/chicken$/);
    // The app is still fully functional afterward -- no crash, no stuck state.
    await page.goForward();
    await expect(page.getByTestId("checkout-wizard")).toBeVisible();
  });
});
