import { assertEquals } from "jsr:@std/assert@1";
import { Deadline, DEFAULT_PROVIDER_BUDGET_MS } from "./deadline.ts";

Deno.test("Deadline: not expired and signal not aborted immediately after construction", () => {
  const deadline = new Deadline(2000);
  try {
    assertEquals(deadline.hasExpired(), false);
    assertEquals(deadline.signal.aborted, false);
  } finally {
    deadline.clear();
  }
});

Deno.test("Deadline: signal aborts and hasExpired() becomes true once the budget elapses", async () => {
  const deadline = new Deadline(30);
  const aborted = new Promise<void>((resolve) => deadline.signal.addEventListener("abort", () => resolve()));
  await aborted;
  assertEquals(deadline.hasExpired(), true);
  assertEquals(deadline.signal.aborted, true);
  deadline.clear();
});

Deno.test("Deadline: clear() prevents a late abort from firing after the caller is done", async () => {
  const deadline = new Deadline(20);
  deadline.clear();
  // If clear() didn't actually cancel the underlying timer, the abort would
  // still fire around 20ms later -- wait past that window and confirm it
  // never did.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assertEquals(deadline.signal.aborted, false);
});

Deno.test("DEFAULT_PROVIDER_BUDGET_MS leaves real margin inside Supabase's ~5s hook budget", () => {
  // Not a tautology check on the literal constant -- a regression guard: if
  // this budget ever creeps up near or past 5000ms, the margin this
  // architecture depends on (cold start + signature verification + the
  // return trip to GoTrue) silently disappears.
  assertEquals(DEFAULT_PROVIDER_BUDGET_MS <= 4000, true, "provider budget must leave meaningful margin under the ~5s hook limit");
  assertEquals(DEFAULT_PROVIDER_BUDGET_MS >= 2000, true, "provider budget must leave enough time for a real login+send round trip");
});
