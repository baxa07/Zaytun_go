// Eskiz.uz SMS client. Endpoints and field names are taken directly from
// Eskiz's published OpenAPI spec (github.com/iota-uz/eskiz/swagger.json,
// cross-checked against the eskiz-sms PyPI client and eskiz.uz/en/sms) --
// not guessed. Eskiz's public docs do not describe error-response bodies,
// so failure classification below is deliberately conservative: only a
// small, explicit set of outcomes is trusted, everything else collapses to
// "provider error" rather than inventing undocumented semantics.
import type { Deadline } from "./deadline.ts";

export interface EskizConfig {
  email: string;
  password: string;
  sender: string;
  baseUrl: string;
}

export type EskizSendOutcome =
  | { ok: true }
  | { ok: false; kind: "auth_failed" | "rate_limited" | "provider_error" | "network_timeout" | "malformed_response"; detail: string };

class EskizAuthFailedError extends Error {}
class EskizMalformedResponseError extends Error {}

const DEFAULT_BASE_URL = "https://notify.eskiz.uz";

export function loadEskizConfigFromEnv(env: { get(key: string): string | undefined }): EskizConfig | null {
  const email = env.get("ESKIZ_EMAIL");
  const password = env.get("ESKIZ_PASSWORD");
  const sender = env.get("ESKIZ_SENDER");
  // Fail closed: every field is required, and the production sender is
  // never silently defaulted to Eskiz's shared "4546" test nickname --
  // whether that's acceptable for production OTP traffic is still pending
  // Eskiz's own confirmation (see docs/production-readiness.md). An
  // operator must set ESKIZ_SENDER explicitly, for any environment.
  if (!email || !password || !sender) return null;
  const baseUrl = env.get("ESKIZ_BASE_URL") || DEFAULT_BASE_URL;
  return { email, password, sender, baseUrl };
}

export class EskizClient {
  #config: EskizConfig;
  #fetchImpl: typeof fetch;
  #cachedToken: string | null = null;
  // Single-flight: concurrent callers hitting a cold cache all await the
  // same in-flight login instead of each firing their own request against
  // Eskiz.
  #loginInFlight: Promise<string> | null = null;

  constructor(config: EskizConfig, fetchImpl: typeof fetch = fetch) {
    this.#config = config;
    this.#fetchImpl = fetchImpl;
  }

  #login(signal: AbortSignal): Promise<string> {
    if (this.#loginInFlight) return this.#loginInFlight;
    const attempt = this.#doLogin(signal).finally(() => {
      if (this.#loginInFlight === attempt) this.#loginInFlight = null;
    });
    this.#loginInFlight = attempt;
    return attempt;
  }

  async #doLogin(signal: AbortSignal): Promise<string> {
    const body = new URLSearchParams({ email: this.#config.email, password: this.#config.password });
    const res = await this.#fetchImpl(`${this.#config.baseUrl}/api/auth/login`, { method: "POST", body, signal });
    if (!res.ok) throw new EskizAuthFailedError(`Eskiz login rejected: ${res.status}`);
    const json = await res.json().catch(() => null) as { data?: { token?: unknown } } | null;
    const token = json?.data?.token;
    if (typeof token !== "string" || token.length === 0) {
      throw new EskizMalformedResponseError("Eskiz login response missing data.token");
    }
    this.#cachedToken = token;
    return token;
  }

  async #refresh(currentToken: string, signal: AbortSignal): Promise<string> {
    const res = await this.#fetchImpl(`${this.#config.baseUrl}/api/auth/refresh`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${currentToken}` },
      signal,
    });
    if (!res.ok) throw new EskizAuthFailedError(`Eskiz refresh rejected: ${res.status}`);
    const json = await res.json().catch(() => null) as { data?: { token?: unknown } } | null;
    const token = json?.data?.token;
    if (typeof token !== "string" || token.length === 0) {
      throw new EskizMalformedResponseError("Eskiz refresh response missing data.token");
    }
    this.#cachedToken = token;
    return token;
  }

  async #attemptSend(token: string, destination: string, message: string, signal: AbortSignal): Promise<Response> {
    const body = new URLSearchParams({
      mobile_phone: destination,
      message,
      from: this.#config.sender,
    });
    return this.#fetchImpl(`${this.#config.baseUrl}/api/message/sms/send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body,
      signal,
    });
  }

  // Token expiry is treated as opaque (Eskiz does not publish a duration):
  // reuse the cached token on a warm invocation; on a 401 from send, refresh
  // once; if refresh itself fails, log in once; then retry the send exactly
  // once with whatever token that produced. Never a third send attempt, and
  // never a second refresh/login round -- bounded, non-recursive, so a
  // persistently misbehaving account fails fast within the shared deadline
  // instead of looping.
  async sendSms(destination: string, message: string, deadline: Deadline): Promise<EskizSendOutcome> {
    try {
      let token = this.#cachedToken ?? (await this.#login(deadline.signal));
      let response = await this.#attemptSend(token, destination, message, deadline.signal);

      if (response.status === 401) {
        try {
          token = await this.#refresh(token, deadline.signal);
        } catch {
          this.#cachedToken = null;
          token = await this.#login(deadline.signal);
        }
        response = await this.#attemptSend(token, destination, message, deadline.signal);
      }

      return this.#classify(response);
    } catch (error) {
      if (error instanceof EskizAuthFailedError) {
        return { ok: false, kind: "auth_failed", detail: error.message };
      }
      if (error instanceof EskizMalformedResponseError) {
        return { ok: false, kind: "malformed_response", detail: error.message };
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        return { ok: false, kind: "network_timeout", detail: "Eskiz call exceeded the shared deadline" };
      }
      return { ok: false, kind: "provider_error", detail: error instanceof Error ? error.message : "unknown network error" };
    }
  }

  async #classify(response: Response): Promise<EskizSendOutcome> {
    if (response.status === 429) {
      return { ok: false, kind: "rate_limited", detail: "Eskiz rate limit (429)" };
    }
    if (response.status === 401 || response.status === 403) {
      // Second attempt still unauthorized after a refresh+login cycle --
      // treat as an auth failure, not a transient issue worth GoTrue
      // retrying the whole hook.
      return { ok: false, kind: "auth_failed", detail: `Eskiz send unauthorized: ${response.status}` };
    }
    if (!response.ok) {
      return { ok: false, kind: "provider_error", detail: `Eskiz send failed: ${response.status}` };
    }
    const json = await response.json().catch(() => null) as { id?: unknown; status?: unknown } | null;
    // Eskiz's public docs don't enumerate the possible values of `status`
    // beyond success; only a response we can positively identify as
    // carrying a message id is trusted as accepted -- anything else
    // (missing id, unexpected shape) is malformed, not guessed as success.
    if (!json || typeof json.id !== "string" || json.id.length === 0) {
      return { ok: false, kind: "malformed_response", detail: "Eskiz send response missing id" };
    }
    return { ok: true };
  }
}
