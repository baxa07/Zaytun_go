import { expect, test, type Page } from "@playwright/test";

const evidence = (name: string) => `qa/screenshots/${name}.png`;

async function openCheckout(page: Page) {
  await page.goto("/menu/chicken");
  await page.getByRole("button", { name: "+" }).click();
  await page.getByTestId("buy-now").click();
  await page.waitForURL("**/checkout");
}

// Landmark ("Mo'ljal") is optional under the minimum delivery-address
// contract, so this only fills the still-required contact fields.
async function fillRequiredAddress(page: Page) {
  await page.getByLabel("Ism *").fill("Xarita Test Mijoz");
  await page.getByLabel("Telefon *").fill("+998901112233");
}

test.describe("precise delivery location", () => {
  test("search, suggestion, pin movement, confirmation and reconfirmation", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCheckout(page);
    await expect(page.getByTestId("map-empty")).toBeVisible();
    await page.screenshot({ path: evidence("01-empty-map-selection") });

    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Amir Temur");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await expect(page.getByRole("button", { name: /Amir Temur ko‘chasi 24B/ })).toBeVisible();
    await page.screenshot({ path: evidence("02-search-results") });

    await page.getByRole("button", { name: /Amir Temur ko‘chasi 24B/ }).click();
    await expect(page.getByTestId("map-suggestion")).toContainText("Yangiariq MFY");
    await expect(page.getByTestId("coordinate-summary")).toContainText("Pin belgilandi");
    await page.screenshot({ path: evidence("03-selected-marker-suggestion") });

    await page.getByRole("button", { name: "Manzilni qo‘llash" }).click();
    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Yangiariq MFY");
    await page.getByLabel("Uy / bino (ixtiyoriy)").fill("24B, yashil darvoza");
    await fillRequiredAddress(page);
    await page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
    await page.screenshot({ path: evidence("04-confirmed-pin-address") });

    await page.getByTestId("map-picker-set").click({ position: { x: 40, y: 40 } });
    await expect(page.getByTestId("map-reconfirmation")).toBeVisible();
    await expect(page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan")).not.toBeChecked();
    await page.screenshot({ path: evidence("05-reconfirmation-required") });
  });

  test("use-my-location prefills the pin from browser geolocation", async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 40.1039, longitude: 65.3688 });
    await openCheckout(page);
    await expect(page.getByTestId("map-empty")).toBeVisible();

    await page.getByTestId("use-my-location").click();
    await expect(page.getByTestId("coordinate-summary")).toContainText("Pin belgilandi");
    await expect(page.getByTestId("map-suggestion")).toContainText("Yangiariq MFY");
  });

  test("submits valid pins into manual operator review without claiming a radius", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCheckout(page);
    await fillRequiredAddress(page);
    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Amir Temur");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await page.getByRole("button", { name: /Amir Temur ko‘chasi 24B/ }).click();
    await page.getByRole("button", { name: "Manzilni qo‘llash" }).click();
    await page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
    await page.getByTestId("checkout-submit").click();
    await expect(page).toHaveURL(/\/confirmation\//);

    await openCheckout(page);
    await fillRequiredAddress(page);
    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Tashqaridagi");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await page.getByRole("button", { name: /Tashqaridagi test manzili/ }).click();
    await expect(page.getByTestId("delivery-review-notice")).toContainText("operator tomonidan tasdiqlanadi");
    await page.getByRole("button", { name: "Manzilni qo‘llash" }).click();
    await page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
    await page.getByTestId("checkout-submit").click();
    await expect(page).toHaveURL(/\/confirmation\//);
    await page.screenshot({ path: evidence("06-outside-delivery-zone") });
  });

  test("pickup bypasses and does not load a delivery map", async ({ page }) => {
    await openCheckout(page);
    await page.getByTestId("type-pickup").click();
    await expect(page.locator(".location-picker")).toHaveCount(0);
    await page.getByLabel("Ism *").fill("Pickup Mijoz");
    await page.getByLabel("Telefon *").fill("+998901112233");
    await page.getByTestId("checkout-submit").click();
    await expect(page).toHaveURL(/\/confirmation\//);
  });

  test("restaurant and driver expose exact safe navigation destinations", async ({ context }) => {
    const restaurant = await context.newPage();
    await restaurant.setViewportSize({ width: 1024, height: 768 });
    await restaurant.goto("/restaurant/orders/ord-new");
    await expect(restaurant.getByTestId("restaurant-location-detail")).toContainText("2.40 km");
    const restaurantYandex = restaurant.getByRole("link", { name: "Yandex Maps" });
    await expect(restaurantYandex).toHaveAttribute("href", /rtext=~40\.103900%2C65\.368800/);
    await expect(restaurantYandex).toHaveAttribute("rel", "noopener noreferrer");
    await restaurant.setViewportSize({ width: 1440, height: 900 });
    await expect(restaurant.locator("html")).toHaveJSProperty("scrollWidth", 1440);
    await restaurantYandex.scrollIntoViewIfNeeded();
    await restaurant.screenshot({ path: evidence("07-restaurant-location-detail") });

    const driver = await context.newPage();
    await driver.setViewportSize({ width: 390, height: 844 });
    await driver.goto("/driver");
    // Raw coordinates are not part of the normal driver UI -- collapsed
    // behind a "Texnik ma'lumot" disclosure, same pattern as the restaurant
    // panel. Human-readable content (distance) remains directly visible.
    const driverCoordinateText = driver.locator('[data-testid="driver-location-debug"] p');
    await expect(driverCoordinateText).toBeHidden();
    await expect(driver.getByTestId("driver-location-detail")).toContainText("2.4 km");
    const driverYandex = driver.getByRole("link", { name: "Yandex Maps" });
    await expect(driverYandex).toHaveAttribute("href", /rtext=~40\.103900%2C65\.368800/);
    await driver.getByTestId("driver-location-debug").locator("summary").click();
    await expect(driverCoordinateText).toHaveText("40.103900, 65.368800");
    await expect(driver.getByRole("link", { name: "Google Maps" })).toHaveAttribute("href", /destination=40\.103900%2C65\.368800/);
    await driver.screenshot({ path: evidence("08-driver-navigation") });
  });

  test("checkout has no horizontal overflow at mobile target widths", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCheckout(page);
    await expect(page.locator("html")).toHaveJSProperty("scrollWidth", 390);
    await page.screenshot({ path: evidence("09-checkout-390x844") });

    await page.setViewportSize({ width: 320, height: 700 });
    await expect(page.locator("html")).toHaveJSProperty("scrollWidth", 320);
    await page.screenshot({ path: evidence("10-checkout-320x700") });
  });
});

