import {defineConfig, devices} from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  testIgnore: 'auth-local.spec.ts',
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
    env: {...process.env, VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '', VITE_MAP_PROVIDER: 'mock'},
  },
  projects: [
    {name: 'chromium', use: {...devices['Desktop Chrome']}},
  ],
})
