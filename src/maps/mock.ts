import { MapProviderError, type AddressSuggestion, type GeocodingResult, type MapAdapter, type MapController, type MapCoordinate } from "./types";

const points: AddressSuggestion[] = [
  { label: "Amir Temur ko‘chasi 24B, Navoiy", formattedAddress: "Navoiy, Yangiariq MFY, Amir Temur ko‘chasi 24B", coordinate: { latitude: 40.1039, longitude: 65.3688 }, providerPlaceId: "mock-amir-24b", district: "Yangiariq MFY", street: "Amir Temur ko‘chasi", house: "24B" },
  { label: "Navoiy Markaziy bozori", formattedAddress: "Navoiy shahri, Markaziy bozor", coordinate: { latitude: 40.1012, longitude: 65.3721 }, providerPlaceId: "mock-market", district: "Navoiy shahri", street: "Islom Karimov ko‘chasi", house: "Bozor kirishi" },
  { label: "Tashqaridagi test manzili", formattedAddress: "Delivery zone tashqarisi", coordinate: { latitude: 40.45, longitude: 65.8 }, providerPlaceId: "mock-outside", district: "Tashqi hudud", street: "Uzoq ko‘cha", house: "1" },
  // Two results, both genuinely far (~354km) from the configured service
  // area -- neither auto-applies, so a query matching both is the one
  // deterministic way to exercise "list stays open, customer taps one" in
  // tests, since every other fixture point is close enough to auto-apply
  // (and thus close its own list) the instant it's searched.
  { label: "Toshkentdagi ofis, 1", formattedAddress: "Toshkent shahri, Chilonzor tumani, 1", coordinate: { latitude: 41.311081, longitude: 69.279737 }, providerPlaceId: "mock-tashkent-1", district: "Chilonzor tumani", street: "Bunyodkor shoh ko‘chasi", house: "1" },
  { label: "Toshkentdagi ofis, 2", formattedAddress: "Toshkent shahri, Chilonzor tumani, 2", coordinate: { latitude: 41.32, longitude: 69.29 }, providerPlaceId: "mock-tashkent-2", district: "Chilonzor tumani", street: "Bunyodkor shoh ko‘chasi", house: "2" },
];

export class MockMapAdapter implements MapAdapter {
  readonly provider = "mock" as const;
  async load() {}
  async initialize(container: HTMLElement, options: { center: MapCoordinate; zoom: number; selected?: MapCoordinate; onSelect: (coordinate: MapCoordinate) => void }): Promise<MapController> {
    container.innerHTML = "";
    const surface = document.createElement("button");
    surface.type = "button";
    surface.className = "mock-map-surface";
    surface.dataset.testid = "map-picker-set";
    surface.setAttribute("aria-label", "Mock xaritada pin joylashuvini tanlash");
    const pin = document.createElement("span"); pin.className = "mock-pin"; pin.textContent = "📍"; surface.append(pin);
    surface.addEventListener("click", (event) => {
      const rect = surface.getBoundingClientRect();
      options.onSelect({ latitude: options.center.latitude + (0.5 - (event.clientY - rect.top) / Math.max(rect.height, 1)) * 0.02, longitude: options.center.longitude + ((event.clientX - rect.left) / Math.max(rect.width, 1) - 0.5) * 0.02 });
    });
    container.append(surface);
    // Exposed as data attributes (not a visual camera -- this is a static
    // mock background) purely so tests can assert whether/where a recenter
    // happened, same as production's real map camera move.
    return {
      setCoordinate: () => pin.classList.add("selected"),
      recenter: (coordinate, zoom) => {
        surface.dataset.cameraLat = String(coordinate.latitude);
        surface.dataset.cameraLng = String(coordinate.longitude);
        if (zoom !== undefined) surface.dataset.cameraZoom = String(zoom);
      },
      dispose: () => { container.innerHTML = ""; },
    };
  }
  async search(query: string) {
    const normalized = query.trim().toLowerCase();
    if (normalized === "error") throw new MapProviderError("GEOCODING_FAILED", "Mock qidiruv vaqtincha ishlamayapti", true);
    // Simulates the exact production bug this adapter's search-config
    // caching fixed: a Search/Geosuggest-path failure while the map core
    // itself is already loaded and working -- must classify as a search
    // error, never a map error, and must never disturb an existing valid
    // selection.
    if (normalized === "service-down") throw new MapProviderError("SEARCH_SERVICE_UNAVAILABLE", "Mock qidiruv xizmati sozlanmagan", true);
    return points.filter((point) => point.label.toLowerCase().includes(normalized));
  }
  async reverseGeocode(coordinate: MapCoordinate): Promise<GeocodingResult | null> { const nearest = points.map((point) => ({ point, distance: Math.hypot(point.coordinate.latitude - coordinate.latitude, point.coordinate.longitude - coordinate.longitude) })).sort((a, b) => a.distance - b.distance)[0]; return nearest?.distance < 0.08 ? { ...nearest.point, coordinate } : null; }
}
export { points as mockLocations };
