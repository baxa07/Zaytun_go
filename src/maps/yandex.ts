import { defaultMapLocation } from "./core";
import {
  MapProviderError,
  type AddressSuggestion,
  type GeocodingResult,
  type MapAdapter,
  type MapController,
  type MapCoordinate,
  type MapProviderErrorCode,
} from "./types";

// The map (rendering/pin/interaction) stays on the JS Maps API v3 SDK --
// only YMap/YMapMarker/etc, nothing search-related.
type YMaps3 = {
  ready: Promise<void>;
  YMap: new (container: HTMLElement, options: unknown) => { addChild(value: unknown): void; destroy(): void; setLocation?(location: { center: [number, number]; zoom?: number; duration?: number }): unknown };
  YMapDefaultSchemeLayer: new (options: Record<string, unknown>) => unknown;
  YMapDefaultFeaturesLayer: new (options: Record<string, unknown>) => unknown;
  YMapMarker: new (options: unknown, element: HTMLElement) => { update(options: unknown): void };
  YMapListener: new (options: unknown) => unknown;
};

declare global {
  interface Window {
    ymaps3?: YMaps3;
    __zaytunYandexCoreLoader?: Promise<YMaps3>;
  }
}

type DiagnosticDetails = Record<string, string | number | boolean | undefined>;
const diagnostic = (event: string, details: DiagnosticDetails = {}) => {
  if (import.meta.env.DEV) console.info(`[ZAYTUN map] ${event}`, details);
};
const errorDetails = (error: unknown): DiagnosticDetails => {
  const record = typeof error === "object" && error ? error as Record<string, unknown> : {};
  const status = record.status ?? record.statusCode ?? (record.response as Record<string, unknown> | undefined)?.status;
  return { errorType: error instanceof Error ? error.name : typeof error, status: typeof status === "number" || typeof status === "string" ? status : undefined };
};

const withReadyTimeout = async (api: YMaps3) => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  diagnostic("ymaps3.ready started");
  try {
    await Promise.race([
      api.ready,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new MapProviderError("READY_TIMEOUT", "Yandex Maps tayyor bo‘lishi juda uzoq davom etdi", true)), 15000);
      }),
    ]);
    diagnostic("ymaps3.ready succeeded");
  } catch (error) {
    diagnostic(error instanceof MapProviderError && error.code === "READY_TIMEOUT" ? "ymaps3.ready timed out" : "ymaps3.ready failed", errorDetails(error));
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
  return api;
};

const loadYandexCore = (mapsKey: string) => {
  if (window.__zaytunYandexCoreLoader) return window.__zaytunYandexCoreLoader;
  const promise = new Promise<YMaps3>((resolve, reject) => {
    const script = window.ymaps3 ? undefined : document.createElement("script");
    const fail = (error: MapProviderError) => {
      diagnostic("core script load failed", { ...errorDetails(error), code: error.code, host: "api-maps.yandex.ru" });
      script?.remove();
      window.__zaytunYandexCoreLoader = undefined;
      reject(error);
    };
    const ready = async (api: YMaps3) => {
      try {
        await withReadyTimeout(api);
        diagnostic("core script load succeeded", { host: "api-maps.yandex.ru" });
        resolve(api);
      } catch (error) {
        fail(error instanceof MapProviderError ? error : new MapProviderError("READY_FAILED", "Yandex Maps ishga tushmadi", true));
      }
    };
    if (window.ymaps3) {
      void ready(window.ymaps3);
      return;
    }
    if (!script) return;
    document.querySelector<HTMLScriptElement>('script[data-zaytun-map-loader="yandex"]')?.remove();
    script.src = `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(mapsKey)}&lang=ru_RU`;
    script.async = true;
    script.dataset.zaytunMapLoader = "yandex";
    diagnostic("core script load started", { host: "api-maps.yandex.ru", origin: window.location.origin });
    script.onload = () => {
      if (!window.ymaps3) {
        fail(new MapProviderError("CORE_LOAD_FAILED", "Yandex Maps asosiy obyekti topilmadi", true));
        return;
      }
      void ready(window.ymaps3);
    };
    script.onerror = () => {
      script.remove();
      fail(new MapProviderError("CORE_LOAD_FAILED", "Yandex Maps asosiy skripti yuklanmadi", true));
    };
    document.head.append(script);
  });
  window.__zaytunYandexCoreLoader = promise;
  return promise;
};

