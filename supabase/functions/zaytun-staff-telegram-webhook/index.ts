import { createTelegramClient, type TelegramClient, type TelegramUpdate } from "./telegram.ts";

const STAFF_APP_URL = "https://zaytungonavoiy.netlify.app/restaurant";
const WELCOME = [
  "🍽 Zaytun Oshxona",
  "",
  "Buyurtmalar, tayyorlash jarayoni va haydovchilarga topshirishni boshqarish uchun xodimlar ilovasini oching.",
  "",
  "Owner hisobi shu ilovada Menu boshqaruvini ham ko‘radi.",
  "",
  "Yangi buyurtma xabarlarini olish uchun rasmiy Zaytun Kafe telefonini bir marta ulashing.",
].join("\n");
const KEYBOARD = {
  keyboard: [
    [{ text: "🍽 Oshxona ilovasini ochish", web_app: { url: STAFF_APP_URL } }],
    [{ text: "🔔 Kafe telefonini ulash", request_contact: true }],
  ],
  resize_keyboard: true,
};

type BindResult = "bound" | "phone_mismatch" | "unavailable";

export interface HandlerDeps {
  env: { get(key: string): string | undefined };
  telegram: TelegramClient | null;
  bindCafeChat?: (chatId: number, senderId: number, phone: string) => Promise<BindResult>;
}

function response(status: number, body: string) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function log(outcome: string) {
  console.log(JSON.stringify({ event: "zaytun_staff_telegram_webhook", outcome }));
}

export async function handleStaffTelegramWebhook(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method !== "POST") return response(405, "Method not allowed");
  const expectedSecret = deps.env.get("STAFF_TELEGRAM_WEBHOOK_SECRET");
  if (!expectedSecret) {
    log("rejected_config");
    return response(500, "Server misconfigured");
  }
  if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expectedSecret) {
    log("rejected_secret");
    return response(401, "Unauthorized");
  }
  if (!deps.telegram) {
    log("rejected_config");
    return response(500, "Server misconfigured");
  }

  let update: TelegramUpdate;
  try {
    update = await req.json();
  } catch {
    log("rejected_payload");
    return response(200, "ok");
  }

  const message = update.message;
  if (message?.chat.type === "private" && message.text?.startsWith("/start")) {
    try {
      await deps.telegram.sendMessage(message.chat.id, WELCOME, KEYBOARD);
      log("start_handled");
    } catch {
      log("telegram_api_error");
    }
  } else if (message?.chat.type === "private" && message.contact) {
    const senderId = message.from?.id;
    const contactOwnerId = message.contact.user_id;
    if (!senderId || !contactOwnerId || senderId !== contactOwnerId || !deps.bindCafeChat) {
      await deps.telegram.sendMessage(
        message.chat.id,
        "Bu kontaktni ulab bo‘lmadi. Pastdagi tugma orqali aynan o‘zingizning Telegram kontaktingizni yuboring.",
      ).catch(() => {});
      log("contact_rejected");
      return response(200, "ok");
    }
    try {
      const result = await deps.bindCafeChat(message.chat.id, senderId, message.contact.phone_number);
      if (result === "bound") {
        await deps.telegram.sendMessage(
          message.chat.id,
          "✅ Zaytun Kafe ulandi. Endi yangi buyurtmalar shu chatga keladi.",
          { inline_keyboard: [[{ text: "🍽 Oshxona ilovasini ochish", web_app: { url: STAFF_APP_URL } }]] },
        );
        log("cafe_chat_bound");
      } else if (result === "phone_mismatch") {
        await deps.telegram.sendMessage(
          message.chat.id,
          "Bu raqam Zaytun Kafening rasmiy raqamiga mos kelmadi. Kafe Telegram hisobidan qayta urinib ko‘ring.",
        );
        log("contact_phone_mismatch");
      } else {
        await deps.telegram.sendMessage(message.chat.id, "Ulash vaqtincha amalga oshmadi. Birozdan keyin qayta urinib ko‘ring.");
        log("contact_unavailable");
      }
    } catch {
      log("telegram_api_error");
    }
  } else {
    log("ignored");
  }
  return response(200, "ok");
}

if (import.meta.main) {
  const { createClient } = await import("jsr:@supabase/supabase-js@2");
  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  );
  const normalizePhone = (value: string) => `+${value.replace(/\D/g, "")}`;
  Deno.serve((req) => {
    const token = Deno.env.get("STAFF_TELEGRAM_BOT_TOKEN");
    return handleStaffTelegramWebhook(req, {
      env: Deno.env,
      telegram: token ? createTelegramClient(token) : null,
      bindCafeChat: async (chatId, _senderId, phone) => {
        const { data: settings, error: settingsError } = await admin
          .from("delivery_settings")
          .select("restaurant_phone, branch_id")
          .eq("id", true)
          .maybeSingle();
        if (settingsError || !settings?.restaurant_phone || !settings.branch_id) return "unavailable";
        if (normalizePhone(phone) !== normalizePhone(settings.restaurant_phone)) return "phone_mismatch";
        const { data: branch, error } = await admin
          .from("branches")
          .update({ notification_chat_id: String(chatId) })
          .eq("id", settings.branch_id)
          .eq("active", true)
          .select("id")
          .maybeSingle();
        return error || !branch ? "unavailable" : "bound";
      },
    });
  });
}
