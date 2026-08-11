// Minimal Telegram Bot API client. Only the one call this bot needs --
// sendMessage -- not a general-purpose SDK. The bot token lives only in
// this module's constructor argument, sourced from Deno.env at the real
// entrypoint (see index.ts); never logged, never returned, never part of
// any thrown error message.

export interface InlineKeyboardButton {
  text: string;
  url?: string;
}

export interface TelegramClient {
  sendMessage(chatId: number, text: string, replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] }): Promise<void>;
}

export function createTelegramClient(botToken: string, fetchImpl: typeof fetch = fetch): TelegramClient {
  const base = `https://api.telegram.org/bot${botToken}`;
  const post = async (method: string, body: Record<string, unknown>) => {
    const res = await fetchImpl(`${base}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // Never include the response body in the thrown error -- it could echo
    // back request content, and the token is already redacted from `base`
    // by construction (this string is never logged).
    if (!res.ok) throw new Error(`Telegram ${method} failed: ${res.status}`);
  };
  return {
    sendMessage: (chatId, text, replyMarkup) =>
      post("sendMessage", { chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
  };
}

export interface TelegramUpdate {
  message?: {
    text?: string;
    chat: { id: number; type?: string };
  };
}
