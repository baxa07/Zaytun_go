// Minimal Telegram Bot API client -- identical shape to
// zaytun-telegram-webhook/telegram.ts (duplicated rather than shared, so
// this function's deploy bundle stays self-contained and the existing,
// already-working webhook function is never touched by this addition).
// Only the one call this needs -- sendMessage.

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
    if (!res.ok) throw new Error(`Telegram ${method} failed: ${res.status}`);
  };
  return {
    sendMessage: (chatId, text, replyMarkup) =>
      post("sendMessage", { chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
  };
}
