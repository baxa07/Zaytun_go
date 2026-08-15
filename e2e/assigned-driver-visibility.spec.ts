import { expect, test } from "@playwright/test";

// driver-1's seeded local-store identity (src/data.ts) -- Aziz Bekov,
// +998 93 555 12 12. The seeded active order keeps driver-1 BUSY until it's
// completed, so every test here frees driver-1 up first, matching the same
// pattern canonical-lifecycle.spec.ts already establishes for this reason.

async function freeUpDriverOne(driver: import("@playwright/test").Page) {
  await driver.goto("/driver");
  await expect(driver.locator(".delivery-card")).toBeVisible();
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yetib keldim");
  await driver.getByTestId("driver-primary-action").click(); // ON_THE_WAY -> ARRIVED
  await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yetkazildi");
  await driver.getByTestId("driver-primary-action").click(); // ARRIVED -> DELIVERED
  await expect(driver.getByTestId("driver-no-active")).toBeVisible();
}

async function placeDeliveryOrder(customer: import("@playwright/test").Page) {
  await customer.goto("/menu/chicken");
  await customer.getByRole("button", { name: "+" }).click();
  await customer.getByTestId("buy-now").click();
  await customer.waitForURL("**/checkout");
  await customer.getByLabel("Ism *").fill("Haydovchi Ko‘rinishi Mijoz");
  await customer.getByLabel("Telefon *").fill("+998907778811");
  await customer.getByLabel("Mahalla yoki tuman *").fill("Karmana tumani");
  await customer.getByLabel("Ko‘cha yoki joylashuv *").fill("Bunyodkor ko‘chasi");
  await customer.getByLabel("Uy / bino (ixtiyoriy)").fill("5A");
  await customer.getByTestId("map-picker-set").click();
  await customer.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
  await customer.getByTestId("checkout-submit").click();
  await customer.waitForURL("**/confirmation/**");
  return customer.url().split("/confirmation/")[1];
}

test.describe("assigned driver visibility for restaurant staff (Phase 5B, launch blocker 2)", () => {
  test("driver identity is visible from DRIVER_ASSIGNED through DELIVERED, with no raw id or enum", async ({ context }) => {
    const customer = await context.newPage();
    const staff = await context.newPage();
    const driver = await context.newPage();

    await freeUpDriverOne(driver);
    const orderId = await placeDeliveryOrder(customer);

    await staff.goto(`/restaurant/orders/${orderId}`);
    // Before assignment, staff has no driver identity to show yet -- and
    // the address/contact panel that block would live in doesn't error.
    await expect(staff.getByTestId("assigned-driver")).toHaveCount(0);

    await staff.getByTestId("approve-delivery").click();
    await staff.getByTestId("action-confirm").click();
    await staff.getByTestId("action-start-prep").click();
    await staff.getByTestId("action-mark-ready").click();
    await staff.locator(".manual-assign summary").click();
    await staff.getByTestId("assign-driver-driver-1").click();

    // DRIVER_ASSIGNED: the exact requirement from Phase 5A -- staff can now
    // answer "who currently has this delivery?" without leaving the page.
    const assignedDriverPanel = staff.getByTestId("assigned-driver");
    await expect(assignedDriverPanel).toBeVisible();
    await expect(assignedDriverPanel).toContainText("Aziz Bekov");
    const driverPhoneLink = assignedDriverPanel.getByRole("link", { name: /\+998 93 555 12 12/ });
    await expect(driverPhoneLink).toHaveAttribute("href", "tel:+998 93 555 12 12");
    // No raw internal id or untranslated enum leaked into this panel.
    await expect(assignedDriverPanel).not.toContainText("driver-1");
    await expect(assignedDriverPanel).not.toContainText("AVAILABLE");
    await expect(assignedDriverPanel).not.toContainText("OFFLINE");

    await driver.goto("/driver");
    await driver.getByTestId("driver-primary-action").click(); // accept
    await driver.getByTestId("driver-primary-action").click(); // PICKED_UP

    await staff.reload();
    // ON_THE_WAY: still visible, still correct, after the order has moved
    // two more stages past assignment and a full page reload.
    await driver.getByTestId("driver-primary-action").click(); // ON_THE_WAY
    await staff.reload();
    await expect(staff.getByTestId("assigned-driver")).toBeVisible();
    await expect(staff.getByTestId("assigned-driver")).toContainText("Aziz Bekov");

    await driver.getByTestId("driver-primary-action").click(); // ARRIVED
    await driver.getByTestId("driver-primary-action").click(); // DELIVERED
    await expect(driver.getByTestId("driver-no-active")).toBeVisible();

    await staff.reload();
    // DELIVERED: the historical record survives to the terminal state --
    // staff can still see who handled a completed order.
    await expect(staff.locator(".detail-head .badge")).toHaveText("Yetkazildi");
    await expect(staff.getByTestId("assigned-driver")).toBeVisible();
    await expect(staff.getByTestId("assigned-driver")).toContainText("Aziz Bekov");
    await expect(staff.getByTestId("assigned-driver").getByRole("link", { name: /\+998 93 555 12 12/ })).toBeVisible();

    // The READY-only assignment picker must not still be showing now that
    // the order is long past READY -- assignment controls stay correctly
    // gated to their original single stage, unaffected by this change.
    await expect(staff.getByTestId("assign-driver-driver-1")).toHaveCount(0);
  });

  test("pickup orders never show a driver-identity block", async ({ page }) => {
    await page.goto("/menu/chicken");
    await page.getByTestId("buy-now").click();
    await page.waitForURL("**/checkout");
    await page.getByTestId("type-pickup").click();
    await page.getByLabel("Restoranda karta orqali").check();
    await page.getByLabel("Ism *").fill("Olib Ketish Mijoz");
    await page.getByLabel("Telefon *").fill("+998907778822");
    await page.getByTestId("checkout-submit").click();
    await page.waitForURL("**/confirmation/**");
    const orderId = page.url().split("/confirmation/")[1];

    await page.goto(`/restaurant/orders/${orderId}`);
    await page.getByTestId("action-confirm").click();
    await page.getByTestId("action-start-prep").click();
    await page.getByTestId("action-mark-ready").click();
    await page.getByTestId("action-mark-pickup-complete").click();
    await expect(page.locator(".detail-head .badge")).toHaveText("Olib ketildi");

    await expect(page.getByTestId("assigned-driver")).toHaveCount(0);
  });
});
