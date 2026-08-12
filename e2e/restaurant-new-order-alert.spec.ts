import { expect, test, type Page } from "@playwright/test";

// The seed fixture data (ord-new, ord-clarify) always includes a couple of
// already-NEW orders -- correctly surfaced by the alert on first load, but
// not what these tests are exercising. Acknowledge everything once up
// front so each test starts from a clean, deterministic baseline.
async function clearExistingAlerts(staff: Page) {
  await staff.goto("/restaurant");
  if (await staff.getByTestId("new-order-alert").isVisible().catch(() => false)) {
    await staff.getByTestId("acknowledge-all-orders").click();
  }
}

test.describe("restaurant new-order alert", () => {
  test("persists until acknowledged, then clears -- and does not replay after reload", async ({ context }) => {
    const customer = await context.newPage();
    const staff = await context.newPage();
    await clearExistingAlerts(staff);
    await expect(staff.getByTestId("new-order-alert")).toHaveCount(0);

    await customer.goto("/menu/chicken");
    await customer.getByTestId("buy-now").click();
    await customer.getByTestId("type-pickup").click();
    await customer.getByLabel("Ism *").fill("Alert Test Mijoz");
    await customer.getByLabel("Telefon *").fill("+998901112244");
    await customer.getByTestId("checkout-submit").click();
    await customer.waitForURL("**/confirmation/**");
    const orderId = customer.url().split("/confirmation/")[1];

    await staff.reload();
    await expect(staff.getByTestId("new-order-alert")).toBeVisible();
    await expect(staff.getByTestId("new-order-alert")).toContainText("1 ta yangi buyurtma");
    await expect(staff.getByTestId(`new-order-alert-${orderId}`)).toBeVisible();

    // Opening the order from the alert acknowledges it -- the alert clears.
    await staff.getByTestId(`new-order-alert-${orderId}`).click();
    await staff.waitForURL(`**/restaurant/orders/${orderId}`);
    await staff.goto("/restaurant");
    await expect(staff.getByTestId("new-order-alert")).toHaveCount(0);

    // Acknowledgement survives a reload -- the same order never re-alerts.
    await staff.reload();
    await expect(staff.getByTestId("new-order-alert")).toHaveCount(0);
  });

  test("Barchasini ko‘rdim clears every currently-shown alert at once", async ({ context }) => {
    const customer = await context.newPage();
    const staff = await context.newPage();
    await clearExistingAlerts(staff);

    await customer.goto("/menu/chicken");
    await customer.getByTestId("buy-now").click();
    await customer.getByTestId("type-pickup").click();
    await customer.getByLabel("Ism *").fill("Ack All Mijoz");
    await customer.getByLabel("Telefon *").fill("+998901112255");
    await customer.getByTestId("checkout-submit").click();
    await customer.waitForURL("**/confirmation/**");

    await staff.reload();
    await expect(staff.getByTestId("new-order-alert")).toBeVisible();
    await staff.getByTestId("acknowledge-all-orders").click();
    await expect(staff.getByTestId("new-order-alert")).toHaveCount(0);
  });

  test("opening a NEW order directly from the board also acknowledges it", async ({ context }) => {
    const customer = await context.newPage();
    const staff = await context.newPage();
    await clearExistingAlerts(staff);

    await customer.goto("/menu/chicken");
    await customer.getByTestId("buy-now").click();
    await customer.getByTestId("type-pickup").click();
    await customer.getByLabel("Ism *").fill("Board Click Mijoz");
    await customer.getByLabel("Telefon *").fill("+998901112266");
    await customer.getByTestId("checkout-submit").click();
    await customer.waitForURL("**/confirmation/**");
    const orderId = customer.url().split("/confirmation/")[1];

    await staff.reload();
    await expect(staff.getByTestId("new-order-alert")).toBeVisible();
    await staff.getByTestId(`order-card-${orderId}`).click();
    await staff.waitForURL(`**/restaurant/orders/${orderId}`);
    await staff.goto("/restaurant");
    await expect(staff.getByTestId("new-order-alert")).toHaveCount(0);
  });
});
