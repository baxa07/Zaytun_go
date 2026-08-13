import { expect, test } from "@playwright/test";

// Restaurant UI Phase 1: live incoming orders + preparing workflow.
// Neither test below ever calls staff.reload() -- the whole point is
// proving the board and detail page update themselves via the existing
// postgres_changes-based realtime subscription (state.tsx's subscribe(),
// wired for authenticated staff/driver sessions) while a customer order
// and staff actions happen from separate, real, signed-in sessions.
const localPassword = "zaytun-local-2026";

async function signInStaff(page: import("@playwright/test").Page) {
  await page.goto("/restaurant");
  await page.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
  await page.getByLabel("Parol").fill(localPassword);
  await page.getByRole("button", { name: "Kirish" }).click();
  await expect(page.getByRole("button", { name: "Chiqish" })).toBeVisible();
}

test("a new delivery order appears on the restaurant board live, with no reload, and stays synchronized across two staff sessions", async ({ browser }) => {
  const staff1Context = await browser.newContext();
  const staff2Context = await browser.newContext();
  const customerContext = await browser.newContext();
  const staff1 = await staff1Context.newPage();
  const staff2 = await staff2Context.newPage();
  const customer = await customerContext.newPage();

  await signInStaff(staff1);
  await signInStaff(staff2);

  await customer.goto("/menu/chicken");
  await customer.getByRole("button", { name: "+" }).click();
  await customer.getByTestId("buy-now").click();
  await customer.waitForURL("**/checkout");
  await customer.getByLabel("Ism *").fill("Live Board Mijoz");
  await customer.getByLabel("Telefon *").fill("+998907776644");
  await customer.getByTestId("type-pickup").click();
  await customer.getByTestId("checkout-submit").click();
  await customer.waitForURL("**/confirmation/**");
  const orderId = customer.url().split("/confirmation/")[1];

  // Both already-open staff boards must pick this up on their own.
  await expect(staff1.getByTestId(`order-card-${orderId}`)).toBeVisible({ timeout: 15000 });
  await expect(staff2.getByTestId(`order-card-${orderId}`)).toBeVisible({ timeout: 15000 });
  await expect(staff1.getByTestId("new-order-alert")).toBeVisible();
  await expect(staff1.getByTestId(`new-order-alert-${orderId}`)).toBeVisible();

  await staff1Context.close();
  await staff2Context.close();
  await customerContext.close();
});

test("restaurant status changes (accept, preparing, ready) propagate live across staff sessions, and the average prep-time hint is visible while deciding", async ({ browser }) => {
  const staffContext = await browser.newContext();
  const watcherContext = await browser.newContext();
  const customerContext = await browser.newContext();
  const staff = await staffContext.newPage();
  const watcher = await watcherContext.newPage();
  const customer = await customerContext.newPage();

  await signInStaff(staff);
  await signInStaff(watcher);

  await customer.goto("/menu/chicken");
  await customer.getByRole("button", { name: "+" }).click();
  await customer.getByTestId("buy-now").click();
  await customer.waitForURL("**/checkout");
  await customer.getByLabel("Ism *").fill("Live Status Mijoz");
  await customer.getByLabel("Telefon *").fill("+998907776655");
  await customer.getByLabel("Mahalla yoki tuman *").fill("Guliston tumani");
  await customer.getByLabel("Ko‘cha yoki joylashuv *").fill("Test ko‘chasi");
  await customer.getByTestId("map-picker-set").click();
  await customer.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
  await customer.getByTestId("checkout-submit").click();
  await customer.waitForURL("**/confirmation/**");
  const orderId = customer.url().split("/confirmation/")[1];

  // The "watcher" session opens the order detail page directly and never
  // navigates again -- every assertion on it below must resolve purely
  // from realtime-triggered refetches landing in already-mounted React
  // state.
  await watcher.goto(`/restaurant/orders/${orderId}`);
  await expect(watcher.getByTestId("delivery-review-required")).toBeVisible();
  // The average prep-time hint sits in the same action panel staff uses
  // to decide whether to approve/accept/prepare -- visible immediately,
  // not scrolled far down the page.
  await expect(watcher.getByTestId("average-prep-time")).toContainText("20–25 daqiqa");

  await staff.goto(`/restaurant/orders/${orderId}`);
  await staff.getByTestId("approve-delivery").click();
  await expect(watcher.getByTestId("delivery-review-approved")).toBeVisible({ timeout: 15000 });

  await staff.getByTestId("action-confirm").click();
  await expect(watcher.getByTestId("action-start-prep")).toBeVisible({ timeout: 15000 });

  await staff.getByTestId("action-start-prep").click();
  await expect(watcher.getByTestId("action-mark-ready")).toBeVisible({ timeout: 15000 });

  await staff.getByTestId("action-mark-ready").click();
  // PREPARING and READY are visibly distinct states -- once READY,
  // "Tayyor deb belgilash" is gone (delivery orders wait for automatic
  // dispatch here, not a further staff click).
  await expect(watcher.getByTestId("action-mark-ready")).toHaveCount(0, { timeout: 15000 });

  await staffContext.close();
  await watcherContext.close();
  await customerContext.close();
});
