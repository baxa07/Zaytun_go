// A single shared deadline for the whole outbound-provider portion of one
// hook invocation, instead of independent per-call timeouts. Supabase's
// Send SMS Hook budget is a hard ~5s for the entire invocation (signature
// verification + our logic + every network call), so login, refresh, the
// initial send, and the one retry all race against ONE AbortController --
// whichever call is in flight when the budget expires is the one that gets
// aborted, and nothing after it can start (see hasExpired()).

export class Deadline {
  private readonly controller: AbortController;
  private readonly deadlineAt: number;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(budgetMs: number) {
    this.controller = new AbortController();
    this.deadlineAt = Date.now() + budgetMs;
    this.timer = setTimeout(() => this.controller.abort(), budgetMs);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  hasExpired(): boolean {
    return this.controller.signal.aborted || Date.now() >= this.deadlineAt;
  }

  clear(): void {
    clearTimeout(this.timer);
  }
}

// Provider-work budget, deliberately well under Supabase's ~5s hook limit --
// leaves margin for cold start, signature verification, and the return trip
// to GoTrue. Kept as a named export so tests can construct short deadlines
// instead of waiting out a near-5s window.
export const DEFAULT_PROVIDER_BUDGET_MS = 3500;
