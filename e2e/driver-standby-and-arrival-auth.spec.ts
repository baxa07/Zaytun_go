import { expect, test } from "@playwright/test";
import { forceFreeDriver, driverRpc } from "./helpers/driverCleanup";

// Driver UI Phase: standby awareness (information, never ownership),
// the purely-informational "arrived at restaurant" marker, and the two
// realtime guarantees the user explicitly called out -- standby/
// assignment/reassignment/cancellation all live with no reload, and a
// late check-in reliably surfaces an already-waiting order (the direct
// regression test for the "driver checked in late, no delivery came
// through" incident -- the backend fix already exists and is pgTAP-
// tested; this proves it reaches the driver's own screen).
const localPassword = "zaytun-local-2026";

async function freeDriver(page: import("@playwright/test").Page, identifier: string) {
  // See e2e/helpers/driverCleanup.ts -- an accepted, not-yet-ready order
  // has no driver-side action at all, so the UI-only loop below can't
  // reach it on its own.
  await forceFreeDriver(identifier);
  await page.goto("/driver");
  await page.getByLabel("Telefon yoki email").fill(identifier);
  await page.getByLabel("Parol").fill(localPassword);
  await page.getByRole("button", { name: "Kirish" }).click();
  await expect(page.getByRole("button", { name: "Chiqish" })).toBeVisible();
  await page.waitForTimeout(500);
  // Off-shift with no active work renders "driver-off-duty", never
  // "driver-no-active" -- go on-shift first, before waiting on
  // "driver-no-active" below, so a driver left off-shift by an earlier
  // test can never hang this helper.
  if (await page.getByTestId("driver-shift-toggle").isEnabled().catch(() => false)) {
    if ((await page.getByTestId("driver-availability-status").textContent()) !== "🟢 Ishga tayyor") {
      await page.getByTestId("driver-shift-toggle").click();
      await expect(page.getByTestId("driver-availability-status")).toHaveText("🟢 Ishga tayyor");
    }
  }
  // "Free" means no active assignment/delivery card -- not literally the
  // driver-no-active testid, since the driver may legitimately be showing
  // driver-standby-notice instead (another order still PREPARING
  // elsewhere in the branch). Standby is information, not ownership, so
  // it's still "free" for a fresh scenario.
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

async function placeDeliveryOrder(customer: import("@playwright/test").Page, phone: string) {
  await customer.goto("/menu/chicken");
  await customer.getByRole("button", { name: "+" }).click();
  await customer.getByTestId("buy-now").click();
  await customer.waitForURL("**/checkout");
  await customer.getByLabel("Ism *").fill("Driver Standby Mijoz");
  await customer.getByLabel("Telefon *").fill(phone);
  await customer.getByLabel("Mahalla yoki tuman *").fill("Guliston tumani");
  await customer.getByLabel("Ko‘cha yoki joylashuv *").fill("Test ko‘chasi");
  await customer.getByTestId("map-picker-set").click();
  await customer.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
  await customer.getByTestId("checkout-submit").click();
  await customer.waitForURL("**/confirmation/**");
  return customer.url().split("/confirmation/")[1];
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

test("with no eligible driver at ACCEPT, a standby notice appears live immediately (not at PREPARING), is visually/structurally distinct from an assignment, and is replaced live by a real assignment the moment a driver checks in", async ({ browser }) => {
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customerContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();
  const customer = await customerContext.newPage();
  const staff = await staffContext.newPage();

  // Multi-Order Dispatch: assignment now happens at ACCEPT (CONFIRMED),
  // not READY -- so proving "standby means genuinely nobody eligible" and
  // "never both ASSIGNED and STANDBY for the same driver" requires BOTH
  // seed drivers to be ineligible at ACCEPT time, not just one.
  //
  // Deliberately PAUSED (dispatch_status), not OFF_SHIFT: src/App.tsx's
  // own knownOffDuty gate hides the standby notice entirely whenever
  // shift_status isn't ON_SHIFT (an off-duty driver has no reason to see
  // pending demand), so proving the notice itself renders live requires
  // staying ON_SHIFT while genuinely ineligible -- exactly the same
  // technique supabase/tests/restaurant_prep_and_driver_standby.test.sql
  // already uses server-side for the identical scenario.
  await freeDriver(otherDriver, "998900000099");
  await driverRpc("998900000099", "pause_dispatch");
  await otherDriverContext.close();
  await freeDriver(driver, "driver@zaytun.local");
  await driverRpc("driver@zaytun.local", "pause_dispatch");
  try {
    await signInStaff(staff);

    const orderId = await placeDeliveryOrder(customer, "+998907778810");

    await staff.goto(`/restaurant/orders/${orderId}`);
    await staff.getByTestId("approve-delivery").click();
    await staff.getByTestId("action-confirm").click(); // fires the early-dispatch attempt; fails (nobody eligible) -> standby fires immediately

    // Lands on the already-open driver page live, no reload -- at ACCEPT
    // time, well before PREPARING.
    await expect(driver.getByTestId("driver-standby-notice")).toBeVisible({ timeout: 15000 });
    // Information, not ownership -- no accept/decline, not the assignment card.
    await expect(driver.locator(".assignment-card")).toHaveCount(0);
    await expect(driver.locator(".standby-card button")).toHaveCount(0);
    await expect(driver.getByTestId("driver-decline-assignment")).toHaveCount(0);

    // The late check-in itself (here: becoming eligible again while already
    // ON_SHIFT) -- the eligibility sweep must reach this already-open driver
    // page live, replacing standby with a real assignment, with no reload
    // and no further restaurant action.
    await driverRpc("driver@zaytun.local", "resume_dispatch");
    await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
    await expect(driver.getByTestId("driver-standby-notice")).toHaveCount(0);
  } finally {
    // Guaranteed cleanup regardless of assertion outcome above -- a
    // PAUSED driver left behind here would otherwise silently break every
    // later test in this file (and beyond) that assumes both seed drivers
    // are genuinely eligible after freeDriver.
    await driverRpc("998900000099", "resume_dispatch").catch(() => {});
    await driverRpc("driver@zaytun.local", "resume_dispatch").catch(() => {});
    await driverContext.close();
    await customerContext.close();
    await staffContext.close();
  }
});

test("the 'at restaurant' marker is live on both driver and staff, and never blocks the real transition to PICKED_UP", async ({ browser }) => {
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customerContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();
  const customer = await customerContext.newPage();
  const staff = await staffContext.newPage();

  await takeOffShift(otherDriver, "998900000099");
  await otherDriverContext.close();
  await freeDriver(driver, "driver@zaytun.local");
  await signInStaff(staff);

  const orderId = await placeDeliveryOrder(customer, "+998907778811");

  await staff.goto(`/restaurant/orders/${orderId}`);
  await staff.getByTestId("approve-delivery").click();
  await staff.getByTestId("action-confirm").click(); // Multi-Order Dispatch: real assignment happens right here, at ACCEPT

  // Lands on the already-open driver page live, no reload, well before
  // the food is ready.
  await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
  await driver.getByTestId("driver-primary-action").click(); // accept
  // The order isn't READY yet -- the pre-ready sub-view, not the full
  // delivery-card action flow.
  await expect(driver.getByTestId("driver-pre-ready-card")).toBeVisible();

  await readyOrder(staff, orderId);
  await expect(driver.locator(".delivery-card")).toBeVisible({ timeout: 15000 });

  await driver.getByTestId("driver-mark-at-restaurant").click();
  await expect(driver.getByTestId("driver-at-restaurant-badge")).toBeVisible();

  // Lands on the already-open staff order-detail page live, no reload.
  await expect(staff.getByTestId("driver-at-restaurant-notice")).toBeVisible({ timeout: 15000 });

  // Never blocked -- the real transition still works normally.
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Buyurtmani oldim");
  await driver.getByTestId("driver-primary-action").click(); // PICKED_UP
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yo‘lga chiqdim");

  await driverContext.close();
  await customerContext.close();
  await staffContext.close();
});

test("a late check-in reliably surfaces an already-waiting order live, with no reload (regression for the 'checked in late, no delivery came through' incident)", async ({ browser }) => {
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customerContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();
  const customer = await customerContext.newPage();
  const staff = await staffContext.newPage();

  // Both seed drivers off-shift -- zero eligible candidates when the
  // order becomes READY, so the dispatch sweep at that moment finds
  // nobody and the order stays READY, unassigned and waiting.
  await takeOffShift(otherDriver, "998900000099");
  await otherDriverContext.close();
  await takeOffShift(driver, "driver@zaytun.local");
  await signInStaff(staff);

  const orderId = await placeDeliveryOrder(customer, "+998907778812");

  await staff.goto(`/restaurant/orders/${orderId}`);
  await staff.getByTestId("approve-delivery").click();
  await staff.getByTestId("action-confirm").click();
  await staff.getByTestId("action-start-prep").click();
  await staff.getByTestId("action-mark-ready").click();
  await expect(staff.getByTestId("dispatch-searching")).toBeVisible({ timeout: 15000 });

  // The late check-in itself: start_shift's own eligibility sweep
  // (20260814100000_driver_eligibility_redispatch_sweep.sql) must reach
  // this already-open driver page live, with no reload.
  await driver.getByTestId("driver-shift-toggle").click();
  await expect(driver.getByTestId("driver-availability-status")).toHaveText("🟢 Ishga tayyor");
  await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 15000 });

  await driverContext.close();
  await customerContext.close();
  await staffContext.close();
});

