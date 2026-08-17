import { execSync } from "node:child_process";
import { expect, test, type APIRequestContext } from "@playwright/test";

// LOCAL TEST ONLY -- Supabase CLI's fixed, publicly documented anon
// (publishable) key for every local dev instance, identical across all
// `supabase start` installs. Not a secret: publishable keys are meant to be
// embedded in client code and are safe to read here.
const LOCAL_ANON_KEY = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
const LOCAL_API_URL = "http://127.0.0.1:54321";

// This suite mutates delivery_settings.customer_auth_required directly via
// psql so both rollout states (false/true) can be exercised locally without
// a restaurant-facing UI for the flag. Connection is pinned to the local-only
// Postgres host/port playwright.auth.config.ts already restricts this file
// to running against -- never point this at a remote/production database.
// Production's flag is only ever changed through the reviewed release-gate
// process, never by a test. The password is Supabase CLI's fixed, publicly
// documented default for every local dev instance (identical across all
// `supabase start` installs, printed to any developer's terminal) -- passed
// via PGPASSWORD, not embedded in a connection URL, so no credential-shaped
// string appears in source.
const LOCAL_DB_HOST = "127.0.0.1";
const LOCAL_DB_PORT = "54322";
const LOCAL_DB_USER = "postgres";
const LOCAL_DB_NAME = "postgres";
const LOCAL_DB_PASSWORD = "postgres";

function assertLocalDbHost(host: string, port: string) {
  if (!/^(127\.0\.0\.1|localhost)$/.test(host) || port !== "54322") {
    throw new Error(`customer-otp Playwright suite aborted: DB host "${host}:${port}" is not the local Supabase database.`);
  }
}
assertLocalDbHost(LOCAL_DB_HOST, LOCAL_DB_PORT);

function psql(sql: string): string {
  return execSync(
    `psql -h ${LOCAL_DB_HOST} -p ${LOCAL_DB_PORT} -U ${LOCAL_DB_USER} -d ${LOCAL_DB_NAME} -At -F'|' -c "${sql}"`,
    { encoding: "utf8", env: { ...process.env, PGPASSWORD: LOCAL_DB_PASSWORD } },
  ).trim();
}

function setCustomerAuthRequired(value: boolean) {
  psql(`update delivery_settings set customer_auth_required=${value} where id=true;`);
}

function queryOrder(orderId: string): { number: string; customer_id: string | null; primary_phone: string; actor_type: string; actor_id: string } {
  const out = psql(
    `select o.number, o.customer_id, o.primary_phone, e.actor_type, e.actor_id from orders o join order_events e on e.order_id = o.id and e.previous_status is null where o.id = '${orderId}';`,
  );
  const [number, customer_id, primary_phone, actor_type, actor_id] = out.split("|");
  return { number, customer_id: customer_id || null, primary_phone, actor_type, actor_id };
}

// Mints a throwaway second real auth identity (via the local-only fixture
// phone 998000000002), resolving its canonical customers row, and returns
// that auth user's id -- used to reproduce a genuine CUSTOMER_PHONE_CONFLICT
// by reassigning that row onto the phone a later OTP verification attempts.
async function mintOtherAuthUserId(request: APIRequestContext): Promise<string> {
  await request.post(`${LOCAL_API_URL}/auth/v1/otp`, {
    headers: { apikey: LOCAL_ANON_KEY, "Content-Type": "application/json" },
    data: { phone: "+998000000002" },
  });
  const verifyResponse = await request.post(`${LOCAL_API_URL}/auth/v1/verify`, {
    headers: { apikey: LOCAL_ANON_KEY, "Content-Type": "application/json" },
    data: { phone: "+998000000002", token: "222222", type: "sms" },
  });
  const body = await verifyResponse.json();
  await request.post(`${LOCAL_API_URL}/rest/v1/rpc/ensure_current_customer`, {
    headers: { apikey: LOCAL_ANON_KEY, Authorization: `Bearer ${body.access_token}`, "Content-Type": "application/json" },
    data: {},
  });
  return body.user.id as string;
}

const addItemToCartAndReachCheckout = async (page: import("@playwright/test").Page) => {
  await page.goto("/menu");
  await page.getByRole("link", { name: /Zaytun tovuq grili tanlash/ }).click();
  await page.getByRole("button", { name: "+" }).click();
  await page.getByTestId("buy-now").click();
  await page.getByTestId("type-pickup").click();
};

