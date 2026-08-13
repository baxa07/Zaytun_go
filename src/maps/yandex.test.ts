import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mapCustomerFacingLocationError } from "./customerLocationErrorCopy";
import { MapProviderError } from "./types";
import { YandexMapAdapter } from "./yandex";

// Minimal stand-in for the ymaps3 v3 SDK -- just enough surface for
// YandexMapAdapter to exercise its own loading/configuration/init logic
// without a real Yandex script or network access.
function fakeYmaps3(options: { setApikeys?: (keys: { search?: string; suggest?: string }) => void } = {}) {
  const setApikeys = options.setApikeys ?? vi.fn();
  return {
    ready: Promise.resolve(),
    getDefaultConfig: () => ({ setApikeys }),
    search: vi.fn().mockResolvedValue([{ geometry: { coordinates: [65.4, 40.1] }, properties: { name: "Test", description: "Test" } }]),
    suggest: vi.fn().mockResolvedValue([{ title: { text: "Test" }, address: { formattedAddress: "Test" } }]),
    YMap: class { addChild() {} destroy() {} },
    YMapDefaultSchemeLayer: class {},
    YMapDefaultFeaturesLayer: class {},
    YMapMarker: class { update() {} },
    YMapListener: class {},
    setApikeysMock: setApikeys,
  };
}

describe("YandexMapAdapter: search-service configuration is cached once, classified correctly, and never blocks the map", () => {
  beforeEach(() => {
    // Module-level caches live on `window` (see src/maps/yandex.ts) so a
    // second adapter instance within the same page session reuses them --
    // exactly the property under test. Reset between tests so they don't
    // leak across cases.
    delete (window as unknown as Record<string, unknown>).ymaps3;
    delete (window as unknown as Record<string, unknown>).__zaytunYandexCoreLoader;
    delete (window as unknown as Record<string, unknown>).__zaytunYandexSearchConfigLoader;
    delete (window as unknown as Record<string, unknown>).__zaytunYandexSearchConfigKeys;
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).ymaps3;
    delete (window as unknown as Record<string, unknown>).__zaytunYandexCoreLoader;
    delete (window as unknown as Record<string, unknown>).__zaytunYandexSearchConfigLoader;
    delete (window as unknown as Record<string, unknown>).__zaytunYandexSearchConfigKeys;
  });

  it("repeated search/suggest/reverse-geocode calls configure Search/Geosuggest keys exactly once, not once per call", async () => {
    const fake = fakeYmaps3();
    (window as unknown as { ymaps3: unknown }).ymaps3 = fake;
    const adapter = new YandexMapAdapter("maps-key", "search-key", "geosuggest-key");

    await adapter.search("first query");
    await adapter.search("second query");
    await adapter.reverseGeocode({ latitude: 40.1, longitude: 65.4 });

    expect(fake.setApikeysMock).toHaveBeenCalledTimes(1);
    expect(fake.setApikeysMock).toHaveBeenCalledWith({ search: "search-key", suggest: "geosuggest-key" });
  });

  it("a Search/Geosuggest configuration failure is classified as a search-path error, never a map error -- and the map core initializes successfully regardless", async () => {
    const fake = fakeYmaps3({
      setApikeys: () => {
        throw new Error("simulated Yandex configuration rejection");
      },
    });
    (window as unknown as { ymaps3: unknown }).ymaps3 = fake;
    const adapter = new YandexMapAdapter("maps-key", "search-key", "geosuggest-key");

    // Map initialization does not touch Search/Geosuggest configuration at
    // all -- this must succeed even though setApikeys() is broken, proving
    // the two are genuinely decoupled (this is the actual production
    // scenario: the map renders fine while search fails).
    const container = document.createElement("div");
    Object.defineProperty(container, "getBoundingClientRect", {
      value: () => ({ width: 300, height: 230, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} }),
    });
    const controller = await adapter.initialize(container, { center: { latitude: 40.1, longitude: 65.4 }, zoom: 17, onSelect: () => {} });
    expect(controller).toBeTruthy();

    // Only now does the search path hit the broken setApikeys().
    let caught: unknown;
    try {
      await adapter.search("Sharq 19");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MapProviderError);
    expect((caught as MapProviderError).code).toBe("SEARCH_SERVICE_UNAVAILABLE");

    // Classified correctly: the search-recoverable message, never the
    // map-broken claim.
    const message = mapCustomerFacingLocationError(caught, "search");
    expect(message).toBe("Manzilni hozir qidirib bo‘lmadi. Xaritadagi belgingiz saqlandi.");
    expect(message).not.toContain("Xarita hozircha ishlamayapti");
  });

  it("fails safely rather than silently mixing configurations when a later call supplies different key values", async () => {
    const fake = fakeYmaps3();
    (window as unknown as { ymaps3: unknown }).ymaps3 = fake;
    const first = new YandexMapAdapter("maps-key", "search-key-a", "geosuggest-key-a");
    await first.search("first query");
    expect(fake.setApikeysMock).toHaveBeenCalledTimes(1);
    expect(fake.setApikeysMock).toHaveBeenCalledWith({ search: "search-key-a", suggest: "geosuggest-key-a" });

    const second = new YandexMapAdapter("maps-key", "search-key-b", "geosuggest-key-b");
    let caught: unknown;
    try {
      await second.search("second query");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MapProviderError);
    expect((caught as MapProviderError).code).toBe("SEARCH_SERVICE_UNAVAILABLE");
    // The mismatch is rejected outright -- setApikeys is never called a
    // second time with the new (or any) keys, so the cached configuration
    // is never silently overwritten either.
    expect(fake.setApikeysMock).toHaveBeenCalledTimes(1);
  });
});
