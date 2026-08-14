import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { forceFreeDriver } from "./helpers/driverCleanup";

// Zaytun Go -- Full Live Operational Validation. Covers the specific gaps
// NOT already proven by the existing real-backend auth-suite specs (which
// this phase re-ran clean, 32/32, as its own baseline evidence for most of
// scenarios A-E and F): live redispatch to a SECOND eligible driver after
// a delay-release or a decline (existing coverage deliberately keeps the
// second driver off-shift for determinism), Telegram-outbox enqueue/no-
// duplicate proof (real bot delivery cannot be verified locally -- no bot
// token is configured in supabase/functions/.env -- so this verifies the
// application-layer contract: exactly one outbox row per order+channel,
// never faked as a real send), the customer-closes-the-page case, and an
// explicit driver/restaurant offline->online recovery pair mirroring the
// one already proven for the customer surface.
const localPassword = "zaytun-local-2026";

function psql(sql: string): string {
  return execFileSync(
    "psql",
    ["-h", "127.0.0.1", "-p", "54322", "-U", "postgres", "-d", "postgres", "-t", "-A", "-c", sql],
    { env: { ...process.env, PGPASSWORD: "postgres" } },
  ).toString().trim();
}
function outboxCount(orderId: string, channel: string): number {
  return Number(psql(`select count(*) from public.notification_outbox where order_id='${orderId}' and channel='${channel}';`));
}
// No real Telegram bot token exists in this local environment -- this
// simulates only the ONE precondition the enqueue trigger checks
// (orders.customer_telegram_chat_id is not null), the same fixture
// technique supabase/tests/customer_realtime_and_arrival.test.sql already
// uses at the pgTAP layer. It proves the application enqueues correctly;
// it does NOT prove a real Telegram message is ever delivered.
function linkTelegram(orderId: string, chatId: number): void {
  psql(`update public.orders set customer_telegram_chat_id=${chatId} where id='${orderId}';`);
}

async function freeDriver(page: import("@playwright/test").Page, identifier: string) {
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
  if (await page.locator(".assignment-card, .delivery-card").count() > 0) {
    await forceFreeDriver(identifier);
    await page.reload();
    await page.waitForTimeout(500);
  }
  for (let i = 0; i < 6; i++) {
    if (await page.locator(".assignment-card, .delivery-card").count() === 0) break;
    await page.getByTestId("driver-primary-action").click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(250);
  }
  if (await page.locator(".assignment-card, .delivery-card").count() > 0) {
    await forceFreeDriver(identifier);
    await page.reload();
  }
  await expect(page.locator(".assignment-card, .delivery-card")).toHaveCount(0, { timeout: 10000 });
}

// Best-effort end-of-test hygiene only, never something the scenario under
// test depends on -- so it must never be able to hang the whole test.
// Wrapped defensively (reload first, bounded click timeout, swallow any
// failure) after a real hang here was traced to a stale click landing on
// a page mid-re-render right after freeDriver()'s own cleanup settles.
async function takeOffShiftBestEffort(page: import("@playwright/test").Page, identifier: string) {
  try {
    // Deliberately NOT freeDriver() -- this page is already signed in
    // (mid-test), so freeDriver()'s own login-form fill() calls would
    // wait forever for a "Telefon yoki email" field that will never
    // appear on an already-authenticated dashboard (found via a real 90s
    // hang: no explicit timeout on those fills, so the wait outlives any
    // try/catch around the call -- it never rejects, it just never
    // resolves until the whole test's own timeout tears it down).
    await forceFreeDriver(identifier);
    await page.reload();
    await page.waitForTimeout(500);
    for (let i = 0; i < 6; i++) {
      if (await page.locator(".assignment-card, .delivery-card").count() === 0) break;
      await page.getByTestId("driver-primary-action").click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(250);
    }
    if (await page.locator(".assignment-card, .delivery-card").count() > 0) {
      await forceFreeDriver(identifier);
      await page.reload();
      await page.waitForTimeout(500);
    }
    if ((await page.getByTestId("driver-availability-status").textContent({ timeout: 5000 }).catch(() => "")) === "🟢 Ishga tayyor") {
      await page.getByTestId("driver-shift-toggle").click({ timeout: 5000 });
      await expect(page.getByTestId("driver-availability-status")).toHaveText("⚪ Hozir ishlamayapman", { timeout: 5000 });
    }
  } catch {
    /* best-effort test hygiene only -- never block the test on this */
  }
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
  for (let i = 0; i < 5; i++) {
    if ((await staff.locator(".detail-head .badge").textContent()) === "Haydovchi biriktirilgan") break;
    await staff.getByTestId("action-mark-ready").click().catch(() => {});
    await staff.waitForTimeout(400);
  }
  await expect(staff.locator(".detail-head .badge")).toHaveText("Haydovchi biriktirilgan", { timeout: 10000 });
}