test.describe("customer_auth_required=false (production default): anonymous checkout regression", () => {
  test.beforeAll(() => setCustomerAuthRequired(false));

  test("anonymous browse -> cart -> checkout completes with no OTP interruption", async ({ page }) => {
    await addItemToCartAndReachCheckout(page);
    await page.getByLabel("Ism *").fill("Flag Off Mijoz");
    await page.getByLabel("Telefon *").fill("+998901234599");
    await page.getByTestId("checkout-submit").click();
    await expect(page).toHaveURL(/\/confirmation\//);
    await expect(page.getByTestId("customer-otp-step")).toHaveCount(0);

    const orderId = page.url().split("/confirmation/")[1];
    const order = queryOrder(orderId);
    expect(order.customer_id).toBeNull();
    expect(order.actor_type).toBe("CUSTOMER");
    expect(order.actor_id).toBe("guest");
  });
});

test("Turnstile script failure is fail-closed and the visible retry loads a fresh widget", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let scriptRequests = 0;
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js", async (route) => {
    scriptRequests += 1;
    if (scriptRequests === 1) await route.abort("failed");
    else await route.continue();
  });
  await page.goto("/orders");
  await expect(page.getByText("Xavfsizlik tekshiruvi yuklanmadi")).toBeVisible();
  await expect(page.getByRole("button", { name: "SMS kod yuborish" })).toBeDisabled();
  await page.screenshot({ path: "qa/screenshots/24-turnstile-error-retry-390x844.png", fullPage: true });
  await page.getByTestId("orders-captcha-retry").click();
  await expect(page.getByTestId("orders-captcha-retry")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "SMS kod yuborish" })).toBeEnabled({ timeout: 15000 });
  expect(scriptRequests).toBe(2);
});

