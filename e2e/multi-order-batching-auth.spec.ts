import { expect, test } from "@playwright/test";
import { forceFreeDriver } from "./helpers/driverCleanup";

// Multi-Order Dispatch: the core two-order batching scenario end to end
// (assign at ACCEPT, second compatible order joins the same driver,
// multi-stop pickup/delivery, batched decline, customer privacy). Exact
// stop_sequence determinism by distance is already proven precisely in
// supabase/tests/multi_order_dispatch.test.sql with controlled
// coordinates -- this suite proves the LIVE, no-reload, real-UI-driven
// experience of a driver actually handling two batched orders, without
// depending on which physical stop the mock map coordinate happens to
// sequence first.
const localPassword = "zaytun-local-2026";

async function freeDriver(page: import("@playwright/test").Page, identifier: string) {
  // See e2e/helpers/driverCleanup.ts -- an accepted, not-yet-ready order
  // has no driver-side action at all, so the UI-only loop below can't
  // reach it on its own (also unblocks this file's own test 3, which
  // deliberately leaves both A and B pre-ready to exercise privacy).
  await forceFreeDriver(identifier);
  await page.goto("/driver");
  await page.getByLabel("Telefon yoki email").fill(identifier);
  await page.getByLabel("Parol").fill(localPassword);
  await page.getByRole("button", { name: "Kirish" }).click();
  await expect(page.getByRole("button", { name: "Chiqish" })).toBeVisible();
  await page.waitForTimeout(500);
  if (await page.getByTestId("driver-shift-toggle").isEnabled().catch(() => false)) {
    if ((await page.getByTestId("driver-availability-status").textContent()) !== "🟢 Ishga tayyor") {
      await page.getByTestId("driver-shift-toggle").click();
      await expect(page.getByTestId("driver-availability-status")).toHaveText("🟢 Ishga tayyor");
    }
  }
  for (let i = 0; i < 6; i++) {
    if (await page.locator(".assignment-card, .delivery-card").count() === 0) break;
    await page.getByTestId("driver-primary-action").click().catch(() => page.getByTestId("driver-primary-action").click());
    await page.waitForTimeout(250);
  }
  await expect(page.locator(".assignment-card, .delivery-card")).toHaveCount(0);
}

async function takeOffShift(page: import("@playwright/test").Page, identifier: string) {
  await freeDriver(page, identifier);
  await page.getByTestId("driver-shift-toggle").click();
  await expect(page.getByTestId("driver-availability-status")).toHaveText("⚪ Hozir ishlamayapman");
}

async function signInStaff(page: import("@playwright/test").Page) {
  await page.goto("/restaurant");
  await page.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
  await page.getByLabel("Parol").fill(localPassword);
  await page.getByRole("button", { name: "Kirish" }).click();
  await expect(page.getByRole("button", { name: "Chiqish" })).toBeVisible();
}

async function placeDeliveryOrder(customer: import("@playwright/test").Page, name: string, phone: string) {
  await customer.goto("/menu/chicken");
  await customer.getByRole("button", { name: "+" }).click();
  await customer.getByTestId("buy-now").click();
  await customer.waitForURL("**/checkout");
  await customer.getByLabel("Ism *").fill(name);
  await customer.getByLabel("Telefon *").fill(phone);
  await customer.getByLabel("Mahalla yoki tuman *").fill("Guliston tumani");
  await customer.getByLabel("Ko‘cha yoki joylashuv *").fill("Test ko‘chasi");
  await customer.getByTestId("map-picker-set").click();
  await customer.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
  await customer.getByTestId("checkout-submit").click();
  await customer.waitForURL("**/confirmation/**");
  return customer.url().split("/confirmation/")[1];
}

async function acceptOrder(staff: import("@playwright/test").Page, orderId: string) {
  await staff.goto(`/restaurant/orders/${orderId}`);
  await staff.getByTestId("approve-delivery").click();
  await staff.getByTestId("action-confirm").click();
}

async function readyOrder(staff: import("@playwright/test").Page, orderId: string) {
  await staff.goto(`/restaurant/orders/${orderId}`);
  await staff.getByTestId("action-start-prep").click();
  await expect(staff.getByTestId("action-mark-ready")).toBeVisible({ timeout: 10000 });
  // Multi-Order Dispatch's per-transition realtime fan-out (orders,
  // order_events, driver_assignments, drivers all fire on one early
  // assignment) can trigger a re-render right as this click lands,
  // occasionally swallowing it -- retry until the badge actually confirms
  // DRIVER_ASSIGNED rather than trusting a single click.
  for (let i = 0; i < 5; i++) {
    if ((await staff.locator(".detail-head .badge").textContent()) === "Haydovchi biriktirilgan") break;
    await staff.getByTestId("action-mark-ready").click().catch(() => {});
    await staff.waitForTimeout(400);
  }
  await expect(staff.locator(".detail-head .badge")).toHaveText("Haydovchi biriktirilgan", { timeout: 10000 });
}

