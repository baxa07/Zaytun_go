import { expect, test } from "@playwright/test";

async function placeDeliveryOrder(customer: import("@playwright/test").Page) {
  await customer.goto("/menu/chicken");
  // Two items (136,000 so‘m) clears the 100,000 so‘m delivery minimum.
  await customer.getByRole("button", { name: "+" }).click();
  await customer.getByTestId("buy-now").click();
  await customer.waitForURL("**/checkout");
  await customer.getByLabel("Ism *").fill("Restoran Test Mijoz");
  await customer.getByLabel("Telefon *").fill("+998907778899");
  await customer.getByLabel("Mahalla yoki tuman *").fill("Karmana tumani");
  await customer.getByLabel("Ko‘cha yoki joylashuv *").fill("Bunyodkor ko‘chasi");
  await customer.getByLabel("Uy / bino *").fill("noma’lum");
  await customer.getByLabel("Mo‘ljal", { exact: true }).fill("Maktab yonida");
  await customer.getByTestId("map-picker-set").click();
  await customer.getByLabel("Pin to‘g‘ri joyda").check();
  await customer.getByTestId("checkout-submit").click();
  await customer.waitForURL("**/confirmation/**");
  const orderId = customer.url().split("/confirmation/")[1];
  await customer.getByTestId("track-link").click();
  await customer.waitForURL(`**/track/${orderId}`);
  return orderId;
}

test.describe("restaurant address review", () => {
  test("clarify then customer revise then reject/approve round-trips through both sides", async ({ context }) => {
    const customer = await context.newPage();
    const staff = await context.newPage();

    const orderId = await placeDeliveryOrder(customer);

    await staff.goto(`/restaurant/orders/${orderId}`);
    await expect(staff.getByTestId("delivery-review-required")).toBeVisible();
    await expect(staff.getByTestId("contact-customer")).toHaveAttribute("href", "tel:+998907778899");

    // Clarify is blocked without a reason.
    await expect(staff.getByTestId("request-clarification")).toBeDisabled();
    await staff.locator(".delivery-review-panel input").fill("Uy raqamini aniqlashtiring");
    await expect(staff.getByTestId("request-clarification")).toBeEnabled();
    await staff.getByTestId("request-clarification").click();

    await expect(staff.getByTestId("delivery-review-clarification-pending")).toBeVisible();
    await expect(staff.getByTestId("clarification-reason-sent")).toContainText("Uy raqamini aniqlashtiring");
    await expect(staff.getByTestId("delivery-review-required")).toHaveCount(0);

    // The customer sees the same reason and can act on it.
    await customer.reload();
    await expect(customer.getByTestId("order-status")).toHaveText("Manzilni aniqlashtirish kerak");
    await expect(customer.getByTestId("clarification-reason")).toContainText("Uy raqamini aniqlashtiring");
    await customer.getByTestId("edit-delivery-address").click();
    await customer.getByLabel("Uy / bino *").fill("14-uy, ko‘k darvoza");
    await customer.getByTestId("map-picker-set").click({ position: { x: 60, y: 60 } });
    await customer.getByLabel("Pin to‘g‘ri joyda").check();
    await customer.getByTestId("submit-address-revision").click();
    await expect(customer.getByTestId("order-status")).toHaveText("Manzil tasdiqlanmoqda");

    // Restaurant sees the review panel again, with the customer's update.
    await staff.reload();
    await expect(staff.getByTestId("delivery-review-required")).toBeVisible();

    // This time, reject terminally.
    await staff.locator(".delivery-review-panel input").fill("Hudud xizmat doirasidan tashqarida");
    await staff.getByTestId("reject-delivery").click();
    await expect(staff.locator(".detail-head .badge")).toHaveText("Rad etildi");
  });

  test("rapid double click on approve only approves once", async ({ context }) => {
    const customer = await context.newPage();
    const staff = await context.newPage();
    const orderId = await placeDeliveryOrder(customer);

    await staff.goto(`/restaurant/orders/${orderId}`);
    await staff.getByTestId("approve-delivery").dblclick();

    await expect(staff.getByTestId("delivery-review-approved")).toBeVisible();
    await expect(staff.getByTestId("event-list").locator("div")).toHaveCount(2);
  });
});