// --- Search / Geosuggest / reverse-geocode: Yandex HTTP REST APIs -------
//
// The JS Maps API v3's own ymaps3.search()/ymaps3.suggest() proved
// unreliable on real production devices (repeated real-device failures
// even after fixing the key-configuration-caching and error-classification
// bugs those calls were tripping over -- see git history). Confirmed
// separately, safely, without exposing any key value:
//   - the exact same production Search and Geosuggest keys succeed
//     (HTTP 200, correct results) against Yandex's classic REST endpoints
//     with the production Referer
//   - both endpoints send Access-Control-Allow-Origin: * and answer GET
//     preflights correctly, so a direct browser fetch() is supported --
//     no proxy/backend needed
// So search/geosuggest/reverse-geocode now call these REST endpoints
// directly. The map itself (YMap/YMapMarker/drag/click) is completely
// unaffected -- it never used these methods.
const GEOCODE_URL = "https://geocode-maps.yandex.ru/v1/";
const SUGGEST_URL = "https://suggest-maps.yandex.ru/v1/suggest";
// Soft bias only -- ranks results near the configured restaurant/service
// area higher without excluding a genuinely valid address elsewhere (that
// is a separate, already-handled concept: deliveryZoneResult). ~0.5
// degrees of span is generous enough to cover the whole surrounding
// region without ever acting as a hard restriction.
const BIAS_SPAN = "0.5,0.5";
const REST_TIMEOUT_MS = 8000;

const textValue = (value: unknown) => typeof value === "string" ? value : typeof value === "object" && value ? String((value as { text?: unknown }).text || "") : "";
const componentsFrom = (value: unknown): Array<{ kind?: string; name?: string }> => Array.isArray(value) ? value as Array<{ kind?: string; name?: string }> : [];
const componentValue = (components: Array<{ kind?: string; name?: string }>, kinds: string[]) => components.find((component) => component.kind && kinds.includes(component.kind))?.name;

