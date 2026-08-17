import { expect, test, type Page } from "@playwright/test";

// Phase D, Part B/H: the new-order SOUND specifically, against a real
// backend so a genuinely new order can arrive via the existing realtime
// subscription while the Restaurant page stays mounted -- no reload,
// which matters here because a reload always establishes a fresh
// hydration baseline (see App.tsx's hasHydratedRef) and would make
// "pre-existing vs freshly arrived" indistinguishable from this test's
// point of view. The visual alert itself is already covered by
// restaurant-new-order-alert.spec.ts; this file is sound-specific.
const localPassword = "zaytun-local-2026";

async function installFakeAudio(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __oscillatorStarts: number }).__oscillatorStarts = 0;
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
      createGain() {
        return new FakeGain();
      }
      createOscillator() {
        return new FakeOscillator();
      }
      async resume() {
        this.state = "running";
      }
    }
    (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
  });
}

const soundStarts = (page: Page) => page.evaluate(() => (window as unknown as { __oscillatorStarts: number }).__oscillatorStarts);

async function signInStaff(page: Page) {
  await page.goto("/restaurant");
  await page.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
  await page.getByLabel("Parol").fill(localPassword);
  await page.getByRole("button", { name: "Kirish" }).click();
  await expect(page.getByRole("button", { name: "Chiqish" })).toBeVisible();
}

// The passive "any gesture arms it" listener can already have armed sound
// by the time a test reaches the dedicated button (e.g. signing in is
// itself a qualifying click) -- check status first rather than assuming
// the button is still there to click.
async function ensureSoundArmed(page: Page) {
  const status = page.getByTestId("restaurant-sound-status");
  if ((await status.textContent())?.includes("Ovoz yoqilgan")) return;
  await page.getByRole("heading", { name: "Buyurtmalar" }).click();
  await expect(status).toContainText("Ovoz yoqilgan", { timeout: 5000 });
}

async function placePickupOrder(customer: Page, name: string, phone: string) {
  await customer.goto("/menu/chicken");
  await customer.getByRole("button", { name: "+" }).click();
  await customer.getByTestId("buy-now").click();
  await customer.getByTestId("type-pickup").click();
  await customer.getByLabel("Ism *").fill(name);
  await customer.getByLabel("Telefon *").fill(phone);
  await customer.getByTestId("checkout-submit").click();
  await customer.waitForURL("**/confirmation/**");
}

test("pre-existing NEW orders on reload never trigger sound; a genuinely new arrival afterward (no reload) does, and repeats until acknowledged", async ({ browser }) => {
  test.setTimeout(60000);
  const staffContext = await browser.newContext();
  const customerContext = await browser.newContext();
  const staff = await staffContext.newPage();
  const customer = await customerContext.newPage();

  await installFakeAudio(staff);
  await signInStaff(staff);
  if (await staff.getByTestId("new-order-alert").isVisible().catch(() => false)) {
    await staff.getByTestId("acknowledge-all-orders").click();
  }
  await ensureSoundArmed(staff);

  // Reload once more with a clean (acknowledged) baseline -- the fresh
  // mount's hydration must not play anything even though real orders
  // already exist server-side.
  await staff.reload();
  await ensureSoundArmed(staff);
  await staff.waitForTimeout(500);
  expect(await soundStarts(staff)).toBe(0);

  // A genuinely new order now arrives via the real realtime subscription
  // -- the SAME mounted page, no reload.
  await placePickupOrder(customer, "Sound Auth Test", "+998907779401");
  await expect.poll(() => soundStarts(staff), { timeout: 15000 }).toBeGreaterThan(0);
  const afterArrival = await soundStarts(staff);

  // Repeats on an interval while unacknowledged.
  await staff.waitForTimeout(9000);
  expect(await soundStarts(staff)).toBeGreaterThan(afterArrival);

  // Acknowledging stops the repeat.
  await staff.getByTestId("acknowledge-all-orders").click();
  const afterAcknowledge = await soundStarts(staff);
  await staff.waitForTimeout(9000);
  expect(await soundStarts(staff)).toBe(afterAcknowledge);

  await staffContext.close();
  await customerContext.close();
});

test("full authenticated app refresh never converts browser audio lock into a persisted mute", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await installFakeAudio(page);
  await signInStaff(page);

  await page.evaluate(() => {
    localStorage.removeItem("zaytun-go:sound-preference");
    localStorage.removeItem("zaytun-go:sound-preference-v2");
  });
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "Chiqish" })).toBeVisible();
  await expect(page.getByTestId("restaurant-sound-status")).toContainText("Ovoz birinchi bosishda faollashadi");
  await expect(page.getByTestId("restaurant-sound-toggle")).toHaveText("Ovozni o‘chirish");
  expect(await page.evaluate(() => localStorage.getItem("zaytun-go:sound-preference-v2"))).toBeNull();

  // A second refresh exercises session restoration and the complete app
  // initialization path again. Neither Auth hydration nor the service
  // worker may manufacture an explicit mute preference.
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByTestId("restaurant-sound-status")).toContainText("Ovoz birinchi bosishda faollashadi");
  expect(await page.evaluate(() => localStorage.getItem("zaytun-go:sound-preference-v2"))).toBeNull();

  await page.getByTestId("restaurant-sound-toggle").click();
  expect(await page.evaluate(() => localStorage.getItem("zaytun-go:sound-preference-v2"))).toBe("explicit-muted");
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByTestId("restaurant-sound-status")).toContainText("Ovoz o‘chirilgan");

  await page.getByTestId("restaurant-sound-toggle").click();
  expect(await page.evaluate(() => localStorage.getItem("zaytun-go:sound-preference-v2"))).toBe("enabled");
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByTestId("restaurant-sound-status")).toContainText("Ovoz birinchi bosishda faollashadi");
  await context.close();
});

test("legacy ambiguous mute is normalized ON without clearing unrelated storage", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await installFakeAudio(page);
  await page.addInitScript(() => {
    localStorage.setItem("zaytun-go:sound-preference", "muted");
    localStorage.removeItem("zaytun-go:sound-preference-v2");
    localStorage.setItem("zaytun-go:unrelated-proof", "preserved");
  });
  await signInStaff(page);
  await expect(page.getByTestId("restaurant-sound-status")).toContainText("Ovoz birinchi bosishda faollashadi");
  expect(await page.evaluate(() => localStorage.getItem("zaytun-go:sound-preference-v2"))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem("zaytun-go:unrelated-proof"))).toBe("preserved");
  await page.screenshot({ path: "qa/screenshots/25-restaurant-sound-default-on-390x844.png", fullPage: true });
  await context.close();
});
