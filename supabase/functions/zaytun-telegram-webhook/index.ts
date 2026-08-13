// Telegram webhook for @ZaytunKafeNavoiy_bot -- Entry v1, deliberately
// tiny: /start shows two URL buttons (order link, and a link into
// @Zaytun_kafe_navoi, the staff/customer account that handles table
// booking). There is no callback flow, no reservation engine, no state
// machine of its own -- staff read and answer booking messages directly
// in Telegram. Does not touch Zaytun Go's own checkout/delivery/Auth
// database, EXCEPT for the one narrow addition below: consuming a
// single-use link token so the customer can receive a driver-arrival
// notification even after closing the tracking page. That token is
// generated server-side (request_telegram_link RPC, called from the
// tracking page using the same order id + tracking token that already
// gates get_order_tracking) and is opaque here -- this function never
// sees or trusts a client-submitted Telegram id; the id it stores always
// comes from Telegram's own webhook payload for a request that already
// passed the secret-token check below.
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

const LINK_SUCCESS_TEXT =
  "✅ Bog‘landi! Kuryer yetib kelganda shu yerga xabar beramiz.";
const LINK_FAILED_TEXT =
  "Havola muddati o‘tgan yoki noto‘g‘ri. Buyurtma sahifasidan qaytadan urinib ko‘ring.";

export interface HandlerDeps {
  env: { get(key: string): string | undefined };
  // null when TELEGRAM_BOT_TOKEN itself is unset -- distinct failure mode
  // from a bad/missing webhook secret, logged and rejected separately.
  telegram: TelegramClient | null;
  // Atomically consumes a single-use telegram_link_requests token and
  // links the resolved order to chatId; returns false for
  // unknown/expired/already-consumed tokens. chatId always comes from
  // Telegram's own webhook payload, never from message text.
  consumeLink: (token: string, chatId: number) => Promise<boolean>;
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
    const text = update.message?.text ?? "";
    if (text === "/start") {
      await telegram.sendMessage(update.message!.chat.id, WELCOME_TEXT, START_KEYBOARD);
      logOutcome("start_handled");
    } else if (text.startsWith("/start ")) {
      // Telegram sends a deep-link payload (t.me/<bot>?start=<token>) as
      // "/start <token>" in the message text -- the token itself is
      // opaque here, validated entirely inside consumeLink.
      const token = text.slice("/start ".length).trim();
      const linked = token ? await deps.consumeLink(token, update.message!.chat.id) : false;
      await telegram.sendMessage(update.message!.chat.id, linked ? LINK_SUCCESS_TEXT : LINK_FAILED_TEXT);
      logOutcome(linked ? "link_consumed" : "link_invalid");
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
  const { createClient } = await import("jsr:@supabase/supabase-js@2");
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceRoleKey);

  Deno.serve((req) => {
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    return handleTelegramWebhook(req, {
      env: Deno.env,
      telegram: botToken ? createTelegramClient(botToken) : null,
      consumeLink: async (token, chatId) => {
        // A single conditional UPDATE (not select-then-update) makes
        // consumption atomic under concurrent/duplicate webhook deliveries
        // -- only the request that actually flips consumed_at from null
        // gets a row back, so a Telegram retry of the same update can
        // never link/notify twice from one token.
        const { data: consumedRows } = await admin
          .from("telegram_link_requests")
          .update({ consumed_at: new Date().toISOString() })
          .eq("token", token)
          .is("consumed_at", null)
          .gt("expires_at", new Date().toISOString())
          .select("order_id");
        const orderId = consumedRows?.[0]?.order_id;
        if (!orderId) return false;
        const { error } = await admin.from("orders").update({ customer_telegram_chat_id: chatId }).eq("id", orderId);
        return !error;
      },
    });
  });
}
