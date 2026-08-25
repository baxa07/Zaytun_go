import { assertEquals } from "jsr:@std/assert";
import { handleStaffTelegramWebhook } from "./index.ts";
import type { TelegramClient } from "./telegram.ts";

const SECRET = "staff-webhook-secret";
const env = { get: (key: string) => key === "STAFF_TELEGRAM_WEBHOOK_SECRET" ? SECRET : undefined };

function request(body: unknown, secret = SECRET) {
  return new Request("https://example.test/zaytun-staff-telegram-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret },
    body: JSON.stringify(body),
  });
}

Deno.test("private /start opens the shared Restaurant and Owner staff app", async () => {
  const calls: unknown[][] = [];
  const telegram: TelegramClient = { sendMessage: async (...args) => { calls.push(args); } };
  const result = await handleStaffTelegramWebhook(request({ message: { text: "/start", chat: { id: 42, type: "private" } } }), { env, telegram });
  assertEquals(result.status, 200);
  assertEquals(calls.length, 1);
  const [chatId, text, keyboard] = calls[0] as [number, string, { inline_keyboard: Array<Array<{ web_app?: { url: string } }>> }];
  assertEquals(chatId, 42);
  assertEquals(text.includes("Zaytun Oshxona"), true);
  assertEquals(text.includes("Owner"), true);
  assertEquals(keyboard.inline_keyboard[0][0].web_app?.url.endsWith("/restaurant"), true);
});

Deno.test("wrong staff webhook secret is denied before sending", async () => {
  let sent = false;
  const telegram: TelegramClient = { sendMessage: async () => { sent = true; } };
  const result = await handleStaffTelegramWebhook(request({ message: { text: "/start", chat: { id: 42, type: "private" } } }, "wrong"), { env, telegram });
  assertEquals(result.status, 401);
  assertEquals(sent, false);
});

Deno.test("group messages never open the staff app", async () => {
  let sent = false;
  const telegram: TelegramClient = { sendMessage: async () => { sent = true; } };
  const result = await handleStaffTelegramWebhook(request({ message: { text: "/start", chat: { id: -42, type: "group" } } }), { env, telegram });
  assertEquals(result.status, 200);
  assertEquals(sent, false);
});
