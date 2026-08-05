import type { RestaurantConfig } from "./domain";

export type FulfillmentType = "DELIVERY" | "PICKUP";

export function fulfillmentSummary(type: FulfillmentType) {
  return type === "DELIVERY"
    ? { label: "Yetkazish", value: "Manzilga qarab" }
    : { label: "Olib ketish", value: "Bepul" };
}

export function homeFulfillmentCopy(config: RestaurantConfig | null) {
  if (config?.deliveryEnabled === true) {
    const preparation = config.estimatedPreparationMinutes;
    const delivery = config.estimatedDeliveryMinutes;
    return {
      eyebrow: "NAVOIY · TEZ YETKAZIB BERISH",
      supporting: `${config.restaurantName} taomlarini onlayn buyurtma qiling va har bir bosqichni kuzating.`,
      timing: preparation != null && delivery != null
        ? `${preparation}–${preparation + delivery} min`
        : "Vaqt taom va manzilga qarab aniqlanadi",
    };
  }

  return {
    eyebrow: "NAVOIY · ONLAYN BUYURTMA",
    supporting: "Sevimli taomlaringizni onlayn buyurtma qiling va tayyor bo‘lganda olib keting.",
    timing: config?.estimatedPreparationMinutes != null
      ? `Tayyorlanish vaqti: ${config.estimatedPreparationMinutes} min`
      : "Tayyorlanish vaqti taomga qarab aniqlanadi",
  };
}
