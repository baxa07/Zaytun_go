import { execSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";

// LOCAL TEST ONLY -- same fixed, publicly documented local Supabase
// credentials used throughout the Supabase-backed suite (see
// customer-otp.spec.ts). Not secrets: safe to read here.
const LOCAL_DB_HOST = "127.0.0.1";
const LOCAL_DB_PORT = "54322";
const LOCAL_DB_USER = "postgres";
const LOCAL_DB_NAME = "postgres";
const LOCAL_DB_PASSWORD = "postgres";

function assertLocalDbHost(host: string, port: string) {
  if (!/^(127\.0\.0\.1|localhost)$/.test(host) || port !== "54322") {
    throw new Error(`checkout-idempotency Playwright suite aborted: DB host "${host}:${port}" is not the local Supabase database.`);
  }
}
assertLocalDbHost(LOCAL_DB_HOST, LOCAL_DB_PORT);

function psql(sql: string): string {
  return execSync(
    `psql -h ${LOCAL_DB_HOST} -p ${LOCAL_DB_PORT} -U ${LOCAL_DB_USER} -d ${LOCAL_DB_NAME} -At -F'|' -c "${sql}"`,
    { encoding: "utf8", env: { ...process.env, PGPASSWORD: LOCAL_DB_PASSWORD } },
  ).trim();
}

function countOrdersForPhone(phone: string): number {
  const out = psql(`select count(*) from orders where primary_phone = '${phone}';`);
  return Number(out);
}

const PENDING_KEY = "zgo.pendingCheckout";
const readPendingCheckoutId = (page: Page) =>
  page.evaluate((key) => {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { id: string; fingerprint: string }).id : null;
  }, PENDING_KEY);

const addItemToCartAndReachCheckout = async (page: Page) => {
  await page.goto("/menu");
  await page.getByRole("link", { name: /Zaytun tovuq grili tanlash/ }).click();
  await page.getByRole("button", { name: "+" }).click();
  await page.getByTestId("buy-now").click();
  await page.getByTestId("type-pickup").click();
};

