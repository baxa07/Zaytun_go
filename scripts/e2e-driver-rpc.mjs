// Multi-Order Dispatch: standalone worker for e2e specs that need a
// driver-side self-service RPC (pause_dispatch/resume_dispatch) with no
// corresponding UI control yet (only the combined shift start/end toggle
// is exposed in the Driver page today). Spawned as a child process for
// the same reason as scripts/e2e-force-free-driver.mjs: importing
// @supabase/supabase-js directly inside a Playwright-transpiled test file
// hits a real Node.js module-loading bug.
import { createClient } from '@supabase/supabase-js'

const identifier = process.argv[2]
const rpcName = process.argv[3]
if (!identifier || !rpcName) throw new Error('usage: node e2e-driver-rpc.mjs <email-or-phone> <rpc-name>')

const url = 'http://127.0.0.1:54321'
const anonKey = 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH'
const password = 'zaytun-local-2026'
const driver = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } })

const isEmail = identifier.includes('@')
const driverAuth = await driver.auth.signInWithPassword(
  isEmail ? { email: identifier, password } : { phone: identifier, password },
)
if (driverAuth.error) throw driverAuth.error

const result = await driver.rpc(rpcName)
if (result.error) throw result.error

process.exit(0)
