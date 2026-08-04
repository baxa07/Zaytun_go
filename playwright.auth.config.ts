import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "auth-local.spec.ts",
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
    env: { ...process.env, VITE_DATA_PROVIDER:"supabase", VITE_MAP_PROVIDER: "mock", VITE_DEFAULT_MAP_LAT:"40.087274", VITE_DEFAULT_MAP_LNG:"65.402551", VITE_DEFAULT_MAP_ZOOM:"17" },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
