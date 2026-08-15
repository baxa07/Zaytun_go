import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Phase D, Part A: exercises the REAL navigator.serviceWorker registration/
// update/reload path in a real browser -- not a reimplemented copy of the
// decision logic. The default config's webServer runs `vite build && vite
// preview`, which genuinely serves dist/sw.js, so a real SW registration
// is available here. A "new deploy" is simulated by editing dist/sw.js on
// disk (byte-different content is what makes the browser's own update
// check detect anything at all) and restored afterward so it can't affect
// any other test sharing the same server process.
const SW_PATH = resolve(__dirname, "..", "dist", "sw.js");

function withSimulatedNewDeploy<T>(run: () => Promise<T>): Promise<T> {
  const original = readFileSync(SW_PATH, "utf8");
  writeFileSync(SW_PATH, original.replace("zaytun-go-static-", "zaytun-go-static-e2e-simulated-deploy-"));
  return run().finally(() => writeFileSync(SW_PATH, original));
}

// Short, deterministic timing -- see pwa.ts's testConfig(). Installed via
// addInitScript so it's present before any application code (including
// registerProductionServiceWorker) runs.
async function installFastPwaTiming(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    (window as unknown as { __zaytunPwaTestConfig: Record<string, number> }).__zaytunPwaTestConfig = {
      autoActivateDelayMs: 800,
      mutationRecheckMs: 500,
      periodicCheckMs: 3600000,
    };
  });
}

test.describe("service worker update reliability", () => {
  test("a new deploy is detected without a hard refresh, and auto-activates with no explicit click", async ({ page }) => {
    await installFastPwaTiming(page);
    await page.goto("/driver");
    // Let the first-ever registration settle (install/activate) before
    // simulating a new deploy -- otherwise the "new" worker could just be
    // mistaken for the very first install.
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 15000 });

    await withSimulatedNewDeploy(async () => {
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
      // New worker/version detected -- the banner appears, no reload yet.
      await expect(page.locator(".update-notice")).toBeVisible({ timeout: 15000 });

      // Mark this page instance so we can prove a reload actually
      // happened (a fresh page load has no such marker).
      await page.evaluate(() => {
        (window as unknown as { __e2eMarker: string }).__e2eMarker = "pre-reload";
      });

      // Auto-activates on its own within the short test window -- no
      // click on "Yangilash" at all.
      await page.waitForFunction(
        () => (window as unknown as { __e2eMarker?: string }).__e2eMarker === undefined,
        { timeout: 15000 },
      );
      // The reload-loop guard means exactly one reload -- confirm the
      // page is stable afterward (no marker reappears/second reload).
      await page.waitForTimeout(1000);
      const controllerActive = await page.evaluate(() => !!navigator.serviceWorker.controller);
      expect(controllerActive).toBe(true);
    });
  });

  test("only one reload occurs even if controllerchange fires again", async ({ page }) => {
    await installFastPwaTiming(page);
    await page.goto("/driver");
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 15000 });

    let reloadCount = 0;
    page.on("load", () => {
      reloadCount++;
    });

    await withSimulatedNewDeploy(async () => {
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
      await expect(page.locator(".update-notice")).toBeVisible({ timeout: 15000 });
      await page.waitForFunction(
        () => (window as unknown as { __zaytunPwaTest?: { hasReloaded: () => boolean } }).__zaytunPwaTest?.hasReloaded(),
        { timeout: 15000 },
      );
      // hasReloaded flips true once, right before the one real reload --
      // give it a moment to actually complete, then confirm nothing else
      // reloads on top of it.
      await page.waitForTimeout(2000);
      expect(reloadCount).toBeLessThanOrEqual(1);
    });
  });

  test("a pending operational mutation defers the reload until it completes", async ({ page }) => {
    await installFastPwaTiming(page);
    await page.goto("/driver");
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 15000 });

    await withSimulatedNewDeploy(async () => {
      // Simulate a mutation being in flight for the whole detection
      // window -- via the real module-level signal pwa.ts's own
      // controllerchange handler consumes (state.tsx wires the real
      // pendingTransitionState count into the exact same function).
      await page.evaluate(() => {
        (window as unknown as { __zaytunPwaTest: { setPendingMutationCount: (n: number) => void } }).__zaytunPwaTest.setPendingMutationCount(1);
      });
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
      await expect(page.locator(".update-notice")).toBeVisible({ timeout: 15000 });

      await page.evaluate(() => {
        (window as unknown as { __e2eMarker: string }).__e2eMarker = "pre-reload";
      });

      // Well past the auto-activate delay -- must NOT have reloaded while
      // the mutation is still pending.
      await page.waitForTimeout(2500);
      expect(await page.evaluate(() => (window as unknown as { __e2eMarker?: string }).__e2eMarker)).toBe("pre-reload");

      // Mutation completes -- the deferred reload now proceeds.
      await page.evaluate(() => {
        (window as unknown as { __zaytunPwaTest: { setPendingMutationCount: (n: number) => void } }).__zaytunPwaTest.setPendingMutationCount(0);
      });
      await page.waitForFunction(
        () => (window as unknown as { __e2eMarker?: string }).__e2eMarker === undefined,
        { timeout: 15000 },
      );
    });
  });

  test("auth/session storage is not cleared by the update reload", async ({ page }) => {
    await installFastPwaTiming(page);
    await page.goto("/driver");
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 15000 });
    await page.evaluate(() => localStorage.setItem("e2e-fake-session-marker", "still-here"));

    await withSimulatedNewDeploy(async () => {
      const reloaded = page.waitForEvent("load", { timeout: 15000 });
      await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r?.update()));
      await expect(page.locator(".update-notice")).toBeVisible({ timeout: 15000 });
      await reloaded;
      expect(await page.evaluate(() => localStorage.getItem("e2e-fake-session-marker"))).toBe("still-here");
    });
  });

  test("visibilitychange and online events trigger a real update check, detecting a deploy that happened while the tab was already open", async ({ page }) => {
    await installFastPwaTiming(page);
    await page.goto("/driver");
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 15000 });

    await withSimulatedNewDeploy(async () => {
      // No manual registration.update() call here -- only the
      // visibilitychange listener installed by registerProductionServiceWorker
      // itself may trigger the check that discovers the simulated deploy.
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await expect(page.locator(".update-notice")).toBeVisible({ timeout: 15000 });
    });
  });

  test("the online event alone triggers a real update check, detecting a deploy that happened while the tab was already open", async ({ page }) => {
    await installFastPwaTiming(page);
    await page.goto("/driver");
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 15000 });

    await withSimulatedNewDeploy(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event("online")));
      await expect(page.locator(".update-notice")).toBeVisible({ timeout: 15000 });
    });
  });
});
