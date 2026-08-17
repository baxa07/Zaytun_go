import { expect, test, type Page } from "@playwright/test";

async function placeDeliveryOrder(customer: Page, house = "5A") {
  await customer.goto("/menu/chicken");
  await customer.getByRole("button", { name: "+" }).click(); // 136,000 so'm clears the delivery minimum
  await customer.getByTestId("buy-now").click();
  await customer.waitForURL("**/checkout");
  await customer.getByLabel("Ism *").fill("Timeline Test Mijoz");
  await customer.getByLabel("Telefon *").fill("+998901112233");
  await customer.getByLabel("Mahalla yoki tuman *").fill("Karmana tumani");
  await customer.getByLabel("Ko‘cha yoki joylashuv *").fill("Bunyodkor ko‘chasi");
  await customer.getByLabel("Uy / bino (ixtiyoriy)").fill(house);
  await customer.getByTestId("map-picker-set").click();
  await customer.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
  await customer.getByTestId("checkout-submit").click();
  await customer.waitForURL("**/confirmation/**");
  const orderId = customer.url().split("/confirmation/")[1];
  await customer.getByTestId("track-link").click();
  await customer.waitForURL(`**/track/${orderId}`);
  return orderId;
}

const noHorizontalOverflow = async (page: Page) => {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
};

test.describe("customer delivery timeline: event-driven 8-stage mapping", () => {
  test("Haydovchiga berildi begins at driver pickup, not at assignment, across the full flow", async ({ context }) => {
    const customer = await context.newPage();
    const staff = await context.newPage();
    const driver = await context.newPage();

    // Free the seeded driver first, same technique as canonical-lifecycle.spec.ts.
    await driver.goto("/driver");
    await expect(driver.locator(".delivery-card")).toBeVisible();
    await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yetib keldim");
    await driver.getByTestId("driver-primary-action").click();
    await expect(driver.getByTestId("driver-primary-action")).toHaveText("Yetkazildi");
    await driver.getByTestId("driver-primary-action").click();
    await expect(driver.getByTestId("driver-no-active")).toBeVisible();

    const orderId = await placeDeliveryOrder(customer);
    await expect(customer.getByTestId("order-status")).toHaveText("Manzil tasdiqlanmoqda");

    await staff.goto(`/restaurant/orders/${orderId}`);
    await staff.getByTestId("approve-delivery").click();
    await customer.reload();
    await expect(customer.getByTestId("order-status")).toHaveText("Manzil tasdiqlandi");

    await staff.getByTestId("action-confirm").click();
    await customer.reload();
    await expect(customer.getByTestId("order-status")).toHaveText("Tayyorlanmoqda");

    await staff.getByTestId("action-start-prep").click();
    await customer.reload();
    await expect(customer.getByTestId("order-status")).toHaveText("Tayyorlanmoqda");

    await staff.getByTestId("action-mark-ready").click();
    await customer.reload();
    await expect(customer.getByTestId("order-status")).toHaveText("Tayyorlanmoqda");

    await staff.locator(".manual-assign summary").click();
    await staff.getByTestId("assign-driver-driver-1").click();
    await customer.reload();
    // DRIVER_ASSIGNED must NOT read as Haydovchiga berildi.
    await expect(customer.getByTestId("order-status")).toHaveText("Tayyorlanmoqda");
    await expect(customer.getByTestId("order-status")).not.toHaveText("Haydovchiga berildi");

    await driver.goto("/driver");
    await expect(driver.getByTestId("driver-primary-action")).toHaveText("Qabul qilish");
    await driver.getByTestId("driver-primary-action").click(); // accept
    await customer.reload();
    // Accepted but not yet physically picked up: still Tayyorlanmoqda.
    await expect(customer.getByTestId("order-status")).toHaveText("Tayyorlanmoqda");

    await driver.getByTestId("driver-mark-at-restaurant").click();
    await customer.reload();
    await expect(customer.locator(".timeline > div").filter({ hasText: "Haydovchi restoranga keldi" })).toHaveClass(/done/);

    await driver.getByTestId("driver-primary-action").click(); // PICKED_UP
    await customer.reload();
    await expect(customer.getByTestId("order-status")).toHaveText("Haydovchiga berildi");

    await driver.getByTestId("driver-primary-action").click(); // ON_THE_WAY
    await customer.reload();
    await expect(customer.getByTestId("order-status")).toHaveText("Yo‘lda");

    await driver.getByTestId("driver-primary-action").click(); // ARRIVED
    await customer.reload();
    await expect(customer.getByTestId("order-status")).toHaveText("Yetib keldi");

    await driver.getByTestId("driver-primary-action").click(); // DELIVERED
    await customer.reload();
    await expect(customer.getByTestId("order-status")).toHaveText("Yetkazildi");

    const stageLabels = await customer.locator(".timeline b").allTextContents();
    expect(stageLabels).toEqual(["Buyurtma qabul qilindi", "Manzil tasdiqlandi", "Tayyorlanmoqda", "Haydovchi restoranga keldi", "Haydovchiga berildi", "Yo‘lda", "Yetib keldi", "Yetkazildi"]);
    await expect(customer.locator(".timeline > div.done")).toHaveCount(8);
  });
});

test.describe("customer delivery timeline: exceptional states never fake progress", () => {
  test("a cancelled delivery order shows cancellation, not Manzil tasdiqlandi or later stages", async ({ page }) => {
    const orderId = await placeDeliveryOrder(page, "9-uy");
    const staff = await page.context().newPage();
    await staff.goto(`/restaurant/orders/${orderId}`);
    await staff.getByTestId("delivery-review-required").waitFor();
    await staff.getByPlaceholder("Bekor qilish sababi").fill("Mijoz so‘radi");
    await staff.getByTestId("action-cancel").click();
    await expect(staff.locator(".detail-head .badge")).toHaveText("Bekor qilindi");

    await page.reload();
    await expect(page.getByTestId("order-status")).toHaveText("Bekor qilindi");
    await expect(page.getByTestId("order-status")).not.toHaveText("Manzil tasdiqlandi");
    await expect(page.getByTestId("order-status")).not.toHaveText("Yetkazildi");
    await noHorizontalOverflow(page);
  });
});

test.describe("responsive: customer delivery timeline and driver surface", () => {
  const viewports = [
    { name: "desktop", width: 1440, height: 900 },
    { name: "phone-390", width: 390, height: 844 },
    { name: "phone-320", width: 320, height: 700 },
  ];

  test("eight-stage timeline stays overflow-free and readable at desktop and mobile widths", async ({ page }) => {
    const orderId = await placeDeliveryOrder(page);
    const staff = await page.context().newPage();
    await staff.goto(`/restaurant/orders/${orderId}`);
    await staff.getByTestId("approve-delivery").click();
    await staff.getByTestId("action-confirm").click();

    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.reload();
      await expect(page.getByTestId("order-status")).toHaveText("Tayyorlanmoqda");
      await expect(page.locator(".timeline")).toBeVisible();
      await noHorizontalOverflow(page);
    }
  });

  test("driver surface has no leftover empty space or overflow after removing Keyingi yetkazish", async ({ context }) => {
    const driver = await context.newPage();
    for (const viewport of [{ width: 390, height: 844 }, { width: 810, height: 1080 }]) {
      await driver.setViewportSize(viewport);
      await driver.goto("/driver");
      await expect(driver.locator(".delivery-card")).toBeVisible();
      await expect(driver.getByText(/Keyingi yetkazish/i)).toHaveCount(0);
      await noHorizontalOverflow(driver);
    }
  });
});
