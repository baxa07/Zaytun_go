export interface TelegramClient {
  sendMessage(chatId: number, text: string, replyMarkup?: unknown): Promise<void>;
}

export function createTelegramClient(botToken: string, fetchImpl: typeof fetch = fetch): TelegramClient {
  const base = `https://api.telegram.org/bot${botToken}`;
  return {
    async sendMessage(chatId, text, replyMarkup) {
      const response = await fetchImpl(`${base}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup }),
      });
      if (!response.ok) throw new Error(`Telegram sendMessage failed: ${response.status}`);
    },
  };
}

export interface TelegramUpdate {
  message?: {
    text?: string;
    chat: { id: number; type?: string };
    from?: { id: number };
    contact?: {
      phone_number: string;
      user_id?: number;
    };
  };
}
