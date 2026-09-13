import {
  createTelegramClient,
  type TelegramClient,
  type TelegramUpdate,
} from "./telegram.ts";

const STAFF_APP_URL = "https://zaytungonavoiy.netlify.app/restaurant";
const WELCOME = [
  "🍽 Zaytun Oshxona",
  "",
  "Buyurtmalar, tayyorlash jarayoni va haydovchilarga topshirishni boshqarish uchun xodimlar ilovasini oching.",
  "",
  "Owner hisobi shu ilovada Menu boshqaruvini ham ko‘radi.",
  "",
  "Yangi buyurtma xabarlarini olish uchun rasmiy Zaytun Kafe telefonini bir marta ulashing.",
  "So‘ng botni «Zaytun Go Buyurtmalar» guruhiga qo‘shib, guruh ichida /buyurtmalar buyrug‘ini yuboring.",
].join("\n");
const KEYBOARD = {
  keyboard: [
    [{ text: "🍽 Oshxona ilovasini ochish", web_app: { url: STAFF_APP_URL } }],
    [{ text: "🔔 Kafe telefonini ulash", request_contact: true }],
  ],
  resize_keyboard: true,
};

type BindResult = "bound" | "phone_mismatch" | "unauthorized" | "unavailable";
const GROUP_LINK_TTL_SECONDS = 15 * 60;

export interface HandlerDeps {
  env: { get(key: string): string | undefined };
  telegram: TelegramClient | null;
  bindCafeChat?: (
    chatId: number,
    senderId: number,
    phone: string,
  ) => Promise<BindResult>;
  createGroupBindToken?: (senderId: number) => Promise<string>;
  bindCafeGroup?: (
    chatId: number,
    senderId: number,
    token: string,
  ) => Promise<BindResult>;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

async function groupBindSignature(
  secret: string,
  senderId: number,
  issuedAt: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`zaytun-staff-group:${senderId}:${issuedAt}`),
  );
  return base64Url(new Uint8Array(signature).slice(0, 18));
}

export async function createGroupBindToken(
  secret: string,
  senderId: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  return `${nowSeconds}.${await groupBindSignature(
    secret,
    senderId,
    nowSeconds,
  )}`;
}

export async function verifyGroupBindToken(
  secret: string,
  senderId: number,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const [issuedAtText, suppliedSignature, extra] = token.split(".");
  const issuedAt = Number(issuedAtText);
  if (extra || !suppliedSignature || !Number.isSafeInteger(issuedAt)) {
    return false;
  }
  if (
    issuedAt > nowSeconds + 60 || nowSeconds - issuedAt > GROUP_LINK_TTL_SECONDS
  ) return false;
  const expected = await groupBindSignature(secret, senderId, issuedAt);
  if (expected.length !== suppliedSignature.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^
      suppliedSignature.charCodeAt(index);
  }
  return difference === 0;
}

function response(status: number, body: string) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

function log(outcome: string) {
  console.log(
    JSON.stringify({ event: "zaytun_staff_telegram_webhook", outcome }),
  );
}

