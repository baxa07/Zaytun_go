// Telegram webhook for @ZaytunKafeNavoiy_bot -- Entry v1, deliberately
// tiny: /start shows two URL buttons (order link, and a link into
// @Zaytun_kafe_navoi, the staff/customer account that handles table
// booking). There is no callback flow, no reservation engine, no state
// machine, no persistence of any kind -- staff read and answer booking
// messages directly in Telegram. Does not touch Zaytun Go's own
// checkout/delivery/Auth/database at all.
//
// Telegram does not send a Supabase-issued JWT, so this function must run
// with verify_jwt off (see supabase/config.toml) -- it verifies the
// request itself via Telegram's own X-Telegram-Bot-Api-Secret-Token
// header against TELEGRAM_WEBHOOK_SECRET, the same "do our own auth check
// since platform JWT verification can't apply" pattern send-sms-hook uses
// for Standard Webhooks signatures.
import { createTelegramClient, type TelegramClient, type TelegramUpdate } from "./telegram.ts";

const WELCOME_TEXT =
  "Assalomu alaykum! 👋\nZaytun’ga xush kelibsiz.\nQanday yordam bera olamiz?";

const ORDER_URL = "https://zaytungonavoiy.netlify.app";
const BOOKING_CHAT_URL = "https://t.me/Zaytun_kafe_navoi";

const START_KEYBOARD = {
  inline_keyboard: [
    [{ text: "🛍 Buyurtma berish", url: ORDER_URL }],
    [{ text: "🍽 Stol band qilish", url: BOOKING_CHAT_URL }],
  ],
};

export interface HandlerDeps {
  env: { get(key: string): string | undefined };
  // null when TELEGRAM_BOT_TOKEN itself is unset -- distinct failure mode
  // from a bad/missing webhook secret, logged and rejected separately.
  telegram: TelegramClient | null;
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

// Deliberately minimal, deliberately no secrets: no bot token, no webhook
// secret, no chat id, no message text, no user id -- category only, same
// discipline as send-sms-hook's own logging.
function logOutcome(outcome: string): void {
  console.log(JSON.stringify({ event: "zaytun_telegram_webhook", outcome }));
}

export async function handleTelegramWebhook(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method !== "POST") {
    logOutcome("rejected_method");
    return textResponse(405, "Method not allowed");
  }

  // Secret verification FIRST, before the body is ever parsed or trusted --
  // a missing configured secret fails the same way a wrong one would, never
  // falling through to processing an unverified update.
  const expectedSecret = deps.env.get("TELEGRAM_WEBHOOK_SECRET");
  if (!expectedSecret) {
    logOutcome("rejected_config");
    return textResponse(500, "Server misconfigured");
  }
  if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expectedSecret) {
    logOutcome("rejected_secret");
    return textResponse(401, "Unauthorized");
  }

  if (!deps.telegram) {
    logOutcome("rejected_config");
    return textResponse(500, "Server misconfigured");
  }
  const telegram = deps.telegram;

  let update: TelegramUpdate;
  try {
    update = await req.json();
  } catch {
    logOutcome("rejected_payload");
    // Still 200: a malformed body from a verified caller isn't something
    // Telegram should retry-storm us over.
    return textResponse(200, "ok");
  }

  try {
    if (update.message?.text === "/start") {
      await telegram.sendMessage(update.message.chat.id, WELCOME_TEXT, START_KEYBOARD);
      logOutcome("start_handled");
    } else {
      // Any other message/update (including free-text booking requests,
      // staff replies, anything else) is left as an ordinary Telegram chat
      // -- deliberately no bot reply, no error, just acknowledge receipt
      // so Telegram doesn't retry.
      logOutcome("ignored");
    }
  } catch {
    // A Telegram API call itself failed (network/rate-limit/etc.) -- still
    // 200 so Telegram doesn't retry-storm the whole update; the failure
    // category is logged, never the underlying error detail (which could
    // echo request content).
    logOutcome("telegram_api_error");
  }

  return textResponse(200, "ok");
}

if (import.meta.main) {
  Deno.serve((req) => {
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    return handleTelegramWebhook(req, {
      env: Deno.env,
      telegram: botToken ? createTelegramClient(botToken) : null,
    });
  });
}
