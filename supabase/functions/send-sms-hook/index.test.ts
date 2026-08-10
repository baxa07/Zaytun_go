import { assertEquals, assertMatch } from "jsr:@std/assert@1";
import { handleSendSmsHook, type HandlerDeps } from "./index.ts";

const OTP = "654321";
const HOOK_SECRET = "v1,whsec_ZmFrZS10ZXN0LXNlY3JldC1uZXZlci1yZWFs"; // fake, never a real secret
const VALID_ENV = new Map([
  ["SEND_SMS_HOOK_SECRETS", HOOK_SECRET],
  ["ESKIZ_EMAIL", "fake@example.test"],
  ["ESKIZ_PASSWORD", "fake-password-never-real"],
  ["ESKIZ_SENDER", "TESTSENDER"],
]);

function envFrom(map: Map<string, string>) {
  return { get: (k: string) => map.get(k) };
}

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function acceptingEskizFetch(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url.includes("/api/auth/login")) return jsonRes(200, { data: { token: "tok-1" } });
    if (url.includes("/api/message/sms/send")) return jsonRes(200, { id: "msg-1", status: "waiting" });
    throw new Error(`unexpected fake call: ${url}`);
  }) as typeof fetch;
}

function throwingEskizFetch(calls: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    calls.push(typeof input === "string" ? input : input.toString());
    throw new Error("this must never be called");
  }) as typeof fetch;
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://example.test/functions/v1/send-sms-hook", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

Deno.test("valid signed hook -> accepted SMS -> 200 {}", async () => {
  const calls: string[] = [];
  const deps: HandlerDeps = {
    env: envFrom(VALID_ENV),
    verifyWebhook: () => ({ user: { phone: "998901234567" }, sms: { otp: OTP } }),
    eskizFetch: acceptingEskizFetch(calls),
  };
  const res = await handleSendSmsHook(post({}), deps);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {});
  assertEquals(calls.length, 2, "expected one login + one send");
});

