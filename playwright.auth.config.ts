import { defineConfig, devices } from "@playwright/test";

// This suite talks to a REAL Supabase backend (signs in as restaurant/driver,
// mutates orders). `vite build` runs in production mode, and Vite's env-file
// precedence puts .env.production.local above .env.local — so if this file
// only forwarded ...process.env, a machine with a .env.production.local
// present (e.g. for real production builds/deploys) would silently point
// this suite at hosted production Supabase instead of the local instance.
// That happened once during RC validation (read-only contact only, caught
// and fixed there). Hardening it here: force the exact local Supabase
// values so no .env file can win, and fail closed with a clear error if the
// resolved host is ever not local, rather than trusting a comment/developer
// memory to keep it that way.
const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";
const LOCAL_SUPABASE_ANON_KEY = "sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH";
const ALLOWED_LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

function assertLocalSupabaseHost(url: string) {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error(`auth-local Playwright suite aborted: VITE_SUPABASE_URL "${url}" is not a valid URL.`);
  }
  if (!ALLOWED_LOCAL_HOSTS.has(host)) {
    throw new Error(
      `auth-local Playwright suite aborted: resolved Supabase host "${host}" is not local ` +
        `(expected one of ${[...ALLOWED_LOCAL_HOSTS].join(", ")}). This suite signs in and mutates ` +
        `real data, and must never run against a hosted project. Refusing to start the web server.`,
    );
  }
}

const webServerEnv = {
  ...process.env,
  VITE_DATA_PROVIDER: "supabase",
  VITE_MAP_PROVIDER: "mock",
  VITE_DEFAULT_MAP_LAT: "40.087274",
  VITE_DEFAULT_MAP_LNG: "65.402551",
  VITE_DEFAULT_MAP_ZOOM: "17",
  // Cloudflare's official public always-pass INVISIBLE Turnstile test
  // sitekey -- not a secret, safe on any domain including localhost. Lets
  // this suite exercise the real customer-OTP-send CAPTCHA gate without any
  // human interaction or real Cloudflare account.
  VITE_TURNSTILE_SITE_KEY: "1x00000000000000000000BB",
  // Set last, after the ...process.env spread, so nothing above (including a
  // real .env.production.local picked up by `vite build`) can override them.
  VITE_SUPABASE_URL: LOCAL_SUPABASE_URL,
  VITE_SUPABASE_ANON_KEY: LOCAL_SUPABASE_ANON_KEY,
  VITE_SUPABASE_PUBLISHABLE_KEY: LOCAL_SUPABASE_ANON_KEY,
};

assertLocalSupabaseHost(webServerEnv.VITE_SUPABASE_URL);

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["auth-local.spec.ts", "customer-otp.spec.ts", "checkout-idempotency.spec.ts", "live-restaurant-board.spec.ts", "order-history.spec.ts", "driver-ledger.spec.ts", "driver-lifecycle-auth.spec.ts", "restaurant-dispatch-auth.spec.ts", "decline-reassignment-auth.spec.ts", "customer-realtime-tracking.spec.ts", "restaurant-realtime.spec.ts", "driver-standby-and-arrival-auth.spec.ts", "multi-order-batching-auth.spec.ts", "driver-operational-ux-auth.spec.ts"],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:4174",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run build && npm run preview -- --host localhost --port 4174 --strictPort",
    port: 4174,
    reuseExistingServer: false,
    env: webServerEnv,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
