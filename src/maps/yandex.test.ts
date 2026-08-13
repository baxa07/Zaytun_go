import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MapProviderError } from "./types";
import { YandexMapAdapter } from "./yandex";

// Minimal stand-in for the JS Maps API v3 SDK -- only what initialize()
// still needs (map rendering). Search/suggest/reverse-geocode no longer
// touch this at all -- they call Yandex's REST APIs directly via fetch(),
// mocked below.
function fakeYmaps3(setLocation?: (location: { center: [number, number]; zoom?: number }) => void) {
  return {
    ready: Promise.resolve(),
    YMap: class {
      addChild() {}
      destroy() {}
      setLocation = setLocation;
    },
    YMapDefaultSchemeLayer: class {},
    YMapDefaultFeaturesLayer: class {},
    YMapMarker: class { update() {} },
    YMapListener: class {},
  };
}

function fakeContainer() {
  const container = document.createElement("div");
  Object.defineProperty(container, "getBoundingClientRect", {
    value: () => ({ width: 300, height: 230, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON() {} }),
  });
  return container;
}

const geocodeResponse = (overrides: Record<string, unknown> = {}) => ({
  response: {
    GeoObjectCollection: {
      featureMember: [
        {
          GeoObject: {
            name: "улица Шарк, 19",
            description: "Навои, Узбекистан",
            Point: { pos: "65.403434 40.084673" },
            metaDataProperty: {
              GeocoderMetaData: {
                Address: {
                  formatted: "Узбекистан, Навои, улица Шарк, 19",
                  Components: [
                    { kind: "country", name: "Узбекистан" },
                    { kind: "province", name: "Навоийская область" },
                    { kind: "locality", name: "Навои" },
                    { kind: "street", name: "улица Шарк" },
                    { kind: "house", name: "19" },
                  ],
                },
              },
            },
            ...overrides,
          },
        },
      ],
    },
  },
});

const suggestResponse = () => ({
  results: [
    { title: { text: "Sharq ko‘chasi, 19" }, subtitle: { text: "Navoiy" }, address: { formatted_address: "Navoiy, Sharq ko‘chasi, 19" } },
  ],
});

