// Outbound Telegram new-order notification, invoked by our own database
// (via a notification_outbox row + pg_net trigger), never by Telegram
// itself -- so this is verified with our own shared secret
// (TELEGRAM_NOTIFY_SECRET), the same "do our own auth check since
// platform JWT verification doesn't apply" pattern zaytun-telegram-webhook
// and send-sms-hook already use, just via a Bearer header instead of
// Telegram's own signature header. Reuses the existing bot
// (@ZaytunKafeNavoiy_bot) and its TELEGRAM_BOT_TOKEN secret -- no second
// bot, no change to the webhook's /start behavior.
//
// Deliberately decoupled from order creation: this function is only ever
// called AFTER an order (and its durable outbox row) already exist. A
// failure here can never roll back or delay checkout -- see the
// dispatch_notification_via_pg_net trigger this is invoked from.
import { createTelegramClient, type TelegramClient } from "./telegram.ts";
import { formatNewOrderMessage, newOrderKeyboard, type NotificationData } from "./message.ts";

export interface HandlerDeps {
  env: { get(key: string): string | undefined };
  telegram: TelegramClient | null;
  // Returns null when there is nothing left to do (already sent, or the
  // outbox row / order genuinely doesn't exist) -- not an error condition.
  fetchNotification: (outboxId: string) => Promise<NotificationData | null>;
  markSent: (outboxId: string) => Promise<void>;
  markFailed: (outboxId: string, error: string) => Promise<void>;
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

// Category only, same discipline as the webhook's own logging -- never
// the outbox id, chat id, or message content.
function logOutcome(outcome: string): void {
  console.log(JSON.stringify({ event: "zaytun_telegram_notify", outcome }));
}

export async function handleTelegramNotify(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method !== "POST") {
    logOutcome("rejected_method");
    return textResponse(405, "Method not allowed");
  }

  const expectedSecret = deps.env.get("TELEGRAM_NOTIFY_SECRET");
  if (!expectedSecret) {
    logOutcome("rejected_config");
    return textResponse(500, "Server misconfigured");
  }
  if (req.headers.get("Authorization") !== `Bearer ${expectedSecret}`) {
    logOutcome("rejected_secret");
    return textResponse(401, "Unauthorized");
  }

  if (!deps.telegram) {
    logOutcome("rejected_config");
    return textResponse(500, "Server misconfigured");
  }
  const telegram = deps.telegram;

  let body: { outboxId?: string };
  try {
    body = await req.json();
  } catch {
    logOutcome("rejected_payload");
    return textResponse(400, "Invalid payload");
  }
  if (!body.outboxId) {
    logOutcome("rejected_payload");
    return textResponse(400, "Missing outboxId");
  }
  const outboxId = body.outboxId;

  const data = await deps.fetchNotification(outboxId);
  if (!data) {
    logOutcome("nothing_to_send");
    return textResponse(200, "ok");
  }

  try {
    await telegram.sendMessage(data.chatId, formatNewOrderMessage(data), newOrderKeyboard());
    await deps.markSent(outboxId);
    logOutcome("sent");
  } catch {
    // Never retry-storm the caller (our own DB trigger) -- the outbox row
    // itself records the failure for later inspection/retry.
    await deps.markFailed(outboxId, "telegram_api_error").catch(() => {
      /* even failure-bookkeeping must not throw back to the caller */
    });
    logOutcome("telegram_api_error");
  }

  return textResponse(200, "ok");
}

if (import.meta.main) {
  const { createClient } = await import("jsr:@supabase/supabase-js@2");
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceRoleKey);

  Deno.serve(async (req) => {
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
    return handleTelegramNotify(req, {
      env: Deno.env,
      telegram: botToken ? createTelegramClient(botToken) : null,
      fetchNotification: async (outboxId) => {
        const { data: outboxRow } = await admin
          .from("notification_outbox")
          .select("order_id, status")
          .eq("id", outboxId)
          .maybeSingle();
        if (!outboxRow || outboxRow.status !== "PENDING") return null;

        const { data: order } = await admin
          .from("orders")
          .select("number, order_type, total, payment_method, customer_name, branch_id")
          .eq("id", outboxRow.order_id)
          .maybeSingle();
        if (!order) return null;

        const { data: branch } = await admin
          .from("branches")
          .select("notification_chat_id")
          .eq("id", order.branch_id)
          .maybeSingle();
        const fallbackChatId = Deno.env.get("TELEGRAM_RESTAURANT_CHAT_ID");
        const chatIdText = branch?.notification_chat_id || fallbackChatId;
        if (!chatIdText) return null;

        return {
          chatId: Number(chatIdText),
          orderNumber: order.number,
          orderType: order.order_type,
          total: order.total,
          paymentMethod: order.payment_method,
          customerName: order.customer_name,
        };
      },
      markSent: async (outboxId) => {
        await admin
          .from("notification_outbox")
          .update({ status: "SENT", sent_at: new Date().toISOString() })
          .eq("id", outboxId);
      },
      markFailed: async (outboxId, error) => {
        await admin
          .from("notification_outbox")
          .update({ status: "FAILED", last_error: error, attempts: 1 })
          .eq("id", outboxId);
      },
    });
  });
}
