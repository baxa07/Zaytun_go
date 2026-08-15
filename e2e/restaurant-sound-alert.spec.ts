import { expect, test } from "@playwright/test";

// Phase D, Part B/F: the sound enable/status UI itself, on the local
// provider (no realtime needed for this one). Hydration/new-arrival/
// repeat behavior against a real backend lives in
// restaurant-sound-alert-auth.spec.ts, since the local provider has no
// live updates without a reload -- a reload always establishes a fresh
// hydration baseline, which would make that specific scenario untestable
// here.
test("sound starts locked, an explicit gesture enables it, and the status reflects both states", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeGain {
      gain = { value: 0 };
      connect() {}
    }
    class FakeOscillator {
      type = "sine";
      frequency = { value: 0 };
      connect() {}
      start() {}
      stop() {}
    }
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      createGain() {
        return new FakeGain();
      }
      createOscillator() {
        return new FakeOscillator();
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  });
  await page.goto("/restaurant");

  await expect(page.getByTestId("restaurant-sound-enable")).toBeVisible();
  await expect(page.getByTestId("restaurant-sound-status")).toHaveCount(0);

  await page.getByTestId("restaurant-sound-enable").click();
  await expect(page.getByTestId("restaurant-sound-status")).toBeVisible();
  await expect(page.getByTestId("restaurant-sound-status")).toContainText("Ovoz yoqilgan");
});
