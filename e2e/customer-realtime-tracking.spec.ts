import { expect, test } from "@playwright/test";
import { forceFreeDriver } from "./helpers/driverCleanup";

// Customer Realtime + Driver Arrival Completion Phase. Every assertion in
// this file deliberately never calls customer.reload() -- the whole point
// is proving the tracking page updates itself (via the broadcast signal
// in src/realtime.ts, refetched through the existing token-gated
// get_order_tracking RPC) while staff/driver progress the SAME order from
// separate, real, signed-in Supabase sessions.
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
  // "driver-no-active" (see the knownOffDuty branch in App.tsx) -- go
  // on-shift first, before waiting on "driver-no-active" below, so a
  // driver left off-shift by an earlier test (real Supabase, no
  // per-file DB isolation) can never hang this helper.
  if (await page.getByTestId("driver-shift-toggle").isEnabled().catch(() => false)) {
    if ((await page.getByTestId("driver-availability-status").textContent()) !== "🟢 Ishga tayyor") {
      await page.getByTestId("driver-shift-toggle").click();
      await expect(page.getByTestId("driver-availability-status")).toHaveText("🟢 Ishga tayyor");
    }
  }
  // "Free" means no active assignment/delivery card -- not literally the
  // driver-no-active testid, since a driver may legitimately be showing
  // driver-standby-notice instead (informational, not ownership).
  for (let i = 0; i < 6; i++) {
    if (await page.locator(".assignment-card, .delivery-card").count() === 0) break;
    await page.getByTestId("driver-primary-action").click().catch(() => page.getByTestId("driver-primary-action").click());
    await page.waitForTimeout(250);
  }
  await expect(page.locator(".assignment-card, .delivery-card")).toHaveCount(0);
}

test("customer tracking page updates live across the full delivery lifecycle, including driver arrival, with no manual reload", async ({ browser }) => {
  const customerContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const staff = await staffContext.newPage();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();

  // Make ...003 the sole eligible driver so this test deterministically
  // watches its own page rather than guessing which seed driver gets
  // auto-dispatched.
  await freeDriver(otherDriver, "998900000099");
  if ((await otherDriver.getByTestId("driver-availability-status").textContent()) === "🟢 Ishga tayyor") {
    await otherDriver.getByTestId("driver-shift-toggle").click();
    await expect(otherDriver.getByTestId("driver-availability-status")).toHaveText("⚪ Hozir ishlamayapman");
  }
  // Not needed again -- closed immediately rather than held open for the
  // rest of this (already 3-context) test, to keep peak concurrent
  // browser resource usage down across this long sequential suite.
  await otherDriverContext.close();
  await freeDriver(driver, "driver@zaytun.local");

  await customer.goto("/menu/chicken");
  await customer.getByRole("button", { name: "+" }).click();
  await customer.getByTestId("buy-now").click();
  await customer.waitForURL("**/checkout");
  await customer.getByLabel("Ism *").fill("Realtime Mijoz");
  await customer.getByLabel("Telefon *").fill("+998907776611");
  await customer.getByLabel("Mahalla yoki tuman *").fill("Guliston tumani");
  await customer.getByLabel("Ko‘cha yoki joylashuv *").fill("Test ko‘chasi");
  await customer.getByTestId("map-picker-set").click();
  await customer.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
  await customer.getByTestId("checkout-submit").click();
  await customer.waitForURL("**/confirmation/**");
  const orderId = customer.url().split("/confirmation/")[1];

  // The one and only navigation to the tracking page in this whole test --
  // every status assertion below must resolve without another goto/reload.
  await customer.goto(`/track/${orderId}`);
  await expect(customer.getByTestId("order-status")).toContainText("Manzil tasdiqlanmoqda");

  await staff.goto(`/restaurant/orders/${orderId}`);
  await staff.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
  await staff.getByLabel("Parol").fill(localPassword);
  await staff.getByRole("button", { name: "Kirish" }).click();
  // Stage 1 ("Manzil tasdiqlandi") is driven by delivery_review_status
  // alone (see customerDeliveryStageIndex, src/fulfillmentLifecycle.ts)
  // and is reachable while order.status is still NEW -- the very first
  // live update this test proves is this approval landing without reload.
  await staff.getByTestId("approve-delivery").click();
  await expect(customer.getByTestId("order-status")).toContainText("Manzil tasdiqlandi", { timeout: 15000 });

  // CONFIRMED/PREPARING/READY/DRIVER_ASSIGNED all collapse into the same
  // "Tayyorlanmoqda" header label -- asserting it once after all three
  // staff actions still proves each one reached the customer live (the
  // review-status-only "Manzil tasdiqlandi" text from the previous step
  // is gone, replaced by kitchen-stage text), it just can't distinguish
  // CONFIRMED from PREPARING from READY by header text alone.
  await staff.getByTestId("action-confirm").click();
  await staff.getByTestId("action-start-prep").click();
  await staff.getByTestId("action-mark-ready").click(); // triggers real automatic dispatch
  await expect(customer.getByTestId("order-status")).toContainText("Tayyorlanmoqda", { timeout: 15000 });

  // A rapid click right as the primary action re-renders (label/target
  // change after the previous transition) can hit a momentarily detached
  // node -- retry once rather than failing the whole test, same pattern
  // this suite's own freeDriver() helper already relies on.
  const clickPrimaryAction = () =>
    driver.getByTestId("driver-primary-action").click().catch(() => driver.getByTestId("driver-primary-action").click());

  await driver.reload();
  await expect(driver.locator(".assignment-card")).toBeVisible();
  await clickPrimaryAction(); // accept
  await clickPrimaryAction(); // PICKED_UP
  await expect(customer.getByTestId("order-status")).toContainText("Haydovchiga berildi", { timeout: 15000 });

  await clickPrimaryAction(); // ON_THE_WAY
  await expect(customer.getByTestId("order-status")).toContainText("Yo‘lda", { timeout: 15000 });

  await clickPrimaryAction(); // ARRIVED
  await expect(customer.getByTestId("order-status")).toContainText("Yetib keldi", { timeout: 15000 });
  await expect(customer.getByTestId("driver-arrived-message")).toBeVisible();

  await clickPrimaryAction(); // DELIVERED
  await expect(customer.getByTestId("order-status")).toContainText("Yetkazildi", { timeout: 15000 });

  // Terminal: the page must remain stable (no error, no stale flicker)
  // once nothing will ever change again -- both the realtime subscription
  // and the backup poll tear down at this point (see isTerminal in
  // src/App.tsx's Track component).
  await customer.waitForTimeout(1000);
  await expect(customer.getByTestId("order-status")).toContainText("Yetkazildi");

  await customerContext.close();
  await staffContext.close();
  await driverContext.close();
});

