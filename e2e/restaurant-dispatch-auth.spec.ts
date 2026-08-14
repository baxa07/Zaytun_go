import { expect, test } from "@playwright/test";
import { forceFreeDriver } from "./helpers/driverCleanup";

const localPassword = "zaytun-local-2026";

test("P5 restaurant dispatch presentation (real Supabase): genuine automatic assignment, no manual click, correct driver identity", async ({ browser }) => {
  const customerContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const staff = await staffContext.newPage();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();

  // Two seed drivers are both ON_SHIFT/ACTIVE by default -- take the other
  // one off shift so automatic dispatch has exactly one eligible
  // candidate, making the assigned identity deterministic to assert on.
  // Multi-Order Dispatch: an earlier spec's driver may be stuck holding
  // an accepted-but-not-yet-ready order with no driver-side action at all
  // -- see e2e/helpers/driverCleanup.ts.
  await forceFreeDriver("998900000099");
  await forceFreeDriver("driver@zaytun.local");

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

  // Free the seeded driver first so real automatic dispatch has an
  // eligible courier -- same technique as the other auth-local specs.
  await driver.goto("/driver");
  await driver.getByLabel("Telefon yoki email").fill("driver@zaytun.local");
  await driver.getByLabel("Parol").fill(localPassword);
  await driver.getByRole("button", { name: "Kirish" }).click();
  await expect(driver.getByRole("button", { name: "Chiqish" })).toBeVisible();
  // See driver-lifecycle-auth.spec.ts: the post-sign-in refresh is async and
  // can still be in flight right as "Chiqish" appears, so give it a moment
  // before trusting an immediate single-shot isVisible() check.
  await driver.waitForTimeout(500);
  // "Free" means no active assignment/delivery card -- not literally the
  // driver-no-active testid, since the driver may legitimately be showing
  // driver-standby-notice instead (another order still PREPARING
  // elsewhere in the branch). Standby is information, not ownership, so
  // it's still "free" for a fresh scenario.
  for (let i = 0; i < 6; i++) {
    if (await driver.locator(".assignment-card, .delivery-card").count() === 0) break;
    await driver.getByTestId("driver-primary-action").click().catch(() => driver.getByTestId("driver-primary-action").click());
    await driver.waitForTimeout(250);
  }
  await expect(driver.locator(".assignment-card, .delivery-card")).toHaveCount(0);

  await customer.goto("/menu/chicken");
  await customer.getByRole("button", { name: "+" }).click();
  await customer.getByTestId("buy-now").click();
  await customer.waitForURL("**/checkout");
  await customer.getByLabel("Ism *").fill("P5 Auth Mijoz");
  await customer.getByLabel("Telefon *").fill("+998907776900");
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
  await staff.getByTestId("action-confirm").click(); // Multi-Order Dispatch: real assignment happens right here, at ACCEPT -- not at READY
  // No manual click anywhere -- this is real Smart Dispatch, and the
  // restaurant is never asked "which driver?". Visible immediately,
  // well before the food is ready.
  await expect(staff.getByTestId("dispatch-courier-status")).toBeVisible({ timeout: 10000 });
  await expect(staff.getByTestId("dispatch-courier-status")).toContainText("Aziz Bekov");
  await staff.getByTestId("action-start-prep").click();
  await staff.getByTestId("action-mark-ready").click(); // reuses the existing assignment, no new search

  await expect(staff.getByTestId("dispatch-courier-status")).toContainText("Aziz Bekov");
  await expect(staff.getByTestId("dispatch-courier-status")).toContainText("Biriktirildi");
  await expect(staff.locator(".detail-head .badge")).toHaveText("Haydovchi biriktirilgan");

  await customerContext.close();
  await staffContext.close();
  await driverContext.close();
  await otherDriverContext.close();
});