describe("YandexMapAdapter: REST-backed search/geosuggest/reverse-geocode", () => {
  beforeEach(() => {
    delete (window as unknown as Record<string, unknown>).ymaps3;
    delete (window as unknown as Record<string, unknown>).__zaytunYandexCoreLoader;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as unknown as Record<string, unknown>).ymaps3;
    delete (window as unknown as Record<string, unknown>).__zaytunYandexCoreLoader;
  });

  it("search: geosuggest then geocode-resolves the best candidate, biased toward the configured service area", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://suggest-maps.yandex.ru/")) {
        return new Response(JSON.stringify(suggestResponse()), { status: 200 });
      }
      if (url.startsWith("https://geocode-maps.yandex.ru/")) {
        return new Response(JSON.stringify(geocodeResponse()), { status: 200 });
      }
      throw new Error(`unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new YandexMapAdapter("maps-key", "search-key", "geosuggest-key");
    const results = await adapter.search("Sharq 19");

    expect(results).toHaveLength(1);
    expect(results[0].coordinate).toEqual({ latitude: 40.084673, longitude: 65.403434 });
    // componentValue() (unchanged from the prior SDK-based parseFeature)
    // matches the first of district/area/province present -- this fixture
    // includes "province" but no "district"/"area" kind, matching
    // Yandex's real Geocoder component ordering.
    expect(results[0].district).toBe("Навоийская область");
    expect(results[0].street).toBe("улица Шарк");
    expect(results[0].house).toBe("19");

    const suggestCall = fetchMock.mock.calls.find(([url]) => (url as string).startsWith("https://suggest-maps.yandex.ru/"));
    const geocodeCall = fetchMock.mock.calls.find(([url]) => (url as string).startsWith("https://geocode-maps.yandex.ru/"));
    expect(suggestCall).toBeTruthy();
    expect(geocodeCall).toBeTruthy();
    // Biased toward the configured restaurant/service-area center (mock
    // provider defaults, see vite.config.ts test env) on both requests.
    expect((suggestCall![0] as string)).toContain("ll=");
    expect((suggestCall![0] as string)).toContain("spn=");
    expect((geocodeCall![0] as string)).toContain("ll=65.402551%2C40.087274");
    // Never leaks the key into a log-visible place beyond the URL itself,
    // and never sends the map key to either search endpoint.
    expect((suggestCall![0] as string)).not.toContain("maps-key");
    expect((geocodeCall![0] as string)).not.toContain("maps-key");
  });

  it("a geosuggest failure (non-200) throws SUGGEST_FAILED, classified as a search error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    const adapter = new YandexMapAdapter("maps-key", "search-key", "geosuggest-key");
    let caught: unknown;
    try {
      await adapter.search("Sharq 19");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MapProviderError);
    expect((caught as MapProviderError).code).toBe("SUGGEST_FAILED");
  });

  it("a network failure (fetch throws) is caught and produces a MapProviderError, never an uncaught rejection", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const adapter = new YandexMapAdapter("maps-key", "search-key", "geosuggest-key");
    await expect(adapter.search("Sharq 19")).rejects.toBeInstanceOf(MapProviderError);
  });

  it("reverse-geocode resolves a coordinate to district/street/house via the geocoder REST endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      expect(url).toContain("geocode=65.403434%2C40.084673");
      return new Response(JSON.stringify(geocodeResponse()), { status: 200 });
    }));
    const adapter = new YandexMapAdapter("maps-key", "search-key", "geosuggest-key");
    const result = await adapter.reverseGeocode({ latitude: 40.084673, longitude: 65.403434 });
    expect(result?.street).toBe("улица Шарк");
    expect(result?.coordinate).toEqual({ latitude: 40.084673, longitude: 65.403434 });
  });

  it("map initialization succeeds independently of search -- it never calls fetch at all", async () => {
    (window as unknown as { ymaps3: unknown }).ymaps3 = fakeYmaps3();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new YandexMapAdapter("maps-key", "search-key", "geosuggest-key");
    const controller = await adapter.initialize(fakeContainer(), { center: { latitude: 40.1, longitude: 65.4 }, zoom: 17, onSelect: () => {} });

    expect(controller).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("recenter() calls the SDK's setLocation with the target coordinate and zoom", async () => {
    const setLocation = vi.fn();
    (window as unknown as { ymaps3: unknown }).ymaps3 = fakeYmaps3(setLocation);
    vi.stubGlobal("fetch", vi.fn());

    const adapter = new YandexMapAdapter("maps-key", "search-key", "geosuggest-key");
    const controller = await adapter.initialize(fakeContainer(), { center: { latitude: 40.1, longitude: 65.4 }, zoom: 17, onSelect: () => {} });
    controller.recenter({ latitude: 40.084673, longitude: 65.403434 }, 17);

    expect(setLocation).toHaveBeenCalledWith({ center: [65.403434, 40.084673], zoom: 17 });
  });

  it("recenter() never throws even if the loaded SDK doesn't expose setLocation at all", async () => {
    (window as unknown as { ymaps3: unknown }).ymaps3 = fakeYmaps3(undefined);
    vi.stubGlobal("fetch", vi.fn());

    const adapter = new YandexMapAdapter("maps-key", "search-key", "geosuggest-key");
    const controller = await adapter.initialize(fakeContainer(), { center: { latitude: 40.1, longitude: 65.4 }, zoom: 17, onSelect: () => {} });

    expect(() => controller.recenter({ latitude: 40.084673, longitude: 65.403434 }, 17)).not.toThrow();
  });

  it("search still fails cleanly even if the map core script never loaded (search never depends on window.ymaps3)", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("https://suggest-maps.yandex.ru/")) return new Response(JSON.stringify(suggestResponse()), { status: 200 });
      return new Response(JSON.stringify(geocodeResponse()), { status: 200 });
    }));
    // window.ymaps3 deliberately left undefined -- search must not need it.
    const adapter = new YandexMapAdapter("maps-key", "search-key", "geosuggest-key");
    const results = await adapter.search("Sharq 19");
    expect(results).toHaveLength(1);
  });
});