Deno.test("invalid webhook signature -> zero Eskiz calls", async () => {
  const calls: string[] = [];
  const deps: HandlerDeps = {
    env: envFrom(VALID_ENV),
    verifyWebhook: () => {
      throw new Error("bad signature");
    },
    eskizFetch: throwingEskizFetch(calls),
  };
  const res = await handleSendSmsHook(post({}), deps);
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("missing webhook-signature header -> rejected before any Eskiz call (same fail-closed path as an invalid signature)", async () => {
  const calls: string[] = [];
  const deps: HandlerDeps = {
    env: envFrom(VALID_ENV),
    // The real Deno.serve entrypoint delegates entirely to
    // standardwebhooks' wh.verify(), which throws for a request with no
    // webhook-signature/webhook-id/webhook-timestamp headers at all --
    // this fake reproduces exactly that: no headers means verification
    // cannot succeed, so it must throw just like a forged signature does.
    verifyWebhook: (_payload, headers) => {
      if (!headers["webhook-signature"]) throw new Error("missing webhook-signature header");
      return { user: { phone: "998901234567" }, sms: { otp: OTP } };
    },
    eskizFetch: throwingEskizFetch(calls),
  };
  const res = await handleSendSmsHook(post({}, {}), deps);
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("missing SEND_SMS_HOOK_SECRETS -> zero Eskiz calls, no verify attempted", async () => {
  const calls: string[] = [];
  let verifyCalled = false;
  const env = new Map(VALID_ENV);
  env.delete("SEND_SMS_HOOK_SECRETS");
  const deps: HandlerDeps = {
    env: envFrom(env),
    verifyWebhook: () => {
      verifyCalled = true;
      return { user: { phone: "998901234567" }, sms: { otp: OTP } };
    },
    eskizFetch: throwingEskizFetch(calls),
  };
  const res = await handleSendSmsHook(post({}), deps);
  assertEquals(res.status, 500);
  assertEquals(verifyCalled, false);
  assertEquals(calls.length, 0);
});

Deno.test("malformed hook payload (missing sms) -> 400, zero Eskiz calls", async () => {
  const calls: string[] = [];
  const deps: HandlerDeps = {
    env: envFrom(VALID_ENV),
    verifyWebhook: () => ({ user: { phone: "998901234567" }, sms: {} }) as never,
    eskizFetch: throwingEskizFetch(calls),
  };
  const res = await handleSendSmsHook(post({}), deps);
  assertEquals(res.status, 400);
  assertEquals(calls.length, 0);
});

Deno.test("malformed phone (garbage) -> 400, zero Eskiz calls", async () => {
  const calls: string[] = [];
  const deps: HandlerDeps = {
    env: envFrom(VALID_ENV),
    verifyWebhook: () => ({ user: { phone: "not-a-phone" }, sms: { otp: OTP } }),
    eskizFetch: throwingEskizFetch(calls),
  };
  const res = await handleSendSmsHook(post({}), deps);
  assertEquals(res.status, 400);
  assertEquals(calls.length, 0);
});

Deno.test("non-998 phone -> 400, zero Eskiz calls", async () => {
  const calls: string[] = [];
  const deps: HandlerDeps = {
    env: envFrom(VALID_ENV),
    verifyWebhook: () => ({ user: { phone: "15551234567" }, sms: { otp: OTP } }),
    eskizFetch: throwingEskizFetch(calls),
  };
  const res = await handleSendSmsHook(post({}), deps);
  assertEquals(res.status, 400);
  assertEquals(calls.length, 0);
});

Deno.test("missing Eskiz configuration -> 500, zero Eskiz calls", async () => {
  const calls: string[] = [];
  const env = new Map(VALID_ENV);
  env.delete("ESKIZ_SENDER");
  const deps: HandlerDeps = {
    env: envFrom(env),
    verifyWebhook: () => ({ user: { phone: "998901234567" }, sms: { otp: OTP } }),
    eskizFetch: throwingEskizFetch(calls),
  };
  const res = await handleSendSmsHook(post({}), deps);
  assertEquals(res.status, 500);
  assertEquals(calls.length, 0);
});

Deno.test("non-POST method -> 405, zero Eskiz calls", async () => {
  const calls: string[] = [];
  const deps: HandlerDeps = {
    env: envFrom(VALID_ENV),
    verifyWebhook: () => ({ user: { phone: "998901234567" }, sms: { otp: OTP } }),
    eskizFetch: throwingEskizFetch(calls),
  };
  const res = await handleSendSmsHook(new Request("https://example.test/functions/v1/send-sms-hook", { method: "GET" }), deps);
  assertEquals(res.status, 405);
  assertEquals(calls.length, 0);
});

Deno.test("provider error never relays the raw Eskiz body to the caller", async () => {
  const deps: HandlerDeps = {
    env: envFrom(VALID_ENV),
    verifyWebhook: () => ({ user: { phone: "998901234567" }, sms: { otp: OTP } }),
    eskizFetch: (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/auth/login")) return jsonRes(200, { data: { token: "tok-1" } });
      return jsonRes(500, { secret_internal_detail: "some raw Eskiz diagnostic the caller must never see" });
    }) as typeof fetch,
  };
  const res = await handleSendSmsHook(post({}), deps);
  const bodyText = await res.text();
  // A generic non-auth, non-malformed 5xx from Eskiz is treated as a
  // temporary provider issue (503, retryable by GoTrue), not a permanent
  // provider_error (502, reserved for auth_failed/malformed_response).
  assertEquals(res.status, 503);
  assertEquals(bodyText.includes("secret_internal_detail"), false);
  assertEquals(bodyText.includes("some raw Eskiz diagnostic"), false);
});

Deno.test("no OTP or secrets ever appear in captured production-style logs, success path", async () => {
  const originalLog = console.log;
  const captured: string[] = [];
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    const deps: HandlerDeps = {
      env: envFrom(VALID_ENV),
      verifyWebhook: () => ({ user: { phone: "998901234567" }, sms: { otp: OTP } }),
      eskizFetch: acceptingEskizFetch([]),
    };
    await handleSendSmsHook(post({}), deps);
  } finally {
    console.log = originalLog;
  }
  const allLogs = captured.join("\n");
  assertEquals(allLogs.includes(OTP), false, "OTP must never appear in logs");
  assertEquals(allLogs.includes("fake-password-never-real"), false, "Eskiz password must never appear in logs");
  assertEquals(allLogs.includes(HOOK_SECRET), false, "webhook secret must never appear in logs");
  assertEquals(allLogs.includes("tok-1"), false, "Eskiz bearer token must never appear in logs");
  assertMatch(allLogs, /"outcome":"sent"/);
});

Deno.test("no OTP or secrets ever appear in captured production-style logs, rejected-signature path", async () => {
  const originalLog = console.log;
  const captured: string[] = [];
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    const deps: HandlerDeps = {
      env: envFrom(VALID_ENV),
      verifyWebhook: () => {
        throw new Error("bad signature");
      },
      eskizFetch: throwingEskizFetch([]),
    };
    await handleSendSmsHook(post({ sms: { otp: OTP } }, { "webhook-signature": "v1,whatever" }), deps);
  } finally {
    console.log = originalLog;
  }
  const allLogs = captured.join("\n");
  assertEquals(allLogs.includes(OTP), false);
  assertEquals(allLogs.includes(HOOK_SECRET), false);
});
