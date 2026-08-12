// Message content rules (deliberate, not incidental): concise, and never
// includes full delivery address, customer phone number, exact
// coordinates, payment secrets, OTP, internal UUIDs, or notes. The
// authenticated restaurant panel (behind the inline button below) remains
// the source for anything sensitive.

export interface NotificationData {
  chatId: number;
  orderNumber: string;
  orderType: "DELIVERY" | "PICKUP";
  total: number;
  paymentMethod: string;
  customerName: string;
}

// The production customer-app origin is already a plain, non-secret
// constant in zaytun-telegram-webhook/index.ts (ORDER_URL) -- reused here
// under the same "not a secret, safe to commit" reasoning.
const RESTAURANT_URL = "https://zaytungonavoiy.netlify.app/restaurant";

const paymentLabels: Record<string, string> = {
  CASH: "Naqd pul",
  CLICK: "Click",
  PAYME: "Payme",
  CARD_AT_PICKUP: "Karta (restoranda)",
  CARD_ON_DELIVERY: "Karta",
};

function formatMoney(amount: number): string {
  // Explicit thousands-grouping with a plain space -- deliberately not
  // toLocaleString, whose separator character (regular vs non-breaking
  // space) varies by runtime/ICU data and is not worth depending on here.
  const grouped = Math.round(amount).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${grouped} so‘m`;
}

export function formatNewOrderMessage(data: NotificationData): string {
  const typeLabel = data.orderType === "DELIVERY" ? "Yetkazib berish" : "Olib ketish";
  const paymentLabel = paymentLabels[data.paymentMethod] ?? data.paymentMethod;
  return [
    `🔔 Yangi buyurtma — ${data.orderNumber}`,
    "",
    typeLabel,
    formatMoney(data.total),
    `To‘lov: ${paymentLabel}`,
    "",
    `Mijoz: ${data.customerName}`,
  ].join("\n");
}

export function newOrderKeyboard() {
  return { inline_keyboard: [[{ text: "Restoran panelini ochish", url: RESTAURANT_URL }]] };
}
