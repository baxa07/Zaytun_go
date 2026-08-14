// Driver UI Final Operational UX: test-only helper for
// e2e/driver-operational-ux-auth.spec.ts's actual-wait-exceeded scenario.
// Backdates the driver's own currently-open pickup batch's
// first_member_ready_at well past the configured actual-wait window, so
// the "leave now" / release-on-next-pickup-click behavior can be observed
// without a real multi-minute sleep in the test. Direct local-superuser DB
// connection (delivery_settings/pickup_batches have no driver/staff write
// path for this at all -- only server-side functions touch them), same
// pattern as e2e-set-delivery-settings.mjs. Local Supabase Postgres only.
import { execFileSync } from 'node:child_process'
import { createClient } from '@supabase/supabase-js'

const identifier = process.argv[2]
const minutesAgo = process.argv[3] || '30'
if (!identifier) throw new Error('usage: node e2e-backdate-batch-ready.mjs <driver-email-or-phone> [minutesAgo]')
if (!/^-?\d+$/.test(minutesAgo)) throw new Error('invalid minutesAgo')

const url = 'http://127.0.0.1:54321'
const anonKey = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'
const password = 'zaytun-local-2026'
const driver = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })
const isEmail = identifier.includes('@')
const driverAuth = await driver.auth.signInWithPassword(isEmail ? { email: identifier, password } : { phone: identifier, password })
if (driverAuth.error) throw driverAuth.error
const driverId = driverAuth.data.user.id

execFileSync('psql', [
  '-h', '127.0.0.1', '-p', '54322', '-U', 'postgres', '-d', 'postgres',
  '-c', `update public.pickup_batches set first_member_ready_at = now() - interval '${minutesAgo} minutes' where driver_id = '${driverId}' and status in ('OPEN','READY_TO_DEPART');`,
], { env: { ...process.env, PGPASSWORD: 'postgres' }, stdio: 'inherit' })
