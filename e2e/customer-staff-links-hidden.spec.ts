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

  test("customer nav shows only Menyu / Savat / Kuzatish", async ({ page }) => {
    await page.goto("/menu");
    const nav = page.locator("header nav");
    await expect(nav.getByRole("link", { name: "Menyu" })).toBeVisible();
    await expect(nav.getByRole("link", { name: /Savat/ })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Kuzatish" })).toBeVisible();
    await expect(nav.getByRole("link")).toHaveCount(3);
  });
});