const fetchYandexRest = async (url: string, params: Record<string, string>, code: MapProviderErrorCode, message: string): Promise<unknown> => {
  const query = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${url}?${query}`, { signal: controller.signal });
  } catch (error) {
    diagnostic(`${code} request threw`, errorDetails(error));
    if (import.meta.env.DEV) console.error(`[ZAYTUN map] raw ${code} network error (dev-only, never logged in production, never shown to the customer):`, error);
    throw new MapProviderError(code, message, true);
  } finally {
    clearTimeout(timeoutId);
  }
  if (!response.ok) {
    diagnostic(`${code} request failed`, { status: response.status });
    throw new MapProviderError(code, message, true);
  }
  try {
    return await response.json();
  } catch (error) {
    diagnostic(`${code} response was not valid JSON`, errorDetails(error));
    throw new MapProviderError(code, message, true);
  }
};

// Yandex's classic Geocoder response wraps each hit in a GeoObject with
// Point.pos as a SPACE-separated "lon lat" string (not an array), and
// structured components at metaDataProperty.GeocoderMetaData.Address --
// this shape (and its lowercase Component `kind` values, e.g. "house",
// "street", "locality") is stable and well documented.
const parseGeoObject = (geoObject: unknown): AddressSuggestion | null => {
  if (!geoObject || typeof geoObject !== "object") return null;
  const go = geoObject as Record<string, unknown>;
  const point = go.Point as Record<string, unknown> | undefined;
  const pos = typeof point?.pos === "string" ? point.pos : "";
  const [lonRaw, latRaw] = pos.split(" ");
  const longitude = Number(lonRaw);
  const latitude = Number(latRaw);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  const metaDataProperty = go.metaDataProperty as Record<string, unknown> | undefined;
  const geocoderMetaData = metaDataProperty?.GeocoderMetaData as Record<string, unknown> | undefined;
  const address = (geocoderMetaData?.Address || {}) as Record<string, unknown>;
  const components = componentsFrom(address.Components);
  const formattedAddress = String(address.formatted || go.description || go.name || "");
  const label = String(go.name || formattedAddress);
  return {
    label,
    formattedAddress: formattedAddress || label,
    coordinate: { latitude, longitude },
    district: componentValue(components, ["district", "area", "province"]),
    street: componentValue(components, ["street"]),
    house: componentValue(components, ["house"]),
  };
};

const geocodeRest = async (searchKey: string, geocodeParam: string, bias: MapCoordinate, code: MapProviderErrorCode, message: string): Promise<AddressSuggestion[]> => {
  const data = await fetchYandexRest(GEOCODE_URL, {
    apikey: searchKey,
    geocode: geocodeParam,
    format: "json",
    ll: `${bias.longitude},${bias.latitude}`,
    spn: BIAS_SPAN,
  }, code, message);
  const members = (data as { response?: { GeoObjectCollection?: { featureMember?: unknown[] } } })?.response?.GeoObjectCollection?.featureMember;
  if (!Array.isArray(members)) return [];
  return members
    .map((member) => parseGeoObject((member as { GeoObject?: unknown })?.GeoObject))
    .filter((value): value is AddressSuggestion => Boolean(value));
};

type RestSuggestCandidate = { title: string; formattedAddress: string };
const suggestRest = async (geosuggestKey: string, query: string, bias: MapCoordinate): Promise<RestSuggestCandidate[]> => {
  const data = await fetchYandexRest(SUGGEST_URL, {
    apikey: geosuggestKey,
    text: query,
    print_address: "1",
    types: "geo",
    results: "3",
    ll: `${bias.longitude},${bias.latitude}`,
    spn: BIAS_SPAN,
  }, "SUGGEST_FAILED", "Yandex manzil takliflari olinmadi");
  const results = (data as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  return results
    .slice(0, 3)
    .map((result) => {
      const r = result as Record<string, unknown>;
      const address = r.address as Record<string, unknown> | undefined;
      const title = textValue(r.title);
      const formattedAddress = String(address?.formatted_address || textValue(r.subtitle) || title || "");
      return { title, formattedAddress };
    })
    .filter((candidate) => candidate.title);
};

export class YandexMapAdapter implements MapAdapter {
  readonly provider = "yandex" as const;

  constructor(private mapsKey: string, private searchKey: string, private geosuggestKey: string) {
    diagnostic("configuration inspected", { origin: typeof window === "undefined" ? "non-browser" : window.location.origin, mapsPresent: Boolean(mapsKey), mapsLength: mapsKey.length, searchPresent: Boolean(searchKey), searchLength: searchKey.length, geosuggestPresent: Boolean(geosuggestKey), geosuggestLength: geosuggestKey.length });
    if (!mapsKey) throw new MapProviderError("MISSING_CONFIG", "VITE_MAP_PROVIDER=yandex, lekin VITE_YANDEX_MAPS_API_KEY belgilanmagan");
  }

  private core() { return loadYandexCore(this.mapsKey); }
  async load() { await this.core(); }

  async initialize(container: HTMLElement, options: { center: MapCoordinate; zoom: number; selected?: MapCoordinate; onSelect: (coordinate: MapCoordinate) => void }): Promise<MapController> {
    const yandex = await this.core();
    const bounds = container.getBoundingClientRect();
    diagnostic("map initialization started", { width: Math.round(bounds.width), height: Math.round(bounds.height) });
    if (bounds.width <= 0 || bounds.height <= 0) throw new MapProviderError("MAP_CONTAINER_INVALID", "Xarita maydonining o‘lchami noto‘g‘ri", true);
    let map: { addChild(value: unknown): void; destroy(): void; setLocation?(location: { center: [number, number]; zoom?: number; duration?: number }): unknown } | undefined;
    try {
      container.replaceChildren();
      map = new yandex.YMap(container, { location: { center: [options.center.longitude, options.center.latitude], zoom: options.zoom }, behaviors: ["drag", "scrollZoom", "pinchZoom", "dblClick"] });
      map.addChild(new yandex.YMapDefaultSchemeLayer({}));
      map.addChild(new yandex.YMapDefaultFeaturesLayer({}));
      const element = document.createElement("div");
      element.className = "yandex-pin";
      element.textContent = "📍";
      const start = options.selected || options.center;
      const marker = new yandex.YMapMarker({ coordinates: [start.longitude, start.latitude], draggable: true, onDragEnd: (coordinates: [number, number]) => options.onSelect({ longitude: coordinates[0], latitude: coordinates[1] }) }, element);
      map.addChild(marker);
      map.addChild(new yandex.YMapListener({ layer: "any", onClick: (_layer: unknown, coordinates: [number, number]) => options.onSelect({ longitude: coordinates[0], latitude: coordinates[1] }) }));
      diagnostic("map initialization succeeded");
      return {
        setCoordinate: (coordinate) => marker.update({ coordinates: [coordinate.longitude, coordinate.latitude] }),
        // Camera move is a best-effort enhancement layered on top of
        // already-correct pin placement/address resolution -- if the SDK
        // doesn't expose setLocation() (or it throws), the pin and address
        // are still exactly right, the customer just needs to pan/zoom
        // manually to see it, so this never breaks the rest of the flow.
        recenter: (coordinate, zoom) => {
          try {
            map?.setLocation?.({ center: [coordinate.longitude, coordinate.latitude], zoom });
          } catch (error) {
            diagnostic("map recenter failed", errorDetails(error));
          }
        },
        dispose: () => map?.destroy(),
      };
    } catch (error) {
      map?.destroy();
      diagnostic("map initialization failed", errorDetails(error));
      throw new MapProviderError("MAP_INIT_FAILED", error instanceof Error ? `Xarita yaratilmadi: ${error.name}` : "Xarita yaratilmadi", true);
    }
  }

  async search(query: string) {
    if (!this.geosuggestKey) throw new MapProviderError("SUGGEST_CONFIG_MISSING", "Yandex manzil takliflari kaliti sozlanmagan");
    if (!this.searchKey) throw new MapProviderError("SEARCH_CONFIG_MISSING", "Yandex manzil qidiruv kaliti sozlanmagan");
    const bias = defaultMapLocation();
    // Geosuggest returns text completions + address components, never
    // coordinates, so a follow-up geocode call is genuinely required to
    // resolve each candidate to a coordinate -- not avoidable without a
    // different Yandex product. Resolving more candidates than a small
    // mobile results list needs isn't: capped at 3.
    const suggested = await suggestRest(this.geosuggestKey, query, bias);
    const resolved = await Promise.all(suggested.map(async (candidate) => {
      try {
        const results = await geocodeRest(this.searchKey, candidate.formattedAddress || candidate.title, bias, "SEARCH_FAILED", "Yandex manzil natijalarini koordinataga aylantirmadi");
        return results[0] || null;
      } catch (error) {
        diagnostic("Geocode resolution for a suggestion failed", errorDetails(error));
        return null;
      }
    }));
    const results = resolved.filter((value): value is AddressSuggestion => Boolean(value));
    if (suggested.length && !results.length) throw new MapProviderError("SEARCH_FAILED", "Yandex manzil natijalarini koordinataga aylantirmadi", true);
    if (!results.length) throw new MapProviderError("NO_RESULTS", "Hech qanday joy topilmadi");
    return results;
  }

  async reverseGeocode(coordinate: MapCoordinate): Promise<GeocodingResult | null> {
    if (!this.searchKey) throw new MapProviderError("SEARCH_CONFIG_MISSING", "Yandex teskari geokodlash kaliti sozlanmagan");
    try {
      const results = await geocodeRest(this.searchKey, `${coordinate.longitude},${coordinate.latitude}`, coordinate, "REVERSE_GEOCODING_FAILED", "Yandex pin manzilini aniqlamadi");
      return results[0] ? { ...results[0], coordinate } : null;
    } catch (error) {
      diagnostic("Reverse-geocoding request failed", errorDetails(error));
      throw error instanceof MapProviderError ? error : new MapProviderError("REVERSE_GEOCODING_FAILED", "Yandex pin manzilini aniqlamadi", true);
    }
  }
}
