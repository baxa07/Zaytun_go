// Supabase Auth "Send SMS Hook" endpoint. Supabase Auth remains the sole
// generator/verifier of the OTP itself (signInWithOtp / verifyOtp on the
// frontend are unchanged) -- this function is transport only: it receives
// the hook payload, proves it genuinely came from this project's Auth
// service, and relays the OTP to Eskiz.
//
// Contract sourced from supabase.com/docs/guides/auth/auth-hooks/send-sms-hook
// and .../auth-hooks (Standard Webhooks signing, 5s execution budget,
// {user:{phone}, sms:{otp}} payload, {} + 200 on success,
// {error:{http_code,message}} on failure).
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";
import { Deadline, DEFAULT_PROVIDER_BUDGET_MS } from "./deadline.ts";
import { EskizClient, loadEskizConfigFromEnv } from "./eskiz.ts";
import { formatOtpMessage, isValidHookOtp, normalizeEskizDestination } from "./message.ts";

interface VerifiedHookPayload {
  user: { phone?: unknown };
  sms: { otp?: unknown };
}

// Injected so tests can run the exact same request-handling logic against a
// fake verifier and a fake Eskiz transport -- no real network access, no
// real webhook secret, ever, in tests.
export interface HandlerDeps {
  env: { get(key: string): string | undefined };
  verifyWebhook: (payloadText: string, headers: Record<string, string>, base64Secret: string) => VerifiedHookPayload;
  eskizFetch?: typeof fetch;
  providerBudgetMs?: number;
}

function hookSuccess(): Response {
  return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
}

// Never includes the raw Eskiz response, the OTP, or any credential in the
// message returned to the browser -- only a fixed, safe description per
// failure category.
function hookError(httpCode: number, message: string): Response {
  return new Response(JSON.stringify({ error: { http_code: httpCode, message } }), {
    status: httpCode,
    headers: { "Content-Type": "application/json" },
  });
}

// Deliberately the ONLY logging in this module, and deliberately minimal:
// no OTP, no phone number, no payload, no credential, no token, no webhook
// secret -- just enough to see pass/fail volume and failure category.
function logOutcome(outcome: "sent" | "rejected_method" | "rejected_signature" | "rejected_payload" | "rejected_config" | string): void {
  console.log(JSON.stringify({ event: "send_sms_hook", outcome }));
}

export async function handleSendSmsHook(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method !== "POST") {
    logOutcome("rejected_method");
    return hookError(405, "Method not allowed");
  }

  // Signature verification FIRST, before any payload parsing is trusted or
  // any provider work begins. A missing hook secret means verification is
  // impossible, so it fails the same way an invalid signature would --
  // never falls through to processing an unverified payload.
  const hookSecretRaw = deps.env.get("SEND_SMS_HOOK_SECRETS");
  const payloadText = await req.text();
  const headers = Object.fromEntries(req.headers);

  if (!hookSecretRaw) {
    logOutcome("rejected_config");
    return hookError(500, "Server misconfigured: missing hook secret");
  }

  let verified: VerifiedHookPayload;
  try {
    const base64Secret = hookSecretRaw.replace("v1,whsec_", "");
    verified = deps.verifyWebhook(payloadText, headers, base64Secret);
  } catch {
    logOutcome("rejected_signature");
    return hookError(401, "Invalid webhook signature");
  }

  const user = verified?.user;
  const sms = verified?.sms;
  if (!user || typeof user !== "object" || !sms || typeof sms !== "object") {
    logOutcome("rejected_payload");
    return hookError(400, "Malformed hook payload");
  }

  if (!isValidHookOtp(sms.otp)) {
    logOutcome("rejected_payload");
    return hookError(400, "Malformed hook payload: sms.otp");
  }

  const destination = normalizeEskizDestination(user.phone);
  if (!destination) {
    logOutcome("rejected_payload");
    return hookError(400, "Destination is not a canonical Uzbek phone number");
  }

  const config = loadEskizConfigFromEnv(deps.env);
  if (!config) {
    logOutcome("rejected_config");
    return hookError(500, "Server misconfigured: missing Eskiz configuration");
  }

  const message = formatOtpMessage(sms.otp);
  const client = new EskizClient(config, deps.eskizFetch ?? fetch);
  const deadline = new Deadline(deps.providerBudgetMs ?? DEFAULT_PROVIDER_BUDGET_MS);
  try {
    const outcome = await client.sendSms(destination, message, deadline);
    if (outcome.ok) {
      logOutcome("sent");
      return hookSuccess();
    }
    logOutcome(outcome.kind);
    // GoTrue only auto-retries the whole hook invocation on 429/503 (per
    // Supabase's documented hook retry behavior) -- so 429/503 are reserved
    // for outcomes where retrying might actually help (rate limit, a
    // timeout, or Eskiz itself erroring transiently), while 502 is used for
    // outcomes a bare retry can't fix (bad credentials, or Eskiz returning
    // something we can't parse as success).
    switch (outcome.kind) {
      case "rate_limited":
        return hookError(429, "SMS provider rate limit reached");
      case "network_timeout":
        return hookError(503, "SMS provider timed out");
      case "auth_failed":
        return hookError(502, "SMS provider authentication failed");
      case "malformed_response":
        return hookError(502, "SMS provider returned an unexpected response");
      default:
        return hookError(503, "SMS provider temporarily unavailable");
    }
  } finally {
    deadline.clear();
  }
}

// Real entrypoint -- only wired up when this function actually runs under
// the Edge Runtime (Deno.serve), never during `deno test`.
if (import.meta.main) {
  Deno.serve((req) =>
    handleSendSmsHook(req, {
      env: Deno.env,
      verifyWebhook: (payloadText, headers, base64Secret) => {
        const wh = new Webhook(base64Secret);
        return wh.verify(payloadText, headers) as VerifiedHookPayload;
      },
    }),
  );
}
