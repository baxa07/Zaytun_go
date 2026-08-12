// Translates raw MapProviderError/adapter failures into clean Uzbek
// customer-facing text, keyed on the stable `.code` (never on message
// text or `.name`, which can leak provider names / env var names / raw JS
// error classes -- see src/maps/yandex.ts's error messages for what this
// is deliberately hiding). Mirrors mapCustomerAuthError/mapDriverAuthError
// in src/state.tsx: same shape, same "never show the raw message" rule.
import { MapProviderError, type MapProviderErrorCode } from "./types";

export type LocationErrorContext = "search" | "map" | "reverseGeocode";

const SEARCH_CODES: MapProviderErrorCode[] = [
  "SEARCH_FAILED",
  "SUGGEST_FAILED",
  "SEARCH_CONFIG_MISSING",
  "SUGGEST_CONFIG_MISSING",
  "GEOCODING_FAILED",
];
const MAP_CODES: MapProviderErrorCode[] = [
  "MISSING_CONFIG",
  "CORE_LOAD_FAILED",
  "READY_TIMEOUT",
  "READY_FAILED",
  "MAP_CONTAINER_INVALID",
  "MAP_INIT_FAILED",
  "UNAVAILABLE",
];

export function mapCustomerFacingLocationError(error: unknown, context: LocationErrorContext): string {
  const code = error instanceof MapProviderError ? error.code : undefined;
  if (code === "NO_RESULTS") return "Hech qanday joy topilmadi.";
  if (code ? SEARCH_CODES.includes(code) : context === "search") {
    return "Manzilni avtomatik aniqlab bo‘lmadi. Manzilni yozing yoki xaritada nuqtani qayta belgilang.";
  }
  if (code ? MAP_CODES.includes(code) : context === "map") {
    return "Xarita hozircha ishlamayapti. Birozdan keyin qayta urinib ko‘ring yoki manzilni qo‘lda yozing.";
  }
  return "Manzil avtomatik aniqlanmadi. Manzilni qo‘lda yozing yoki pinni qayta belgilang.";
}
