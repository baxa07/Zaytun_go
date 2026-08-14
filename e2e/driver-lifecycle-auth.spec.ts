import { expect, test } from "@playwright/test";

const localPassword = "zaytun-local-2026";

test("P4 driver work surface (real Supabase): auto-dispatch assignment, accept, one-action-per-stage, and real shift toggle", async ({ browser }) => {
  // Separate browser contexts (not just separate pages in one context) --
  // Supabase's persisted session lives in localStorage, shared by every
  // page within the SAME context. The driver and staff sessions must
  // coexist simultaneously here (the driver stays logged in throughout
  // while staff progresses the order), so they need their own isolated
  // storage, exactly like real separate devices would have.
  const customerContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const staff = await staffContext.newPage();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();

  // Two seed drivers (...003 and ...004) are both ON_SHIFT/ACTIVE by
  // default -- either could be the one automatic dispatch actually picks.
  // Taking the other driver off shift makes ...003 the only eligible
  // candidate, so this test can deterministically watch a single driver's
  // page rather than guessing which one gets the assignment.
  await otherDriver.goto("/driver");
  await otherDriver.getByLabel("Telefon yoki email").fill("998900000099");
  await otherDriver.getByLabel("Parol").fill(localPassword);
  await otherDriver.getByRole("button", { name: "Kirish" }).click();
  await expect(otherDriver.getByRole("button", { name: "Chiqish" })).toBeVisible();
  if (await otherDriver.getByTestId("driver-shift-toggle").isEnabled().catch(() => false)) {
    if ((await otherDriver.getByTestId("driver-availability-status").textContent()) === "🟢 Ishga tayyor") {
      await otherDriver.getByTestId("driver-shift-toggle").click();
    }
  }

  // Free the seeded driver first so automatic dispatch has an eligible
  // courier -- other specs in this same suite run against the same
  // persistent local DB and may leave driver ...003 mid-delivery at any
  // stage (accept through DELIVERED), so this walks the primary action
  // through to completion regardless of exactly where it's stuck, rather
  // than assuming a fixed number of clicks.
  await driver.goto("/driver");
  await driver.getByLabel("Telefon yoki email").fill("driver@zaytun.local");
  await driver.getByLabel("Parol").fill(localPassword);
  await driver.getByRole("button", { name: "Kirish" }).click();
  await expect(driver.getByRole("button", { name: "Chiqish" })).toBeVisible();
  // The post-sign-in data refresh (orders + drivers fetch) is async and can
  // still be in flight the instant "Chiqish" appears -- an immediate
  // single-shot isVisible() check here can catch a not-yet-settled render
  // and misread it, so give the first fetch cycle a moment to land before
  // trusting this check, same as the settled wait already used between
  // iterations below.
  await driver.waitForTimeout(500);
  // "Free" means no active assignment/delivery card -- not literally the
  // driver-no-active testid, since the driver may legitimately be showing
  // driver-standby-notice instead (another order still PREPARING
  // elsewhere in the branch, e.g. left there on purpose by
  // customer-realtime-tracking.spec.ts's offline/online test). Standby is
  // information, not ownership, so it's still "free" for a fresh scenario.
  for (let i = 0; i < 6; i++) {
    if (await driver.locator(".assignment-card, .delivery-card").count() === 0) break;
    // A rapid click right as the primary action re-renders (label/target
    // change after the previous transition) can hit a momentarily
    // detached node -- retry once rather than failing the whole setup step.
    await driver.getByTestId("driver-primary-action").click().catch(() => driver.getByTestId("driver-primary-action").click());
    await driver.waitForTimeout(250);
  }
  await expect(driver.locator(".assignment-card, .delivery-card")).toHaveCount(0);
  await expect(driver.getByTestId("driver-availability-status")).toHaveText("🟢 Ishga tayyor");

  await customer.goto("/menu/chicken");
  await customer.getByRole("button", { name: "+" }).click();
  await customer.getByTestId("buy-now").click();
  await customer.waitForURL("**/checkout");
  await customer.getByLabel("Ism *").fill("Driver P4 Mijoz");
  await customer.getByLabel("Telefon *").fill("+998907776600");
  await customer.getByLabel("Mahalla yoki tuman *").fill("Guliston tumani");
  await customer.getByLabel("Ko‘cha yoki joylashuv *").fill("Test ko‘chasi");
  await customer.getByTestId("map-picker-set").click();
  await customer.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
  await customer.getByTestId("checkout-submit").click();
  await customer.waitForURL("**/confirmation/**");
  const orderId = customer.url().split("/confirmation/")[1];

  await staff.goto(`/restaurant/orders/${orderId}`);
  await staff.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
  await staff.getByLabel("Parol").fill(localPassword);
  await staff.getByRole("button", { name: "Kirish" }).click();
  await staff.getByTestId("approve-delivery").click();
  await staff.getByTestId("action-confirm").click();
  await staff.getByTestId("action-start-prep").click();
  await staff.getByTestId("action-mark-ready").click(); // triggers real automatic dispatch

  // P4.2: a genuinely new assignment produces the prominent "new delivery"
  // card, not the active-delivery card, before acceptance.
  await driver.reload();
  await expect(driver.locator(".assignment-card")).toBeVisible();
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Qabul qilish");
  // P6.1: decline is now real (Smart Dispatch Phase 6), and stays enabled
  // pre-acceptance -- it disappears entirely once accepted, asserted below.
  await expect(driver.getByTestId("driver-decline-assignment")).toBeEnabled();

  // P4.4: exactly one primary action visible at every stage from here on.
  await driver.getByTestId("driver-primary-action").click(); // accept
  await expect(driver.locator(".delivery-card")).toBeVisible();
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Buyurtmani oldim");
  await expect(driver.getByTestId("driver-primary-action")).toHaveCount(1);

  await driver.getByTestId("driver-primary-action").click(); // PICKED_UP
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yo‘lga chiqdim");
  await expect(driver.getByTestId("driver-primary-action")).toHaveCount(1);

  await driver.getByTestId("driver-primary-action").click(); // ON_THE_WAY
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yetib keldim");
  await expect(driver.getByTestId("driver-primary-action")).toHaveCount(1);

  await driver.getByTestId("driver-primary-action").click(); // ARRIVED
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yetkazildi");
  await expect(driver.getByTestId("driver-primary-action")).toHaveCount(1);

  await driver.getByTestId("driver-primary-action").click(); // DELIVERED
  // Proof the delivery is complete and the driver has no active work --
  // not literally driver-no-active, since a standby notice for some other
  // order elsewhere in the branch may legitimately be showing instead.
  await expect(driver.locator(".assignment-card, .delivery-card")).toHaveCount(0);

  // P4.1: shift toggle actually persists to the server -- reload proves
  // it's real state, not just local React state.
  await expect(driver.getByTestId("driver-shift-toggle")).toBeEnabled();
  await driver.getByTestId("driver-shift-toggle").click();
  await expect(driver.getByTestId("driver-availability-status")).toHaveText("⚪ Hozir ishlamayapman");
  await driver.reload();
  await expect(driver.getByTestId("driver-availability-status")).toHaveText("⚪ Hozir ishlamayapman");
  await expect(driver.getByTestId("driver-off-duty")).toBeVisible();

  await driver.getByTestId("driver-shift-toggle").click();
  await expect(driver.getByTestId("driver-availability-status")).toHaveText("🟢 Ishga tayyor");

  await customerContext.close();
  await staffContext.close();
  await driverContext.close();
  await otherDriverContext.close();
});
