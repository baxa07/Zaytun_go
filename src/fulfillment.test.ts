import { describe, expect, it } from "vitest";
import type { RestaurantConfig } from "./domain";
import { fulfillmentSummary, homeFulfillmentCopy } from "./fulfillment";

const configuration = (deliveryEnabled: boolean): RestaurantConfig => ({
  restaurantName: "Zaytun Kafe",
  restaurantAddress: "Navoiy",
  restaurantPhone: "+998507440005",
  restaurantLatitude: 40.087274,
  restaurantLongitude: 65.402551,
  operatingHours: { everyday: "10:00–00:00" },
  deliveryEnabled,
  deliveryRadiusKm: 8,
  deliveryAreaDescription: "Navoiy",
  minimumDeliverySubtotal: 100000,
  baseDeliveryFee: 0,
  freeDeliveryThreshold: null,
  maximumItemQuantity: 50,
  supportedPaymentMethods: ["CASH"],
  pickupPaymentMethods: ["CASH", "CARD_AT_PICKUP"],
  deliveryPaymentMethods: ["CASH"],
  estimatedPreparationMinutes: 25,
  estimatedDeliveryMinutes: 45,
  defaultMapZoom: 17,
});

describe("fulfillment wording", () => {
  it("uses pickup-safe homepage and summary wording when delivery is disabled", () => {
    expect(homeFulfillmentCopy(configuration(false))).toEqual({
      eyebrow: "NAVOIY · ONLAYN BUYURTMA",
      supporting: "Sevimli taomlaringizni onlayn buyurtma qiling va tayyor bo‘lganda olib keting.",
      timing: "Tayyorlanish vaqti: 25 min",
    });
    expect(fulfillmentSummary("PICKUP")).toEqual({ label: "Olib ketish", value: "Bepul" });
  });

  it("preserves delivery wording and timing when delivery is enabled and selected", () => {
    expect(homeFulfillmentCopy(configuration(true))).toEqual({
      eyebrow: "NAVOIY · TEZ YETKAZIB BERISH",
      supporting: "Zaytun Kafe taomlarini onlayn buyurtma qiling va har bir bosqichni kuzating.",
      timing: "25–70 min",
    });
    expect(fulfillmentSummary("DELIVERY")).toEqual({ label: "Yetkazish", value: "Manzilga qarab" });
  });

  it("does not claim delivery while public configuration is still loading", () => {
    expect(homeFulfillmentCopy(null).eyebrow).toBe("NAVOIY · ONLAYN BUYURTMA");
  });
});
