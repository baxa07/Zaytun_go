import { expect, test, type Page } from "@playwright/test";

async function openDeliveryCheckout(page: Page) {
  await page.goto("/menu/chicken");
  await page.getByRole("button", { name: "+" }).click();
  await page.getByTestId("buy-now").click();
  await page.waitForURL("**/checkout");
  await page.getByLabel("Ism *").fill("To‘lov Test Mijoz");
  await page.getByLabel("Telefon *").fill("+998901112233");
  await page.getByTestId("checkout-continue").click();
  await expect(page.getByTestId("checkout-step-map")).toBeVisible();
  await page.getByTestId("map-picker-set").click();
  await page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
  await page.getByTestId("checkout-continue").click();
  await expect(page.getByTestId("checkout-step-address")).toBeVisible();
  await page.getByLabel("Mahalla yoki tuman *").fill("Karmana tumani");
  await page.getByLabel("Ko‘cha yoki joylashuv *").fill("Bunyodkor ko‘chasi");
  // Editing district/street is itself a material change that invalidates
  // the Step 2 pin confirmation (same set() rule as any other address
  // field) -- reconfirm before Continue.
  await page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
  await page.getByTestId("checkout-continue").click();
  await expect(page.getByTestId("checkout-step-4")).toBeVisible();
}

async function openPickupCheckout(page: Page) {
  await page.goto("/menu/chicken");
  await page.getByRole("button", { name: "+" }).click();
  await page.getByTestId("buy-now").click();
  await page.waitForURL("**/checkout");
  await page.getByTestId("type-pickup").click();
  await page.getByLabel("Ism *").fill("Pickup To‘lov Mijoz");
  await page.getByLabel("Telefon *").fill("+998901112234");
  await page.getByTestId("checkout-continue").click();
  await expect(page.getByTestId("checkout-step-4")).toBeVisible();
}

// Payment is Step 4; review (and the actual submit) is Step 5.
async function continueToReviewAndSubmit(page: Page) {
  await page.getByTestId("checkout-continue").click();
  await expect(page.getByTestId("checkout-step-5")).toBeVisible();
  await page.getByTestId("checkout-submit").click();
}

