import { createTelegramClient, type TelegramClient, type TelegramUpdate } from "./telegram.ts";

const DRIVER_APP_URL = "https://zaytungonavoiy.netlify.app/driver";
const WELCOME = [
  "🚗 Zaytun Driver",
  "",
  "Yetkazib berishlarni qabul qilish va boshqarish uchun haydovchi ilovasini oching.",
  "",
  "Kirish faqat Zaytun tomonidan yaratilgan haydovchi hisoblari uchun ochiq.",
].join("\n");
const KEYBOARD = {
  inline_keyboard: [[{ text: "🚗 Haydovchi ilovasini ochish", web_app: { url: DRIVER_APP_URL } }]],
};

export interface HandlerDeps {
  env: { get(key: string): string | undefined };
  telegram: TelegramClient | null;
}

function response(status: number, body: string) {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function log(outcome: string) {
  console.log(JSON.stringify({ event: "zaytun_driver_telegram_webhook", outcome }));
}

export async function handleDriverTelegramWebhook(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method !== "POST") return response(405, "Method not allowed");
  const expectedSecret = deps.env.get("DRIVER_TELEGRAM_WEBHOOK_SECRET");
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
  } else {
    log("ignored");
  }
  return response(200, "ok");
}

if (import.meta.main) {
  Deno.serve((req) => {
    const token = Deno.env.get("DRIVER_TELEGRAM_BOT_TOKEN");
    return handleDriverTelegramWebhook(req, {
      env: Deno.env,
      telegram: token ? createTelegramClient(token) : null,
    });
  });
}
