import {
  MapProviderError,
  type AddressSuggestion,
  type GeocodingResult,
  type MapAdapter,
  type MapController,
  type MapCoordinate,
} from "./types";

type YandexFeature = {
  geometry?: { coordinates?: unknown };
  properties?: Record<string, unknown>;
};
type YandexSuggestItem = {
  title?: string | { text?: string };
  subtitle?: string | { text?: string };
  uri?: string;
  value?: string;
  address?: {
    formattedAddress?: string;
    component?: Array<{ kind?: string[]; name?: string }>;
  };
};
type YMaps3 = {
  ready: Promise<void>;
  getDefaultConfig(): { setApikeys(keys: { search?: string; suggest?: string }): void };
  search(options: { text?: string | [number, number]; uri?: string; limit?: number }): Promise<YandexFeature[]>;
  suggest(options: { text: string; limit?: number }): Promise<YandexSuggestItem[]>;
  YMap: new (container: HTMLElement, options: unknown) => { addChild(value: unknown): void; destroy(): void };
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

const loadYandex = async (mapsKey: string, searchKey: string, geosuggestKey: string) => {
  const api = await loadYandexCore(mapsKey);
  try {
    api.getDefaultConfig().setApikeys({ search: searchKey, suggest: geosuggestKey });
    diagnostic("Search/Geosuggest configuration succeeded", { searchPresent: Boolean(searchKey), searchLength: searchKey.length, geosuggestPresent: Boolean(geosuggestKey), geosuggestLength: geosuggestKey.length });
  } catch (error) {
    diagnostic("Search/Geosuggest configuration failed", errorDetails(error));
    throw new MapProviderError("READY_FAILED", "Yandex qidiruv xizmatlari sozlanmadi", true);
  }
  return api;
};

const textValue = (value: unknown) => typeof value === "string" ? value : typeof value === "object" && value ? String((value as { text?: unknown }).text || "") : "";
const componentsFrom = (value: unknown): Array<{ kind?: string[]; name?: string }> => Array.isArray(value) ? value as Array<{ kind?: string[]; name?: string }> : [];
const componentValue = (components: Array<{ kind?: string[]; name?: string }>, kinds: string[]) => components.find((component) => component.kind?.some((kind) => kinds.includes(kind)))?.name;

const parseFeature = (feature: YandexFeature, fallback?: YandexSuggestItem): AddressSuggestion | null => {
  const coordinates = feature.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2 || !coordinates.slice(0, 2).every(Number.isFinite)) return null;
  const properties = feature.properties || {};
  const metadata = (properties.metaDataProperty as Record<string, unknown> | undefined)?.GeocoderMetaData as Record<string, unknown> | undefined;
  const address = (metadata?.Address || properties.address || fallback?.address || {}) as Record<string, unknown>;
  const components = componentsFrom(address.Components || address.component || fallback?.address?.component);
  const formattedAddress = String(address.formattedAddress || address.formatted || metadata?.text || properties.description || fallback?.address?.formattedAddress || textValue(fallback?.subtitle) || textValue(fallback?.title) || "");
  const label = String(properties.name || textValue(fallback?.title) || formattedAddress);
  return {
    label,
    formattedAddress: formattedAddress || label,
    coordinate: { longitude: Number(coordinates[0]), latitude: Number(coordinates[1]) },
    providerPlaceId: fallback?.uri || String(properties.uri || "") || undefined,
    district: componentValue(components, ["district", "area", "province"]),
    street: componentValue(components, ["street"]),
    house: componentValue(components, ["house"]),
  };
};

export class YandexMapAdapter implements MapAdapter {
  readonly provider = "yandex" as const;

  constructor(private mapsKey: string, private searchKey: string, private geosuggestKey: string) {
    diagnostic("configuration inspected", { origin: typeof window === "undefined" ? "non-browser" : window.location.origin, mapsPresent: Boolean(mapsKey), mapsLength: mapsKey.length, searchPresent: Boolean(searchKey), searchLength: searchKey.length, geosuggestPresent: Boolean(geosuggestKey), geosuggestLength: geosuggestKey.length });
    if (!mapsKey) throw new MapProviderError("MISSING_CONFIG", "VITE_MAP_PROVIDER=yandex, lekin VITE_YANDEX_MAPS_API_KEY belgilanmagan");
  }

