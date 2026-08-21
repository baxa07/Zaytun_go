import { describe, expect, it } from "vitest";
import type { Order } from "./domain";
import { toPublicOrderPayload } from "./supabase";

const order = {
  id: "40000000-0000-4000-8000-000000000100",
  customer: { id: "customer", name: "Test", primaryPhone: "+998901234567" },
  type: "DELIVERY",
  address: {
    customerName: "Test",
    primaryPhone: "+998901234567",
    district: "Navoiy",
    street: "Test",
    house: "1",
    landmark: "Maktab",
    deliveryNotes: "",
    latitude: 40.104,
    longitude: 65.369,
    confidence: "COMPLETE",
    deliveryDistanceKm: 2.5,
    deliveryZoneResult: "ELIGIBLE",
  },
  items: [{
    id: "cart-line",
    menuItemId: "chicken",
    name: "Tampered name",
    unitPrice: 1,
    quantity: 2,
    modifierIds: ["sauce"],
    modifierNames: ["Tampered modifier"],
    instructions: "Separate sauce",
    packagingRequired: true,
    packagingUnitPrice: 1,
    packagingCapacity: 1,
    packagingBoxCount: 2,
    packagingTotal: 2,
    total: 2,
  }],
  subtotal: 2,
  packagingTotal: 2,
  deliveryFee: 0,
  total: 2,
  number: "CLIENT-NUMBER",
  paymentMethod: "CASH",
  paymentStatus: "PENDING",
  specialInstructions: "Test",
  status: "NEW",
  createdAt: new Date(0).toISOString(),
  events: [],
  issues: [],
  assignmentHistory: [],
} satisfies Order;

describe("public order payload", () => {
  it("contains selection data but no client pricing or totals", () => {
    const payload = toPublicOrderPayload(order);

    expect(payload.items).toEqual([{
      menuItemId: "chicken",
      quantity: 2,
      modifierIds: ["sauce"],
      instructions: "Separate sauce",
    }]);
    expect(payload).not.toHaveProperty("subtotal");
    expect(payload).not.toHaveProperty("deliveryFee");
    expect(payload).not.toHaveProperty("total");
    expect(payload.items[0]).not.toHaveProperty("unitPrice");
    expect(payload.items[0]).not.toHaveProperty("total");
    expect(payload).not.toHaveProperty("packagingTotal");
    expect(payload.items[0]).not.toHaveProperty("packagingUnitPrice");
    expect(payload.items[0]).not.toHaveProperty("packagingTotal");
    expect(payload.address).not.toHaveProperty("deliveryDistanceKm");
    expect(payload.address).not.toHaveProperty("deliveryZoneResult");
  });
});