// Drains whichever order is currently actionable on the driver's page --
// accepting a fresh assignment or advancing an in-progress delivery --
// until no active card remains. Deliberately order-agnostic: which of
// the two batched orders the driver acts on first depends on the
// distance-based stop_sequence, which this suite does not control.
async function drainDriverActiveWork(driver: import("@playwright/test").Page, maxSteps = 12) {
  for (let i = 0; i < maxSteps; i++) {
    if (await driver.locator(".assignment-card, .delivery-card").count() === 0) break;
    await driver.getByTestId("driver-primary-action").click().catch(() => driver.getByTestId("driver-primary-action").click());
    await driver.waitForTimeout(300);
  }
}

test("a second compatible order joins the same driver's batch live, and both are delivered end to end through real multi-stop pickup, with no reload anywhere", async ({ browser }) => {
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customerAContext = await browser.newContext();
  const customerBContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();
  const customerA = await customerAContext.newPage();
  const customerB = await customerBContext.newPage();
  const staff = await staffContext.newPage();

  await takeOffShift(otherDriver, "998900000099");
  await otherDriverContext.close();
  await freeDriver(driver, "driver@zaytun.local");
  await signInStaff(staff);

  const orderIdA = await placeDeliveryOrder(customerA, "Batch Mijoz A", "+998907779001");
  await acceptOrder(staff, orderIdA); // real assignment happens right here, at ACCEPT

  // Lands on the already-open driver page live, no reload.
  await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
  await driver.getByTestId("driver-primary-action").click(); // accept A
  await expect(driver.getByTestId("driver-pre-ready-card")).toBeVisible();

  const orderIdB = await placeDeliveryOrder(customerB, "Batch Mijoz B", "+998907779002");
  await acceptOrder(staff, orderIdB); // still under capacity, same branch, compatible -> joins the SAME driver

  // The second order appears live in the driver's queue, with its own
  // accept/decline -- accepting the first order never implicitly covers
  // it, since it is a genuinely separate assignment.
  await expect(driver.getByTestId(`driver-queue-accept-${orderIdB}`)).toBeVisible({ timeout: 15000 });
  await expect(driver.getByTestId("assignment-batch-hint")).toBeVisible(); // A's own card now shows "1 more order in this batch"
  await driver.getByTestId(`driver-queue-accept-${orderIdB}`).click();
  await expect(driver.getByTestId(`driver-queue-${orderIdB}`)).toBeVisible(); // still queued, but no longer needs a response

  // Restaurant staff also sees the batch context live, no reload.
  await staff.goto(`/restaurant/orders/${orderIdA}`);
  await expect(staff.getByTestId("early-assignment-hint")).toBeVisible({ timeout: 15000 });

  await readyOrder(staff, orderIdA);
  // Let A's own DRIVER_ASSIGNED transition reach the driver's already-open
  // page live before staff readies B -- matches the core scenario's own
  // staggered timing (A ready first, B a few minutes behind), and avoids
  // racing two rapid realtime signals for the same driver against each
  // other before either has been refetched.
  await expect(driver.locator(".delivery-card, .assignment-card")).toBeVisible({ timeout: 15000 });
  await readyOrder(staff, orderIdB);

  // Both orders reach DRIVER_ASSIGNED by reusing the existing assignment
  // (no new search), then the driver picks up and delivers both in turn,
  // live, with no reload anywhere on the driver's page.
  await drainDriverActiveWork(driver);
  await expect(driver.getByTestId("driver-no-active")).toBeVisible({ timeout: 15000 });

  await staff.goto(`/restaurant/orders/${orderIdA}`);
  await expect(staff.locator(".detail-head .badge")).toHaveText("Yetkazildi");
  await staff.goto(`/restaurant/orders/${orderIdB}`);
  await expect(staff.locator(".detail-head .badge")).toHaveText("Yetkazildi");

  await driverContext.close();
  await customerAContext.close();
  await customerBContext.close();
  await staffContext.close();
});

