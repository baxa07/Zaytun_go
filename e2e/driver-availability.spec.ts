import { expect, test } from "@playwright/test";

// P4.1/P4.10: the driver work-state toggle and simplified home states, on
// the local/offline provider (fast, no real Supabase needed for pure UI
// logic -- start_shift/end_shift's real RPC wiring is proven separately
// against real Supabase in e2e/driver-availability-auth.spec.ts).
test.describe("P4 driver availability and home states", () => {
  test("driver-1 starts ON_SHIFT with active work: availability toggle shows ON and is guarded against turning off", async ({ page }) => {
    await page.goto("/driver");
    await expect(page.locator(".delivery-card")).toBeVisible();
    await expect(page.getByTestId("driver-availability-status")).toHaveText("🟢 Ishga tayyor");
    // Cannot turn off while there is active work -- the server would
    // reject it anyway (end_shift's ACTIVE_ASSIGNMENTS_EXIST guard), but
    // the button is proactively disabled so the courier isn't shown an
    // action that would just fail.
    await expect(page.getByTestId("driver-shift-toggle")).toBeDisabled();
  });

  test("after completing all active work, the driver can turn availability OFF and sees the off-duty home state", async ({ page }) => {
    await page.goto("/driver");
    await expect(page.locator(".delivery-card")).toBeVisible();
    // Free the seeded driver: the seed order starts already at ON_THE_WAY
    // (already accepted), so ARRIVED then DELIVERED completes it.
    await expect(page.getByTestId("driver-primary-action")).toHaveText("Yetib keldim");
    await page.getByTestId("driver-primary-action").click();
    await expect(page.getByTestId("driver-primary-action")).toHaveText("Yetkazildi");
    await page.getByTestId("driver-primary-action").click();
    await expect(page.getByTestId("driver-no-active")).toBeVisible();

    await expect(page.getByTestId("driver-shift-toggle")).toBeEnabled();
    await page.getByTestId("driver-shift-toggle").click();
    await expect(page.getByTestId("driver-availability-status")).toHaveText("⚪ Hozir ishlamayapman");
    await expect(page.getByTestId("driver-off-duty")).toBeVisible();
    await expect(page.getByTestId("driver-no-active")).toHaveCount(0);

    // Turning back ON returns to the normal idle-ready state.
    await page.getByTestId("driver-shift-toggle").click();
    await expect(page.getByTestId("driver-availability-status")).toHaveText("🟢 Ishga tayyor");
    await expect(page.getByTestId("driver-no-active")).toBeVisible();
  });

  test("mobile widths (375/390/393/430) have no horizontal overflow on the driver surface", async ({ page }) => {
    for (const width of [375, 390, 393, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/driver");
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(scrollWidth, `width ${width}`).toBeLessThanOrEqual(clientWidth);
    }
  });
});