test.describe("Manual Click/Payme payments", () => {
  test("delivery checkout offers Click and Payme as manual transfer choices", async ({ page }) => {
    await openDeliveryCheckout(page);
    await expect(page.getByLabel("Naqd pul")).toBeVisible();
    await expect(page.getByLabel("💳 Click")).toBeEnabled();
    await expect(page.getByLabel("💳 Payme")).toBeEnabled();
    await expect(page.getByLabel("Terminal — restoranda")).toHaveCount(0);
  });

  test("pickup checkout offers cash, terminal, Click, and Payme", async ({ page }) => {
    await openPickupCheckout(page);
    await expect(page.getByLabel("Naqd pul")).toBeEnabled();
    await expect(page.getByLabel("Terminal — restoranda")).toBeEnabled();
    await expect(page.getByLabel("💳 Click")).toBeEnabled();
    await expect(page.getByLabel("💳 Payme")).toBeEnabled();
  });

  test("CASH still works end to end for delivery, with no remote-payment notice", async ({ page }) => {
    await openDeliveryCheckout(page);
    await expect(page.getByLabel("Naqd pul")).toBeChecked();
    await expect(page.getByTestId("remote-payment-notice")).toHaveCount(0);
    await continueToReviewAndSubmit(page);
    await expect(page).toHaveURL(/\/confirmation\//);
  });

  test("selecting Click explains Restaurant confirmation and completes checkout as pending", async ({ page }) => {
    await openDeliveryCheckout(page);
    await page.getByLabel("💳 Click").check();
    await expect(page.getByTestId("remote-payment-notice")).toHaveText(
      "Restoran Click/Payme to‘lovini tekshirib tasdiqlaydi.",
    );
    await expect(page.getByTestId("remote-payment-notice")).not.toContainText("karta");
    await page.getByTestId("checkout-continue").click();
    await expect(page.getByTestId("checkout-step-5")).toBeVisible();
    await expect(page.getByTestId("review-payment-method")).toContainText("Click");
    await page.getByTestId("checkout-submit").click();
    await expect(page).toHaveURL(/\/confirmation\//);
  });

  test("selecting Payme explains Restaurant confirmation and completes checkout as pending", async ({ page }) => {
    await openDeliveryCheckout(page);
    await page.getByLabel("💳 Payme").check();
    await expect(page.getByTestId("remote-payment-notice")).toHaveText(
      "Restoran Click/Payme to‘lovini tekshirib tasdiqlaydi.",
    );
    await page.getByTestId("checkout-continue").click();
    await expect(page.getByTestId("checkout-step-5")).toBeVisible();
    await expect(page.getByTestId("review-payment-method")).toContainText("Payme");
    await page.getByTestId("checkout-submit").click();
    await expect(page).toHaveURL(/\/confirmation\//);
  });

  test("restaurant sees prominent pending Click state and staff-only confirmation actions", async ({ page }) => {
    await openDeliveryCheckout(page);
    await page.getByLabel("💳 Click").check();
    await continueToReviewAndSubmit(page);
    await page.waitForURL("**/confirmation/**");
    const orderId = page.url().split("/confirmation/")[1];

    await page.goto(`/restaurant/orders/${orderId}`);
    await expect(page.getByTestId("order-payment-preference")).toContainText("To‘lov:");
    await expect(page.getByTestId("order-payment-preference")).toContainText("Click");
    // Still shown as pending/not-collected -- selecting Click never implies
    // payment was received.
    await expect(page.getByTestId("order-payment-preference")).toContainText("Kutilmoqda");
    await expect(page.getByTestId("order-payment-preference")).not.toContainText("Olindi");
    await expect(page.getByTestId("remote-payment-staff-hint")).toContainText("CLICK — TO‘LOV KUTILMOQDA");
    await expect(page.getByRole("link", { name: "Mijozga qo‘ng‘iroq" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pul tushdi" })).toBeVisible();

    await expect(page.getByTestId(`order-card-payment-${orderId}`)).toHaveCount(0);
    await page.goto("/restaurant");
    await expect(page.getByTestId(`order-card-payment-${orderId}`)).toContainText("Click");
  });

  test("restaurant sees prominent pending Payme state", async ({ page }) => {
    await openDeliveryCheckout(page);
    await page.getByLabel("💳 Payme").check();
    await continueToReviewAndSubmit(page);
    await page.waitForURL("**/confirmation/**");
    const orderId = page.url().split("/confirmation/")[1];

    await page.goto(`/restaurant/orders/${orderId}`);
    await expect(page.getByTestId("order-payment-preference")).toContainText("Payme");
    await expect(page.getByTestId("order-payment-preference")).toContainText("Kutilmoqda");
    await expect(page.getByTestId("remote-payment-staff-hint")).toContainText("PAYME — TO‘LOV KUTILMOQDA");
  });

  test("preparation remains blocked until Restaurant confirms manual payment", async ({ page }) => {
    await openDeliveryCheckout(page);
    await page.getByLabel("💳 Payme").check();
    await continueToReviewAndSubmit(page);
    await page.waitForURL("**/confirmation/**");
    const orderId = page.url().split("/confirmation/")[1];

    await page.goto(`/restaurant/orders/${orderId}`);
    await expect(page.locator(".detail-head .badge")).not.toHaveText("Tayyorlanmoqda");
    // The same delivery-review gate applies regardless of payment method --
    // the order is not confirmed/prepared just because a payment method
    // was selected.
    await expect(page.getByTestId("approve-delivery")).toBeVisible();
    await page.getByTestId("approve-delivery").click();
    await page.getByTestId("action-confirm").click();
    await expect(page.getByRole("button", { name: "Tayyorlashni boshlash" })).toBeDisabled();
    await page.getByTestId("confirm-manual-payment").click();
    await expect(page.getByTestId("remote-payment-staff-hint")).toContainText("PAYME — TO‘LOV TASDIQLANDI");
    await expect(page.getByRole("button", { name: "Tayyorlashni boshlash" })).toBeEnabled();
  });

  test("customer tracking shows method and pending notice without a confirmation control", async ({ page }) => {
    await openDeliveryCheckout(page);
    await page.getByLabel("💳 Click").check();
    await continueToReviewAndSubmit(page);
    await page.waitForURL("**/confirmation/**");
    await page.getByTestId("track-link").click();

    await expect(page.getByTestId("tracking-payment-method")).toContainText("Click");
    await expect(page.getByTestId("tracking-remote-payment-notice")).toHaveText(
      "Restoran Click/Payme to‘lovini tekshirib tasdiqlaydi.",
    );
    await expect(page.locator("main")).not.toContainText("CLICK");
    await expect(page.locator("main")).not.toContainText("Olindi");
    await expect(page.getByRole("button", { name: "Pul tushdi" })).toHaveCount(0);
  });

  test("pickup Click remains pending and preparation unlocks only after Restaurant confirmation", async ({ page }) => {
    await openPickupCheckout(page);
    await page.getByLabel("💳 Click").check();
    await continueToReviewAndSubmit(page);
    await page.waitForURL("**/confirmation/**");
    const orderId = page.url().split("/confirmation/")[1];

    await page.goto(`/restaurant/orders/${orderId}`);
    await expect(page.getByTestId("remote-payment-staff-hint")).toContainText("CLICK — TO‘LOV KUTILMOQDA");
    await page.getByTestId("action-confirm").click();
    await expect(page.getByTestId("action-start-prep")).toBeDisabled();
    await page.getByTestId("confirm-manual-payment").click();
    await expect(page.getByTestId("remote-payment-staff-hint")).toContainText("CLICK — TO‘LOV TASDIQLANDI");
    await expect(page.getByTestId("action-start-prep")).toBeEnabled();
  });

  test("switching from delivery (Click selected) to pickup preserves the now-valid manual method -- exercised via Back to Step 1, matching how fulfillment type can only be changed from Step 1 in the 5-step wizard", async ({ page }) => {
    await openDeliveryCheckout(page);
    await page.getByLabel("💳 Click").check();
    await expect(page.getByLabel("💳 Click")).toBeChecked();

    // Fulfillment type only lives on Step 1 -- back out to it, preserving
    // the payment selection made on Step 4 (Back/Continue must never
    // discard entered information).
    await page.getByTestId("checkout-back").click();
    await expect(page.getByTestId("checkout-step-address")).toBeVisible();
    await page.getByTestId("checkout-back").click();
    await expect(page.getByTestId("checkout-step-map")).toBeVisible();
    await page.getByTestId("checkout-back").click();
    await expect(page.getByTestId("checkout-step-1")).toBeVisible();

    await page.getByTestId("type-pickup").click();
    await page.getByTestId("checkout-continue").click();
    await expect(page.getByTestId("checkout-step-4")).toBeVisible();
    await expect(page.getByLabel("💳 Click")).toBeChecked();
    await expect(page.getByLabel("💳 Payme")).toBeEnabled();
    await expect(page.getByLabel("Terminal — restoranda")).toBeEnabled();
  });
});
