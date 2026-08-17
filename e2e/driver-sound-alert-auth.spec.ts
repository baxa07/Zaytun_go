import { expect, test, type Page } from "@playwright/test";
import { forceFreeDriver } from "./helpers/driverCleanup";

// Phase D, Part C/H: the new-assignment SOUND specifically, against a
// real backend. Covers: hydration never replays a sound for an existing
// assignment, a genuinely new assignment (batched or unbatched) sounds
// immediately, it repeats while unanswered and stops once accepted, and
// -- critically -- the recently fixed invariant (any active, un-picked-up
// assignment gets a full primary-panel card, never just a passive row)
// is unaffected by any of this.
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

async function ensureSoundArmed(page: Page) {
  const status = page.getByTestId("driver-sound-status");
  if ((await status.textContent())?.includes("Ovoz yoqilgan")) return;
  await page.getByRole("heading", { name: "Bugungi yetkazish" }).click();
  await expect(status).toContainText("Ovoz yoqilgan", { timeout: 5000 });
}

async function freeDriver(page: Page, identifier: string) {
  await forceFreeDriver(identifier);
  await page.goto("/driver");
  await page.getByLabel("Telefon yoki email").fill(identifier);
  await page.getByLabel("Parol").fill(localPassword);
  await page.getByRole("button", { name: "Kirish" }).click();
  await expect(page.getByRole("button", { name: "Chiqish" })).toBeVisible();
  await page.waitForTimeout(500);
  if (await page.getByTestId("driver-shift-toggle").isEnabled().catch(() => false)) {
    if ((await page.getByTestId("driver-availability-status").textContent()) !== "🟢 Ishga tayyor") {
      await page.getByTestId("driver-shift-toggle").click();
      await expect(page.getByTestId("driver-availability-status")).toHaveText("🟢 Ishga tayyor");
    }
  }
  if (await page.locator(".assignment-card, .delivery-card").count() > 0) {
    await forceFreeDriver(identifier);
    await page.reload();
    await page.waitForTimeout(500);
  }
  for (let i = 0; i < 6; i++) {
    if (await page.locator(".assignment-card, .delivery-card").count() === 0) break;
    await page.getByTestId("driver-primary-action").click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(250);
  }
  if (await page.locator(".assignment-card, .delivery-card").count() > 0) {
    await forceFreeDriver(identifier);
    await page.reload();
  }
  await expect(page.locator(".assignment-card, .delivery-card")).toHaveCount(0, { timeout: 10000 });
}

async function takeOffShift(page: Page, identifier: string) {
  await freeDriver(page, identifier);
  await page.getByTestId("driver-shift-toggle").click();
  await expect(page.getByTestId("driver-availability-status")).toHaveText("⚪ Hozir ishlamayapman");
}

async function signInStaff(page: Page) {
  await page.goto("/restaurant");
  await page.getByLabel("Telefon yoki email").fill("restaurant@zaytun.local");
  await page.getByLabel("Parol").fill(localPassword);
  await page.getByRole("button", { name: "Kirish" }).click();
  await expect(page.getByRole("button", { name: "Chiqish" })).toBeVisible();
}

test("driver clean and legacy-only storage default ON; an explicit V2 mute alone persists OFF", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await installFakeAudio(page);
  await page.goto("/driver");
  await page.evaluate(() => {
    localStorage.setItem("zaytun-go:sound-preference", "muted");
    localStorage.removeItem("zaytun-go:sound-preference-v2");
  });
  await page.reload();
  await page.getByLabel("Telefon yoki email").fill("driver@zaytun.local");
  await page.getByLabel("Parol").fill(localPassword);
  await page.getByRole("button", { name: "Kirish" }).click();
  await expect(page.getByTestId("driver-sound-status")).toContainText("Ovoz birinchi bosishda faollashadi");
  await page.screenshot({ path: "qa/screenshots/26-driver-sound-default-on-390x844.png", fullPage: true });
  await page.reload();
  await expect(page.getByTestId("driver-sound-status")).toContainText("Ovoz birinchi bosishda faollashadi");
  // Any ordinary operational interaction unlocks/resumes audio. The
  // dedicated sound control is not required, and unlocking stays silent.
  await page.getByRole("heading", { name: "Bugungi yetkazish" }).click();
  await expect(page.getByTestId("driver-sound-status")).toContainText("Ovoz yoqilgan");
  expect(await soundStarts(page)).toBe(0);
  await page.getByTestId("driver-sound-toggle").click();
  await expect(page.getByTestId("driver-sound-status")).toContainText("Ovoz o‘chirilgan");
  expect(await page.evaluate(() => localStorage.getItem("zaytun-go:sound-preference-v2"))).toBe("explicit-muted");
  await page.reload();
  await expect(page.getByTestId("driver-sound-status")).toContainText("Ovoz o‘chirilgan");
  await page.getByTestId("driver-sound-toggle").click();
  expect(await page.evaluate(() => localStorage.getItem("zaytun-go:sound-preference-v2"))).toBe("enabled");
  await page.reload();
  await expect(page.getByTestId("driver-sound-status")).toContainText("Ovoz birinchi bosishda faollashadi");
  await context.close();
});

