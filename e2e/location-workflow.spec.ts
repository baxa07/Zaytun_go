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
    // Never auto-applied, even for a single close match -- the same street
    // name can exist in more than one city, so the customer always taps
    // the result they mean.
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
    const driverYandex = driver.getByRole("link", { name: "Yo‘nalishni ochish" });
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

test.describe("map-derived address stays in sync with the pin (never a stale merge)", () => {
  test("automatic autofill from a resolved location is authoritative -- it replaces a manually typed value, never merges with it", async ({ page }) => {
    await openCheckout(page);
    await fillRequiredAddress(page);

    // Manually typed before any pin is placed. A resolved location must
    // still replace this -- keeping it would mean the written address no
    // longer matches the pin, which is exactly the "courier gets pin A,
    // address B" failure this guards against.
    await page.getByLabel("Mahalla yoki tuman *").fill("Mening tumanim");
    await expect(page.getByTestId("address-autofilled-notice")).toHaveCount(0);

    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Amir Temur");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await page.getByRole("button", { name: /Amir Temur ko‘chasi 24B/ }).click();

    await expect(page.getByTestId("address-autofilled-notice")).toContainText("Manzil xaritadan aniqlandi");
    await expect(page.locator(".error")).toHaveCount(0);
    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Yangiariq MFY");
    await expect(page.getByLabel("Ko‘cha yoki joylashuv *")).toHaveValue("Amir Temur ko‘chasi");
    await expect(page.getByLabel("Uy / bino (ixtiyoriy)")).toHaveValue("24B");
  });

  test("searching a new location replaces the previous map-derived address, invalidates confirmation, and keeps courier-specific fields", async ({ page }) => {
    await openCheckout(page);
    await fillRequiredAddress(page);

    // Location A.
    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Amir Temur");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await page.getByRole("button", { name: /Amir Temur ko‘chasi 24B/ }).click();
    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Yangiariq MFY");
    await expect(page.getByLabel("Ko‘cha yoki joylashuv *")).toHaveValue("Amir Temur ko‘chasi");
    await expect(page.getByLabel("Uy / bino (ixtiyoriy)")).toHaveValue("24B");

    // A courier-specific field, entered against A -- must survive the move
    // to B untouched (only district/street/house are map-derived).
    await page.getByTestId("address-optional-toggle").click();
    await page.getByLabel("Mo‘ljal (ixtiyoriy)").fill("Katta supermarket yonida");

    await page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
    await expect(page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan")).toBeChecked();

    // Location B -- must fully replace A's map-derived address, not merge
    // with it, and must invalidate the confirmation given for A's pin.
    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("bozor");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await page.getByRole("button", { name: /Navoiy Markaziy bozori/ }).click();

    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Navoiy shahri");
    await expect(page.getByLabel("Ko‘cha yoki joylashuv *")).toHaveValue("Islom Karimov ko‘chasi");
    await expect(page.getByLabel("Uy / bino (ixtiyoriy)")).toHaveValue("Bozor kirishi");
    await expect(page.getByLabel("Mahalla yoki tuman *")).not.toHaveValue("Yangiariq MFY");
    await expect(page.getByLabel("Ko‘cha yoki joylashuv *")).not.toHaveValue("Amir Temur ko‘chasi");

    await expect(page.getByLabel("Mo‘ljal (ixtiyoriy)")).toHaveValue("Katta supermarket yonida");

    await expect(page.getByTestId("map-reconfirmation")).toBeVisible();
    await expect(page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan")).not.toBeChecked();
  });

  test("manually moving the pin after a search replaces the map-derived address with the new pin's location", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCheckout(page);
    await fillRequiredAddress(page);

    // Location A, via search.
    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Amir Temur");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await page.getByRole("button", { name: /Amir Temur ko‘chasi 24B/ }).click();
    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Yangiariq MFY");
    await expect(page.getByLabel("Ko‘cha yoki joylashuv *")).toHaveValue("Amir Temur ko‘chasi");

    // Manually move the pin (not another search) to a different location.
    await page.getByTestId("map-picker-set").click({ position: { x: 40, y: 40 } });

    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Navoiy shahri");
    await expect(page.getByLabel("Ko‘cha yoki joylashuv *")).toHaveValue("Islom Karimov ko‘chasi");
    await expect(page.getByLabel("Uy / bino (ixtiyoriy)")).toHaveValue("Bozor kirishi");
    await expect(page.getByLabel("Mahalla yoki tuman *")).not.toHaveValue("Yangiariq MFY");
    await expect(page.getByLabel("Ko‘cha yoki joylashuv *")).not.toHaveValue("Amir Temur ko‘chasi");
  });

  test("a failed second search preserves the previous valid coordinate, pin, and written address", async ({ page }) => {
    await openCheckout(page);
    await fillRequiredAddress(page);

    // Valid Location A, confirmed.
    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Amir Temur");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await page.getByRole("button", { name: /Amir Temur ko‘chasi 24B/ }).click();
    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Yangiariq MFY");
    await expect(page.getByLabel("Ko‘cha yoki joylashuv *")).toHaveValue("Amir Temur ko‘chasi");
    await page.getByTestId("address-optional-toggle").click();
    await page.getByLabel("Mo‘ljal (ixtiyoriy)").fill("Katta supermarket yonida");
    await page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();

    // A search that fails outright (mock adapter's dedicated failure
    // trigger -- see src/maps/mock.ts) must never touch A's coordinate,
    // pin, written address, courier-specific fields, or confirmation.
    // Only a recoverable message should change.
    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("error");
    await page.getByRole("button", { name: "Qidirish" }).click();

    await expect(page.locator(".search-status")).toContainText("Manzilni hozir qidirib bo‘lmadi");
    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Yangiariq MFY");
    await expect(page.getByLabel("Ko‘cha yoki joylashuv *")).toHaveValue("Amir Temur ko‘chasi");
    await expect(page.getByLabel("Uy / bino (ixtiyoriy)")).toHaveValue("24B");
    await expect(page.getByLabel("Mo‘ljal (ixtiyoriy)")).toHaveValue("Katta supermarket yonida");
    await expect(page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan")).toBeChecked();
    await expect(page.getByTestId("coordinate-summary")).toContainText("Pin belgilandi");

    // A search that genuinely finds nothing must behave the same way.
    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("nonexistent place xyz");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await expect(page.locator(".search-status")).toContainText("Manzil topilmadi");
    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Yangiariq MFY");
    await expect(page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan")).toBeChecked();
  });

  test("a search-service configuration failure shows the search-specific message, never the map-broken message, and preserves the existing valid location", async ({ page }) => {
    await openCheckout(page);
    await fillRequiredAddress(page);

    // Valid, confirmed Location A -- the map itself is visibly working
    // (it rendered A's pin), which is exactly the production scenario:
    // the map core is fine, only the search-configuration path fails.
    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Amir Temur");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await page.getByRole("button", { name: /Amir Temur ko‘chasi 24B/ }).click();
    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Yangiariq MFY");
    await expect(page.getByTestId("coordinate-summary")).toContainText("Pin belgilandi");
    await page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();

    // src/maps/mock.ts's dedicated SEARCH_SERVICE_UNAVAILABLE trigger --
    // the same error code the real Yandex adapter now throws when
    // Search/Geosuggest configuration itself fails.
    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("service-down");
    await page.getByRole("button", { name: "Qidirish" }).click();

    // The search-recoverable message, never the map-broken claim.
    await expect(page.locator(".search-status")).toContainText("Manzilni hozir qidirib bo‘lmadi");
    await expect(page.locator(".search-status")).not.toContainText("Xarita hozircha ishlamayapti");
    await expect(page.locator(".map-error")).toHaveCount(0);

    // Location A is fully intact -- coordinate, pin, address, courier
    // field, and confirmation all untouched.
    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Yangiariq MFY");
    await expect(page.getByLabel("Ko‘cha yoki joylashuv *")).toHaveValue("Amir Temur ko‘chasi");
    await expect(page.getByLabel("Uy / bino (ixtiyoriy)")).toHaveValue("24B");
    await expect(page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan")).toBeChecked();
    await expect(page.getByTestId("coordinate-summary")).toContainText("Pin belgilandi");
  });
});

test.describe("map camera follows selection (search, geolocation, list pick)", () => {
  test("a search selection replaces the search field with the selected address and moves the map camera there", async ({ page }) => {
    await openCheckout(page);
    await fillRequiredAddress(page);

    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Amir Temur");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await page.getByRole("button", { name: /Amir Temur ko‘chasi 24B/ }).click();

    // Search field no longer shows the raw typed query -- it shows the
    // selected, normalized result, so it's obvious the search actually
    // took effect.
    await expect(page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish")).toHaveValue("Amir Temur ko‘chasi 24B, Navoiy");
    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Yangiariq MFY");
    await expect(page.getByLabel("Ko‘cha yoki joylashuv *")).toHaveValue("Amir Temur ko‘chasi");
    await expect(page.getByTestId("coordinate-summary")).toContainText("Pin belgilandi");
    // The map camera (not just the pin) moved to the selected location --
    // src/maps/mock.ts's recenter() records this as a data attribute on
    // the same element production's real map camera move affects.
    await expect(page.getByTestId("map-picker-set")).toHaveAttribute("data-camera-lat", "40.1039");
    await expect(page.getByTestId("map-picker-set")).toHaveAttribute("data-camera-lng", "65.3688");
    // Selecting from the list is a completed choice, not an open menu --
    // the results panel never lingers underneath an already-applied address.
    await expect(page.locator(".map-results")).toHaveCount(0);
  });

  test("tapping a result from an open list applies it and closes the list -- search field, pin, camera, and address all become that result", async ({ page }) => {
    await openCheckout(page);
    await fillRequiredAddress(page);

    // "Toshkentdagi" matches two mock points that are BOTH genuinely far
    // (~354km) from the configured service area -- neither auto-applies,
    // so the list stays open with two real alternatives, the only
    // deterministic way to exercise "list open, customer taps one" (every
    // other fixture point is close enough to auto-apply on its own).
    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Toshkentdagi");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await expect(page.getByRole("button", { name: /Toshkentdagi ofis, 1/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Toshkentdagi ofis, 2/ })).toBeVisible();
    // Neither auto-applied -- the query text is still exactly what was typed.
    await expect(page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish")).toHaveValue("Toshkentdagi");

    await page.getByRole("button", { name: /Toshkentdagi ofis, 2/ }).click();

    await expect(page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish")).toHaveValue("Toshkentdagi ofis, 2");
    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Chilonzor tumani");
    await expect(page.getByLabel("Ko‘cha yoki joylashuv *")).toHaveValue("Bunyodkor shoh ko‘chasi");
    await expect(page.getByLabel("Uy / bino (ixtiyoriy)")).toHaveValue("2");
    await expect(page.getByTestId("map-picker-set")).toHaveAttribute("data-camera-lat", "41.32");
    await expect(page.getByTestId("map-picker-set")).toHaveAttribute("data-camera-lng", "69.29");
    await expect(page.getByTestId("coordinate-summary")).toContainText("Pin belgilandi");
    // The list is gone -- only the selected result remains visible.
    await expect(page.locator(".map-results")).toHaveCount(0);
  });

  test("editing the search field after a selection and searching again reopens a fresh list, and picking from it closes the list again", async ({ page }) => {
    await openCheckout(page);
    await fillRequiredAddress(page);

    // Select Location A from the results list.
    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Amir Temur");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await page.getByRole("button", { name: /Amir Temur ko‘chasi 24B/ }).click();
    await expect(page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish")).toHaveValue("Amir Temur ko‘chasi 24B, Navoiy");
    await page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();

    // The customer intentionally edits the field and searches again --
    // this is a brand new search, not a reveal of a stale list.
    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Toshkentdagi");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await expect(page.getByRole("button", { name: /Toshkentdagi ofis, 1/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Toshkentdagi ofis, 2/ })).toBeVisible();
    // Neither result is picked yet, so nothing about A's
    // coordinate/confirmation has changed -- only the list populated.
    await expect(page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan")).toBeChecked();

    await page.getByRole("button", { name: /Toshkentdagi ofis, 1/ }).click();

    await expect(page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish")).toHaveValue("Toshkentdagi ofis, 1");
    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Chilonzor tumani");
    await expect(page.getByTestId("map-picker-set")).toHaveAttribute("data-camera-lat", "41.311081");
    // Tapping the new result changed the coordinate -- A's confirmation is
    // now correctly invalidated.
    await expect(page.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan")).not.toBeChecked();
    await expect(page.locator(".map-results")).toHaveCount(0);
  });

  test("a successful geolocation moves the pin, moves the camera to the same coordinate, and autofills the address", async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 40.1039, longitude: 65.3688 });
    await openCheckout(page);

    await page.getByTestId("use-my-location").click();

    await expect(page.getByTestId("coordinate-summary")).toContainText("Pin belgilandi");
    await expect(page.getByTestId("map-suggestion")).toContainText("Yangiariq MFY");
    await expect(page.getByTestId("map-picker-set")).toHaveAttribute("data-camera-lat", "40.1039");
    await expect(page.getByTestId("map-picker-set")).toHaveAttribute("data-camera-lng", "65.3688");
  });

  test("a failed search after a valid selection leaves the search field, pin, camera, and address exactly as they were", async ({ page }) => {
    await openCheckout(page);
    await fillRequiredAddress(page);

    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Amir Temur");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await page.getByRole("button", { name: /Amir Temur ko‘chasi 24B/ }).click();
    await expect(page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish")).toHaveValue("Amir Temur ko‘chasi 24B, Navoiy");
    await expect(page.getByTestId("map-picker-set")).toHaveAttribute("data-camera-lat", "40.1039");

    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("error");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await expect(page.locator(".search-status")).toContainText("Manzilni hozir qidirib bo‘lmadi");

    // The camera never moved for the failed attempt -- still exactly
    // where Location A left it.
    await expect(page.getByTestId("map-picker-set")).toHaveAttribute("data-camera-lat", "40.1039");
    await expect(page.getByTestId("map-picker-set")).toHaveAttribute("data-camera-lng", "65.3688");
    await expect(page.getByLabel("Mahalla yoki tuman *")).toHaveValue("Yangiariq MFY");
    await expect(page.getByLabel("Ko‘cha yoki joylashuv *")).toHaveValue("Amir Temur ko‘chasi");
    await expect(page.getByTestId("coordinate-summary")).toContainText("Pin belgilandi");
  });

  test("manually moving the pin does not recenter the camera -- only SEARCH/GEOLOCATION/list-selection do", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openCheckout(page);
    await fillRequiredAddress(page);

    await page.getByLabel("Ko‘cha, joy yoki mo‘ljal qidirish").fill("Amir Temur");
    await page.getByRole("button", { name: "Qidirish" }).click();
    await page.getByRole("button", { name: /Amir Temur ko‘chasi 24B/ }).click();
    await expect(page.getByTestId("map-picker-set")).toHaveAttribute("data-camera-lat", "40.1039");

    // A manual tap moves the pin/coordinate (and the written address, via
    // reverse-geocode) but must never touch the camera -- the customer is
    // already looking at this viewport.
    await page.getByTestId("map-picker-set").click({ position: { x: 40, y: 40 } });
    await expect(page.getByTestId("address-autofilled-notice")).toBeVisible();
    await expect(page.getByTestId("map-picker-set")).toHaveAttribute("data-camera-lat", "40.1039");
    await expect(page.getByTestId("map-picker-set")).toHaveAttribute("data-camera-lng", "65.3688");
  });
});
