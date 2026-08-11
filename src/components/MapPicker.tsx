import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { beginReverse, confirmSelection, initialSelection, receiveSuggestion, selectCoordinate } from "../maps/core";
import { createMapAdapter, defaultMapLocation } from "../maps/factory";
import type { AddressSuggestion, MapController, MapLocationSelection } from "../maps/types";

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

  const choose = useCallback(async (coordinate: AddressSuggestion["coordinate"]) => {
    const movedFromConfirmed = confirmedCoordinate.current && (confirmedCoordinate.current.latitude !== coordinate.latitude || confirmedCoordinate.current.longitude !== coordinate.longitude);
    const wasConfirmed = Boolean(movedFromConfirmed) || explicitlyConfirmed.current || selectionRef.current.state === "CONFIRMED" || Boolean(selectionRef.current.confirmedAt);
    const selected = { ...selectCoordinate(selectionRef.current, coordinate), ...(wasConfirmed ? { state: "NEEDS_RECONFIRMATION" as const, confirmedAt: undefined } : {}) };
    explicitlyConfirmed.current = false;
    emit(beginReverse(selected));
    try {
      const suggestion = await ("reverseGeocode" in adapter ? adapter.reverseGeocode(coordinate) : Promise.resolve(null));
      emit(receiveSuggestion(selected, suggestion));
    } catch (error) {
      emit({ ...selected, state: "ERROR", error: error instanceof Error ? error.message : "Manzil aniqlanmadi" });
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
        void choose(coordinate);
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
      .then(() => disposed || !container.current ? undefined : adapter.initialize(container.current, { center: { latitude: defaults.latitude, longitude: defaults.longitude }, zoom: defaults.zoom, selected: selectionRef.current.coordinate, onSelect: (coordinate) => void choose(coordinate) }))
      .then((nextController) => { if (!nextController) return; if (disposed) nextController.dispose(); else { controller.current = nextController; setMapState("READY"); setMapError(""); } })
      .catch((error) => { if (!disposed) { setMapState("ERROR"); setMapError(error instanceof Error ? error.message : "Xarita yuklanmadi"); } });
    return () => { disposed = true; controller.current?.dispose(); controller.current = undefined; };
  }, [adapter, retry, choose, emit]);

  useEffect(() => { if (selection.coordinate) controller.current?.setCoordinate(selection.coordinate); }, [selection.coordinate]);

  if (adapter instanceof Error) return <div className="map-error" role="alert"><b>Xarita sozlanmagan</b><p>{adapter.message}</p></div>;
  return <section className="location-picker" aria-label="Yetkazish joyini xaritada tanlash">
    <div className="map-search"><label className="field"><span>Ko‘cha, joy yoki mo‘ljal qidirish</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Masalan: Amir Temur 24" /></label><button type="button" className="button secondary" disabled={!query.trim() || searching} onClick={async () => { setSearching(true); setResults([]); setSearchMessage(""); try { const found=await adapter.search(query); setResults(found); setSearchMessage(found.length?`${found.length} ta natija`:"Hech qanday joy topilmadi"); } catch (error) { setSearchMessage(error instanceof Error ? error.message : "Qidiruv ishlamadi"); } finally { setSearching(false); } }}>Qidirish</button></div>
    <button type="button" className="button secondary" data-testid="use-my-location" disabled={locating} onClick={useMyLocation}>{locating ? "Aniqlanmoqda…" : "📍 Joylashuvimni aniqlash"}</button>
    <div aria-live="polite" className="search-status">{searching ? "Qidirilmoqda…" : searchMessage}</div>
    {results.length > 0 && <ul className="map-results">{results.map((result) => <li key={result.providerPlaceId || result.label}><button type="button" onClick={() => { setResults([]); controller.current?.setCoordinate(result.coordinate); void choose(result.coordinate); }}><b>{result.label}</b><small>{result.formattedAddress}</small></button></li>)}</ul>}
    <div className="map-frame"><div ref={container} className="map-canvas" role="application" aria-label="Pin qo‘yish uchun interaktiv xarita"></div>{mapState === "LOADING" && <div className="map-loading" role="status">Yandex xaritasi yuklanmoqda…</div>}</div>
    {mapState === "ERROR" && <div className="map-error" role="alert"><b>Xarita ishga tushmadi</b><span>{mapError}</span><button type="button" onClick={() => { setMapState("LOADING"); setMapError(""); setRetry((value) => value + 1); }}>Xaritani qayta yuklash</button></div>}
    {selection.coordinate ? <div className="coordinate-summary" data-testid="coordinate-summary"><span>✓ Kirish nuqtasi xaritada belgilandi</span><small>Pin yetkazish kirishi yoki mashina bora oladigan eng yaqin nuqtada bo‘lishi kerak.</small></div> : <div className="map-empty" data-testid="map-empty">Xaritadan nuqta tanlang yoki manzilni qidiring.</div>}
    {selection.suggestion && <div className="map-suggestion" data-testid="map-suggestion"><span>Tavsiya etilgan manzil</span><b>{selection.suggestion.formattedAddress}</b><button type="button" onClick={() => onApplySuggestion(selection.suggestion!)}>Tavsiya maydonlarini qo‘llash</button></div>}
    {selection.coordinate && selection.state === "SELECTED" && !selection.suggestion && <p className="warning">Xarita xizmati yozma manzil topmadi. Pin saqlandi; manzil maydonlarini qo‘lda tekshiring.</p>}
    {selection.state === "NEEDS_RECONFIRMATION" && <p className="warning" data-testid="map-reconfirmation">Pin yoki manzil o‘zgardi. Joylashuvni qayta tasdiqlang.</p>}
    {selection.error && <div className="map-error" role="alert"><b>Pin manzilini aniqlash ishlamadi</b><span>{selection.error}</span><button type="button" disabled={!selection.coordinate} onClick={() => selection.coordinate && void choose(selection.coordinate)}>Teskari geokodlashni qayta urinish</button></div>}
    <label className="pin-confirm"><input type="checkbox" checked={selection.state === "CONFIRMED"} disabled={!selection.coordinate} onChange={(event) => { explicitlyConfirmed.current = event.target.checked; confirmedCoordinate.current = event.target.checked ? selection.coordinate : undefined; emit(event.target.checked ? confirmSelection(selection) : { ...selection, state: "NEEDS_RECONFIRMATION", confirmedAt: undefined }); }} /><span><b>Kirish joyi xaritada to‘g‘ri belgilangan</b><small>Bu — kuryer yetib boradigan aniq nuqta, yozma manzil emas.</small></span></label>
  </section>;
}