export async function handleStaffTelegramWebhook(
  req: Request,
  deps: HandlerDeps,
): Promise<Response> {
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
  const chatType = message?.chat.type;
  const [rawCommand = "", groupBindToken = ""] =
    message?.text?.trim().split(/\s+/, 2) ?? [];
  const command = rawCommand.split("@")[0].toLowerCase();
  if (
    message && (chatType === "group" || chatType === "supergroup") &&
    command === "/buyurtmalar"
  ) {
    const senderId = message.from?.id;
    if (!senderId || !groupBindToken || !deps.bindCafeGroup) {
      await deps.telegram.sendMessage(
        message.chat.id,
        "Guruhni ulash uchun botning shaxsiy chatida rasmiy Zaytun Kafe telefonini yuboring va berilgan to‘liq buyruqni shu yerga ko‘chiring.",
      ).catch(() => {});
      log("group_bind_rejected");
      return response(200, "ok");
    }
    try {
      const result = await deps.bindCafeGroup(
        message.chat.id,
        senderId,
        groupBindToken,
      );
      if (result === "bound") {
        await deps.telegram.sendMessage(
          message.chat.id,
          "✅ Zaytun Go Buyurtmalar guruhi ulandi. Bu sinov xabari — keyingi yangi buyurtma shu guruhga keladi.",
          {
            inline_keyboard: [[{
              text: "🍽 Oshxona ilovasini ochish",
              web_app: { url: STAFF_APP_URL },
            }]],
          },
        );
        log("cafe_group_bound");
      } else if (result === "unauthorized") {
        await deps.telegram.sendMessage(
          message.chat.id,
          "Bu guruhni ulash uchun avval botning shaxsiy chatida rasmiy Zaytun Kafe telefonini ulang.",
        );
        log("group_bind_unauthorized");
      } else {
        await deps.telegram.sendMessage(
          message.chat.id,
          "Guruhni ulash vaqtincha amalga oshmadi. Birozdan keyin qayta urinib ko‘ring.",
        );
        log("group_bind_unavailable");
      }
    } catch {
      log("telegram_api_error");
    }
  } else if (
    message?.chat.type === "private" && message.text?.startsWith("/start")
  ) {
    try {
      await deps.telegram.sendMessage(message.chat.id, WELCOME, KEYBOARD);
      log("start_handled");
    } catch {
      log("telegram_api_error");
    }
  } else if (message?.chat.type === "private" && message.contact) {
    const senderId = message.from?.id;
    const contactOwnerId = message.contact.user_id;
    if (
      !senderId || !contactOwnerId || senderId !== contactOwnerId ||
      !deps.bindCafeChat
    ) {
      await deps.telegram.sendMessage(
        message.chat.id,
        "Bu kontaktni ulab bo‘lmadi. Pastdagi tugma orqali aynan o‘zingizning Telegram kontaktingizni yuboring.",
      ).catch(() => {});
      log("contact_rejected");
      return response(200, "ok");
    }
    try {
      const result = await deps.bindCafeChat(
        message.chat.id,
        senderId,
        message.contact.phone_number,
      );
      if (result === "bound") {
        const token = deps.createGroupBindToken
          ? await deps.createGroupBindToken(senderId)
          : "";
        const groupInstruction = token
          ? `\n\nGuruhda 15 daqiqa ichida shu to‘liq buyruqni yuboring:\n/buyurtmalar ${token}`
          : "";
        await deps.telegram.sendMessage(
          message.chat.id,
          `✅ Zaytun Kafe tasdiqlandi. Endi botni «Zaytun Go Buyurtmalar» guruhiga qo‘shing.${groupInstruction}\n\nGuruh ulanmaguncha xabarlar shu shaxsiy chatga keladi.`,
          {
            inline_keyboard: [[{
              text: "🍽 Oshxona ilovasini ochish",
              web_app: { url: STAFF_APP_URL },
            }]],
          },
        );
        log("cafe_chat_bound");
      } else if (result === "phone_mismatch") {
        await deps.telegram.sendMessage(
          message.chat.id,
          "Bu raqam Zaytun Kafening rasmiy raqamiga mos kelmadi. Kafe Telegram hisobidan qayta urinib ko‘ring.",
        );
        log("contact_phone_mismatch");
      } else {
        await deps.telegram.sendMessage(
          message.chat.id,
          "Ulash vaqtincha amalga oshmadi. Birozdan keyin qayta urinib ko‘ring.",
        );
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
      bindCafeChat: async (chatId, senderId, phone) => {
        const { data: settings, error: settingsError } = await admin
          .from("delivery_settings")
          .select("restaurant_phone, branch_id")
          .eq("id", true)
          .maybeSingle();
        if (
          settingsError || !settings?.restaurant_phone || !settings.branch_id
        ) return "unavailable";
        if (
          normalizePhone(phone) !== normalizePhone(settings.restaurant_phone)
        ) return "phone_mismatch";
        const { data: branch, error } = await admin
          .from("branches")
          .update({ notification_chat_id: String(chatId) })
          .eq("id", settings.branch_id)
          .eq("active", true)
          .select("id")
          .maybeSingle();
        return error || !branch ? "unavailable" : "bound";
      },
      createGroupBindToken: (senderId) =>
        createGroupBindToken(
          Deno.env.get("STAFF_TELEGRAM_WEBHOOK_SECRET") ?? "",
          senderId,
        ),
      bindCafeGroup: async (chatId, senderId, groupToken) => {
        const groupSecret = Deno.env.get("STAFF_TELEGRAM_WEBHOOK_SECRET") ?? "";
        if (
          !groupSecret ||
          !(await verifyGroupBindToken(groupSecret, senderId, groupToken))
        ) return "unauthorized";
        const { data: settings, error: settingsError } = await admin
          .from("delivery_settings")
          .select("branch_id")
          .eq("id", true)
          .maybeSingle();
        if (settingsError || !settings?.branch_id) return "unavailable";
        const { data: updated, error } = await admin
          .from("branches")
          .update({ notification_chat_id: String(chatId) })
          .eq("id", settings.branch_id)
          .eq("active", true)
          .select("id")
          .maybeSingle();
        return error || !updated ? "unavailable" : "bound";
      },
    });
  });
}