test.describe("minimum delivery-address contract (Pin Workflow Refinement)", () => {
  test("automatic autofill only fills empty district/street/house fields and never overwrites a manually typed value", async ({ page }) => {
    await openCheckout(page);
    await fillRequiredAddress(page);

    // Manually typed before any pin is placed -- this must survive the
    // automatic autofill untouched, since autofill only ever fills fields
    // that are still empty.
    await page.getByLabel("Mahalla yoki tuman *").fill("Mening tumanim");
    await expect(page.getByTestId("address-autofilled-notice")).toHaveCount(0);

    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Amir Temur");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await page.getByRole("button", { name: /Amir Temur ko‘chasi 24B/ }).click();

    // Non-blocking confirmation, not an error or alert.
    await expect(page.getByTestId("address-autofilled-notice")).toContainText("Manzil xaritadan aniqlandi");
    await expect(page.locator(".error")).toHaveCount(0);

    // The manually typed district is untouched by the automatic lookup...
    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Mening tumanim");
    // ...while the still-empty street/house fields were quietly filled in.
    await expect(page.getByLabel("Ko‘cha yoki joylashuv *")).toHaveValue("Amir Temur ko‘chasi");
    await expect(page.getByLabel("Uy / bino (ixtiyoriy)")).toHaveValue("24B");
  });

  test("explicit Manzilni qo‘llash never touches the optional operational fields", async ({ page }) => {
    await openCheckout(page);
    await fillRequiredAddress(page);

    await page.getByTestId("address-optional-toggle").click();
    await page.getByLabel("Kirish", { exact: true }).fill("5");
    await page.getByLabel("Mo‘ljal (ixtiyoriy)").fill("Katta supermarket yonida");

    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Amir Temur");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await page.getByRole("button", { name: /Amir Temur ko‘chasi 24B/ }).click();
    await page.getByRole("button", { name: "Manzilni qo‘llash" }).click();

    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Yangiariq MFY");
    await expect(page.getByLabel("Kirish", { exact: true })).toHaveValue("5");
    await expect(page.getByLabel("Mo‘ljal (ixtiyoriy)")).toHaveValue("Katta supermarket yonida");
  });

  test("optional-details disclosure starts collapsed and preserves values across toggling", async ({ page }) => {
    await openCheckout(page);

    const toggle = page.getByTestId("address-optional-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("address-optional-details")).toHaveCount(0);

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.getByLabel("Kirish", { exact: true }).fill("7");
    await page.getByLabel("Xonadon").fill("12");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("address-optional-details")).toHaveCount(0);

    await toggle.click();
    await expect(page.getByLabel("Kirish", { exact: true })).toHaveValue("7");
    await expect(page.getByLabel("Xonadon")).toHaveValue("12");
  });

  test("fresh render shows no validation errors, and a single missing required field is the only error after Continue", async ({ page }) => {
    await openCheckout(page);
    await expect(page.locator(".error")).toHaveCount(0);

    await page.getByLabel("Ism *").fill("Mijoz");
    await page.getByLabel("Telefon *").fill("+998901112233");
    await page.getByLabel("Ko‘cha yoki joylashuv *").fill("Bunyodkor ko‘chasi");
    await page.getByTestId("map-picker-set").click();
    // The reverse-geocoded pin autofills empty fields asynchronously -- wait
    // for it to settle, then clear district again so exactly one field is
    // genuinely missing (not incidentally filled by the async lookup).
    await expect(page.getByTestId("address-autofilled-notice")).toBeVisible();
    await page.getByLabel("Mahalla yoki tuman *").fill("");
    await page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();

    // Only Mahalla/tuman is genuinely missing -- everything else above is
    // filled in, so exactly one error should appear.
    await page.getByTestId("checkout-submit").click();
    await expect(page.locator(".error")).toHaveText(["Mahalla yoki tumanni kiriting"]);

    await page.getByLabel("Mahalla yoki tuman *").fill("Karmana tumani");
    await expect(page.locator(".error")).toHaveCount(0);
  });

  test("regression: a normal delivery checkout succeeds with exactly the new minimum info -- district, street and a confirmed pin, everything else left empty", async ({ page }) => {
    await openCheckout(page);
    await fillRequiredAddress(page);
    await page.getByLabel("Mahalla yoki tuman *").fill("Karmana tumani");
    await page.getByLabel("Ko‘cha yoki joylashuv *").fill("Bunyodkor ko‘chasi");
    await page.getByTestId("map-picker-set").click();
    // Wait for the async reverse-geocode lookup to settle, then clear
    // whatever it may have auto-filled, to prove house/entrance/floor/
    // apartment/landmark/notes are all genuinely optional -- not just
    // optional in the UI but coincidentally filled in.
    await expect(page.getByTestId("map-suggestion")).toBeVisible();
    await page.getByLabel("Uy / bino (ixtiyoriy)").fill("");
    await expect(page.getByTestId("address-optional-details")).toHaveCount(0);
    await page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();

    await page.getByTestId("checkout-submit").click();
    await expect(page).toHaveURL(/\/confirmation\//);
  });
});
