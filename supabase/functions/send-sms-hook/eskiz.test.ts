import { assertEquals, assertExists } from "jsr:@std/assert@1";
import { Deadline } from "./deadline.ts";
import { EskizClient, loadEskizConfigFromEnv } from "./eskiz.ts";

const CONFIG = { email: "fake@example.test", password: "fake-password", sender: "TESTSENDER", baseUrl: "https://fake-eskiz.test" };

type FakeCall = { url: string; method: string; auth: string | null };

// A scriptable fake fetch: each call to `send-sms-hook`'s underlying
// EskizClient records the request and is answered by the next queued
// responder for that path -- no real network access, ever.
function fakeFetch(script: Record<string, Array<(call: FakeCall) => Response>>) {
  const calls: FakeCall[] = [];
  const cursors: Record<string, number> = {};
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url).pathname;
    const call: FakeCall = { url, method: init?.method ?? "GET", auth: (init?.headers as Record<string, string> | undefined)?.["Authorization"] ?? null };
    calls.push(call);
    const responders = script[path];
    if (!responders) throw new Error(`fakeFetch: no script for path ${path}`);
    const i = cursors[path] ?? 0;
    cursors[path] = i + 1;
    const responder = responders[Math.min(i, responders.length - 1)];
    return responder(call);
  };
  return { fetch: impl as typeof fetch, calls };
}

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.test("loadEskizConfigFromEnv: fails closed when any field is missing (sender absent)", () => {
  const env = new Map([["ESKIZ_EMAIL", "a@b.test"], ["ESKIZ_PASSWORD", "pw"]]);
  const config = loadEskizConfigFromEnv({ get: (k) => env.get(k) });
  assertEquals(config, null);
});

Deno.test("loadEskizConfigFromEnv: never defaults sender to 4546 -- requires it explicitly", () => {
  const env = new Map([["ESKIZ_EMAIL", "a@b.test"], ["ESKIZ_PASSWORD", "pw"], ["ESKIZ_SENDER", ""]]);
  const config = loadEskizConfigFromEnv({ get: (k) => env.get(k) });
  assertEquals(config, null);
});

Deno.test("loadEskizConfigFromEnv: succeeds when all fields present", () => {
  const env = new Map([["ESKIZ_EMAIL", "a@b.test"], ["ESKIZ_PASSWORD", "pw"], ["ESKIZ_SENDER", "ZAYTUN"]]);
  const config = loadEskizConfigFromEnv({ get: (k) => env.get(k) });
  assertExists(config);
  assertEquals(config!.sender, "ZAYTUN");
});

Deno.test("sendSms: cold cache logs in once, then sends -- accepted", async () => {
  const { fetch, calls } = fakeFetch({
    "/api/auth/login": [() => jsonRes(200, { data: { token: "tok-1" } })],
    "/api/message/sms/send": [() => jsonRes(200, { id: "msg-1", status: "waiting" })],
  });
  const client = new EskizClient(CONFIG, fetch);
  const outcome = await client.sendSms("998901234567", "ZAYTUN GO ilovasi uchun kirish kodi: 123456", new Deadline(2000));
  assertEquals(outcome, { ok: true });
  assertEquals(calls.map((c) => c.url.replace(CONFIG.baseUrl, "")), ["/api/auth/login", "/api/message/sms/send"]);
});

Deno.test("sendSms: login failure surfaces as auth_failed, no send attempted", async () => {
  const { fetch, calls } = fakeFetch({
    "/api/auth/login": [() => jsonRes(401, { message: "invalid credentials" })],
  });
  const client = new EskizClient(CONFIG, fetch);
  const outcome = await client.sendSms("998901234567", "msg", new Deadline(2000));
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.kind, "auth_failed");
  assertEquals(calls.length, 1);
});

Deno.test("sendSms: warm invocation reuses the cached token -- no second login", async () => {
  const { fetch, calls } = fakeFetch({
    "/api/auth/login": [() => jsonRes(200, { data: { token: "tok-1" } })],
    "/api/message/sms/send": [() => jsonRes(200, { id: "msg-1", status: "waiting" }), () => jsonRes(200, { id: "msg-2", status: "waiting" })],
  });
  const client = new EskizClient(CONFIG, fetch);
  const first = await client.sendSms("998901234567", "msg", new Deadline(2000));
  const second = await client.sendSms("998901234568", "msg", new Deadline(2000));
  assertEquals(first, { ok: true });
  assertEquals(second, { ok: true });
  const loginCalls = calls.filter((c) => c.url.includes("/api/auth/login"));
  assertEquals(loginCalls.length, 1, "expected exactly one login across two warm sends");
});