  private api() { return loadYandex(this.mapsKey, this.searchKey, this.geosuggestKey); }
  async load() { await this.api(); }

  async initialize(container: HTMLElement, options: { center: MapCoordinate; zoom: number; selected?: MapCoordinate; onSelect: (coordinate: MapCoordinate) => void }): Promise<MapController> {
    const yandex = await this.api();
    const bounds = container.getBoundingClientRect();
    diagnostic("map initialization started", { width: Math.round(bounds.width), height: Math.round(bounds.height) });
    if (bounds.width <= 0 || bounds.height <= 0) throw new MapProviderError("MAP_CONTAINER_INVALID", "Xarita maydonining o‘lchami noto‘g‘ri", true);
    let map: { addChild(value: unknown): void; destroy(): void } | undefined;
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
      return { setCoordinate: (coordinate) => marker.update({ coordinates: [coordinate.longitude, coordinate.latitude] }), dispose: () => map?.destroy() };
    } catch (error) {
      map?.destroy();
      diagnostic("map initialization failed", errorDetails(error));
      throw new MapProviderError("MAP_INIT_FAILED", error instanceof Error ? `Xarita yaratilmadi: ${error.name}` : "Xarita yaratilmadi", true);
    }
  }

  async search(query: string) {
    const yandex = await this.api();
    if (!this.geosuggestKey) throw new MapProviderError("SUGGEST_CONFIG_MISSING", "Yandex manzil takliflari kaliti sozlanmagan");
    if (!this.searchKey) throw new MapProviderError("SEARCH_CONFIG_MISSING", "Yandex manzil qidiruv kaliti sozlanmagan");
    let suggested: YandexSuggestItem[];
    try {
      suggested = await yandex.suggest({ text: query, limit: 5 });
    } catch (error) {
      diagnostic("Geosuggest request failed", errorDetails(error));
      throw new MapProviderError("SUGGEST_FAILED", `Yandex manzil takliflari olinmadi${error instanceof Error ? `: ${error.name}` : ""}`, true);
    }
    const resolved = await Promise.all(suggested.map(async (suggestion) => {
      try {
        const features = await yandex.search(suggestion.uri ? { uri: suggestion.uri, limit: 1 } : { text: suggestion.address?.formattedAddress || textValue(suggestion.title), limit: 1 });
        return features[0] ? parseFeature(features[0], suggestion) : null;
      } catch (error) {
        diagnostic("Search request failed", errorDetails(error));
        return null;
      }
    }));
    const results = resolved.filter((value): value is AddressSuggestion => Boolean(value));
    if (suggested.length && !results.length) throw new MapProviderError("SEARCH_FAILED", "Yandex manzil natijalarini koordinataga aylantirmadi", true);
    if (!results.length) throw new MapProviderError("NO_RESULTS", "Hech qanday joy topilmadi");
    return results;
  }

  async reverseGeocode(coordinate: MapCoordinate): Promise<GeocodingResult | null> {
    const yandex = await this.api();
    if (!this.searchKey) throw new MapProviderError("SEARCH_CONFIG_MISSING", "Yandex teskari geokodlash kaliti sozlanmagan");
    try {
      const features = await yandex.search({ text: [coordinate.longitude, coordinate.latitude], limit: 1 });
      const result = features[0] ? parseFeature(features[0]) : null;
      return result ? { ...result, coordinate } : null;
    } catch (error) {
      diagnostic("Reverse-geocoding request failed", errorDetails(error));
      throw new MapProviderError("REVERSE_GEOCODING_FAILED", `Yandex pin manzilini aniqlamadi${error instanceof Error ? `: ${error.name}` : ""}`, true);
    }
  }
}