test("cancellation while DRIVER_ASSIGNED reflects live on the driver's own screen, with no reload", async ({ browser }) => {
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customerContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();
  const customer = await customerContext.newPage();
  const staff = await staffContext.newPage();

  await takeOffShift(otherDriver, "998900000099");
  await otherDriverContext.close();
  await freeDriver(driver, "driver@zaytun.local");
  await signInStaff(staff);

  const orderId = await placeDeliveryOrder(customer, "+998907778813");

  await staff.goto(`/restaurant/orders/${orderId}`);
  await staff.getByTestId("approve-delivery").click();
  await staff.getByTestId("action-confirm").click(); // Multi-Order Dispatch: real assignment happens right here, at ACCEPT
  await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
  await readyOrder(staff, orderId);

  // legalTransitions allows CANCELLED from every pre-departure stage
  // (including DRIVER_ASSIGNED, reached here); this exercises the
  // restaurant's own action-cancel control at the stage staff is most
  // likely to actually use it.
  await staff.getByPlaceholder("Bekor qilish sababi").fill("Sinov uchun bekor qilish");
  await staff.getByTestId("action-cancel").click();

  // Lands on the already-open driver page live, no reload -- the driver
  // is still ON_SHIFT/ACTIVE, so the assignment/delivery card disappears
  // (proof the cancellation reached the driver). Not asserting
  // driver-no-active specifically -- a standby notice for some other
  // order elsewhere in the branch may legitimately be showing instead,
  // which is still correctly "free."
  await expect(driver.locator(".assignment-card")).toHaveCount(0, { timeout: 15000 });
  await expect(driver.locator(".delivery-card")).toHaveCount(0);

  await driverContext.close();
  await customerContext.close();
  await staffContext.close();
});