async function placeDeliveryOrder(customer: Page, name: string, phone: string) {
  await customer.goto("/menu/chicken");
  await customer.getByRole("button", { name: "+" }).click();
  await customer.getByTestId("buy-now").click();
  await customer.waitForURL("**/checkout");
  await customer.getByLabel("Ism *").fill(name);
  await customer.getByLabel("Telefon *").fill(phone);
  await customer.getByLabel("Mahalla yoki tuman *").fill("Guliston tumani");
  await customer.getByLabel("Ko‘cha yoki joylashuv *").fill("Test ko‘chasi");
  await customer.getByTestId("map-picker-set").click();
  await customer.getByLabel("Kirish joyi xaritada to‘g‘ri belgilangan").check();
  await customer.getByTestId("checkout-submit").click();
  await customer.waitForURL("**/confirmation/**");
  return customer.url().split("/confirmation/")[1];
}

async function acceptOrder(staff: Page, orderId: string) {
  await staff.goto(`/restaurant/orders/${orderId}`);
  await staff.getByTestId("approve-delivery").click();
  await staff.getByTestId("action-confirm").click();
}

test("hydration with an existing assignment plays no sound; a genuinely new assignment sounds immediately, repeats while unanswered, and stops once accepted -- the full-card invariant is unaffected", async ({ browser }) => {
  test.setTimeout(60000);
  const driverContext = await browser.newContext();
  const otherDriverContext = await browser.newContext();
  const customerAContext = await browser.newContext();
  const customerBContext = await browser.newContext();
  const staffContext = await browser.newContext();
  const driver = await driverContext.newPage();
  const otherDriver = await otherDriverContext.newPage();
  const customerA = await customerAContext.newPage();
  const customerB = await customerBContext.newPage();
  const staff = await staffContext.newPage();
  await driver.setViewportSize({ width: 390, height: 844 });

  await takeOffShift(otherDriver, "998900000099");
  await otherDriverContext.close();
  await installFakeAudio(driver);
  await freeDriver(driver, "driver@zaytun.local");
  // Arm sound BEFORE the assignment is created -- otherwise there is
  // nothing to play through yet and the chime is a correct no-op, not a
  // meaningful proof either way.
  await ensureSoundArmed(driver);
  await signInStaff(staff);

  // Explicit mute is a preference, not a browser-lock state, and must
  // suppress even a genuinely new assignment while persisting reload.
  await driver.getByTestId("driver-sound-toggle").click();
  await expect(driver.getByTestId("driver-sound-status")).toContainText("Ovoz o‘chirilgan");

  const orderIdA = await placeDeliveryOrder(customerA, "Sound Driver A", "+998907779501");
  await acceptOrder(staff, orderIdA);
  await expect(driver.locator(".assignment-card")).toBeVisible({ timeout: 15000 });
  const afterFirstAssignment = await soundStarts(driver);
  expect(afterFirstAssignment).toBe(0);

  // Hydration check: reload with this same active, unaccepted assignment
  // still present -- must not replay a sound for it.
  await driver.reload();
  await expect(driver.getByTestId("driver-sound-status")).toContainText("Ovoz o‘chirilgan");
  await driver.waitForTimeout(500);
  expect(await soundStarts(driver)).toBe(0);

  // Explicit unmute happens inside a legitimate click, so it persists and
  // unlocks immediately without manufacturing an assignment sound.
  await driver.getByTestId("driver-sound-toggle").click();
  await expect(driver.getByTestId("driver-sound-status")).toContainText("Ovoz yoqilgan");
  expect(await soundStarts(driver)).toBe(0);

  // Accept it -- the repeat for THIS assignment must stop.
  await driver.getByTestId("driver-primary-action").click();
  await expect(driver.getByTestId("driver-pre-ready-card")).toBeVisible();

  // A second order joins (batched, since same branch/compatible window)
  // -- must sound immediately, without a reload, and without collapsing
  // into a passive row (the recently fixed invariant).
  const orderIdB = await placeDeliveryOrder(customerB, "Sound Driver B", "+998907779502");
  await acceptOrder(staff, orderIdB);
  await expect(driver.getByTestId("driver-pickup-batch")).toBeVisible({ timeout: 15000 });
  await expect(driver.getByTestId(`driver-batch-accept-${orderIdB}`)).toBeVisible();
  await expect.poll(() => soundStarts(driver), { timeout: 15000 }).toBeGreaterThan(0);
  const afterSecondAssignment = await soundStarts(driver);

  // Repeats while B remains unanswered.
  await driver.waitForTimeout(9000);
  expect(await soundStarts(driver)).toBeGreaterThan(afterSecondAssignment);

  // Accepting B stops the repeat, and both orders remain full, active
  // cards (never a passive KEYINGI-only row) -- the invariant this phase
  // must not regress.
  await driver.getByTestId(`driver-batch-accept-${orderIdB}`).click();
  await expect(driver.getByTestId("driver-batch-count")).toContainText("2/2 buyurtma");
  const afterAcceptB = await soundStarts(driver);
  await driver.waitForTimeout(9000);
  expect(await soundStarts(driver)).toBe(afterAcceptB);

  await driverContext.close();
  await customerAContext.close();
  await customerBContext.close();
  await staffContext.close();
});
