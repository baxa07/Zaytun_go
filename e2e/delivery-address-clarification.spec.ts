import { expect, test } from "@playwright/test";

// Uses the seeded "ord-clarify" fixture (data.ts), which starts NEW with
// delivery_review_status=CLARIFICATION_REQUESTED. Restaurant-triggered
// clarification is Phase C UI; until then this fixture is the local
// equivalent of "restaurant requests clarification" for this test.
test.describe("delivery address clarification", () => {
  test("customer sees the reason, edits the address, reconfirms the pin, and resubmits for review", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/track/ord-clarify");

    await expect(page.getByTestId("order-status")).toHaveText("Manzilni aniqlashtirish kerak");
    await expect(page.getByTestId("clarification-required")).toBeVisible();
    await expect(page.getByTestId("clarification-reason")).toContainText("Uy raqami yoki mo‘ljalni aniqlashtiring.");
    // Existing tracking content remains visible around the card.
    await expect(page.locator(".timeline")).toBeVisible();
    // No horizontal overflow at the mobile tracking viewport.
    await expect(page.locator("html")).toHaveJSProperty("scrollWidth", 390);

    await page.getByTestId("edit-delivery-address").click();
    await expect(page.getByTestId("address-revision-editor")).toBeVisible();
    await expect(page.getByTestId("clarification-required")).toHaveCount(0);
    await expect(page.locator("html")).toHaveJSProperty("scrollWidth", 390);
    // The map stays usable (interactive surface rendered) on a phone viewport.
    await expect(page.getByTestId("map-picker-set")).toBeVisible();

    // The current address is pre-populated, including the map pin.
    await expect(page.getByLabel("Uy / bino (ixtiyoriy)")).toHaveValue("Bino raqami noma’lum");
    await expect(page.getByTestId("coordinate-summary")).toContainText("Pin belgilandi");
    // A prior pin confirmation is never trusted into a fresh revision session.
    await expect(page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan")).not.toBeChecked();

    // Submitting without a fresh confirmation is blocked.
    await page.getByTestId("submit-address-revision").click();
    await expect(page.getByText("Pin yetkazish nuqtasida ekanini tasdiqlang")).toBeVisible();

    // Edit the address and move the pin; still requires a fresh confirmation.
    await page.getByLabel("Uy / bino (ixtiyoriy)").fill("14-uy, yashil darvoza");
    await page.getByTestId("map-picker-set").click({ position: { x: 40, y: 40 } });
    await expect(page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan")).not.toBeChecked();

    await page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
    await expect(page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan")).toBeChecked();

    await page.getByTestId("submit-address-revision").click();

    await expect(page.getByTestId("address-revision-editor")).toHaveCount(0);
    await expect(page.getByTestId("address-revision-success")).toBeVisible();
    await expect(page.getByTestId("order-status")).toHaveText("Manzil tasdiqlanmoqda");
    await expect(page.getByTestId("tracking-delivery-review")).toBeVisible();
  });

  test("cancel closes the editor without changing the order", async ({ page }) => {
    await page.goto("/track/ord-clarify");
    await page.getByTestId("edit-delivery-address").click();
    await expect(page.getByTestId("address-revision-editor")).toBeVisible();

    await page.getByLabel("Uy / bino (ixtiyoriy)").fill("O‘zgartirilgan qiymat");
    await page.getByTestId("cancel-address-revision").click();

    await expect(page.getByTestId("address-revision-editor")).toHaveCount(0);
    await expect(page.getByTestId("order-status")).toHaveText("Manzilni aniqlashtirish kerak");
    await expect(page.getByTestId("clarification-required")).toBeVisible();
  });

  test("rapid double submit sends a single revision", async ({ page }) => {
    await page.goto("/track/ord-clarify");
    await page.getByTestId("edit-delivery-address").click();
    await page.getByTestId("map-picker-set").click({ position: { x: 40, y: 40 } });
    await page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();

    await page.getByTestId("submit-address-revision").dblclick();

    await expect(page.getByTestId("address-revision-editor")).toHaveCount(0);
    await expect(page.getByTestId("address-revision-success")).toBeVisible();
    await expect(page.getByTestId("order-status")).toHaveText("Manzil tasdiqlanmoqda");
    // A duplicated/second revision would have appended a second audit event.
    await page.goto("/restaurant/orders/ord-clarify");
    await expect(page.getByTestId("event-list").locator("div")).toHaveCount(2);
  });
});