Deno.test("sendSms: initial 401 -> refresh -> retry send succeeds", async () => {
  const { fetch, calls } = fakeFetch({
    "/api/auth/login": [() => jsonRes(200, { data: { token: "tok-1" } })],
    "/api/message/sms/send": [() => jsonRes(401, { message: "expired" }), () => jsonRes(200, { id: "msg-1", status: "waiting" })],
    "/api/auth/refresh": [() => jsonRes(200, { data: { token: "tok-2" } })],
  });
  const client = new EskizClient(CONFIG, fetch);
  const outcome = await client.sendSms("998901234567", "msg", new Deadline(2000));
  assertEquals(outcome, { ok: true });
  const sendCalls = calls.filter((c) => c.url.includes("/api/message/sms/send"));
  assertEquals(sendCalls.length, 2);
  assertEquals(sendCalls[0].auth, "Bearer tok-1");
  assertEquals(sendCalls[1].auth, "Bearer tok-2");
  const refreshCalls = calls.filter((c) => c.url.includes("/api/auth/refresh"));
  assertEquals(refreshCalls.length, 1);
});

Deno.test("sendSms: refresh failure falls back to a single login, then retries send once", async () => {
  const { fetch, calls } = fakeFetch({
    "/api/auth/login": [() => jsonRes(200, { data: { token: "tok-1" } }), () => jsonRes(200, { data: { token: "tok-2" } })],
    "/api/message/sms/send": [() => jsonRes(401, { message: "expired" }), () => jsonRes(200, { id: "msg-1", status: "waiting" })],
    "/api/auth/refresh": [() => jsonRes(401, { message: "refresh rejected" })],
  });
  const client = new EskizClient(CONFIG, fetch);
  const outcome = await client.sendSms("998901234567", "msg", new Deadline(2000));
  assertEquals(outcome, { ok: true });
  const loginCalls = calls.filter((c) => c.url.includes("/api/auth/login"));
  assertEquals(loginCalls.length, 2, "initial cold-cache login + fallback login after refresh failure");
  const sendCalls = calls.filter((c) => c.url.includes("/api/message/sms/send"));
  assertEquals(sendCalls.length, 2, "retry limited to exactly once");
});

Deno.test("sendSms: retry never happens twice -- a second 401 after refresh is a terminal auth_failed, not a loop", async () => {
  const { fetch, calls } = fakeFetch({
    "/api/auth/login": [() => jsonRes(200, { data: { token: "tok-1" } })],
    "/api/message/sms/send": [() => jsonRes(401, { message: "expired" }), () => jsonRes(401, { message: "still expired" })],
    "/api/auth/refresh": [() => jsonRes(200, { data: { token: "tok-2" } })],
  });
  const client = new EskizClient(CONFIG, fetch);
  const outcome = await client.sendSms("998901234567", "msg", new Deadline(2000));
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.kind, "auth_failed");
  const sendCalls = calls.filter((c) => c.url.includes("/api/message/sms/send"));
  assertEquals(sendCalls.length, 2, "exactly one retry, never a third attempt");
});

Deno.test("sendSms: provider 429 classified as rate_limited", async () => {
  const { fetch } = fakeFetch({
    "/api/auth/login": [() => jsonRes(200, { data: { token: "tok-1" } })],
    "/api/message/sms/send": [() => jsonRes(429, { message: "too many requests" })],
  });
  const client = new EskizClient(CONFIG, fetch);
  const outcome = await client.sendSms("998901234567", "msg", new Deadline(2000));
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.kind, "rate_limited");
});

Deno.test("sendSms: provider 500/503 classified as provider_error", async () => {
  const { fetch } = fakeFetch({
    "/api/auth/login": [() => jsonRes(200, { data: { token: "tok-1" } })],
    "/api/message/sms/send": [() => jsonRes(503, { message: "upstream unavailable" })],
  });
  const client = new EskizClient(CONFIG, fetch);
  const outcome = await client.sendSms("998901234567", "msg", new Deadline(2000));
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.kind, "provider_error");
});

Deno.test("sendSms: malformed provider response (missing id) is never treated as success", async () => {
  const { fetch } = fakeFetch({
    "/api/auth/login": [() => jsonRes(200, { data: { token: "tok-1" } })],
    "/api/message/sms/send": [() => jsonRes(200, { status: "waiting" })],
  });
  const client = new EskizClient(CONFIG, fetch);
  const outcome = await client.sendSms("998901234567", "msg", new Deadline(2000));
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.kind, "malformed_response");
});

Deno.test("sendSms: a network/deadline timeout is classified as network_timeout, not silently swallowed", async () => {
  const config = { ...CONFIG };
  const impl = (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  const client = new EskizClient(config, impl as typeof fetch);
  const outcome = await client.sendSms("998901234567", "msg", new Deadline(50));
  assertEquals(outcome.ok, false);
  if (!outcome.ok) assertEquals(outcome.kind, "network_timeout");
});
