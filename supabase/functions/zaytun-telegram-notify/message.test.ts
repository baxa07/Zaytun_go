import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  arrivalKeyboard,
  formatArrivalMessage,
  formatNewOrderMessage,
  newOrderKeyboard,
  type ArrivalNotificationData,
  type NotificationData,
} from "./message.ts";

const base: NotificationData = {
  chatId: -1001234567890,
  orderNumber: "ZG-1051",
  orderType: "DELIVERY",
  total: 260000,
  paymentMethod: "CLICK",
  customerName: "Bahrom",
};

Deno.test("formats the exact requested shape", () => {
  const message = formatNewOrderMessage(base);
  assertEquals(
    message,
    "🔔 Yangi buyurtma — ZG-1051\n\nYetkazib berish\n260 000 so‘m\nTo‘lov: Click\n\nMijoz: Bahrom",
  );
});

Deno.test("pickup orders label correctly", () => {
  const message = formatNewOrderMessage({ ...base, orderType: "PICKUP" });
  assertStringIncludes(message, "Olib ketish");
});

Deno.test("every supported payment method maps to a customer-friendly label", () => {
  assertStringIncludes(formatNewOrderMessage({ ...base, paymentMethod: "CASH" }), "To‘lov: Naqd pul");
  assertStringIncludes(formatNewOrderMessage({ ...base, paymentMethod: "PAYME" }), "To‘lov: Payme");
  assertStringIncludes(formatNewOrderMessage({ ...base, paymentMethod: "CARD_AT_PICKUP" }), "To‘lov: Karta (restoranda)");
});

Deno.test("never includes address, phone, coordinates, or any internal identifier", () => {
  const message = formatNewOrderMessage(base);
  assertEquals(/\+?\d{9,}/.test(message), false, "no phone-shaped digit run");
  assertEquals(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(message), false, "no UUID");
  assertEquals(message.toLowerCase().includes("koordinat"), false);
  assertEquals(message.toLowerCase().includes("manzil"), false);
  assertEquals(message.toLowerCase().includes("otp"), false);
});

Deno.test("the inline keyboard has exactly one button pointing at the production restaurant panel", () => {
  const keyboard = newOrderKeyboard();
  assertEquals(keyboard.inline_keyboard.length, 1);
  assertEquals(keyboard.inline_keyboard[0].length, 1);
  assertEquals(keyboard.inline_keyboard[0][0].text, "Restoran panelini ochish");
  assertStringIncludes(keyboard.inline_keyboard[0][0].url ?? "", "/restaurant");
});

const arrival: ArrivalNotificationData = {
  chatId: 555111,
  orderNumber: "ZG-1088",
  orderId: "9a000000-0000-4000-8000-000000000001",
  trackingToken: "9b000000-0000-4000-8000-000000000002",
};

Deno.test("arrival message matches the requested shape and includes the public order number", () => {
  const message = formatArrivalMessage(arrival);
  assertEquals(
    message,
    "🚗 Zaytun Go — kuryer yetib keldi\n\nBuyurtmangiz yetkazib berish manziliga yetib keldi.\n\nIltimos, buyurtmani qabul qilishga tayyor bo‘ling.\n\nBuyurtma #ZG-1088",
  );
});

Deno.test("arrival message never includes a phone number, coordinates, or the internal order id -- only the generic word 'manzil' (location), never an actual address", () => {
  const message = formatArrivalMessage(arrival);
  assertEquals(/\+?\d{9,}/.test(message), false, "no phone-shaped digit run");
  assertEquals(message.includes(arrival.orderId), false, "internal id must not appear in the message body itself");
  assertEquals(message.toLowerCase().includes("koordinat"), false);
});

Deno.test("arrival keyboard has exactly one tracking-link button carrying both the order id and tracking token", () => {
  const keyboard = arrivalKeyboard(arrival);
  assertEquals(keyboard.inline_keyboard.length, 1);
  assertEquals(keyboard.inline_keyboard[0].length, 1);
  assertEquals(keyboard.inline_keyboard[0][0].text, "Buyurtmani ko‘rish");
  const url = keyboard.inline_keyboard[0][0].url ?? "";
  assertStringIncludes(url, `/track/${arrival.orderId}`);
  assertStringIncludes(url, arrival.trackingToken);
});
