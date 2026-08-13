import { expect, test } from "@playwright/test";

// P5: the restaurant renders canonical backend state only -- these tests
// cover the new presentation pieces (exception banner, dispatch-searching/
// courier-monitoring state, demoted manual assignment) that the existing
// lifecycle specs don't directly assert on.
test.describe("P5 restaurant dispatch presentation", () => {
  test("a READY delivery order shows the automatic dispatch state, an exception chip, and manual assignment starts collapsed", async ({ context }) => {
    const customer = await context.newPage();
    const staff = await context.newPage();

    await customer.goto("/menu/chicken");
    await customer.getByRole("button", { name: "+" }).click();
    await customer.getByTestId("buy-now").click();
    await customer.waitForURL("**/checkout");
    await customer.getByLabel("Ism *").fill("Dispatch UX Mijoz");
    await customer.getByLabel("Telefon *").fill("+998907776800");
    await customer.getByLabel("Mahalla yoki tuman *").fill("Guliston tumani");
    await customer.getByLabel("Ko‘cha yoki joylashuv *").fill("Test ko‘chasi");
    await customer.getByTestId("map-picker-set").click();
    await customer.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
    await customer.getByTestId("checkout-submit").click();
    await customer.waitForURL("**/confirmation/**");
    const orderId = customer.url().split("/confirmation/")[1];

    await staff.goto(`/restaurant/orders/${orderId}`);
    await staff.getByTestId("approve-delivery").click();
    await staff.getByTestId("action-confirm").click();
    await staff.getByTestId("action-start-prep").click();
    await staff.getByTestId("action-mark-ready").click();

    // Automatic dispatch presentation -- no "which driver?" question.
    await expect(staff.getByTestId("dispatch-searching")).toBeVisible();
    await expect(staff.getByTestId("dispatch-searching")).toContainText("Kuryer qidirilmoqda");
    // The board-level exception chip for a courier-waiting order.
    await expect(staff.getByTestId("exception-COURIER_WAITING")).toBeVisible();

    // Manual assignment is a closed-by-default exception control -- the
    // driver option buttons are not directly clickable without opening it.
    const manualPanel = staff.locator(".manual-assign");
    await expect(manualPanel).toBeVisible();
    await expect(staff.getByTestId("assign-driver-driver-1")).toHaveCount(1);
    await expect(manualPanel).not.toHaveJSProperty("open", true);
    await manualPanel.locator("summary").click();
    await expect(manualPanel).toHaveJSProperty("open", true);
  });

  test("assigned/accepted/picked-up/on-the-way/arrived each render a courier-monitoring block, never a restaurant-side lifecycle action button", async ({ context }) => {
    const customer = await context.newPage();
    const staff = await context.newPage();
    const driver = await context.newPage();

    await driver.goto("/driver");
    await expect(driver.locator(".delivery-card")).toBeVisible();
    await driver.getByTestId("driver-primary-action").click();
    await driver.getByTestId("driver-primary-action").click();
    await expect(driver.getByTestId("driver-no-active")).toBeVisible();

    await customer.goto("/menu/chicken");
    await customer.getByRole("button", { name: "+" }).click();
    await customer.getByTestId("buy-now").click();
    await customer.waitForURL("**/checkout");
    await customer.getByLabel("Ism *").fill("Monitoring UX Mijoz");
    await customer.getByLabel("Telefon *").fill("+998907776801");
    await customer.getByLabel("Mahalla yoki tuman *").fill("Guliston tumani");
    await customer.getByLabel("Ko‘cha yoki joylashuv *").fill("Test ko‘chasi");
    await customer.getByTestId("map-picker-set").click();
    await customer.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
    await customer.getByTestId("checkout-submit").click();
    await customer.waitForURL("**/confirmation/**");
    const orderId = customer.url().split("/confirmation/")[1];

    await staff.goto(`/restaurant/orders/${orderId}`);
    await staff.getByTestId("approve-delivery").click();
    await staff.getByTestId("action-confirm").click();
    await staff.getByTestId("action-start-prep").click();
    await staff.getByTestId("action-mark-ready").click();
    await staff.locator(".manual-assign summary").click();
    await staff.getByTestId("assign-driver-driver-1").click();

    // Assigned, not yet accepted.
    await expect(staff.getByTestId("dispatch-courier-status")).toContainText("Biriktirildi");
    await expect(staff.getByTestId("dispatch-courier-status")).toContainText("Aziz Bekov");

    await driver.goto("/driver");
    await expect(driver.locator(".assignment-card")).toBeVisible();
    await driver.getByTestId("driver-primary-action").click(); // accept
    await staff.reload();
    await expect(staff.getByTestId("dispatch-courier-status")).toContainText("Qabul qildi");

    await driver.getByTestId("driver-primary-action").click(); // PICKED_UP
    await staff.reload();
    await expect(staff.getByTestId("dispatch-courier-status")).toContainText("Buyurtmani oldi");

    await driver.getByTestId("driver-primary-action").click(); // ON_THE_WAY
    await staff.reload();
    await expect(staff.getByTestId("dispatch-courier-status")).toContainText("Yo‘lda");

    await driver.getByTestId("driver-primary-action").click(); // ARRIVED
    await staff.reload();
    await expect(staff.getByTestId("dispatch-courier-status")).toContainText("Yetib bordi");

    // At no point does the restaurant get a courier-lifecycle action
    // button -- only the driver's own surface (Phase 4) controls that.
    for (const forbidden of ["action-mark-picked-up", "action-mark-on-the-way", "action-mark-arrived", "action-mark-delivered"]) {
      await expect(staff.getByTestId(forbidden)).toHaveCount(0);
    }

    await driver.getByTestId("driver-primary-action").click(); // DELIVERED
    await staff.reload();
    await expect(staff.locator(".detail-head .badge")).toHaveText("Yetkazildi");
    await expect(staff.getByTestId("dispatch-courier-status")).toHaveCount(0);
  });

  test("PICKUP orders never show dispatch-searching or courier-monitoring state, even once READY", async ({ page }) => {
    await page.goto("/menu/chicken");
    await page.getByTestId("buy-now").click();
    await page.getByTestId("type-pickup").click();
    await page.getByLabel("Ism *").fill("Pickup UX Mijoz");
    await page.getByLabel("Telefon *").fill("+998907776802");
    await page.getByTestId("checkout-submit").click();
    await page.waitForURL("**/confirmation/**");
    const orderId = page.url().split("/confirmation/")[1];

    await page.goto(`/restaurant/orders/${orderId}`);
    await page.getByTestId("action-confirm").click();
    await page.getByTestId("action-start-prep").click();
    await page.getByTestId("action-mark-ready").click();

    await expect(page.getByTestId("dispatch-searching")).toHaveCount(0);
    await expect(page.getByTestId("dispatch-courier-status")).toHaveCount(0);
    await expect(page.locator(".manual-assign")).toHaveCount(0);
    await expect(page.getByTestId("exception-COURIER_WAITING")).toHaveCount(0);
    // Pickup keeps its own primary action instead.
    await expect(page.getByTestId("action-mark-pickup-complete")).toBeVisible();
  });
});
