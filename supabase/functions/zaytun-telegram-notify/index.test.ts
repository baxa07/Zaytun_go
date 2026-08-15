import { assertEquals } from "jsr:@std/assert@1";
import { handleTelegramNotify, type HandlerDeps } from "./index.ts";
import type { TelegramClient } from "./telegram.ts";
import type { ArrivalNotificationData, AssignmentNotificationData, NotificationData } from "./message.ts";

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
  customerPhone: "+998901234567",
  addressSummary: "Guliston tumani, Test ko‘chasi, 24B",
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
      fetchNotification: async () => ({ channel: "TELEGRAM_RESTAURANT_NEW_ORDER", data: sampleData }),
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
  const deps: HandlerDeps = { env: envFrom(VALID_ENV), telegram: client, fetchNotification: async () => ({ channel: "TELEGRAM_RESTAURANT_NEW_ORDER", data: sampleData }), markSent: async () => {}, markFailed: async () => {} };
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
  const deps: HandlerDeps = { env: envFrom(new Map()), telegram: client, fetchNotification: async () => ({ channel: "TELEGRAM_RESTAURANT_NEW_ORDER", data: sampleData }), markSent: async () => {}, markFailed: async () => {} };
  const res = await handleTelegramNotify(post({ outboxId: "x" }), deps);
  assertEquals(res.status, 500);
});

Deno.test("missing bot token (telegram client null) -> 500", async () => {
  const deps: HandlerDeps = { env: envFrom(VALID_ENV), telegram: null, fetchNotification: async () => ({ channel: "TELEGRAM_RESTAURANT_NEW_ORDER", data: sampleData }), markSent: async () => {}, markFailed: async () => {} };
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

const sampleArrival: ArrivalNotificationData = {
  chatId: 555111,
  orderNumber: "ZG-1088",
  orderId: "9a000000-0000-4000-8000-000000000001",
  trackingToken: "9b000000-0000-4000-8000-000000000002",
};

Deno.test("TELEGRAM_CUSTOMER_ARRIVED channel -> sends the arrival message with a tracking link, marks SENT", async () => {
  const { deps, sentIds } = baseDeps({
    fetchNotification: async () => ({ channel: "TELEGRAM_CUSTOMER_ARRIVED", data: sampleArrival }),
  });
  const res = await handleTelegramNotify(post({ outboxId: "outbox-arrival-1" }), deps);
  assertEquals(res.status, 200);
  assertEquals(sentIds, ["outbox-arrival-1"]);
});

Deno.test("TELEGRAM_CUSTOMER_ARRIVED message -> uses the order's own chat id, order number, and a tracking link carrying the token, never an internal-only id alone", async () => {
  const { client, calls } = fakeTelegram();
  const deps: HandlerDeps = {
    env: envFrom(VALID_ENV),
    telegram: client,
    fetchNotification: async () => ({ channel: "TELEGRAM_CUSTOMER_ARRIVED", data: sampleArrival }),
    markSent: async () => {},
    markFailed: async () => {},
  };
  await handleTelegramNotify(post({ outboxId: "outbox-arrival-2" }), deps);
  assertEquals(calls.length, 1);
  const [chatId, text, replyMarkup] = calls[0].args as [number, string, { inline_keyboard: Array<Array<{ url: string }>> }];
  assertEquals(chatId, 555111);
  assertEquals(text.includes("kuryer yetib keldi"), true);
  assertEquals(text.includes("ZG-1088"), true);
  const url = replyMarkup.inline_keyboard[0][0].url;
  assertEquals(url.includes(sampleArrival.orderId), true);
  assertEquals(url.includes(sampleArrival.trackingToken), true);
});

const sampleAssignment: AssignmentNotificationData = {
  chatId: 777222,
  orderNumber: "ZG-1073",
  branchName: "Zaytun Kafe",
  distanceKm: 2.1,
};

Deno.test("TELEGRAM_DRIVER_NEW_ASSIGNMENT channel -> sends the assignment message to the assigned driver's own chat id, marks SENT", async () => {
  const { client, calls } = fakeTelegram();
  const sentIds: string[] = [];
  const deps: HandlerDeps = {
    env: envFrom(VALID_ENV),
    telegram: client,
    fetchNotification: async () => ({ channel: "TELEGRAM_DRIVER_NEW_ASSIGNMENT", data: sampleAssignment }),
    markSent: async (id) => { sentIds.push(id); },
    markFailed: async () => {},
  };
  const res = await handleTelegramNotify(post({ outboxId: "outbox-assignment-1" }), deps);
  assertEquals(res.status, 200);
  assertEquals(sentIds, ["outbox-assignment-1"]);
  assertEquals(calls.length, 1);
  const [chatId, text] = calls[0].args as [number, string];
  assertEquals(chatId, 777222);
  assertEquals(text.includes("ZG-1073"), true);
  assertEquals(text.includes("Zaytun Kafe"), true);
});

Deno.test("TELEGRAM_DRIVER_NEW_ASSIGNMENT, no chat id found (unconfigured mapping) -> fetchNotification returns null -> 200, no Telegram call, assignment itself is never affected", async () => {
  const { deps, sentIds, failedIds } = baseDeps({ fetchNotification: async () => null });
  const res = await handleTelegramNotify(post({ outboxId: "outbox-assignment-unconfigured" }), deps);
  assertEquals(res.status, 200);
  assertEquals(sentIds, []);
  assertEquals(failedIds, []);
});
