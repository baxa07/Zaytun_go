import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { beginReverse, confirmSelection, haversineKm, initialSelection, receiveSuggestion, selectCoordinate } from "../maps/core";
import { mapCustomerFacingLocationError } from "../maps/customerLocationErrorCopy";
import { createMapAdapter, defaultMapLocation } from "../maps/factory";
import type { AddressSuggestion, LocationSource, MapController, MapCoordinate, MapLocationSelection } from "../maps/types";

// A search result further than this from the configured restaurant/service
// area is never auto-applied -- only ever reachable by the customer
// explicitly clicking it in the results list. This exists purely to catch
// an obviously wrong/distant mismatch (a same-named street in a different
// city or country); it is deliberately generous so it never second-guesses
// a genuinely valid address that merely falls outside the delivery radius
// (that is a separate, already-handled concept -- see deliveryZoneResult).
const SEARCH_AUTO_APPLY_RADIUS_KM = 200;
const NO_RESULTS_MESSAGE = "Manzil topilmadi. Boshqacha yozib ko‘ring yoki xaritada belgilang.";

export function MapPicker({ value, onChange, onApplySuggestion }: { value?: MapLocationSelection; onChange: (value: MapLocationSelection) => void; onApplySuggestion: (suggestion: AddressSuggestion) => void }) {
  const adapter = useMemo(() => { try { return createMapAdapter(); } catch (error) { return error as Error; } }, []);
  const container = useRef<HTMLDivElement>(null);
  const controller = useRef<MapController | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<AddressSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState("");
  const [locating, setLocating] = useState(false);
  const [mapState, setMapState] = useState<"LOADING" | "READY" | "ERROR">("LOADING");
  const [mapError, setMapError] = useState("");
  const [retry, setRetry] = useState(0);
  const selection = value || initialSelection("provider" in adapter ? adapter.provider : "yandex");
  const selectionRef = useRef(selection);
  const explicitlyConfirmed = useRef(selection.state === "CONFIRMED");
  const confirmedCoordinate = useRef(selection.state === "CONFIRMED" ? selection.coordinate : undefined);
  const onChangeRef = useRef(onChange);
  useEffect(() => { selectionRef.current = selection; }, [selection]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  const emit = useCallback((next: MapLocationSelection) => {
    selectionRef.current = next;
    onChangeRef.current(next);
  }, []);

  // Single canonical entry point for every way a coordinate can be chosen --
  // a search result, "Joylashuvimni aniqlash", a map tap, or dragging the
  // pin -- so all four feed the same reconfirmation-invalidation and
  // address-population logic instead of three/four separate
  // implementations. `knownSuggestion` lets a search result (which already
  // carries district/street/house/formattedAddress from the search
  // response) skip the redundant reverseGeocode round trip; map taps,
  // drags and geolocation have no such data yet and still resolve it
  // asynchronously.
  const choose = useCallback(async (coordinate: MapCoordinate, source: LocationSource, knownSuggestion?: AddressSuggestion) => {
    const movedFromConfirmed = confirmedCoordinate.current && (confirmedCoordinate.current.latitude !== coordinate.latitude || confirmedCoordinate.current.longitude !== coordinate.longitude);
    const wasConfirmed = Boolean(movedFromConfirmed) || explicitlyConfirmed.current || selectionRef.current.state === "CONFIRMED" || Boolean(selectionRef.current.confirmedAt);
    const selected = { ...selectCoordinate(selectionRef.current, coordinate, source), ...(wasConfirmed ? { state: "NEEDS_RECONFIRMATION" as const, confirmedAt: undefined } : {}) };
    explicitlyConfirmed.current = false;
    if (knownSuggestion) {
      emit(receiveSuggestion(selected, knownSuggestion));
      return;
    }
    emit(beginReverse(selected));
    try {
      const suggestion = await ("reverseGeocode" in adapter ? adapter.reverseGeocode(coordinate) : Promise.resolve(null));
      emit(receiveSuggestion(selected, suggestion));
    } catch (error) {
      emit({ ...selected, state: "ERROR", error: mapCustomerFacingLocationError(error, "reverseGeocode") });
    }
  }, [adapter, emit]);

  // "Use my location" prefill: routes through the same choose() flow as a
  // search-result click or map tap, so the result always lands in SELECTED
  // (never auto-CONFIRMED) -- the customer still explicitly confirms the pin
  // themselves, same as any other selection method.
  const useMyLocation = useCallback(() => {
    if (!("geolocation" in navigator)) {
      setSearchMessage("Bu qurilmada joylashuvni aniqlash imkoniyati yo‘q.");
      return;
    }
    setLocating(true);
    setSearchMessage("");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        const coordinate = { latitude: position.coords.latitude, longitude: position.coords.longitude };
        controller.current?.setCoordinate(coordinate);
        controller.current?.recenter(coordinate, defaultMapLocation().zoom);
        void choose(coordinate, "GEOLOCATION");
      },
      () => {
        setLocating(false);
        setSearchMessage("Joylashuvni aniqlab bo‘lmadi. Xaritadan qo‘lda tanlang yoki qidiring.");
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, [choose]);

  useEffect(() => {
    if (adapter instanceof Error || !container.current) return;
    let disposed = false;
    const defaults = defaultMapLocation();
    void adapter.load()
      .then(() => disposed || !container.current ? undefined : adapter.initialize(container.current, { center: { latitude: defaults.latitude, longitude: defaults.longitude }, zoom: defaults.zoom, selected: selectionRef.current.coordinate, onSelect: (coordinate) => void choose(coordinate, "MAP") }))
      .then((nextController) => { if (!nextController) return; if (disposed) nextController.dispose(); else { controller.current = nextController; setMapState("READY"); setMapError(""); } })
      .catch((error) => { if (!disposed) { setMapState("ERROR"); setMapError(mapCustomerFacingLocationError(error, "map")); } });
    return () => { disposed = true; controller.current?.dispose(); controller.current = undefined; };
  }, [adapter, retry, choose, emit]);

  useEffect(() => { if (selection.coordinate) controller.current?.setCoordinate(selection.coordinate); }, [selection.coordinate]);

  if (adapter instanceof Error) return <div className="map-error" role="alert"><b>Xarita sozlanmagan</b><p>{mapCustomerFacingLocationError(adapter, "map")}</p></div>;

  // One customer-friendly status card instead of several stacked
  // success/warning/error blocks. These four states are provably mutually
  // exclusive: confirmSelection() and beginReverse() (src/maps/core.ts)
  // always clear `error`, and the choose() catch above always pairs
  // state:"ERROR" with a non-empty `error`, so there is never a moment
  // where more than one of these conditions is simultaneously true.
  //
  // "confirmed" here means "a pin exists and nothing's wrong with it" --
  // it covers SELECTED/REVERSE_GEOCODING/SUGGESTION_AVAILABLE/CONFIRMED
  // alike, matching the original coordinate-summary behavior of showing
  // the instant a coordinate is chosen, independent of whether the
  // customer has ticked the confirmation checkbox yet (that's a separate,
  // explicit action below, not what this status card reports).
  const statusVariant: "empty" | "error" | "attention" | "confirmed" = !selection.coordinate
    ? "empty"
    : selection.error
      ? "error"
      : selection.state === "NEEDS_RECONFIRMATION"
        ? "attention"
        : "confirmed";
  const statusTestId = statusVariant === "empty"
    ? "map-empty"
    : statusVariant === "confirmed"
      ? "coordinate-summary"
      : statusVariant === "attention"
        ? "map-reconfirmation"
        : undefined;

  return <section className="location-picker" aria-label="Yetkazish joyini xaritada tanlash">
    <div className="map-search"><label className="field"><span>Ko‘cha, joy yoki mo‘ljal qidirish</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Masalan: Amir Temur 24" /></label><button type="button" className="button secondary" disabled={!query.trim() || searching} onClick={async () => {
      setSearching(true); setResults([]); setSearchMessage("");
      try {
        const found = await adapter.search(query);
        if (!found.length) { setSearchMessage(NO_RESULTS_MESSAGE); return; }
        // Rank by proximity to the configured service area so the closest,
        // most plausible match is what gets auto-applied -- never an
        // arbitrary "first" result from the provider's own ordering.
        const center = defaultMapLocation();
        const ranked = [...found].sort((a, b) => haversineKm(center, a.coordinate) - haversineKm(center, b.coordinate));
        setResults(ranked);
        setSearchMessage(`${ranked.length} ta natija`);
        const best = ranked[0];
        // A successful search drives the map directly -- no second click on
        // a result required for the common case. The full ranked list stays
        // visible below so the customer can pick a different one if this
        // guess is wrong; clicking any entry re-applies through the exact
        // same path. Never auto-applied when the closest match is still
        // implausibly far away (a different city/country mismatch) -- that
        // stays a explicit, customer-driven pick from the list.
        if (haversineKm(center, best.coordinate) <= SEARCH_AUTO_APPLY_RADIUS_KM) {
          controller.current?.setCoordinate(best.coordinate);
          controller.current?.recenter(best.coordinate, center.zoom);
          // The selected result replaces the raw typed query -- otherwise
          // the field keeps showing what the customer typed even though a
          // different (normalized, resolved) address is what's actually
          // selected, which reads as if the search never took effect.
          setQuery(best.label || best.formattedAddress);
          void choose(best.coordinate, "SEARCH", best);
        }
      } catch (error) {
        setSearchMessage(mapCustomerFacingLocationError(error, "search"));
      } finally {
        setSearching(false);
      }
    }}>Qidirish</button></div>
    <button type="button" className="button secondary" data-testid="use-my-location" disabled={locating} onClick={useMyLocation}>{locating ? "Aniqlanmoqda…" : "📍 Joylashuvimni aniqlash"}</button>
    <div aria-live="polite" className="search-status">{searching ? "Manzil qidirilmoqda…" : searchMessage}</div>
    {results.length > 0 && <ul className="map-results">{results.map((result) => <li key={result.providerPlaceId || result.label}><button type="button" onClick={() => { controller.current?.setCoordinate(result.coordinate); controller.current?.recenter(result.coordinate, defaultMapLocation().zoom); setQuery(result.label || result.formattedAddress); void choose(result.coordinate, "SEARCH", result); }}><b>{result.label}</b><small>{result.formattedAddress}</small></button></li>)}</ul>}
    <div className="map-frame"><div ref={container} className="map-canvas" role="application" aria-label="Pin qo‘yish uchun interaktiv xarita"></div>{mapState === "LOADING" && <div className="map-loading" role="status">Xarita yuklanmoqda…</div>}</div>
    {mapState === "ERROR" && <div className="map-error" role="alert"><b>Xarita ishga tushmadi</b><span>{mapError}</span><button type="button" onClick={() => { setMapState("LOADING"); setMapError(""); setRetry((value) => value + 1); }}>Qayta urinish</button></div>}
    <div className={`location-status location-status--${statusVariant}`} data-testid={statusTestId}>
      {statusVariant === "empty" && <span>Xaritadan nuqta tanlang yoki manzilni qidiring.</span>}
      {statusVariant === "error" && <><b>Manzil avtomatik aniqlanmadi</b><span>Manzilni qo‘lda yozing yoki pinni qayta belgilang.</span><button type="button" disabled={!selection.coordinate} onClick={() => selection.coordinate && void choose(selection.coordinate, selection.source || "MAP")}>Qayta urinish</button></>}
      {statusVariant === "attention" && <><b>Manzilni tekshirib chiqing</b><span>Pin kirish joyiga yaqin ekanini tasdiqlang.</span></>}
      {statusVariant === "confirmed" && <><span>✓ Pin belgilandi</span><small>Kuryer boradigan nuqta tanlandi.</small></>}
    </div>
    {selection.suggestion && <div className="map-suggestion-inline" data-testid="map-suggestion"><span>Taklif: {selection.suggestion.formattedAddress}</span><button type="button" onClick={() => onApplySuggestion(selection.suggestion!)}>Manzilni qo‘llash</button></div>}
    <label className="pin-confirm"><input type="checkbox" checked={selection.state === "CONFIRMED"} disabled={!selection.coordinate} onChange={(event) => { explicitlyConfirmed.current = event.target.checked; confirmedCoordinate.current = event.target.checked ? selection.coordinate : undefined; emit(event.target.checked ? confirmSelection(selection) : { ...selection, state: "NEEDS_RECONFIRMATION", confirmedAt: undefined }); }} /><span><b>Kirish joyi xaritada to‘g‘ri belgilangan</b><small>Bu — kuryer yetib boradigan aniq nuqta, yozma manzil emas.</small></span></label>
  </section>;
}
