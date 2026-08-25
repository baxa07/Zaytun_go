import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

const orderId = "db000000-0000-4000-8000-000000000001";
const password = "zaytun-local-2026";
const psql = (sql: string) => execFileSync(
  "psql",
  ["postgresql://postgres:postgres@127.0.0.1:54322/postgres", "-v", "ON_ERROR_STOP=1", "-Atc", sql],
  { encoding: "utf8" },
).trim();

async function installTelegramStaffApp(page: Page) {
  await page.route("https://telegram.org/js/telegram-web-app.js*", (route) => route.abort());
  await page.addInitScript(() => {
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
        setBottomBarColor: () => {},
        disableVerticalSwipes: () => {},
        requestFullscreen: () => {},
        BackButton: { show: () => {}, hide: () => {}, onClick: () => {}, offClick: () => {} },
      },
    };
  });
}

async function signIn(page: Page) {
  await page.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
  await page.getByLabel("Parol").fill(password);
  await page.getByRole("button", { name: "Kirish" }).click();
}

test("staff Telegram Mini App is a one-column phone board and accepts/starts in one tap", async ({ page }) => {
  test.setTimeout(60_000);
  psql(`delete from public.orders where id='${orderId}'; select public.create_public_order('{"id":"${orderId}","customer":{"name":"Mobile Operator","primaryPhone":"+998900000601"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"ayran","quantity":1,"modifierIds":[]}]}'::jsonb);`);
  await installTelegramStaffApp(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/restaurant");
  await signIn(page);

  await expect(page.locator("html")).toHaveClass(/telegram-staff-mini-app/);
  await expect(page.getByRole("tablist", { name: "Buyurtma bosqichlari" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Yangi/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId(`order-card-${orderId}`)).toBeVisible();
  expect(await page.locator(".board .column").evaluateAll((nodes) => nodes.filter((node) => getComputedStyle(node).display !== "none").length)).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const navBox = await page.getByTestId("operational-navigation").boundingBox();
  expect(navBox).not.toBeNull();
  expect(navBox!.y + navBox!.height).toBeLessThanOrEqual(844);

  await page.getByTestId(`order-card-${orderId}`).click();
  await expect(page.getByTestId("action-confirm")).toHaveText("Qabul qilish va tayyorlashni boshlash");
  const actionTop = await page.locator(".action-panel").evaluate((node) => node.getBoundingClientRect().top);
  const detailsTop = await page.locator(".detail-grid>.stack").evaluate((node) => node.getBoundingClientRect().top);
  expect(actionTop).toBeLessThan(detailsTop);
  await page.getByTestId("action-confirm").click();
  await expect(page.locator(".detail-head .badge")).toHaveText("Tayyorlanmoqda");
  await expect(page.getByTestId("action-start-prep")).toHaveCount(0);
  expect(psql(`select status from public.orders where id='${orderId}'`)).toBe("PREPARING");
  expect(psql(`select count(*) from public.order_events where order_id='${orderId}' and new_status in('CONFIRMED','PREPARING')`)).toBe("2");
  psql(`delete from public.orders where id='${orderId}'`);
});
