// Multi-Order Dispatch: standalone worker for e2e/helpers/driverCleanup.ts.
//
// Cancels every non-terminal order currently assigned to one driver, via
// the same staff-authoritative transition_order RPC path
// scripts/test-capacity-concurrency.mjs already proves works at any
// pre-terminal status. This must be a plain, separately-invoked Node
// script (spawned as a child process), not imported directly into a
// Playwright test file: importing @supabase/supabase-js from inside a
// Playwright-transpiled test file hits a real Node.js bug ("Unexpected
// module status 3") in @supabase/auth-js's internal module structure,
// under Playwright's own CJS/ESM interop for `require`d dependencies.
// Running as a plain `node script.mjs` process (exactly like
// test-capacity-concurrency.mjs already does) sidesteps that transform
// entirely.
import { createClient } from '@supabase/supabase-js'

const identifier = process.argv[2]
if (!identifier) throw new Error('usage: node e2e-force-free-driver.mjs <email-or-phone>')

const url = 'http://127.0.0.1:54321'
const anonKey = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'
const password = 'zaytun-local-2026'
const make = () => createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })

const NON_TERMINAL_STATUSES = ['NEW', 'CONFIRMED', 'PREPARING', 'READY', 'DRIVER_ASSIGNED', 'PICKED_UP', 'ON_THE_WAY', 'ARRIVED']

const staff = make()
const driver = make()

const staffAuth = await staff.auth.signInWithPassword({ email: 'restaurant@zaytun.local', password })
if (staffAuth.error) process.exit(0)

const isEmail = identifier.includes('@')
const driverAuth = await driver.auth.signInWithPassword(
  isEmail ? { email: identifier, password } : { phone: identifier, password },
)
if (driverAuth.error || !driverAuth.data.user) process.exit(0)
const driverId = driverAuth.data.user.id

const active = await staff.from('orders').select('id,status').eq('assigned_driver_id', driverId).in('status', NON_TERMINAL_STATUSES)
if (active.error || !active.data) process.exit(0)

for (const o of active.data) {
  try {
    await staff.rpc('transition_order', { p_order_id: o.id, p_new_status: 'CANCELLED', p_reason: 'e2e test cleanup', p_notes: null })
  } catch {
    // best-effort
  }
}

process.exit(0)
