import {defineConfig, devices} from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['auth-local.spec.ts', 'customer-otp.spec.ts', 'checkout-idempotency.spec.ts', 'live-restaurant-board.spec.ts', 'order-history.spec.ts', 'driver-ledger.spec.ts', 'driver-lifecycle-auth.spec.ts', 'restaurant-dispatch-auth.spec.ts', 'decline-reassignment-auth.spec.ts', 'customer-realtime-tracking.spec.ts', 'restaurant-realtime.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && npm run preview -- --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    env: {...process.env, VITE_DATA_PROVIDER:'local', VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '', VITE_MAP_PROVIDER: 'mock', VITE_DEFAULT_MAP_LAT:'40.087274', VITE_DEFAULT_MAP_LNG:'65.402551', VITE_DEFAULT_MAP_ZOOM:'17'},
  },
  projects: [
    {name: 'chromium', use: {...devices['Desktop Chrome']}},
  ],
})
