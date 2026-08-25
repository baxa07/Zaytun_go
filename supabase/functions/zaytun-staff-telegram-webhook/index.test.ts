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
  const [chatId, text, keyboard] = calls[0] as [number, string, { keyboard: Array<Array<{ web_app?: { url: string }; request_contact?: boolean }>> }];
  assertEquals(chatId, 42);
  assertEquals(text.includes("Zaytun Oshxona"), true);
  assertEquals(text.includes("Owner"), true);
  assertEquals(keyboard.keyboard[0][0].web_app?.url.endsWith("/restaurant"), true);
  assertEquals(keyboard.keyboard[1][0].request_contact, true);
});

Deno.test("official café contact binds the private chat and confirms notifications", async () => {
  const calls: unknown[][] = [];
  const binds: unknown[][] = [];
  const telegram: TelegramClient = { sendMessage: async (...args) => { calls.push(args); } };
  const result = await handleStaffTelegramWebhook(request({
    message: {
      chat: { id: 507440005, type: "private" },
      from: { id: 77 },
      contact: { phone_number: "+998507440005", user_id: 77 },
    },
  }), {
    env,
    telegram,
    bindCafeChat: async (...args) => { binds.push(args); return "bound"; },
  });
  assertEquals(result.status, 200);
  assertEquals(binds, [[507440005, 77, "+998507440005"]]);
  assertEquals(String(calls[0][1]).includes("yangi buyurtmalar shu chatga keladi"), true);
});

Deno.test("a forwarded or someone else's contact can never bind the café chat", async () => {
  let bound = false;
  const calls: unknown[][] = [];
  const telegram: TelegramClient = { sendMessage: async (...args) => { calls.push(args); } };
  const result = await handleStaffTelegramWebhook(request({
    message: {
      chat: { id: 42, type: "private" },
      from: { id: 77 },
      contact: { phone_number: "+998507440005", user_id: 88 },
    },
  }), { env, telegram, bindCafeChat: async () => { bound = true; return "bound"; } });
  assertEquals(result.status, 200);
  assertEquals(bound, false);
  assertEquals(String(calls[0][1]).includes("aynan o‘zingizning"), true);
});

Deno.test("a different phone is rejected by the authoritative café-phone check", async () => {
  const calls: unknown[][] = [];
  const telegram: TelegramClient = { sendMessage: async (...args) => { calls.push(args); } };
  await handleStaffTelegramWebhook(request({
    message: {
      chat: { id: 42, type: "private" },
      from: { id: 77 },
      contact: { phone_number: "+998900000000", user_id: 77 },
    },
  }), { env, telegram, bindCafeChat: async () => "phone_mismatch" });
  assertEquals(String(calls[0][1]).includes("rasmiy raqamiga mos kelmadi"), true);
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
