import { expect, test } from "@playwright/test";

async function installFakeAudio(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    (window as unknown as { __oscillatorStarts: number }).__oscillatorStarts = 0;
    (window as unknown as { __audioResumes: number }).__audioResumes = 0;
    class FakeGain {
      gain = { value: 0 };
      connect() {}
    }
    class FakeOscillator {
      type = "sine";
      frequency = { value: 0 };
      connect() {}
      start() {
        (window as unknown as { __oscillatorStarts: number }).__oscillatorStarts++;
      }
      stop() {}
    }
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      state = "suspended";
      createGain() { return new FakeGain(); }
      createOscillator() { return new FakeOscillator(); }
      async resume() {
        this.state = "running";
        (window as unknown as { __audioResumes: number }).__audioResumes++;
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  });
}

test("sound defaults ON, unlocks silently on a normal gesture, and explicit mute/unmute persists", async ({ page }) => {
  await installFakeAudio(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/restaurant");
  await page.evaluate(() => {
    localStorage.removeItem("zaytun-go:sound-preference");
    localStorage.removeItem("zaytun-go:sound-preference-v2");
  });
  await page.reload();

  const status = page.getByTestId("restaurant-sound-status");
  const toggle = page.getByTestId("restaurant-sound-toggle");
  await expect(status).toContainText("Ovoz birinchi bosishda faollashadi");
  await expect(toggle).toHaveText("Ovozni o‘chirish");

  await page.getByRole("heading", { name: "Buyurtmalar" }).click();
  await expect(status).toContainText("Ovoz yoqilgan");
  expect(await page.evaluate(() => (window as unknown as { __audioResumes: number }).__audioResumes)).toBe(1);
  expect(await page.evaluate(() => (window as unknown as { __oscillatorStarts: number }).__oscillatorStarts)).toBe(0);

  await toggle.click();
  await expect(status).toContainText("Ovoz o‘chirilgan");
  await page.reload();
  await expect(status).toContainText("Ovoz o‘chirilgan");
  await expect(toggle).toHaveText("Ovozni yoqish");

  await toggle.click();
  await expect(status).toContainText("Ovoz yoqilgan");
  await page.reload();
  await expect(status).toContainText("Ovoz birinchi bosishda faollashadi");
  await expect(toggle).toHaveText("Ovozni o‘chirish");

  await page.getByRole("heading", { name: "Buyurtmalar" }).click();
  await expect(status).toContainText("Ovoz yoqilgan");
  await page.screenshot({ path: "qa/screenshots/12-restaurant-sound-default-on-mobile.png", fullPage: true });

  await page.goto("/driver");
  const driverStatus = page.getByTestId("driver-sound-status");
  await expect(driverStatus).toContainText("Ovoz birinchi bosishda faollashadi");
  await page.getByRole("heading", { name: "Bugungi yetkazish" }).click();
  await expect(driverStatus).toContainText("Ovoz yoqilgan");
  await page.screenshot({ path: "qa/screenshots/13-driver-sound-default-on-mobile.png", fullPage: true });
});
