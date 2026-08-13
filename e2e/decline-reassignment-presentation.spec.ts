import { expect, test, type Page } from "@playwright/test";

// Local/offline mode has no reset between tests in the same run, so an
// earlier test that accepted (but never completed) driver-1's delivery
// leaves it busy for whatever runs next -- same defensive pattern already
// established for the real-Supabase driver fixture elsewhere.
async function freeDriverOne(driver: Page) {
  await driver.goto("/driver");
  if (await driver.locator(".delivery-card").isVisible().catch(() => false)) {
    await driver.getByTestId("driver-primary-action").click();
    await driver.getByTestId("driver-primary-action").click();
  }
  await expect(driver.getByTestId("driver-no-active")).toBeVisible();
}

// P6: decline/reassignment presentation. Local/offline mode has no
// automatic dispatch engine (manual assignment is already the only path,
// even for the first assignment -- see P5's own tests), so these cover
// the UI contract: decline visibility/reveal, the button disappearing
// once accepted, the restaurant's declined note and searching-state
// recovery, and the manual-reassign exception panel's existence/gating.
// The real automatic-redispatch and staff-only-supersede-success paths
// are proven end to end against real Supabase in decline-reassignment-auth.spec.ts.
test.describe("P6 decline / reassignment presentation", () => {
  test("the assigned driver can decline before accepting; the order returns to searching with a declined note, and the driver returns to idle", async ({ context }) => {
    const customer = await context.newPage();
    const staff = await context.newPage();
    const driver = await context.newPage();
    await freeDriverOne(driver);

    await customer.goto("/menu/chicken");
    await customer.getByRole("button", { name: "+" }).click();
    await customer.getByTestId("buy-now").click();
    await customer.waitForURL("**/checkout");
    await customer.getByLabel("Ism *").fill("Decline UX Mijoz");
    await customer.getByLabel("Telefon *").fill("+998907776900");
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
    await expect(staff.getByTestId("dispatch-courier-status")).toContainText("Biriktirildi");

    await driver.goto("/driver");
    await expect(driver.locator(".assignment-card")).toBeVisible();
    // Decline stays visually secondary: tapping it only reveals the
    // optional reason chips, it does not decline immediately.
    await driver.getByTestId("driver-decline-assignment").click();
    await expect(driver.getByTestId("decline-reasons")).toBeVisible();
    await expect(driver.locator(".assignment-card")).toBeVisible();
    await driver.getByTestId("decline-reason-TOO_FAR").click();

    // Driver returns to idle -- no stale declined card.
    await expect(driver.getByTestId("driver-no-active")).toBeVisible();
    await expect(driver.locator(".assignment-card")).toHaveCount(0);

    await staff.reload();
    await expect(staff.getByTestId("dispatch-searching")).toBeVisible();
    await expect(staff.getByTestId("dispatch-declined-note")).toContainText("Aziz Bekov buyurtmani olmadi");
    // Manual assignment reopens for a fresh pick -- the declining driver
    // is not permanently blacklisted from the manual list.
    await staff.locator(".manual-assign summary").click();
    await expect(staff.getByTestId("assign-driver-driver-1")).toBeEnabled();
  });

  test("once accepted, the decline control disappears -- only pre-acceptance self-service decline exists", async ({ context }) => {
    const customer = await context.newPage();
    const staff = await context.newPage();
    const driver = await context.newPage();
    await freeDriverOne(driver);

    await customer.goto("/menu/chicken");
    await customer.getByRole("button", { name: "+" }).click();
    await customer.getByTestId("buy-now").click();
    await customer.waitForURL("**/checkout");
    await customer.getByLabel("Ism *").fill("Accept UX Mijoz");
    await customer.getByLabel("Telefon *").fill("+998907776901");
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

    await driver.goto("/driver");
    await expect(driver.getByTestId("driver-decline-assignment")).toBeVisible();
    await driver.getByTestId("driver-primary-action").click(); // accept
    await expect(driver.locator(".delivery-card")).toBeVisible();
    await expect(driver.getByTestId("driver-decline-assignment")).toHaveCount(0);
  });

  test("restaurant manual-reassign exception panel exists once a driver is assigned, staff-only, and respects driver availability", async ({ context }) => {
    const customer = await context.newPage();
    const staff = await context.newPage();
    const driver = await context.newPage();
    await freeDriverOne(driver);

    await customer.goto("/menu/chicken");
    await customer.getByRole("button", { name: "+" }).click();
    await customer.getByTestId("buy-now").click();
    await customer.waitForURL("**/checkout");
    await customer.getByLabel("Ism *").fill("Reassign UX Mijoz");
    await customer.getByLabel("Telefon *").fill("+998907776902");
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
    // No manual-reassign panel while still searching -- only the normal
    // first-assignment panel exists at this stage.
    await expect(staff.getByTestId("manual-reassign-panel")).toHaveCount(0);
    await staff.locator(".manual-assign summary").click();
    await staff.getByTestId("assign-driver-driver-1").click();

    // Now that a driver owns the order, the exception panel exists,
    // starts collapsed, excludes the current driver from its own list,
    // and correctly reports no alternative (driver-2 is OFFLINE by
    // default in this seed) rather than a broken/empty state.
    const reassignPanel = staff.getByTestId("manual-reassign-panel");
    await expect(reassignPanel).toBeVisible();
    await expect(reassignPanel).not.toHaveJSProperty("open", true);
    await reassignPanel.locator("summary").click();
    await expect(staff.getByTestId("reassign-driver-driver-1")).toHaveCount(0);
    await expect(staff.getByTestId("no-alternative-driver-available")).toBeVisible();
  });
});
