// Multi-Order Dispatch: shared e2e test-hygiene helper.
//
// Before this phase, a driver's leftover active order after a test always
// had a driver-side primary action available at every stage (accept,
// decline, or progress-to-next), so each spec's own `freeDriver` helper
// could always click its way back to a clean state. Early assignment
// introduces a state with no driver-side action at all: an ACCEPTED order
// still CONFIRMED/PREPARING (the new pre-ready card) can't be declined
// (decline is intentionally pre-acceptance-only, matching the original
// standing business rule) and has nothing to click until the restaurant
// marks it ready. If any spec ends without fully completing/cancelling an
// order it created, a later spec's driver can be left permanently stuck.
//
// Rather than auditing every spec for full completion (fragile, easy to
// regress again), this does a direct, staff-authoritative hard reset:
// spawn scripts/e2e-force-free-driver.mjs, which cancels every
// non-terminal order assigned to the driver via the same `transition_order`
// RPC scripts/test-capacity-concurrency.mjs already proves works at any
// pre-terminal status. Deliberately a spawned child process, not a direct
// `@supabase/supabase-js` import in this file -- importing it directly
// (even via a lazy dynamic import) from inside a Playwright-transpiled
// test file hits a real Node.js bug ("Unexpected module status 3") in
// @supabase/auth-js's internal module structure. Best-effort and silent
// on failure -- this is a safety net for test setup, not something a test
// should ever assert on.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileAsync = promisify(execFile);
// Absolute paths -- Playwright workers may not share this file's own
// intuitive cwd, so bare relative "scripts/..." paths aren't reliable.
const helpersDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(helpersDir, "..", "..", "scripts", "e2e-force-free-driver.mjs");
const rpcScriptPath = path.join(helpersDir, "..", "..", "scripts", "e2e-driver-rpc.mjs");

export async function forceFreeDriver(identifier: string): Promise<void> {
  try {
    await execFileAsync("node", [scriptPath, identifier], { timeout: 15000 });
  } catch {
    // Best-effort only -- the UI-driven cleanup in each spec's own
    // freeDriver is still the primary mechanism; this just unblocks the
    // one state it structurally cannot reach.
  }
}

// Driver-side pause_dispatch/resume_dispatch -- the Driver page only
// exposes a combined shift start/end toggle today, no dedicated
// pause/resume control, but these self-service RPCs are how a driver can
// stay ON_SHIFT (so knownOffDuty stays false and standby notices remain
// visible in the UI, per src/App.tsx's own knownOffDuty gate) while still
// being genuinely ineligible for new work (dispatchStatus !== 'ACTIVE').
export async function driverRpc(identifier: string, rpcName: "pause_dispatch" | "resume_dispatch"): Promise<void> {
  await execFileAsync("node", [rpcScriptPath, identifier, rpcName], { timeout: 15000 });
}
