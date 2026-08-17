// Message content rules (deliberate, not incidental): concise, and never
// includes exact coordinates, payment secrets, OTP, internal UUIDs,
// tracking tokens, delivery notes, or unit-level pin/entrance detail --
// the authenticated restaurant panel (behind the inline button below)
// remains the source for anything that granular. Customer phone and a
// short district+street+house address summary ARE included here
// deliberately (Restaurant UI Phase 1): this channel's audience is
// restaurant staff coordinating delivery, not the general public, and
// they need enough to act on the alert without opening the panel first.

export interface NotificationData {
  chatId: number;
  orderNumber: string;
  orderType: "DELIVERY" | "PICKUP";
  total: number;
  paymentMethod: string;
  customerName: string;
  customerPhone: string;
  // District + street + house only, never entrance/floor/apartment/
  // landmark/notes/coordinates -- undefined for PICKUP orders, which have
  // no delivery address at all.
  addressSummary?: string;
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
  TERMINAL: "Terminal (restoranda)",
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
    `Tel: ${data.customerPhone}`,
    ...(data.addressSummary ? [`Manzil: ${data.addressSummary}`] : []),
  ].join("\n");
}

export function newOrderKeyboard() {
  return { inline_keyboard: [[{ text: "Restoran panelini ochish", url: RESTAURANT_URL }]] };
}

export interface ArrivalNotificationData {
  chatId: number;
  orderNumber: string;
  orderId: string;
  trackingToken: string;
}

// The tracking page normally reads its token from localStorage (set at
// checkout, on the same device/browser that placed the order) -- a link
// opened from Telegram may be a different browser context entirely (e.g.
// Telegram's in-app browser), so the token travels in the URL here too.
// Knowledge of the token is the entire authorization model already (see
// get_order_tracking) -- a token in a URL is not a weaker secret than one
// in localStorage, just a different transport for the same capability.
const TRACK_URL_BASE = "https://zaytungonavoiy.netlify.app/track";

export function formatArrivalMessage(data: ArrivalNotificationData): string {
  return [
    "🚗 Zaytun Go — kuryer yetib keldi",
    "",
    "Buyurtmangiz yetkazib berish manziliga yetib keldi.",
    "",
    "Iltimos, buyurtmani qabul qilishga tayyor bo‘ling.",
    "",
    `Buyurtma #${data.orderNumber}`,
  ].join("\n");
}

export function formatOnTheWayMessage(data: ArrivalNotificationData): string {
  return [
    `🚗 ${data.orderNumber} yo‘lga chiqdi`,
    "",
    "Buyurtmangiz siz tomon ketmoqda.",
  ].join("\n");
}

export function arrivalKeyboard(data: ArrivalNotificationData) {
  return {
    inline_keyboard: [[{ text: "Buyurtmani ko‘rish", url: `${TRACK_URL_BASE}/${data.orderId}?token=${data.trackingToken}` }]],
  };
}

// Driver assignment notification (Phase D): deliberately contains no
// customer information at all -- number, pickup branch, distance. This
// matches the driver app's own pre-acceptance information boundary
// (DriverAssignmentCard shows district + prep estimate, never customer
// name/phone/address until accepted), never getting ahead of what the
// authenticated driver panel itself would reveal at this stage.
const DRIVER_URL = "https://zaytungonavoiy.netlify.app/driver";

export interface AssignmentNotificationData {
  chatId: number;
  orderNumber: string;
  branchName: string;
  distanceKm?: number;
}

export function formatNewAssignmentMessage(data: AssignmentNotificationData): string {
  return [
    `🚗 Yangi yetkazish — ${data.orderNumber}`,
    "",
    `Olib ketish: ${data.branchName}`,
    ...(data.distanceKm !== undefined ? [`Masofa: ${data.distanceKm.toFixed(1)} km`] : []),
    "",
    "Haydovchi panelini ochib buyurtmani qabul qiling.",
  ].join("\n");
}

export function newAssignmentKeyboard() {
  return { inline_keyboard: [[{ text: "Haydovchi panelini ochish", url: DRIVER_URL }]] };
}
