import { assertEquals } from "jsr:@std/assert@1";
import { handleTelegramNotify, type HandlerDeps } from "./index.ts";
import type { TelegramClient } from "./telegram.ts";
import type { NotificationData } from "./message.ts";

const SECRET = "fake-notify-secret-never-real";
const VALID_ENV = new Map([["TELEGRAM_NOTIFY_SECRET", SECRET]]);
const envFrom = (map: Map<string, string>) => ({ get: (k: string) => map.get(k) });

const sampleData: NotificationData = {
  chatId: -100999,
  orderNumber: "ZG-1051",
  orderType: "DELIVERY",
  total: 260000,
  paymentMethod: "CLICK",
  customerName: "Bahrom",
};

function fakeTelegram() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client: TelegramClient = {
    sendMessage: async (...args) => {
      calls.push({ method: "sendMessage", args });
    },
  };
  return { client, calls };
}

function baseDeps(overrides: Partial<HandlerDeps> = {}): { deps: HandlerDeps; sentIds: string[]; failedIds: Array<{ id: string; error: string }> } {
  const sentIds: string[] = [];
  const failedIds: Array<{ id: string; error: string }> = [];
  const { client } = fakeTelegram();
  return {
    deps: {
      env: envFrom(VALID_ENV),
      telegram: client,
      fetchNotification: async () => sampleData,
      markSent: async (id) => { sentIds.push(id); },
      markFailed: async (id, error) => { failedIds.push({ id, error }); },
      ...overrides,
    },
    sentIds,
    failedIds,
  };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://example.test/functions/v1/zaytun-telegram-notify", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, ...headers },
    body: JSON.stringify(body),
  });

Deno.test("valid request -> sends the formatted message and marks the outbox row SENT", async () => {
  const { deps, sentIds } = baseDeps();
  const res = await handleTelegramNotify(post({ outboxId: "outbox-1" }), deps);
  assertEquals(res.status, 200);
  assertEquals(sentIds, ["outbox-1"]);
});

Deno.test("missing Authorization -> 401, nothing sent", async () => {
  const { client, calls } = fakeTelegram();
  const deps: HandlerDeps = { env: envFrom(VALID_ENV), telegram: client, fetchNotification: async () => sampleData, markSent: async () => {}, markFailed: async () => {} };
  const req = new Request("https://example.test/x", { method: "POST", body: JSON.stringify({ outboxId: "x" }) });
  const res = await handleTelegramNotify(req, deps);
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("wrong Authorization -> 401, nothing sent", async () => {
  const { deps, sentIds } = baseDeps();
  const res = await handleTelegramNotify(post({ outboxId: "outbox-1" }, { Authorization: "Bearer wrong" }), deps);
  assertEquals(res.status, 401);
  assertEquals(sentIds, []);
});

Deno.test("missing TELEGRAM_NOTIFY_SECRET config -> 500", async () => {
  const { client } = fakeTelegram();
  const deps: HandlerDeps = { env: envFrom(new Map()), telegram: client, fetchNotification: async () => sampleData, markSent: async () => {}, markFailed: async () => {} };
  const res = await handleTelegramNotify(post({ outboxId: "x" }), deps);
  assertEquals(res.status, 500);
});

Deno.test("missing bot token (telegram client null) -> 500", async () => {
  const deps: HandlerDeps = { env: envFrom(VALID_ENV), telegram: null, fetchNotification: async () => sampleData, markSent: async () => {}, markFailed: async () => {} };
  const res = await handleTelegramNotify(post({ outboxId: "x" }), deps);
  assertEquals(res.status, 500);
});

Deno.test("nothing to send (already sent / row gone) -> 200, no Telegram call, no bookkeeping write", async () => {
  const { deps, sentIds, failedIds } = baseDeps({ fetchNotification: async () => null });
  const res = await handleTelegramNotify(post({ outboxId: "already-sent" }), deps);
  assertEquals(res.status, 200);
  assertEquals(sentIds, []);
  assertEquals(failedIds, []);
});

Deno.test("Telegram API failure -> still 200 (never retry-storm the caller), outbox marked FAILED", async () => {
  const failingTelegram: TelegramClient = {
    sendMessage: async () => {
      throw new Error("simulated Telegram outage");
    },
  };
  const { deps, failedIds } = baseDeps({ telegram: failingTelegram });
  const res = await handleTelegramNotify(post({ outboxId: "outbox-2" }), deps);
  assertEquals(res.status, 200);
  assertEquals(failedIds.length, 1);
  assertEquals(failedIds[0].id, "outbox-2");
});

Deno.test("missing outboxId -> 400", async () => {
  const { deps } = baseDeps();
  const res = await handleTelegramNotify(post({}), deps);
  assertEquals(res.status, 400);
});

Deno.test("malformed JSON -> 400, no crash", async () => {
  const { deps } = baseDeps();
  const req = new Request("https://example.test/x", {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}` },
    body: "{not json",
  });
  const res = await handleTelegramNotify(req, deps);
  assertEquals(res.status, 400);
});

Deno.test("GET method -> 405", async () => {
  const { deps } = baseDeps();
  const res = await handleTelegramNotify(new Request("https://example.test/x", { method: "GET" }), deps);
  assertEquals(res.status, 405);
});
