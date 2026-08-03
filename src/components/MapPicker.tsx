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

  useEffect(() => {
    if (adapter instanceof Error || !container.current) return;
    let disposed = false;
    const defaults = defaultMapLocation();
    void adapter.load()
      .then(() => adapter.initialize(container.current!, { center: { latitude: defaults.latitude, longitude: defaults.longitude }, zoom: defaults.zoom, selected: selectionRef.current.coordinate, onSelect: (coordinate) => void choose(coordinate) }))
      .then((nextController) => { if (disposed) nextController.dispose(); else controller.current = nextController; })
      .catch((error) => emit({ ...selectionRef.current, state: "ERROR", error: error instanceof Error ? error.message : "Xarita yuklanmadi" }));
    return () => { disposed = true; controller.current?.dispose(); };
  }, [adapter, retry, choose, emit]);

  useEffect(() => { if (selection.coordinate) controller.current?.setCoordinate(selection.coordinate); }, [selection.coordinate]);

  if (adapter instanceof Error) return <div className="map-error" role="alert"><b>Xarita sozlanmagan</b><p>{adapter.message}</p></div>;
  return <section className="location-picker" aria-label="Yetkazish joyini xaritada tanlash">
    <div className="map-search"><label className="field"><span>Ko‘cha, joy yoki mo‘ljal qidirish</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Masalan: Amir Temur 24" /></label><button type="button" className="button secondary" disabled={!query.trim() || searching} onClick={async () => { setSearching(true); setResults([]); setSearchMessage(""); try { const found=await adapter.search(query); setResults(found); setSearchMessage(found.length?`${found.length} ta natija`:"Hech qanday joy topilmadi"); } catch (error) { const message=error instanceof Error ? error.message : "Qidiruv ishlamadi"; setSearchMessage(message); emit({ ...selection, state: "ERROR", error: message }); } finally { setSearching(false); } }}>Qidirish</button></div>
    <div aria-live="polite" className="search-status">{searching ? "Qidirilmoqda…" : searchMessage || selection.error || ""}</div>
    {results.length > 0 && <ul className="map-results">{results.map((result) => <li key={result.providerPlaceId || result.label}><button type="button" onClick={() => { setResults([]); controller.current?.setCoordinate(result.coordinate); void choose(result.coordinate); }}><b>{result.label}</b><small>{result.formattedAddress}</small></button></li>)}</ul>}
    <div ref={container} className="map-canvas" role="application" aria-label="Pin qo‘yish uchun interaktiv xarita">Xarita yuklanmoqda…</div>
    {selection.coordinate ? <div className="coordinate-summary" data-testid="coordinate-summary"><span>Tanlangan pin</span><code>{selection.coordinate.latitude.toFixed(6)}, {selection.coordinate.longitude.toFixed(6)}</code><small>Pin yetkazish kirishi yoki mashina bora oladigan eng yaqin nuqtada bo‘lishi kerak.</small></div> : <div className="map-empty" data-testid="map-empty">Xaritadan nuqta tanlang yoki manzilni qidiring.</div>}
    {selection.suggestion && <div className="map-suggestion" data-testid="map-suggestion"><span>Tavsiya etilgan manzil</span><b>{selection.suggestion.formattedAddress}</b><button type="button" onClick={() => onApplySuggestion(selection.suggestion!)}>Tavsiya maydonlarini qo‘llash</button></div>}
    {selection.coordinate && selection.state === "SELECTED" && !selection.suggestion && <p className="warning">Xarita xizmati yozma manzil topmadi. Pin saqlandi; manzil maydonlarini qo‘lda tekshiring.</p>}
    {selection.state === "NEEDS_RECONFIRMATION" && <p className="warning" data-testid="map-reconfirmation">Pin yoki manzil o‘zgardi. Joylashuvni qayta tasdiqlang.</p>}
    {selection.error && <div className="map-error" role="alert"><span>{selection.error}</span><button type="button" onClick={() => { emit({ ...selection, state: selection.coordinate ? "SELECTED" : "NOT_SELECTED", error: undefined }); setRetry((value) => value + 1); }}>Qayta urinish</button></div>}
    <label className="pin-confirm"><input type="checkbox" checked={selection.state === "CONFIRMED"} disabled={!selection.coordinate} onChange={(event) => { explicitlyConfirmed.current = event.target.checked; confirmedCoordinate.current = event.target.checked ? selection.coordinate : undefined; emit(event.target.checked ? confirmSelection(selection) : { ...selection, state: "NEEDS_RECONFIRMATION", confirmedAt: undefined }); }} /><span><b>Pin to‘g‘ri joyda</b><small>Belgi yetkazish kirishi yoki kuryer yetib bora oladigan nuqtani ko‘rsatadi.</small></span></label>
  </section>;
}
