import { describe, expect, it } from "vitest";
import { mapCustomerFacingLocationError } from "./customerLocationErrorCopy";
import { MapProviderError } from "./types";

describe("mapCustomerFacingLocationError (never leaks provider names, env vars, or raw JS error names)", () => {
  it("maps NO_RESULTS to a plain no-results message", () => {
    expect(mapCustomerFacingLocationError(new MapProviderError("NO_RESULTS", "Hech qanday joy topilmadi"), "search")).toBe(
      "Hech qanday joy topilmadi.",
    );
  });

  it("maps search/suggest/geocode failures to the customer-friendly search message, never the raw message", () => {
    const raw = new MapProviderError("SEARCH_FAILED", "Yandex manzil natijalarini koordinataga aylantirmadi");
    const result = mapCustomerFacingLocationError(raw, "search");
    expect(result).toBe("Manzilni avtomatik aniqlab bo‘lmadi. Manzilni yozing yoki xaritada nuqtani qayta belgilang.");
    expect(result).not.toContain("Yandex");
  });

  it("maps config/load/init failures to the customer-friendly map message, never the raw message (env var names must never leak)", () => {
    const raw = new MapProviderError("MISSING_CONFIG", "VITE_MAP_PROVIDER=yandex, lekin VITE_YANDEX_MAPS_API_KEY belgilanmagan");
    const result = mapCustomerFacingLocationError(raw, "map");
    expect(result).toBe("Xarita hozircha ishlamayapti. Birozdan keyin qayta urinib ko‘ring yoki manzilni qo‘lda yozing.");
    expect(result).not.toContain("VITE_");
    expect(result).not.toContain("Yandex");
  });

  it("maps reverse-geocode failures (including a raw JS error name appended) to a clean fallback message", () => {
    const raw = new MapProviderError("REVERSE_GEOCODING_FAILED", "Yandex pin manzilini aniqlamadi: TypeError");
    const result = mapCustomerFacingLocationError(raw, "reverseGeocode");
    expect(result).toBe("Manzil avtomatik aniqlanmadi. Manzilni qo‘lda yozing yoki pinni qayta belgilang.");
    expect(result).not.toContain("TypeError");
  });

  it("falls back to a generic, safe message for a non-MapProviderError value", () => {
    expect(mapCustomerFacingLocationError(new Error("some internal detail"), "reverseGeocode")).toBe(
      "Manzil avtomatik aniqlanmadi. Manzilni qo‘lda yozing yoki pinni qayta belgilang.",
    );
  });

  it("falls back to the context-appropriate message even for an unrecognized code", () => {
    expect(mapCustomerFacingLocationError(new MapProviderError("UNAVAILABLE", "detail"), "map")).toBe(
      "Xarita hozircha ishlamayapti. Birozdan keyin qayta urinib ko‘ring yoki manzilni qo‘lda yozing.",
    );
  });
});
