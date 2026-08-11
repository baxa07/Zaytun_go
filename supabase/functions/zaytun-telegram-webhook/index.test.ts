import { assertEquals } from "jsr:@std/assert@1";
import { handleTelegramWebhook, type HandlerDeps } from "./index.ts";
import type { TelegramClient } from "./telegram.ts";

const SECRET = "fake-webhook-secret-never-real";
const VALID_ENV = new Map([["TELEGRAM_WEBHOOK_SECRET", SECRET]]);

function envFrom(map: Map<string, string>) {
  return { get: (k: string) => map.get(k) };
}

function fakeTelegram() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client: TelegramClient = {
    sendMessage: async (...args) => {
      calls.push({ method: "sendMessage", args });
    },
  };
  return { client, calls };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://example.test/functions/v1/zaytun-telegram-webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, ...headers },
    body: JSON.stringify(body),
  });

Deno.test("/start -> sends welcome text with exactly the two specified URL buttons", async () => {
  const { client, calls } = fakeTelegram();
  const deps: HandlerDeps = { env: envFrom(VALID_ENV), telegram: client };
  const res = await handleTelegramWebhook(
    post({ message: { text: "/start", chat: { id: 12345, type: "private" } } }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "sendMessage");
  const [chatId, text, replyMarkup] = calls[0].args as [number, string, { inline_keyboard: unknown[][] }];
  assertEquals(chatId, 12345);
  assertEquals(text, "Assalomu alaykum! 👋\nZaytun’ga xush kelibsiz.\nQanday yordam bera olamiz?");
  assertEquals(replyMarkup, {
    inline_keyboard: [
      [{ text: "🛍 Buyurtma berish", url: "https://zaytungonavoiy.netlify.app" }],
      [{ text: "🍽 Stol band qilish", url: "https://t.me/Zaytun_kafe_navoi" }],
    ],
  });
});

Deno.test("unrelated message -> no Telegram calls, still 200 (left as an ordinary chat for staff)", async () => {
  const { client, calls } = fakeTelegram();
  const deps: HandlerDeps = { env: envFrom(VALID_ENV), telegram: client };
  const res = await handleTelegramWebhook(
    post({ message: { text: "Salom, stol band qilmoqchiman", chat: { id: 42, type: "private" } } }),
    deps,
  );
  assertEquals(res.status, 200);
  assertEquals(calls.length, 0);
});

Deno.test("missing X-Telegram-Bot-Api-Secret-Token -> 401, zero Telegram calls", async () => {
  const { client, calls } = fakeTelegram();
  const deps: HandlerDeps = { env: envFrom(VALID_ENV), telegram: client };
  const req = new Request("https://example.test/x", {
    method: "POST",
    body: JSON.stringify({ message: { text: "/start", chat: { id: 1 } } }),
  });
  const res = await handleTelegramWebhook(req, deps);
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("wrong X-Telegram-Bot-Api-Secret-Token -> 401, zero Telegram calls", async () => {
  const { client, calls } = fakeTelegram();
  const deps: HandlerDeps = { env: envFrom(VALID_ENV), telegram: client };
  const res = await handleTelegramWebhook(
    post({ message: { text: "/start", chat: { id: 1 } } }, { "X-Telegram-Bot-Api-Secret-Token": "wrong" }),
    deps,
  );
  assertEquals(res.status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("missing TELEGRAM_WEBHOOK_SECRET config -> 500, zero Telegram calls", async () => {
  const { client, calls } = fakeTelegram();
  const deps: HandlerDeps = { env: envFrom(new Map()), telegram: client };
  const res = await handleTelegramWebhook(
    post({ message: { text: "/start", chat: { id: 1 } } }),
    deps,
  );
  assertEquals(res.status, 500);
  assertEquals(calls.length, 0);
});

Deno.test("missing bot token (telegram client null) -> 500, distinct from secret rejection", async () => {
  const deps: HandlerDeps = { env: envFrom(VALID_ENV), telegram: null };
  const res = await handleTelegramWebhook(post({ message: { text: "/start", chat: { id: 1 } } }), deps);
  assertEquals(res.status, 500);
});

Deno.test("malformed JSON body from a verified caller -> 200, no crash, no Telegram calls", async () => {
  const { client, calls } = fakeTelegram();
  const deps: HandlerDeps = { env: envFrom(VALID_ENV), telegram: client };
  const req = new Request("https://example.test/x", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET },
    body: "{not json",
  });
  const res = await handleTelegramWebhook(req, deps);
  assertEquals(res.status, 200);
  assertEquals(calls.length, 0);
});

Deno.test("Telegram API call failure -> still 200 (no retry-storm), error swallowed safely", async () => {
  const client: TelegramClient = {
    sendMessage: async () => {
      throw new Error("simulated Telegram outage");
    },
  };
  const deps: HandlerDeps = { env: envFrom(VALID_ENV), telegram: client };
  const res = await handleTelegramWebhook(
    post({ message: { text: "/start", chat: { id: 1 } } }),
    deps,
  );
  assertEquals(res.status, 200);
});

Deno.test("GET method -> 405", async () => {
  const { client } = fakeTelegram();
  const deps: HandlerDeps = { env: envFrom(VALID_ENV), telegram: client };
  const res = await handleTelegramWebhook(new Request("https://example.test/x", { method: "GET" }), deps);
  assertEquals(res.status, 405);
});