test("a status change missed while the customer is offline is caught up automatically once back online, with no reload", async ({ browser }) => {
  const customerContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const staff = await staffContext.newPage();

  await customer.goto("/menu/chicken");
  await customer.getByRole("button", { name: "+" }).click();
  await customer.getByTestId("buy-now").click();
  await customer.waitForURL("**/checkout");
  await customer.getByLabel("Ism *").fill("Offline Mijoz");
  await customer.getByLabel("Telefon *").fill("+998907776622");
  await customer.getByLabel("Mahalla yoki tuman *").fill("Guliston tumani");
  await customer.getByLabel("Ko‘cha yoki joylashuv *").fill("Test ko‘chasi");
  await customer.getByTestId("map-picker-set").click();
  await customer.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
  await customer.getByTestId("checkout-submit").click();
  await customer.waitForURL("**/confirmation/**");
  const orderId = customer.url().split("/confirmation/")[1];

  await customer.goto(`/track/${orderId}`);
  await expect(customer.getByTestId("order-status")).toContainText("Manzil tasdiqlanmoqda");

  await staff.goto(`/restaurant/orders/${orderId}`);
  await staff.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
  await staff.getByLabel("Parol").fill(localPassword);
  await staff.getByRole("button", { name: "Kirish" }).click();

  // Drop the customer's connection entirely -- both the realtime
  // websocket and any HTTP refetch are unreachable while offline, so the
  // approval below is genuinely missed, not just slow to arrive.
  await customerContext.setOffline(true);
  await staff.getByTestId("approve-delivery").click();
  await staff.getByTestId("action-confirm").click();
  await staff.getByTestId("action-start-prep").click();
  await staff.waitForTimeout(1000);
  // Still showing the pre-offline state -- nothing could have reached this page.
  await expect(customer.getByTestId("order-status")).toContainText("Manzil tasdiqlanmoqda");

  // Coming back online reconnects the realtime channel (which itself
  // triggers a refetch on SUBSCRIBED) and fires the browser's own
  // `online` event (a second, independent refetch trigger) -- either one
  // alone is enough to catch the page up with no reload.
  await customerContext.setOffline(false);
  await expect(customer.getByTestId("order-status")).toContainText("Tayyorlanmoqda", { timeout: 20000 });

  await customerContext.close();
  await staffContext.close();
});

test("a Telegram deep-link style URL (?token=) opened in a browser that never placed the order still loads live tracking correctly", async ({ browser }) => {
  const placingContext = await browser.newContext();
  const placing = await placingContext.newPage();

  await placing.goto("/menu/chicken");
  await placing.getByTestId("buy-now").click();
  await placing.waitForURL("**/checkout");
  await placing.getByLabel("Ism *").fill("Token Link Mijoz");
  await placing.getByLabel("Telefon *").fill("+998907776633");
  await placing.getByTestId("type-pickup").click();
  await placing.getByTestId("checkout-submit").click();
  await placing.waitForURL("**/confirmation/**");
  const orderId = placing.url().split("/confirmation/")[1];
  const token = await placing.evaluate(
    (id) => (JSON.parse(localStorage.getItem("zgo.tracking") || "{}") as Record<string, string>)[id],
    orderId,
  );
  expect(token).toBeTruthy();

  // A completely separate browser context, with empty localStorage --
  // exactly what opening the tracking link from Telegram's own in-app
  // browser looks like.
  const freshContext = await browser.newContext();
  const fresh = await freshContext.newPage();
  await fresh.goto(`/track/${orderId}?token=${token}`);
  await expect(fresh.getByTestId("order-status")).toBeVisible();
  await expect(fresh.locator(".track")).not.toContainText("Kuzatuv havolasi noto‘g‘ri yoki mavjud emas");

  // The token is now persisted locally in this context too, exactly as if
  // this browser had placed the order itself -- a plain reload (no query
  // string) still works.
  await fresh.goto(`/track/${orderId}`);
  await expect(fresh.getByTestId("order-status")).toBeVisible();

  await placingContext.close();
  await freshContext.close();
});
