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
import {
  arrivalKeyboard,
  formatArrivalMessage,
  formatOnTheWayMessage,
  formatNewAssignmentMessage,
  formatNewOrderMessage,
  newAssignmentKeyboard,
  newOrderKeyboard,
  type ArrivalNotificationData,
  type AssignmentNotificationData,
  type NotificationData,
} from "./message.ts";

// One shared outbox/dispatch pipeline, three message channels -- adding a
// channel here means adding a case, not a second Edge Function or a
// second dispatch trigger (dispatch_notification_via_pg_net is already
// channel-agnostic). TELEGRAM_DRIVER_NEW_ASSIGNMENT's stored channel
// value carries a ":<assignment id>" suffix for per-assignment
// idempotency (see the enqueue trigger) -- fetchNotification strips it
// before returning, so the discriminant here is always the bare literal.
export type OutboundNotification =
  | { channel: "TELEGRAM_RESTAURANT_NEW_ORDER"; data: NotificationData }
  | { channel: "TELEGRAM_CUSTOMER_ON_THE_WAY"; data: ArrivalNotificationData }
  | { channel: "TELEGRAM_CUSTOMER_ARRIVED"; data: ArrivalNotificationData }
  | { channel: "TELEGRAM_DRIVER_NEW_ASSIGNMENT"; data: AssignmentNotificationData };

export interface HandlerDeps {
  env: { get(key: string): string | undefined };
  telegram: TelegramClient | null;
  // Returns null when there is nothing left to do (already sent, the
  // outbox row / order genuinely doesn't exist, or -- for
  // TELEGRAM_CUSTOMER_ARRIVED specifically -- the order has no linked
  // Telegram chat) -- not an error condition in any case.
  fetchNotification: (outboxId: string) => Promise<OutboundNotification | null>;
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

  const notification = await deps.fetchNotification(outboxId);
  if (!notification) {
    logOutcome("nothing_to_send");
    return textResponse(200, "ok");
  }
  const { text, keyboard, chatId } =
    notification.channel === "TELEGRAM_RESTAURANT_NEW_ORDER"
      ? { text: formatNewOrderMessage(notification.data), keyboard: newOrderKeyboard(), chatId: notification.data.chatId }
      : notification.channel === "TELEGRAM_DRIVER_NEW_ASSIGNMENT"
      ? { text: formatNewAssignmentMessage(notification.data), keyboard: newAssignmentKeyboard(), chatId: notification.data.chatId }
      : notification.channel === "TELEGRAM_CUSTOMER_ON_THE_WAY"
      ? { text: formatOnTheWayMessage(notification.data), keyboard: arrivalKeyboard(notification.data), chatId: notification.data.chatId }
      : { text: formatArrivalMessage(notification.data), keyboard: arrivalKeyboard(notification.data), chatId: notification.data.chatId };

  try {
    await telegram.sendMessage(chatId, text, keyboard);
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
          .select("order_id, channel, status")
          .eq("id", outboxId)
          .maybeSingle();
        if (!outboxRow || outboxRow.status !== "PENDING") return null;

        if (outboxRow.channel === "TELEGRAM_CUSTOMER_ARRIVED" || outboxRow.channel === "TELEGRAM_CUSTOMER_ON_THE_WAY") {
          const { data: order } = await admin
            .from("orders")
            .select("number, tracking_token, customer_telegram_chat_id")
            .eq("id", outboxRow.order_id)
            .maybeSingle();
          if (!order || !order.customer_telegram_chat_id) return null;
          return {
            channel: outboxRow.channel,
            data: {
              chatId: order.customer_telegram_chat_id,
              orderNumber: order.number,
              orderId: outboxRow.order_id,
              trackingToken: order.tracking_token,
            },
          };
        }

        if (outboxRow.channel.startsWith("TELEGRAM_DRIVER_NEW_ASSIGNMENT:")) {
          const assignmentId = outboxRow.channel.slice("TELEGRAM_DRIVER_NEW_ASSIGNMENT:".length);
          const { data: assignment } = await admin
            .from("driver_assignments")
            .select("driver_id")
            .eq("id", assignmentId)
            .maybeSingle();
          // The driver this specific assignment went to -- not "whoever
          // currently holds the order," which may have changed by the
          // time this dispatches (decline, supersede).
          if (!assignment) return null;
          const { data: driver } = await admin
            .from("drivers")
            .select("telegram_chat_id")
            .eq("id", assignment.driver_id)
            .maybeSingle();
          // Unconfigured mapping is a normal, expected rollout state --
          // never an error. The driver's own in-app sound/UI still works;
          // this is purely an additional fallback channel.
          if (!driver?.telegram_chat_id) return null;

          const { data: order } = await admin
            .from("orders")
            .select("number, branch_id")
            .eq("id", outboxRow.order_id)
            .maybeSingle();
          if (!order) return null;
          const { data: branch } = await admin
            .from("branches")
            .select("name")
            .eq("id", order.branch_id)
            .maybeSingle();
          const { data: address } = await admin
            .from("customer_addresses")
            .select("delivery_distance_km")
            .eq("order_id", outboxRow.order_id)
            .maybeSingle();

          return {
            channel: "TELEGRAM_DRIVER_NEW_ASSIGNMENT",
            data: {
              chatId: Number(driver.telegram_chat_id),
              orderNumber: order.number,
              branchName: branch?.name || "Zaytun Kafe",
              distanceKm: address?.delivery_distance_km ?? undefined,
            },
          };
        }

        const { data: order } = await admin
          .from("orders")
          .select("number, order_type, total, payment_method, customer_name, primary_phone, branch_id")
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

        // District + street + house only -- entrance/floor/apartment/
        // landmark/notes/coordinates stay in the authenticated panel.
        let addressSummary: string | undefined;
        if (order.order_type === "DELIVERY") {
          const { data: address } = await admin
            .from("customer_addresses")
            .select("district, street, house")
            .eq("order_id", outboxRow.order_id)
            .maybeSingle();
          if (address) addressSummary = [address.district, address.street, address.house].filter(Boolean).join(", ");
        }

        return {
          channel: "TELEGRAM_RESTAURANT_NEW_ORDER",
          data: {
            chatId: Number(chatIdText),
            orderNumber: order.number,
            orderType: order.order_type,
            total: order.total,
            paymentMethod: order.payment_method,
            customerName: order.customer_name,
            customerPhone: order.primary_phone,
            addressSummary,
          },
        };
      },
      markSent: async (outboxId) => {
        const { error } = await admin
          .from("notification_outbox")
          .update({ status: "SENT", sent_at: new Date().toISOString() })
          .eq("id", outboxId);
        if (error) throw error;
      },
      markFailed: async (outboxId, error) => {
        // Atomically increments attempts and schedules bounded exponential
        // retry in Postgres. The browser is never involved in either the
        // first send or a retry.
        const { error: bookkeepingError } = await admin.rpc("mark_notification_delivery_failed", {
          p_outbox_id: outboxId,
          p_error: error,
        });
        if (bookkeepingError) throw bookkeepingError;
      },
    });
  });
}
