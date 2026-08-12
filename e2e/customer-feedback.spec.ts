import { expect, test } from "@playwright/test";

test.describe("H3 customer feedback", () => {
  test("PICKUP: not shown before COLLECTED, dismissible, remains available on reload, conditional food issue reveal, submits and persists a read-only confirmation", async ({ page }) => {
    await page.goto("/menu/chicken");
    await page.getByTestId("buy-now").click();
    await page.getByTestId("type-pickup").click();
    await page.getByLabel("Ism *").fill("Feedback Test Mijoz");
    await page.getByLabel("Telefon *").fill("+998907771234");
    await page.getByTestId("checkout-submit").click();
    await page.waitForURL("**/confirmation/**");
    const orderId = page.url().split("/confirmation/")[1];
    await page.getByTestId("track-link").click();
    await page.waitForURL(`**/track/${orderId}`);

    // Not yet eligible -- order is still NEW.
    await expect(page.getByTestId("feedback-card")).toHaveCount(0);

    const staff = await page.context().newPage();
    await staff.goto(`/restaurant/orders/${orderId}`);
    await staff.getByTestId("action-confirm").click();
    await page.reload();
    await expect(page.getByTestId("feedback-card")).toHaveCount(0);

    await staff.getByTestId("action-start-prep").click();
    await staff.getByTestId("action-mark-ready").click();
    await page.reload();
    await expect(page.getByTestId("feedback-card")).toHaveCount(0);

    await staff.getByTestId("action-mark-pickup-complete").click();
    await page.reload();
    // Now eligible -- COLLECTED. PICKUP feedback is food-only, no delivery question.
    await expect(page.getByTestId("feedback-card")).toBeVisible();
    await expect(page.getByText("Yetkazib berish qanday bo‘ldi?")).toHaveCount(0);
    await expect(page.getByText("Taom sizga qanday yoqdi?")).toBeVisible();

    // Dismissible.
    await page.getByTestId("feedback-dismiss").click();
    await expect(page.getByTestId("feedback-card")).toHaveCount(0);
    // Not yet submitted -- the invitation remains available on return/reload.
    await page.reload();
    await expect(page.getByTestId("feedback-card")).toBeVisible();

    // Conditional issue reveal: only when the rating warrants it.
    await expect(page.getByTestId("feedback-food-issue-reasons")).toHaveCount(0);
    await page.getByTestId("feedback-food-EXCELLENT").click();
    await expect(page.getByTestId("feedback-food-issue-reasons")).toHaveCount(0);
    await page.getByTestId("feedback-food-BAD").click();
    await expect(page.getByTestId("feedback-food-issue-reasons")).toBeVisible();
    await page.getByTestId("feedback-food-issue-COLD").click();

    // Basic positive feedback requires no comment -- submit works with just the answers.
    await page.getByTestId("feedback-submit").click();
    await expect(page.getByTestId("feedback-submitted")).toBeVisible();
    await expect(page.getByTestId("feedback-submitted")).toContainText("Yomon");

    // Read-only afterward -- reload does not show the form again, only the confirmation.
    await page.reload();
    await expect(page.getByTestId("feedback-submitted")).toBeVisible();
    await expect(page.getByTestId("feedback-card")).toHaveCount(0);
  });

  test("DELIVERY: delivery rating is required, ISSUE reveals structured reasons, submission carries both answers", async ({ context }) => {
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
    await customer.getByLabel("Ism *").fill("Feedback Delivery Mijoz");
    await customer.getByLabel("Telefon *").fill("+998907771235");
    await customer.getByLabel("Mahalla yoki tuman *").fill("Karmana tumani");
    await customer.getByLabel("Ko‘cha yoki joylashuv *").fill("Test ko‘chasi");
    await customer.getByTestId("map-picker-set").click();
    await customer.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
    await customer.getByTestId("checkout-submit").click();
    await customer.waitForURL("**/confirmation/**");
    const orderId = customer.url().split("/confirmation/")[1];
    await customer.getByTestId("track-link").click();

    await staff.goto(`/restaurant/orders/${orderId}`);
    await staff.getByTestId("approve-delivery").click();
    await staff.getByTestId("action-confirm").click();
    await staff.getByTestId("action-start-prep").click();
    await staff.getByTestId("action-mark-ready").click();
    await staff.getByTestId("assign-driver-driver-1").click();

    await driver.goto("/driver");
    await driver.getByTestId("driver-primary-action").click(); // accept
    await driver.getByTestId("driver-primary-action").click(); // PICKED_UP
    await driver.getByTestId("driver-primary-action").click(); // ON_THE_WAY
    await driver.getByTestId("driver-primary-action").click(); // ARRIVED
    await driver.getByTestId("driver-primary-action").click(); // DELIVERED

    await customer.reload();
    await expect(customer.getByTestId("feedback-card")).toBeVisible();

    // Submit is disabled until the required delivery rating is chosen.
    await customer.getByTestId("feedback-food-GOOD").click();
    await expect(customer.getByTestId("feedback-submit")).toBeDisabled();

    await expect(customer.getByTestId("feedback-delivery-issue-reasons")).toHaveCount(0);
    await customer.getByTestId("feedback-delivery-ISSUE").click();
    await expect(customer.getByTestId("feedback-delivery-issue-reasons")).toBeVisible();
    await customer.getByTestId("feedback-delivery-issue-VERY_LATE").click();
    await customer.getByTestId("feedback-comment").fill("Kuryer juda kech keldi.");

    await expect(customer.getByTestId("feedback-submit")).toBeEnabled();
    await customer.getByTestId("feedback-submit").click();
    await expect(customer.getByTestId("feedback-submitted")).toContainText("Muammo bo‘ldi");
    await expect(customer.getByTestId("feedback-submitted")).toContainText("Yaxshi");

    // Staff can read the feedback on the order detail page.
    await staff.reload();
    await expect(staff.getByTestId("order-feedback-panel")).toContainText("Muammo bo‘ldi");
    await expect(staff.getByTestId("order-feedback-panel")).toContainText("Juda kech keldi");
  });
});
