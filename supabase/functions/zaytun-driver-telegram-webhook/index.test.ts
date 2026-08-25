import { assertEquals } from "jsr:@std/assert";
import { handleDriverTelegramWebhook } from "./index.ts";
import type { TelegramClient } from "./telegram.ts";

const SECRET = "driver-webhook-secret";
const env = { get: (key: string) => key === "DRIVER_TELEGRAM_WEBHOOK_SECRET" ? SECRET : undefined };

function request(body: unknown, secret = SECRET) {
  return new Request("https://example.test/zaytun-driver-telegram-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify(body),
  });
}

Deno.test("private /start opens only the Driver Mini App", async () => {
  const calls: unknown[][] = [];
  const telegram: TelegramClient = { sendMessage: async (...args) => { calls.push(args); } };
  const result = await handleDriverTelegramWebhook(request({ message: { text: "/start", chat: { id: 42, type: "private" } } }), { env, telegram });
  assertEquals(result.status, 200);
  assertEquals(calls.length, 1);
  const [chatId, text, keyboard] = calls[0] as [number, string, { inline_keyboard: Array<Array<{ web_app?: { url: string } }>> }];
  assertEquals(chatId, 42);
  assertEquals(text.includes("Zaytun Driver"), true);
  assertEquals(keyboard.inline_keyboard[0][0].web_app?.url.endsWith("/driver"), true);
});

Deno.test("wrong webhook secret is denied before sending", async () => {
  let sent = false;
  const telegram: TelegramClient = { sendMessage: async () => { sent = true; } };
  const result = await handleDriverTelegramWebhook(request({ message: { text: "/start", chat: { id: 42, type: "private" } } }, "wrong"), { env, telegram });
  assertEquals(result.status, 401);
  assertEquals(sent, false);
});

Deno.test("group messages never open the driver app", async () => {
  let sent = false;
  const telegram: TelegramClient = { sendMessage: async () => { sent = true; } };
  const result = await handleDriverTelegramWebhook(request({ message: { text: "/start", chat: { id: -42, type: "group" } } }), { env, telegram });
  assertEquals(result.status, 200);
  assertEquals(sent, false);
});