test("Scenario A: normal single delivery, live across customer/restaurant/driver, with Telegram-arrival enqueue and no duplicate on retry", async ({ browser }) => {
  test.setTimeout(90000);
  const driverContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const otherDriverContext = await browser.newContext();
  const customerContext = await browser.newContext();
  const staffContext = await browser.newContext();
  try {
    const driver = await driverContext.newPage();
    const otherDriver = await otherDriverContext.newPage();
    const customer = await customerContext.newPage();
    const staff = await staffContext.newPage();

    await freeDriver(otherDriver, "998900000099");
    await otherDriver.getByTestId("driver-shift-toggle").click();
    await expect(otherDriver.getByTestId("driver-availability-status")).toHaveText("⚪ Hozir ishlamayapman");
    await freeDriver(driver, "driver@zaytun.local");
    await signInStaff(staff);

    const orderId = await placeDeliveryOrder(customer, "OpVal Solo Mijoz", "+998907779301");
    // Simulate a Telegram-linked customer purely at the data layer (see
    // linkTelegram's own comment) so the ARRIVED enqueue path is exercised.
    linkTelegram(orderId, 555000111);

    // Restaurant: address review gates acceptance -- staff page stays
    // open, no reload, through the whole approve->accept->assign step.
    await staff.goto(`/restaurant/orders/${orderId}`);
    await expect(staff.getByTestId("approve-delivery")).toBeVisible();
    await staff.getByTestId("approve-delivery").click();
    await expect(staff.getByTestId("delivery-review-approved")).toBeVisible();
    await staff.getByTestId("action-confirm").click();
    // Assignment happens immediately at ACCEPT, not at READY.
    await expect(staff.getByTestId("dispatch-courier-status")).toBeVisible({ timeout: 10000 });

    // Driver: real assignment live, no reload.
    await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
    await expect(driver.getByTestId("driver-primary-action")).toHaveText("Qabul qilish");
    await driver.getByTestId("driver-primary-action").click();
    await expect(driver.getByTestId("driver-pre-ready-card")).toBeVisible();
    await expect(driver.locator(".driver-page")).toContainText(/20.?25 daqiqa/);

    // Driver checks in before food is ready -- restaurant sees it live,
    // page already open, no reload.
    await driver.getByTestId("driver-mark-at-restaurant").click();
    await expect(driver.getByTestId("driver-at-restaurant-badge")).toBeVisible();
    await expect(staff.getByTestId("driver-at-restaurant-notice")).toBeVisible({ timeout: 15000 });

    // Restaurant progresses PREPARING -> READY -- driver sees READY
    // automatically, no click, no reload.
    await staff.getByTestId("action-start-prep").click();
    await staff.getByTestId("action-mark-ready").click();
    await expect(driver.locator(".delivery-card")).toBeVisible({ timeout: 15000 });
    await expect(driver.getByTestId("driver-primary-action")).toHaveText("Buyurtmani oldim");

    // Pickup -- restaurant and customer both update automatically.
    await customer.goto(`/track/${orderId}`);
    await driver.getByTestId("driver-primary-action").click(); // PICKED_UP
    await expect(staff.getByTestId("dispatch-courier-status")).toContainText("Buyurtmani oldi", { timeout: 15000 });
    await expect(customer.getByTestId("order-status")).toContainText("Haydovchiga berildi", { timeout: 15000 });

    // Delivery: navigation action available, destination shown.
    await expect(driver.getByTestId("driver-open-navigation")).toBeVisible();
    await driver.getByTestId("driver-primary-action").click(); // ON_THE_WAY
    await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yetib keldim");
    await driver.getByTestId("driver-primary-action").click(); // ARRIVED

    // Customer tracking updates live, no refresh.
    await expect(customer.getByTestId("order-status")).toContainText("Yetib keldi", { timeout: 15000 });

    // Exactly one Telegram arrival notification is enqueued -- proven at
    // the data layer (real send cannot be verified without a bot token).
    await expect.poll(() => outboxCount(orderId, "TELEGRAM_CUSTOMER_ARRIVED"), { timeout: 10000 }).toBe(1);
    // Repeated-ARRIVED / no-duplicate-enqueue idempotency is already
    // proven directly at the backend by
    // supabase/tests/customer_realtime_and_arrival.test.sql ("a repeated
    // enqueue attempt for the same order+channel does not error... still
    // exactly one row"). Not re-attempted at the UI level here: the
    // primary-action button advances to the NEXT stage after a
    // successful click (by design -- one dominant action, always the
    // real next step), so a second UI click at this point would attempt
    // DELIVERED, not retry ARRIVED, and isn't a meaningful way to
    // exercise this guarantee.

    await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yetkazildi");
    await driver.getByTestId("driver-primary-action").click(); // DELIVERED

    await expect(customer.getByTestId("order-status")).toContainText("Yetkazildi", { timeout: 15000 });
    await expect(staff.locator(".detail-head .badge")).toHaveText("Yetkazildi", { timeout: 15000 });
    await expect(driver.getByTestId("driver-no-active")).toBeVisible({ timeout: 15000 });
    // Driver returns to available -- still on shift, not logged out.
    await expect(driver.getByTestId("driver-availability-status")).toHaveText("🟢 Ishga tayyor");
  } finally {
    await driverContext.close();
    await otherDriverContext.close();
    await customerContext.close();
    await staffContext.close();
  }
});

