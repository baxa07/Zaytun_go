import { MapProviderError, type AddressSuggestion, type GeocodingResult, type MapAdapter, type MapController, type MapCoordinate } from "./types";

const points: AddressSuggestion[] = [
  { label: "Amir Temur ko‘chasi 24B, Navoiy", formattedAddress: "Navoiy, Yangiariq MFY, Amir Temur ko‘chasi 24B", coordinate: { latitude: 40.1039, longitude: 65.3688 }, providerPlaceId: "mock-amir-24b", district: "Yangiariq MFY", street: "Amir Temur ko‘chasi", house: "24B" },
  { label: "Navoiy Markaziy bozori", formattedAddress: "Navoiy shahri, Markaziy bozor", coordinate: { latitude: 40.1012, longitude: 65.3721 }, providerPlaceId: "mock-market", district: "Navoiy shahri", street: "Islom Karimov ko‘chasi", house: "Bozor kirishi" },
  { label: "Tashqaridagi test manzili", formattedAddress: "Delivery zone tashqarisi", coordinate: { latitude: 40.45, longitude: 65.8 }, providerPlaceId: "mock-outside", district: "Tashqi hudud", street: "Uzoq ko‘cha", house: "1" },
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
    return { setCoordinate: () => pin.classList.add("selected"), dispose: () => { container.innerHTML = ""; } };
  }
  async search(query: string) { if (query.trim().toLowerCase() === "error") throw new MapProviderError("GEOCODING_FAILED", "Mock qidiruv vaqtincha ishlamayapti", true); return points.filter((point) => point.label.toLowerCase().includes(query.trim().toLowerCase())); }
  async reverseGeocode(coordinate: MapCoordinate): Promise<GeocodingResult | null> { const nearest = points.map((point) => ({ point, distance: Math.hypot(point.coordinate.latitude - coordinate.latitude, point.coordinate.longitude - coordinate.longitude) })).sort((a, b) => a.distance - b.distance)[0]; return nearest?.distance < 0.08 ? { ...nearest.point, coordinate } : null; }
}
export { points as mockLocations };