test("declining one order in a two-order batch releases only that order, leaving the other's assignment completely undisturbed", async ({ browser }) => {
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customerAContext = await browser.newContext();
  const customerBContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();
  const customerA = await customerAContext.newPage();
  const customerB = await customerBContext.newPage();
  const staff = await staffContext.newPage();

  await takeOffShift(otherDriver, "998900000099");
  await otherDriverContext.close();
  await freeDriver(driver, "driver@zaytun.local");
  await signInStaff(staff);

  const orderIdA = await placeDeliveryOrder(customerA, "Decline Batch A", "+998907779003");
  await acceptOrder(staff, orderIdA);
  await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
  await driver.getByTestId("driver-primary-action").click(); // accept A

  const orderIdB = await placeDeliveryOrder(customerB, "Decline Batch B", "+998907779004");
  await acceptOrder(staff, orderIdB);
  await expect(driver.getByTestId(`driver-queue-decline-${orderIdB}`)).toBeVisible({ timeout: 15000 });

  // Decline B only -- A must be completely unaffected (per decline_assignment's
  // own order-scoped writes, extended here to the early-decline path).
  await driver.getByTestId(`driver-queue-decline-${orderIdB}`).click();

  // B's assignment is genuinely released -- the driver is excluded from
  // its own immediate retry, so with no other eligible driver it goes
  // back to showing no assigned courier at all (not the early-assignment
  // hint, not the courier-monitoring panel).
  await staff.goto(`/restaurant/orders/${orderIdB}`);
  await expect(staff.getByTestId("early-assignment-hint")).toHaveCount(0);
  await expect(staff.getByTestId("dispatch-courier-status")).toHaveCount(0);

  // A is untouched -- still the driver's own real assignment, still
  // present on their page, no reload.
  await expect(driver.getByTestId("driver-queue")).toHaveCount(0); // B is gone from the queue
  await expect(driver.locator('.assignment-card, .delivery-card, [data-testid="driver-pre-ready-card"]')).toHaveCount(1);
  await readyOrder(staff, orderIdA);
  await expect(driver.locator(".delivery-card")).toBeVisible({ timeout: 15000 });
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Buyurtmani oldim");

  await driverContext.close();
  await customerAContext.close();
  await customerBContext.close();
  await staffContext.close();
});

test("customer privacy: two customers batched on the same driver never see each other's name, phone, address, or tracking token", async ({ browser }) => {
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customerAContext = await browser.newContext();
  const customerBContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();
  const customerA = await customerAContext.newPage();
  const customerB = await customerBContext.newPage();
  const staff = await staffContext.newPage();

  await takeOffShift(otherDriver, "998900000099");
  await otherDriverContext.close();
  await freeDriver(driver, "driver@zaytun.local");
  await signInStaff(staff);

  const orderIdA = await placeDeliveryOrder(customerA, "Privacy Mijoz A", "+998907779005");
  await acceptOrder(staff, orderIdA);
  await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
  await driver.getByTestId("driver-primary-action").click();

  const orderIdB = await placeDeliveryOrder(customerB, "Privacy Mijoz B", "+998907779006");
  await acceptOrder(staff, orderIdB);
  await expect(driver.getByTestId(`driver-queue-accept-${orderIdB}`)).toBeVisible({ timeout: 15000 });
  await driver.getByTestId(`driver-queue-accept-${orderIdB}`).click(); // both now genuinely batched together

  // Customer A's own tracking page, reached the normal way (their own
  // confirmation redirect), must never contain Customer B's identifying
  // details, even though they share a driver and a pickup batch.
  await customerA.goto(`/track/${orderIdA}`);
  await expect(customerA.getByTestId("order-status")).toBeVisible();
  await expect(customerA.locator(".track")).not.toContainText("Privacy Mijoz B");
  await expect(customerA.locator(".track")).not.toContainText("+998907779006");
  await expect(customerA.locator(".track")).not.toContainText(orderIdB);

  await customerB.goto(`/track/${orderIdB}`);
  await expect(customerB.getByTestId("order-status")).toBeVisible();
  await expect(customerB.locator(".track")).not.toContainText("Privacy Mijoz A");
  await expect(customerB.locator(".track")).not.toContainText("+998907779005");
  await expect(customerB.locator(".track")).not.toContainText(orderIdA);

  // Customer A cannot read Customer B's order by guessing the id alone --
  // the tracking token is the entire authorization model, and A's browser
  // never received B's token.
  await customerA.goto(`/track/${orderIdB}`);
  // The invalid-token page renders outside the .track wrapper (a distinct
  // error state, not a variant of the normal tracking view) -- assert
  // against the page itself rather than a wrapper class that only exists
  // on a valid tracking page.
  await expect(customerA.getByRole("heading", { name: "Kuzatuv havolasi noto‘g‘ri yoki mavjud emas" })).toBeVisible();

  await driverContext.close();
  await customerAContext.close();
  await customerBContext.close();
  await staffContext.close();
});