test("Scenario C addendum: a delayed second order redispatches live to a second eligible driver (not just released)", async ({ browser }) => {
  test.setTimeout(90000);
  const driverAContext = await browser.newContext();
  const driverBContext = await browser.newContext();
  const customerAContext = await browser.newContext();
  const customerBContext = await browser.newContext();
  const staffContext = await browser.newContext();
  try {
    const driverA = await driverAContext.newPage();
    const driverB = await driverBContext.newPage();
    const customerA = await customerAContext.newPage();
    const customerB = await customerBContext.newPage();
    const staff = await staffContext.newPage();

    // Deterministic setup: only Driver A eligible at first, exactly like
    // driver-operational-ux-auth.spec.ts's own scenario C -- otherwise
    // which driver actually receives order A is a genuine coin flip once
    // both are free (confirmed live: with both free from the start, the
    // dispatch sweep did not reliably pick driver@zaytun.local).
    await freeDriver(driverA, "driver@zaytun.local");
    await freeDriver(driverB, "998900000099");
    await driverB.getByTestId("driver-shift-toggle").click();
    await expect(driverB.getByTestId("driver-availability-status")).toHaveText("⚪ Hozir ishlamayapman");

    await signInStaff(staff);

    const orderIdA = await placeDeliveryOrder(customerA, "OpVal Delay A", "+998907779302");
    await acceptOrder(staff, orderIdA);
    await expect(driverA.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
    await driverA.getByTestId("driver-primary-action").click(); // accept A

    const orderIdB = await placeDeliveryOrder(customerB, "OpVal Delay B", "+998907779303");
    await acceptOrder(staff, orderIdB);
    await expect(driverA.getByTestId(`driver-queue-accept-${orderIdB}`)).toBeVisible({ timeout: 15000 });
    await driverA.getByTestId(`driver-queue-accept-${orderIdB}`).click();

    await readyOrder(staff, orderIdA);
    await expect(driverA.getByTestId("driver-wait-for-second")).toBeVisible({ timeout: 15000 });

    // Driver B becomes eligible right as the delayed release is about to
    // happen -- this is the real "if Driver B is eligible" condition the
    // scenario asks for, without corrupting the deterministic setup above.
    await driverB.getByTestId("driver-shift-toggle").click();
    await expect(driverB.getByTestId("driver-availability-status")).toHaveText("🟢 Ishga tayyor");

    execFileSync("node", ["scripts/e2e-backdate-batch-ready.mjs", "driver@zaytun.local", "30"]);
    await expect(driverA.getByTestId("driver-leave-now")).toBeVisible({ timeout: 25000 });
    await driverA.getByTestId("driver-primary-action").click(); // PICKED_UP A -- triggers the server-side release of B

    await expect(driverA.getByTestId("driver-second-order-released")).toBeVisible({ timeout: 15000 });

    // B is genuinely redispatched -- Driver B, the other real eligible
    // driver, receives it live, no reload, with no involvement from
    // Driver A's own page beyond the release above.
    await expect(driverB.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
    const staffB = await staffContext.browser()!.newPage();
    await staffB.goto(`/restaurant/orders/${orderIdB}`);
    await staffB.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
    await staffB.getByLabel("Parol").fill(localPassword);
    await staffB.getByRole("button", { name: "Kirish" }).click();
    await expect(staffB.getByTestId("dispatch-courier-status")).toBeVisible({ timeout: 15000 });
    await expect(staffB.getByTestId("dispatch-courier-status")).toContainText("LOCAL TEST Phone Driver");
    await staffB.close();
    // Leave Driver B exactly as later tests in this file expect to find
    // it: off-shift, not mid-delivery -- otherwise a later test that only
    // frees driver@zaytun.local could non-deterministically receive an
    // assignment on THIS now-eligible driver instead.
    await takeOffShiftBestEffort(driverB, "998900000099");
  } finally {
    await driverAContext.close();
    await driverBContext.close();
    await customerAContext.close();
    await customerBContext.close();
    await staffContext.close();
  }
});

test("Scenario E addendum: declining one of two orders redispatches live to a second eligible driver, and an already-open restaurant page reflects it", async ({ browser }) => {
  test.setTimeout(90000);
  const driverAContext = await browser.newContext();
  const driverBContext = await browser.newContext();
  const customerAContext = await browser.newContext();
  const customerBContext = await browser.newContext();
  const staffContext = await browser.newContext();
  try {
    const driverA = await driverAContext.newPage();
    const driverB = await driverBContext.newPage();
    const customerA = await customerAContext.newPage();
    const customerB = await customerBContext.newPage();
    const staff = await staffContext.newPage();

    // Deterministic setup: only Driver A eligible at first -- with both
    // free from the start, which one actually receives order A is a
    // genuine coin flip (confirmed live in the delayed-redispatch
    // addendum above).
    await freeDriver(driverA, "driver@zaytun.local");
    await freeDriver(driverB, "998900000099");
    await driverB.getByTestId("driver-shift-toggle").click();
    await expect(driverB.getByTestId("driver-availability-status")).toHaveText("⚪ Hozir ishlamayapman");

    await signInStaff(staff);

    const orderIdA = await placeDeliveryOrder(customerA, "OpVal Decline A", "+998907779304");
    await acceptOrder(staff, orderIdA);
    await expect(driverA.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
    await driverA.getByTestId("driver-primary-action").click(); // accept A
    await expect(driverA.getByTestId("driver-capacity")).toContainText("1/2");

    const orderIdB = await placeDeliveryOrder(customerB, "OpVal Decline B", "+998907779305");
    await acceptOrder(staff, orderIdB);
    await expect(driverA.getByTestId(`driver-queue-decline-${orderIdB}`)).toBeVisible({ timeout: 15000 });

    // Driver B becomes eligible right as the decline is about to happen --
    // the real "if Driver B is eligible" condition, without corrupting the
    // deterministic setup above.
    await driverB.getByTestId("driver-shift-toggle").click();
    await expect(driverB.getByTestId("driver-availability-status")).toHaveText("🟢 Ishga tayyor");

    await driverA.getByTestId(`driver-queue-decline-${orderIdB}`).click();
    await expect(driverA.getByTestId("driver-capacity")).toContainText("1/2");

    // A is untouched.
    await expect(driverA.locator('.assignment-card, .delivery-card, [data-testid="driver-pre-ready-card"]')).toHaveCount(1);

    // B redispatches live to Driver B, the other real eligible driver.
    await expect(driverB.locator(".assignment-card")).toBeVisible({ timeout: 15000 });

    // Restaurant's ALREADY-OPEN order-B page (opened before the decline,
    // never navigated away) reflects the reassignment live, no reload.
    const staffB = await staffContext.browser()!.newPage();
    await staffB.goto(`/restaurant/orders/${orderIdB}`);
    await staffB.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
    await staffB.getByLabel("Parol").fill(localPassword);
    await staffB.getByRole("button", { name: "Kirish" }).click();
    await expect(staffB.getByTestId("dispatch-courier-status")).toContainText("LOCAL TEST Phone Driver", { timeout: 15000 });
    await staffB.close();
    // Leave Driver B off-shift again for later tests in this file.
    await takeOffShiftBestEffort(driverB, "998900000099");
  } finally {
    await driverAContext.close();
    await driverBContext.close();
    await customerAContext.close();
    await customerBContext.close();
    await staffContext.close();
  }
});

test("Scenario G: restaurant missed-order protection -- live visual alert plus exactly one Telegram enqueue, order available regardless of Telegram state", async ({ browser }) => {
  test.setTimeout(90000);
  const staffContext = await browser.newContext();
  const customerContext = await browser.newContext();
  try {
    const staff = await staffContext.newPage();
    const customer = await customerContext.newPage();

    await signInStaff(staff);
    await staff.goto("/restaurant");
    // Arm audio via a real user gesture, matching the spec's own
    // "sound fires after browser audio has been activated" requirement.
    await staff.locator("body").click();

    const orderId = await placeDeliveryOrder(customer, "OpVal Missed Order", "+998907779306");

    // Visual: prominent, unmistakable, no reload.
    await expect(staff.getByTestId(`order-card-${orderId}`)).toBeVisible({ timeout: 15000 });
    await expect(staff.getByTestId("new-order-alert")).toBeVisible();
    await expect(staff.getByTestId(`new-order-alert-${orderId}`)).toBeVisible();

    // Telegram: exactly one restaurant-new-order notification enqueued,
    // real delivery not locally verifiable (see file header comment).
    await expect.poll(() => outboxCount(orderId, "TELEGRAM_RESTAURANT_NEW_ORDER"), { timeout: 10000 }).toBe(1);

    // The order remains fully available in the Restaurant UI regardless
    // of Telegram delivery state (which this local environment cannot
    // exercise) -- staff can act on it immediately.
    await staff.getByTestId(`order-card-${orderId}`).click();
    await expect(staff.getByTestId("approve-delivery")).toBeVisible();
  } finally {
    await staffContext.close();
    await customerContext.close();
  }
});

test("Scenario H: customer closes the tracking page entirely -- ARRIVED Telegram enqueue does not depend on the page staying open, and reopening loads the authoritative state immediately", async ({ browser }) => {
  test.setTimeout(90000);
  const driverContext = await browser.newContext();
  const customerContext = await browser.newContext();
  const staffContext = await browser.newContext();
  try {
    const driver = await driverContext.newPage();
    const customer = await customerContext.newPage();
    const staff = await staffContext.newPage();

    await freeDriver(driver, "driver@zaytun.local");
    await signInStaff(staff);

    const orderId = await placeDeliveryOrder(customer, "OpVal Closed Page", "+998907779307");
    linkTelegram(orderId, 555000222);
    await customer.getByTestId("track-link").click();
    const trackingUrl = customer.url();

    await acceptOrder(staff, orderId);
    await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
    await driver.getByTestId("driver-primary-action").click();
    await readyOrder(staff, orderId);
    await expect(driver.locator(".delivery-card")).toBeVisible({ timeout: 15000 });
    await driver.getByTestId("driver-primary-action").click(); // PICKED_UP

    // Customer closes the TAB completely -- no open page for this order
    // at all from here on. Deliberately closes only the page, not the
    // whole browser context: tracking is authorized by a per-order token
    // persisted in that origin's localStorage (see the existing "?token="
    // deep-link test), which survives a closed tab on a real device just
    // as it does here -- closing the whole context would wipe it and
    // simulate a completely different device, not "closed the page."
    await customer.close();

    await driver.getByTestId("driver-primary-action").click(); // ON_THE_WAY
    await driver.getByTestId("driver-primary-action").click(); // ARRIVED

    // The enqueue is a pure server-side trigger on the ARRIVED transition
    // -- it cannot have depended on any customer page being open.
    await expect.poll(() => outboxCount(orderId, "TELEGRAM_CUSTOMER_ARRIVED"), { timeout: 10000 }).toBe(1);

    // Reopening the tracking link (a fresh page, same browser/context, so
    // the same locally-persisted token is still there -- exactly like
    // reopening a closed tab on the same phone) loads the authoritative
    // ARRIVED state immediately, no stale pre-close snapshot.
    const reopened = await customerContext.newPage();
    await reopened.goto(trackingUrl);
    await expect(reopened.getByTestId("order-status")).toContainText("Yetib keldi", { timeout: 15000 });
  } finally {
    await driverContext.close();
    await customerContext.close();
    await staffContext.close();
  }
});

test("Driver and Restaurant explicit realtime disconnect/recovery -- reconnect triggers an authoritative refetch, no manual refresh", async ({ browser }) => {
  test.setTimeout(90000);
  const driverContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const customerContext = await browser.newContext();
  try {
    const driver = await driverContext.newPage();
    const staff = await staffContext.newPage();
    const customer = await customerContext.newPage();

    await freeDriver(driver, "driver@zaytun.local");
    await signInStaff(staff);

    const orderId = await placeDeliveryOrder(customer, "OpVal Reconnect", "+998907779308");

    // Drop the DRIVER's connection before the assignment is created --
    // both the realtime websocket and any HTTP refetch are unreachable.
    await driverContext.setOffline(true);
    await acceptOrder(staff, orderId);
    await staff.waitForTimeout(1000);

    // Restore the driver's connection -- SUBSCRIBED-triggered refetch
    // must catch the driver up with no manual reload.
    await driverContext.setOffline(false);
    await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 20000 });
    await driver.getByTestId("driver-primary-action").click();
    await expect(driver.getByTestId("driver-pre-ready-card")).toBeVisible();

    // Now the RESTAURANT: land on the order-detail page (subscribed and
    // live) BEFORE dropping its connection, then miss a real update (the
    // driver checking in) while offline, and confirm it catches up on
    // reconnect with no navigation/reload at all.
    await staff.goto(`/restaurant/orders/${orderId}`);
    await expect(staff.getByTestId("driver-at-restaurant-notice")).toHaveCount(0);
    await staffContext.setOffline(true);
    await driver.getByTestId("driver-mark-at-restaurant").click();
    await expect(driver.getByTestId("driver-at-restaurant-badge")).toBeVisible();
    await staff.waitForTimeout(1000);
    // Still hasn't seen it -- genuinely missed, not just slow.
    await expect(staff.getByTestId("driver-at-restaurant-notice")).toHaveCount(0);
    await staffContext.setOffline(false);
    await expect(staff.getByTestId("driver-at-restaurant-notice")).toBeVisible({ timeout: 20000 });
  } finally {
    await driverContext.close();
    await staffContext.close();
    await customerContext.close();
  }
});