test.describe("customer_auth_required=true: full customer phone-OTP checkout flow", () => {
  test.beforeAll(() => setCustomerAuthRequired(true));
  test.afterAll(() => setCustomerAuthRequired(false));

  test("checkout is intercepted by inline OTP, preserves state, verifies, and submits an authenticated order", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await addItemToCartAndReachCheckout(page);
    await page.getByLabel("Ism *").fill("OTP Mijoz");
    await page.getByLabel("Telefon *").fill("+998901234588");
    await page.getByLabel("Buyurtma izohi").fill("Pechene qo‘shmang");
    await page.screenshot({ path: "qa/screenshots/18-checkout-before-submit-390x844.png", fullPage: true });
    await page.getByTestId("checkout-submit").click();

    // Unauthenticated + flag=true: submission is intercepted, not rejected --
    // still on /checkout, and every already-entered field is untouched.
    await expect(page.getByTestId("customer-otp-step")).toBeVisible();
    await expect(page).not.toHaveURL(/\/confirmation\//);
    await expect(page.getByLabel("Ism *")).toHaveValue("OTP Mijoz");
    await expect(page.getByLabel("Buyurtma izohi")).toHaveValue("Pechene qo‘shmang");
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
    await page.screenshot({ path: "qa/screenshots/19-inline-otp-390x844.png", fullPage: true });
    await page.screenshot({ path: "qa/screenshots/20-turnstile-normal-390x844.png", fullPage: true });

    await page.getByLabel("Telefon", { exact: true }).fill("000000001");
    await page.getByTestId("otp-send").click();
    await expect(page.getByLabel("Tasdiqlash kodi")).toBeVisible();

    // Wrong code: clean Uzbek error, no crash, no navigation.
    await page.getByLabel("Tasdiqlash kodi").fill("000000");
    await page.getByTestId("otp-verify").click();
    await expect(page.getByTestId("otp-error")).toContainText("Kod noto‘g‘ri yoki muddati tugagan");
    await expect(page).not.toHaveURL(/\/confirmation\//);
    await page.screenshot({ path: "qa/screenshots/21-invalid-otp-390x844.png", fullPage: true });

    // Correct fixed local OTP: verifies and resumes the same checkout
    // automatically, without asking the user to press submit again.
    await page.getByTestId("otp-resend").click();
    await page.getByLabel("Tasdiqlash kodi").fill("111111");
    await page.getByTestId("otp-verify").click();

    await expect(page).toHaveURL(/\/confirmation\//, { timeout: 15000 });
    await page.screenshot({ path: "qa/screenshots/22-verified-auto-submit-390x844.png", fullPage: true });
    const orderId = page.url().split("/confirmation/")[1];
    const order = queryOrder(orderId);
    expect(order.customer_id).not.toBeNull();
    // Server-derived verified phone, not the manually typed "+998901234588".
    expect(order.primary_phone).toBe("+998000000001");
    expect(order.actor_type).toBe("CUSTOMER");
    expect(order.actor_id).not.toBe("guest");
  });

  test("a canonical customer-resolution failure after successful OTP verification leaves no half-authenticated state and submits no order", async ({ page, request }) => {
    // Reproduce a genuine CUSTOMER_PHONE_CONFLICT: an unrelated identity's
    // customers row already owns the phone this test's own OTP flow is about
    // to verify against -- the exact server-side condition
    // ensure_current_customer rejects, and the exact scenario the
    // verifyCustomerOtp sequencing fix (validate -> ensure_current_customer
    // -> only then finalize React auth state) exists to handle cleanly.
    const otherAuthUserId = await mintOtherAuthUserId(request);
    psql(`update customers set phone_e164='+998000000003' where auth_user_id='${otherAuthUserId}';`);

    await addItemToCartAndReachCheckout(page);
    await page.getByLabel("Ism *").fill("Conflict Mijoz");
    await page.getByLabel("Telefon *").fill("+998901234566");
    await page.getByTestId("checkout-submit").click();
    await expect(page.getByTestId("customer-otp-step")).toBeVisible();

    await page.getByLabel("Telefon", { exact: true }).fill("000000003");
    await page.getByTestId("otp-send").click();
    await expect(page.getByLabel("Tasdiqlash kodi")).toBeVisible();
    await page.getByLabel("Tasdiqlash kodi").fill("333333");
    await page.getByTestId("otp-verify").click();

    // Error is shown, in the clean Uzbek form, not a raw Supabase dump.
    await expect(page.getByTestId("otp-error")).toContainText("boshqa hisobga bog‘langan");
    // Still on /checkout -- the order was never submitted.
    await expect(page).not.toHaveURL(/\/confirmation\//);
    // Never finalized as an authenticated customer -- no half-authenticated
    // window: the masked-phone/"Chiqish" badge never appears.
    await expect(page.getByTestId("customer-session-badge")).toHaveCount(0);
    // The OTP step is still open on its code screen, not silently advanced
    // past the bad identity into a submitted order.
    await expect(page.getByTestId("customer-otp-step")).toBeVisible();

    const orderCount = psql(`select count(*) from orders where primary_phone in ('+998901234566','+998000000003');`);
    expect(orderCount).toBe("0");
  });

  test("Buyurtmalarim recovers an owned order without the original tracking token, and OTP restores it after sign-out", async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 390, height: 844 });
    await addItemToCartAndReachCheckout(page);
    await page.getByLabel("Ism *").fill("Recovery Mijoz");
    await page.getByLabel("Telefon *").fill("+998901234577");
    await page.getByTestId("checkout-submit").click();
    await page.getByLabel("Telefon", { exact: true }).fill("000000002");
    await page.getByTestId("otp-send").click();
    await page.getByLabel("Tasdiqlash kodi").fill("222222");
    await page.getByTestId("otp-verify").click();
    await expect(page).toHaveURL(/\/confirmation\//, { timeout: 15000 });
    const orderId = page.url().split("/confirmation/")[1];

    await page.evaluate(() => localStorage.removeItem("zgo.tracking"));
    await page.goto("/orders");
    await expect(page.getByTestId("my-orders-page")).toBeVisible();
    await page.screenshot({ path: "qa/screenshots/23-buyurtmalarim-390x844.png", fullPage: true });
    await page.screenshot({ path: "qa/screenshots/14-customer-my-orders.png", fullPage: true });
    await expect(page.getByTestId("my-order-card").filter({ hasText: queryOrder(orderId).number })).toBeVisible();
    await page.getByTestId("my-order-card").filter({ hasText: queryOrder(orderId).number }).getByRole("link", { name: "Kuzatish" }).click();
    await expect(page).toHaveURL(new RegExp(`/track/${orderId}$`));
    await expect(page.getByText(queryOrder(orderId).number, { exact: true })).toBeVisible();
    await page.screenshot({ path: "qa/screenshots/15-customer-tracking-recovery.png", fullPage: true });

    // Persisted Supabase session survives a complete reload and still does
    // not need the removed local tracking-token map.
    await page.reload();
    await expect(page.getByText(queryOrder(orderId).number, { exact: true })).toBeVisible();

    await page.goto("/orders");
    await page.getByRole("button", { name: "Chiqish" }).click();
    await expect(page.getByTestId("customer-login-card")).toBeVisible();
    await page.screenshot({ path: "qa/screenshots/16-customer-phone-login.png", fullPage: true });
    await page.getByLabel("Telefon").fill("000000002");
    // Local GoTrue enforces the configured per-phone resend interval just
    // like hosted Auth; the first OTP was sent earlier in this same test.
    await page.waitForTimeout(5500);
    const sendButton = page.getByRole("button", { name: "SMS kod yuborish" });
    await expect(sendButton).toBeEnabled({ timeout: 15000 });
    await sendButton.click();
    await expect(page.getByLabel("SMS kod")).toBeVisible({ timeout: 15000 });
    await page.screenshot({ path: "qa/screenshots/17-customer-otp-code.png", fullPage: true });
    await page.getByLabel("SMS kod").fill("222222");
    await page.getByRole("button", { name: "Tasdiqlash" }).click();
    await expect(page.getByTestId("my-orders-page")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("my-order-card").filter({ hasText: queryOrder(orderId).number })).toBeVisible();
  });
});
