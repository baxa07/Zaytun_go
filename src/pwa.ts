// Phase D: production update reliability. Root cause of the stale-bundle
// bug this replaces: the service worker itself (install/activate/fetch)
// was already correct -- caches only content-hashed /assets/* files
// (safe to serve cache-first forever, since a new deploy always has a new
// hash) and fetches navigations with `cache:'no-store'` (so index.html
// itself was never stale). The actual gap was entirely in THIS file: a
// new waiting worker was only ever detected via the browser's own
// infrequent background update check (no explicit `registration.update()`
// anywhere), and even once detected, activation was 100% manual --
// nothing ever happened unless a human noticed and clicked the banner. An
// already-open, unattended Restaurant/Driver tab could sit on an old
// bundle indefinitely.
const UPDATE_EVENT = 'zaytun-go:update-ready'

// Test seam only: overridable via window.__zaytunPwaTestConfig so e2e
// tests can exercise the real registration/activation/reload path
// deterministically (no 15s real sleep) rather than only unit-testing an
// extracted function. Absent in normal operation, so production timing
// is exactly the values below.
function testConfig(): { autoActivateDelayMs?: number; mutationRecheckMs?: number; periodicCheckMs?: number } {
  return (window as unknown as { __zaytunPwaTestConfig?: Record<string, number> }).__zaytunPwaTestConfig || {}
}
const AUTO_ACTIVATE_DELAY_MS = () => testConfig().autoActivateDelayMs ?? 15000
const MUTATION_RECHECK_MS = () => testConfig().mutationRecheckMs ?? 3000
const PERIODIC_CHECK_MS = () => testConfig().periodicCheckMs ?? 5 * 60 * 1000

let waitingWorker: ServiceWorker | null = null
let updateRequested = false
let hasReloaded = false
let autoActivateTimer: number | null = null

// Set by AppProvider (state.tsx) whenever any operational mutation
// (accept order, ready, pickup, delivered, accept/decline assignment,
// etc. -- anything going through withOrderLock) is in flight. Kept as a
// plain module-level counter rather than a React dependency so this file
// stays framework-agnostic and independently testable.
let pendingMutationCount = 0
export const setPendingMutationCount = (n: number): void => {
  pendingMutationCount = n
}
const hasPendingMutation = () => pendingMutationCount > 0

export const requestApplicationUpdate = (): void => {
  if (!waitingWorker) return
  updateRequested = true
  waitingWorker.postMessage({ type: 'SKIP_WAITING' })
}

// Auto-activation: an explicit click on the banner always wins immediately
// (requestApplicationUpdate above). If nobody clicks it, this converges
// the tab on its own after a grace period -- long enough that a worker
// mid-task sees the banner and can choose to finish first, short enough
// that an unattended tab (the actual production failure mode) doesn't
// stay stale for hours. Never fires while a mutation is genuinely in
// flight -- reschedules itself instead.
function scheduleAutoActivate(): void {
  if (autoActivateTimer !== null) return
  const attempt = () => {
    autoActivateTimer = null
    if (updateRequested) return // already manually triggered -- nothing left to schedule
    if (hasPendingMutation()) {
      autoActivateTimer = window.setTimeout(attempt, MUTATION_RECHECK_MS())
      return
    }
    requestApplicationUpdate()
  }
  autoActivateTimer = window.setTimeout(attempt, AUTO_ACTIVATE_DELAY_MS())
}

export function registerProductionServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .then((registration) => {
        const announce = () => {
          if (registration.waiting) {
            waitingWorker = registration.waiting
            window.dispatchEvent(new Event(UPDATE_EVENT))
            scheduleAutoActivate()
          }
        }
        announce()
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          installing?.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) announce()
          })
        })

        // The browser's own background update check is infrequent and not
        // tied to what the staff/driver is actually doing -- explicitly
        // re-check at the moments a stale bundle would actually matter:
        // right away, whenever the tab becomes visible again (staff
        // switching back to it), whenever the network comes back after a
        // drop, and periodically for as long as an operational screen is
        // left open in the background.
        const checkForUpdate = () => void registration.update().catch(() => {})
        checkForUpdate()
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') checkForUpdate()
        })
        window.addEventListener('online', checkForUpdate)
        window.setInterval(checkForUpdate, PERIODIC_CHECK_MS())

        // Reload-loop guard + mutation guard live here, not just at the
        // SKIP_WAITING call site: the new worker can take control (firing
        // this event) slightly after SKIP_WAITING was posted, and a
        // mutation could start in that small window. hasReloaded ensures
        // at most one reload per page lifetime; a fresh page load after
        // that reload resets it naturally (new module instance).
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (!updateRequested || hasReloaded) return
          const tryReload = () => {
            if (hasPendingMutation()) {
              window.setTimeout(tryReload, MUTATION_RECHECK_MS())
              return
            }
            hasReloaded = true
            window.location.reload()
          }
          tryReload()
        })
      })
      .catch(() => window.dispatchEvent(new CustomEvent('zaytun-go:service-worker-error')))
  })
}
export async function clearDevelopmentServiceWorkers(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  const registrations = await navigator.serviceWorker.getRegistrations()
  await Promise.all(registrations.map((registration) => registration.unregister()))
  for (const key of await caches.keys()) if (key.startsWith('zaytun-go-')) await caches.delete(key)
}
// Test-only surface: exposes the real module-level state this file's own
// controllerchange/auto-activate logic consumes, so e2e tests can drive
// deterministic scenarios (mutation in flight, timing overrides) against
// the ACTUAL registration/update/reload path instead of a reimplemented
// copy of it. Plain function references only -- no secrets, harmless in
// production, and not used by any application code path.
;(window as unknown as { __zaytunPwaTest?: unknown }).__zaytunPwaTest = {
  setPendingMutationCount,
  hasReloaded: () => hasReloaded,
  updateRequested: () => updateRequested,
}
export { UPDATE_EVENT }