test.describe("checkout idempotency (Phase 5B, launch blocker 1)", () => {
  test("Test A: two back-to-back submit clicks on the same pending checkout produce exactly one order", async ({ page }) => {
    const phone = "+998901110001";
    await addItemToCartAndReachCheckout(page);
    await page.getByLabel("Ism *").fill("Ikki Marta Bosildi");
    await page.getByLabel("Telefon *").fill(phone);

    // Fire two click events back-to-back without Playwright's normal
    // actionability waiting (visible/stable/enabled) -- .click()'s own
    // auto-retry loop fights a button that's actively disabling/navigating
    // mid-submission and never settles. dispatchEvent fires the raw DOM
    // event immediately instead, which is what a genuine double-click/
    // double-tap produces: two 'click' events in quick succession. This
    // exercises both the existing in-memory submittingRef debounce AND (if
    // that guard were ever weakened) the stable idempotency key's
    // server-side dedup as a second, independent line of defense.
    const submit = page.getByTestId("checkout-submit");
    await submit.dispatchEvent("click");
    await submit.dispatchEvent("click").catch(() => {});
    await expect(page).toHaveURL(/\/confirmation\//);

    expect(countOrdersForPhone(phone)).toBe(1);
  });

  test("Test B: reload after an uncertain network result reuses the same pending id and creates exactly one order", async ({ page }) => {
    const phone = "+998901110002";
    await addItemToCartAndReachCheckout(page);
    await page.getByLabel("Ism *").fill("Qayta Urinish Mijozi");
    await page.getByLabel("Telefon *").fill(phone);

    const pendingIdBeforeFirstAttempt = await readPendingCheckoutId(page);
    expect(pendingIdBeforeFirstAttempt).toBeNull();

    // Simulate "the server received and processed the order, but the
    // browser never got to see the success response" -- the primary
    // real-world case this fix targets (a timeout, a dropped connection,
    // a tab closed mid-request). We let the REAL request reach Postgres
    // (via route.fetch(), so the order genuinely gets created server-side
    // with a real idempotency_key), then deliberately abort the response
    // before it reaches the page, so the client's own code takes the
    // failure path -- exactly as it would for a real network interruption.
    let interceptedOnce = false;
    await page.route("**/rest/v1/rpc/create_public_order", async (route) => {
      if (interceptedOnce) return route.continue();
      interceptedOnce = true;
      await route.fetch(); // real request really reaches the server and creates the order
      await route.abort("failed"); // the page never sees that it succeeded
    });

    await page.getByTestId("checkout-submit").click();
    // The client-visible outcome of the aborted response: submission
    // failed, still on /checkout, not navigated to /confirmation.
    await expect(page).toHaveURL(/\/checkout$/);

    const pendingIdAfterFailedAttempt = await readPendingCheckoutId(page);
    expect(pendingIdAfterFailedAttempt).not.toBeNull();

    // A real browser reload -- proves the pending id survives in
    // sessionStorage across a genuine navigation, not just React state.
    await page.reload();
    expect(await readPendingCheckoutId(page)).toBe(pendingIdAfterFailedAttempt);

    // The cart itself is not persisted across a reload (by design, unrelated
    // to this fix), so the customer re-adds the identical order before
    // retrying -- the realistic "I'll just try again" flow. Because the
    // fingerprint of this reconstructed checkout matches what's already
    // pending, the same id is reused rather than minting a new one.
    await page.unroute("**/rest/v1/rpc/create_public_order");
    await addItemToCartAndReachCheckout(page);
    await page.getByLabel("Ism *").fill("Qayta Urinish Mijozi");
    await page.getByLabel("Telefon *").fill(phone);
    await page.getByTestId("checkout-submit").click();

    // The retry reaches the correct successful tracking state...
    await expect(page).toHaveURL(/\/confirmation\//);
    const confirmedId = page.url().split("/confirmation/")[1];
    expect(confirmedId).toBe(pendingIdAfterFailedAttempt);

    // ...and the server's real idempotency_key uniqueness meant the retry
    // was deduped against the order already created during the aborted
    // first attempt -- not a second, duplicate order.
    expect(countOrdersForPhone(phone)).toBe(1);

    // Pending checkout is cleared after genuine success.
    expect(await readPendingCheckoutId(page)).toBeNull();
  });

  test("Test C: a new purchase after a completed order gets a fresh id, never the previous order's", async ({ page }) => {
    const firstPhone = "+998901110003";
    await addItemToCartAndReachCheckout(page);
    await page.getByLabel("Ism *").fill("Birinchi Buyurtma");
    await page.getByLabel("Telefon *").fill(firstPhone);
    await page.getByTestId("checkout-submit").click();
    await expect(page).toHaveURL(/\/confirmation\//);
    const firstOrderId = page.url().split("/confirmation/")[1];

    // Success must have cleared the pending-checkout id -- confirmed
    // directly, not inferred.
    expect(await readPendingCheckoutId(page)).toBeNull();

    const secondPhone = "+998901110004";
    await addItemToCartAndReachCheckout(page);
    await page.getByLabel("Ism *").fill("Ikkinchi Buyurtma");
    await page.getByLabel("Telefon *").fill(secondPhone);
    // Before submitting the second, genuinely new order, there must be no
    // stale pending id left over from the first -- and once minted for
    // this new checkout, it must not equal the previous order's id.
    const submit = page.getByTestId("checkout-submit");
    await submit.click();
    await expect(page).toHaveURL(/\/confirmation\//);
    const secondOrderId = page.url().split("/confirmation/")[1];

    expect(secondOrderId).not.toBe(firstOrderId);
    expect(countOrdersForPhone(firstPhone)).toBe(1);
    expect(countOrdersForPhone(secondPhone)).toBe(1);
  });
});
