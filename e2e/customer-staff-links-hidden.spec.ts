import { expect, test } from "@playwright/test";

// Public customer surfaces must never expose a path into staff/courier
// entry -- Restoran/Haydovchi/Xodimlar uchun should not be discoverable
// from anywhere a customer browses. This is UX-only: /restaurant and
// /driver stay reachable directly and remain protected by AuthGate
// (covered separately in the auth-local suite, where anonymous access to
// either route already resolves to a login screen, never the real UI).
const customerRoutes = ["/", "/menu", "/menu/chicken", "/cart", "/checkout", "/track/ord-new"];

test.describe("customer surfaces never expose staff entry", () => {
  for (const route of customerRoutes) {
    test(`no staff/driver link on ${route}`, async ({ page }) => {
      await page.goto(route);
      const nav = page.locator("header nav");
      await expect(nav.getByRole("link", { name: "Restoran" })).toHaveCount(0);
      await expect(nav.getByRole("link", { name: "Haydovchi" })).toHaveCount(0);
      await expect(page.getByText("Xodimlar uchun")).toHaveCount(0);
      await expect(page.locator('a[href="/restaurant"]')).toHaveCount(0);
      await expect(page.locator('a[href="/driver"]')).toHaveCount(0);
    });
  }

  test("customer nav shows only Menyu / Savat / Buyurtmalarim", async ({ page }) => {
    await page.goto("/menu");
    const nav = page.locator("header nav");
    await expect(nav.getByRole("link", { name: "Menyu" })).toBeVisible();
    await expect(nav.getByRole("link", { name: /Savat/ })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Buyurtmalarim" })).toBeVisible();
    await expect(nav.getByRole("link")).toHaveCount(3);
  });

  test("hero tracking action and bottom Buyurtmalarim independently reach the existing orders experience", async ({ page }) => {
    await page.goto("/");
    const heroAction = page.getByTestId("hero-track-order");
    await expect(heroAction).toHaveAttribute("href", "/orders");
    await heroAction.click();
    await expect(page).toHaveURL(/\/orders$/);

    // Exercise the separate, already-working bottom-nav control too: the
    // hero fix must not replace, hide, or intercept it.
    await page.goto("/menu");
    const bottomOrders = page.getByTestId("customer-bottom-nav").getByRole("link", { name: "Buyurtmalarim" });
    await expect(bottomOrders).toHaveAttribute("href", "/orders");
    await bottomOrders.click();
    await expect(page).toHaveURL(/\/orders$/);
  });

  // Shell renders exactly one <nav>, styled differently at mobile widths via
  // CSS rather than a second DOM tree -- but pilot sign-off wants this
  // proven explicitly at a real mobile viewport, not only inferred from the
  // desktop-viewport checks above sharing the same markup.
  for (const route of customerRoutes) {
    test(`mobile viewport (390x844): no staff/driver link on ${route}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(route);
      const nav = page.locator("header nav");
      await expect(nav.getByRole("link", { name: "Restoran" })).toHaveCount(0);
      await expect(nav.getByRole("link", { name: "Haydovchi" })).toHaveCount(0);
      await expect(page.getByText("Xodimlar uchun")).toHaveCount(0);
      await expect(page.locator('a[href="/restaurant"]')).toHaveCount(0);
      await expect(page.locator('a[href="/driver"]')).toHaveCount(0);
    });
  }

  test("mobile viewport (390x844): customer nav shows only Menyu / Savat / Buyurtmalarim", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/menu");
    const nav = page.locator("header nav");
    await expect(nav.getByRole("link", { name: "Menyu" })).toBeVisible();
    await expect(nav.getByRole("link", { name: /Savat/ })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Buyurtmalarim" })).toBeVisible();
    await expect(nav.getByRole("link")).toHaveCount(3);
    await expect(nav.locator(".customer-nav-icon")).toHaveCount(3);
    const menu = nav.getByRole("link", { name: "Menyu" });
    await expect(menu).toHaveClass(/active/);
    const activeBackground = await menu.evaluate((element) => getComputedStyle(element).backgroundColor);
    const inactiveBackground = await nav.getByRole("link", { name: "Buyurtmalarim" }).evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(activeBackground).not.toBe(inactiveBackground);
    const box = await nav.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
    await page.screenshot({ path: "qa/screenshots/27-customer-bottom-nav-active-390x844.png", fullPage: true });
    await nav.getByRole("link", { name: "Buyurtmalarim" }).click();
    await expect(page).toHaveURL(/\/orders$/);
  });
});
