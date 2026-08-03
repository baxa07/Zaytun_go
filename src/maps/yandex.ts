import {
  MapProviderError,
  type AddressSuggestion,
  type GeocodingResult,
  type MapAdapter,
  type MapController,
  type MapCoordinate,
} from "./types";

type YMaps3 = {
  ready: Promise<void>;
  YMap: new (container: HTMLElement, options: unknown) => { addChild(value: unknown): void; destroy(): void };
  YMapDefaultSchemeLayer: new () => unknown;
  YMapDefaultFeaturesLayer: new () => unknown;
  YMapMarker: new (options: unknown, element: HTMLElement) => { update(options: unknown): void };
  YMapListener: new (options: unknown) => unknown;
};

declare global {
  interface Window { ymaps3?: YMaps3 }
}

let loader: Promise<YMaps3> | undefined;

const loadYandex = (key: string) => {
  if (loader) return loader;
  loader = new Promise<YMaps3>((resolve, reject) => {
    const fail = (message: string) => {
      loader = undefined;
      reject(new MapProviderError("LOAD_FAILED", message, true));
    };
    if (window.ymaps3) {
      void window.ymaps3.ready.then(() => resolve(window.ymaps3!)).catch(() => fail("Yandex Maps ishga tushmadi"));
      return;
    }
    const script = document.createElement("script");
    script.src = `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(key)}&lang=uz_UZ`;
    script.async = true;
    script.dataset.zaytunMapLoader = "yandex";
    script.onload = () => {
      if (!window.ymaps3) {
        fail("Yandex Maps global obyekti topilmadi");
        return;
      }
      void window.ymaps3.ready
        .then(() => resolve(window.ymaps3!))
        .catch(() => fail("Yandex Maps ishga tushmadi"));
    };
    script.onerror = () => {
      script.remove();
      fail("Yandex Maps skripti yuklanmadi");
    };
    document.head.append(script);
  });
  return loader;
};

export class YandexMapAdapter implements MapAdapter {
  readonly provider = "yandex" as const;

  constructor(private key: string) {
    if (!key) throw new MapProviderError("MISSING_CONFIG", "VITE_MAP_PROVIDER=yandex, lekin VITE_YANDEX_MAPS_API_KEY belgilanmagan");
  }

  async load() { await loadYandex(this.key); }

  async initialize(container: HTMLElement, options: { center: MapCoordinate; zoom: number; selected?: MapCoordinate; onSelect: (coordinate: MapCoordinate) => void }): Promise<MapController> {
    const yandex = await loadYandex(this.key);
    const map = new yandex.YMap(container, { location: { center: [options.center.longitude, options.center.latitude], zoom: options.zoom }, behaviors: ["drag", "scrollZoom", "pinchZoom", "dblClick"] });
    map.addChild(new yandex.YMapDefaultSchemeLayer());
    map.addChild(new yandex.YMapDefaultFeaturesLayer());
    const element = document.createElement("div");
    element.className = "yandex-pin";
    element.textContent = "📍";
    const start = options.selected || options.center;
    const marker = new yandex.YMapMarker({ coordinates: [start.longitude, start.latitude], draggable: true, onDragEnd: (coordinates: [number, number]) => options.onSelect({ longitude: coordinates[0], latitude: coordinates[1] }) }, element);
    map.addChild(marker);
    map.addChild(new yandex.YMapListener({ layer: "any", onClick: (_layer: unknown, coordinates: [number, number]) => options.onSelect({ longitude: coordinates[0], latitude: coordinates[1] }) }));
    return { setCoordinate: (coordinate) => marker.update({ coordinates: [coordinate.longitude, coordinate.latitude] }), dispose: () => map.destroy() };
  }

  private async geocode(value: string) {
    const url = new URL("https://geocode-maps.yandex.ru/v1/");
    url.searchParams.set("apikey", this.key);
    url.searchParams.set("format", "json");
    url.searchParams.set("lang", "uz_UZ");
    url.searchParams.set("geocode", value);
    const response = await fetch(url);
    if (!response.ok) throw new MapProviderError("GEOCODING_FAILED", "Yandex manzil xizmati javob bermadi", true);
    return response.json() as Promise<Record<string, unknown>>;
  }

  private parse(raw: Record<string, unknown>): AddressSuggestion[] {
    const members = ((((raw.response as Record<string, unknown>)?.GeoObjectCollection as Record<string, unknown>)?.featureMember) || []) as Array<Record<string, unknown>>;
    return members.flatMap((member) => {
      const geoObject = member.GeoObject as Record<string, unknown>;
      const metadata = ((geoObject.metaDataProperty as Record<string, unknown>)?.GeocoderMetaData || {}) as Record<string, unknown>;
      const address = (metadata.Address || {}) as Record<string, unknown>;
      const components = (address.Components || []) as Array<Record<string, string>>;
      const position = String((geoObject.Point as Record<string, unknown>)?.pos || "").split(" ").map(Number);
      if (position.length !== 2 || position.some((value) => !Number.isFinite(value))) return [];
      const part = (kind: string) => components.find((component) => component.kind === kind)?.name;
      return [{
        label: String(metadata.text || geoObject.name || ""),
        formattedAddress: String(metadata.text || geoObject.name || ""),
        coordinate: { longitude: position[0], latitude: position[1] },
        providerPlaceId: String(geoObject.uri || ""),
        district: part("district") || part("province"),
        street: part("street"),
        house: part("house"),
      }];
    });
  }

  async search(query: string) {
    const rows = this.parse(await this.geocode(query));
    if (!rows.length) throw new MapProviderError("NO_RESULTS", "Hech qanday joy topilmadi");
    return rows;
  }

  async reverseGeocode(coordinate: MapCoordinate): Promise<GeocodingResult | null> {
    const rows = this.parse(await this.geocode(`${coordinate.longitude},${coordinate.latitude}`));
    return rows[0] ? { ...rows[0], coordinate } : null;
  }
}
