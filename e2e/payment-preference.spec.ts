import { expect, test, type Page } from "@playwright/test";

async function openDeliveryCheckout(page: Page) {
  await page.goto("/menu/chicken");
  await page.getByRole("button", { name: "+" }).click();
  await page.getByTestId("buy-now").click();
  await page.waitForURL("**/checkout");
  await page.getByLabel("Ism *").fill("To‘lov Test Mijoz");
  await page.getByLabel("Telefon *").fill("+998901112233");
  await page.getByLabel("Mahalla yoki tuman *").fill("Karmana tumani");
  await page.getByLabel("Ko‘cha yoki joylashuv *").fill("Bunyodkor ko‘chasi");
  await page.getByTestId("map-picker-set").click();
  await page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
}

test.describe("Payment Preference v1", () => {
  test("delivery checkout offers CASH, Click and Payme with customer-friendly labels", async ({ page }) => {
    await openDeliveryCheckout(page);
    await expect(page.getByLabel("Naqd pul")).toBeVisible();
    await expect(page.getByLabel("💳 Click")).toBeVisible();
    await expect(page.getByLabel("💳 Payme")).toBeVisible();
    // No raw enum values, provider SDK names, or account/card details leak
    // into the checkout page.
    await expect(page.locator("main")).not.toContainText("CLICK");
    await expect(page.locator("main")).not.toContainText("PAYME");
  });

  test("CASH still works end to end for delivery, with no remote-payment notice", async ({ page }) => {
    await openDeliveryCheckout(page);
    await expect(page.getByLabel("Naqd pul")).toBeChecked();
    await expect(page.getByTestId("remote-payment-notice")).toHaveCount(0);
    await page.getByTestId("checkout-submit").click();
    await expect(page).toHaveURL(/\/confirmation\//);
  });

  test("selecting Click shows the explanatory notice, never a transfer instruction", async ({ page }) => {
    await openDeliveryCheckout(page);
    await page.getByLabel("💳 Click").check();
    await expect(page.getByTestId("remote-payment-notice")).toHaveText(
      "Restoran buyurtmangizni tasdiqlagach, to‘lov uchun siz bilan bog‘lanadi.",
    );
    await expect(page.getByTestId("remote-payment-notice")).not.toContainText("karta");
    await expect(page.getByTestId("review-payment-method")).toContainText("Click");
    await page.getByTestId("checkout-submit").click();
    await expect(page).toHaveURL(/\/confirmation\//);
  });

  test("selecting Payme shows the explanatory notice and completes checkout normally", async ({ page }) => {
    await openDeliveryCheckout(page);
    await page.getByLabel("💳 Payme").check();
    await expect(page.getByTestId("remote-payment-notice")).toHaveText(
      "Restoran buyurtmangizni tasdiqlagach, to‘lov uchun siz bilan bog‘lanadi.",
    );
    await expect(page.getByTestId("review-payment-method")).toContainText("Payme");
    await page.getByTestId("checkout-submit").click();
    await expect(page).toHaveURL(/\/confirmation\//);
  });

  test("restaurant sees the Click preference clearly, with an operational hint, and it is never auto-marked paid", async ({ page }) => {
    await openDeliveryCheckout(page);
    await page.getByLabel("💳 Click").check();
    await page.getByTestId("checkout-submit").click();
    await page.waitForURL("**/confirmation/**");
    const orderId = page.url().split("/confirmation/")[1];

    await page.goto(`/restaurant/orders/${orderId}`);
    await expect(page.getByTestId("order-payment-preference")).toContainText("To‘lov:");
    await expect(page.getByTestId("order-payment-preference")).toContainText("Click");
    // Still shown as pending/not-collected -- selecting Click never implies
    // payment was received.
    await expect(page.getByTestId("order-payment-preference")).toContainText("Kutilmoqda");
    await expect(page.getByTestId("order-payment-preference")).not.toContainText("Olindi");
    await expect(page.getByTestId("remote-payment-staff-hint")).toHaveText(
      "Buyurtmani tekshiring va mijoz bilan to‘lov uchun bog‘laning.",
    );
    // The existing phone-call action stays readily available alongside it.
    await expect(page.locator('a[href^="tel:"]').first()).toBeVisible();

    await expect(page.getByTestId(`order-card-payment-${orderId}`)).toHaveCount(0);
    await page.goto("/restaurant");
    await expect(page.getByTestId(`order-card-payment-${orderId}`)).toContainText("Click");
  });

  test("restaurant sees the Payme preference clearly, with an operational hint, and it is never auto-marked paid", async ({ page }) => {
    await openDeliveryCheckout(page);
    await page.getByLabel("💳 Payme").check();
    await page.getByTestId("checkout-submit").click();
    await page.waitForURL("**/confirmation/**");
    const orderId = page.url().split("/confirmation/")[1];

    await page.goto(`/restaurant/orders/${orderId}`);
    await expect(page.getByTestId("order-payment-preference")).toContainText("Payme");
    await expect(page.getByTestId("order-payment-preference")).toContainText("Kutilmoqda");
    await expect(page.getByTestId("remote-payment-staff-hint")).toBeVisible();
  });

  test("Click/Payme selection does not auto-begin kitchen preparation -- normal restaurant confirmation is still required", async ({ page }) => {
    await openDeliveryCheckout(page);
    await page.getByLabel("💳 Payme").check();
    await page.getByTestId("checkout-submit").click();
    await page.waitForURL("**/confirmation/**");
    const orderId = page.url().split("/confirmation/")[1];

    await page.goto(`/restaurant/orders/${orderId}`);
    await expect(page.locator(".detail-head .badge")).not.toHaveText("Tayyorlanmoqda");
    // The same delivery-review gate applies regardless of payment method --
    // the order is not confirmed/prepared just because a payment method
    // was selected.
    await expect(page.getByTestId("approve-delivery")).toBeVisible();
  });

  test("customer tracking shows the payment method without implying it was collected", async ({ page }) => {
    await openDeliveryCheckout(page);
    await page.getByLabel("💳 Click").check();
    await page.getByTestId("checkout-submit").click();
    await page.waitForURL("**/confirmation/**");
    await page.getByTestId("track-link").click();

    await expect(page.getByTestId("tracking-payment-method")).toContainText("Click");
    await expect(page.getByTestId("tracking-remote-payment-notice")).toHaveText(
      "Restoran buyurtmangizni tasdiqlagach, to‘lov uchun siz bilan bog‘lanadi.",
    );
    await expect(page.locator("main")).not.toContainText("CLICK");
    await expect(page.locator("main")).not.toContainText("Olindi");
  });

  test("switching from delivery Click/Payme to pickup resets payment to cash (not a leftover unsupported method)", async ({ page }) => {
    await page.goto("/menu/chicken");
    await page.getByRole("button", { name: "+" }).click();
    await page.getByTestId("buy-now").click();
    await page.waitForURL("**/checkout");
    await page.getByLabel("💳 Click").check();
    await page.getByTestId("type-pickup").click();
    await expect(page.getByLabel("💳 Click")).toHaveCount(0);
    await expect(page.getByLabel("💳 Payme")).toHaveCount(0);
    await expect(page.getByLabel("Naqd pul")).toBeChecked();
  });
});
