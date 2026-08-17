import { expect, test } from "@playwright/test";

test("Restaurant operational date follows the Tashkent clock across midnight", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-08-17T18:59:50.000Z") });
  await page.goto("/restaurant");

  const date = page.getByTestId("restaurant-operational-date");
  await expect(date).toHaveText("DUSHANBA · 17 AVGUST");

  await page.clock.fastForward(30_000);
  await expect(date).toHaveText("SESHANBA · 18 AVGUST");
});
