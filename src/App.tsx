import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useLocation,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  calculateOrderTotal,
  canTransition,
  checkoutFingerprint,
  createEvent,
  deliveryAddressWasResubmitted,
  driverGreetingName,
  isDeliveryAddressRevisable,
  publicMenuState,
  resolvePendingCheckoutId,
  validateDeliveryLocation,
  validateOrderInput,
  HISTORY_PAGE_SIZE,
  canSubmitOrderFeedback,
  driverAcceptsNewWork,
  deriveDriverOperationalState,
  type ActorType,
  type AddressConfidence,
  type AssignmentDeclineReason,
  type CustomerAddress,
  type Driver,
  type DriverAvailability,
  type DriverLedgerEntry,
  type DriverLedgerSummaryRow,
  type FeedbackDeliveryIssueReason,
  type FeedbackDeliveryRating,
  type FeedbackFoodIssueReason,
  type FeedbackFoodRating,
  type HistoryDatePreset,
  type MenuItem,
  type Order,
  type OrderHistoryFilters,
  type OrderHistoryRow,
  type OrderHistorySummary,
  type OrderStatus,
  type PaymentCollectionStatus,
  type PaymentMethod,
  type PendingCheckout,
  type RestaurantConfig,
  type DriverStandbyNotice,
  type PickupBatchContext,
  type DriverOperationalState,
} from "./domain";
import { useApp, CustomerAuthRequiredError } from "./state";
import { extractUzbekNationalDigits, normalizeUzbekPhone } from "./phone";
import { supabaseConfigured, getStoredTrackingToken, setStoredTrackingToken } from "./supabase";
import { subscribeToOrderTracking, subscribeToDriverStandby } from "./realtime";
import { MapPicker } from "./components/MapPicker";
import { ProductImage } from "./components/ProductImage";
import { TurnstileWidget } from "./components/TurnstileWidget";
import {
  addressConfidence,
  applySuggestion,
  haversineKm,
  initialSelection,
  materialAddressChange,
} from "./maps/core";
import { configuredMapProvider } from "./maps/factory";
import { navigationUrl } from "./maps/navigation";
import type { AddressSuggestion, MapLocationSelection } from "./maps/types";
import { createUuid } from "./uuid";
import { fulfillmentSummary, homeFulfillmentCopy } from "./fulfillment";
import {customerDeliveryStageEventMatchers,customerDeliveryStageIndex,customerDeliveryStages,declineReasonLabels,deliveryDispatchPhase,deliveryDispatchPhaseLabels,fulfillmentStatusLabel,fulfillmentTimeline,isNormalDeliveryStatus,isRemotePaymentMethod,orderExceptions,paymentLabel,paymentMethodsForFulfillment,pickupPaymentGuidance,remotePaymentCustomerNotice,remotePaymentStaffHint,type OrderExceptionKind} from './fulfillmentLifecycle'
import{requestApplicationUpdate,UPDATE_EVENT}from'./pwa'

const money = (n: number) => new Intl.NumberFormat("uz-UZ").format(n) + " so‘m";
// UI-only guard against obvious resend-button hammering -- Supabase's own
// hosted per-phone/per-IP rate limits (see docs/production-readiness.md)
// are the actual enforcement; this just avoids firing requests the server
// would reject anyway.
const DRIVER_OTP_RESEND_COOLDOWN_SECONDS = 30;
const time = (s: string) =>
  new Intl.DateTimeFormat("uz-UZ", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(s));
// H1: Order History spans multiple days, so its rows need a date alongside
// the time -- rendered in the viewing staff member's own browser, same as
// every other on-screen timestamp in this app (only the History RPC's date
// *range* boundaries are computed server-side, in business time).
const historyDateTime = (s: string) =>
  new Intl.DateTimeFormat("uz-UZ", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(s));
// Checkout idempotency persistence: sessionStorage (not localStorage) so a
// genuinely new tab/session never inherits a stale pending id, but the SAME
// tab surviving a reload does. Read/write live only here; the fingerprint
// match/mismatch decision itself is the pure, unit-tested
// resolvePendingCheckoutId in domain.ts.
const PENDING_CHECKOUT_KEY = "zgo.pendingCheckout";
const readPendingCheckout = (): PendingCheckout | null => {
  try {
    const raw = sessionStorage.getItem(PENDING_CHECKOUT_KEY);
    return raw ? (JSON.parse(raw) as PendingCheckout) : null;
  } catch {
    return null;
  }
};
const writePendingCheckout = (value: PendingCheckout) => {
  try {
    sessionStorage.setItem(PENDING_CHECKOUT_KEY, JSON.stringify(value));
  } catch {
    /* sessionStorage unavailable (private mode, quota) -- checkout still works, just without reload/retry id stability */
  }
};
const clearPendingCheckout = () => {
  try {
    sessionStorage.removeItem(PENDING_CHECKOUT_KEY);
  } catch {
    /* nothing to clean up if sessionStorage was never reachable */
  }
};
const statusLabels: Record<OrderStatus, string> = {
  NEW: "Yangi",
  CONFIRMED: "Tasdiqlangan",
  PREPARING: "Tayyorlanmoqda",
  READY: "Tayyor",
  COLLECTED: "Olib ketildi",
  DRIVER_ASSIGNED: "Haydovchi biriktirilgan",
  PICKED_UP: "Olib ketildi",
  ON_THE_WAY: "Yo‘lda",
  ARRIVED: "Yetib keldi",
  DELIVERED: "Yetkazildi",
  REJECTED: "Rad etildi",
  CANCELLED: "Bekor qilindi",
  DELIVERY_FAILED: "Yetkazilmadi",
  RETURNED: "Qaytarildi",
};
// PICKED_UP (courier picked the order up from the restaurant) and
// COLLECTED (customer picked their own order up) share the same flat
// statusLabels string ("Olib ketildi") even though they're unrelated
// events. That's harmless everywhere else statusLabels is used today --
// each surface only ever renders one order type -- except this
// event-history list, which is genuinely shared across both. Disambiguate
// only PICKED_UP here, without touching the flat map itself (also used
// by the driver's own status badge, which must keep reading "Olib
// ketildi") or any other status's wording.
const eventStatusLabel = (status: OrderStatus) =>
  status === "PICKED_UP" ? "Kuryer olib ketdi" : statusLabels[status];
const actorLabels: Record<ActorType, string> = {
  CUSTOMER: "Mijoz",
  RESTAURANT: "Oshxona",
  DISPATCHER: "Operator",
  DRIVER: "Haydovchi",
  SYSTEM: "Tizim",
};
// Free-text reporter identifiers used at DeliveryIssue creation call sites
// (e.g. "restaurant", "driver-1") -- a display-only translation, never
// changes the stored value, and falls back to the raw string for anything
// unrecognized rather than hiding it.
const reportedByLabel = (reportedBy: string) =>
  reportedBy === "restaurant" ? "Oshxona"
  : reportedBy.startsWith("driver") ? "Haydovchi"
  : reportedBy === "customer" ? "Mijoz"
  : reportedBy;
const addressConfidenceLabels: Record<AddressConfidence, string> = {
  COMPLETE: "To‘liq",
  NEEDS_CLARIFICATION: "Aniqlashtirish kerak",
  CUSTOMER_CONFIRMATION_REQUIRED: "Mijoz tasdiqlashi kerak",
};
const deliveryZoneLabels: Record<NonNullable<CustomerAddress["deliveryZoneResult"]>, string> = {
  ELIGIBLE: "Yetkazish hududida",
  OUTSIDE_ZONE: "Hududdan tashqarida",
  DELIVERY_DISABLED: "Yetkazish o‘chirilgan",
};
const paymentStatusLabels: Record<PaymentCollectionStatus, string> = {
  NOT_REQUIRED: "Talab qilinmaydi",
  PENDING: "Kutilmoqda",
  COLLECTED: "Olindi",
  FAILED: "Muvaffaqiyatsiz",
};
const driverAvailabilityLabels: Record<DriverAvailability, string> = {
  AVAILABLE: "Bo‘sh",
  BUSY: "Band",
  OFFLINE: "Oflayn",
};
const deliveryReviewBadges: Partial<Record<NonNullable<Order["deliveryReviewStatus"]>, { label: string; className: string }>> = {
  REVIEW_REQUIRED: { label: "Manzil tekshirilmoqda", className: "review-required" },
  CLARIFICATION_REQUESTED: { label: "Manzil aniqlashtirilmoqda", className: "clarification-requested" },
  APPROVED: { label: "Manzil tasdiqlangan", className: "review-approved" },
};
const issueLabels: Record<string, string> = {
  ADDRESS_INCORRECT: "Manzil noto‘g‘ri",
  CUSTOMER_NOT_ANSWERING: "Mijoz javob bermayapti",
  PAYMENT_PROBLEM: "To‘lov muammosi",
  ADDRESS_CLARIFICATION: "Manzilni aniqlashtirish kerak",
};
// P5.15: exceptions stand out more than normal progress -- this banner is
// a compact, scannable index; the actual actionable controls stay exactly
// where they already were (delivery-review panel, driver section, etc.),
// so this never duplicates the full explanatory text, only summarizes.
const orderExceptionLabels: Record<OrderExceptionKind, (order: Order) => string> = {
  ADDRESS_REVIEW: () => "⚠ Manzil tekshiruvi kerak",
  ADDRESS_CLARIFICATION: () => "⚠ Mijozdan aniqlashtirish kutilmoqda",
  DELIVERY_FAILED: () => "⚠ Yetkazishda muammo bo‘ldi",
  RETURNED: () => "⚠ Buyurtma qaytarildi",
  REMOTE_PAYMENT_PENDING: (order) => `⚠ ${paymentLabel(order.paymentMethod, true)} — to‘lovni tasdiqlang`,
  COURIER_WAITING: () => "⏳ Kuryer kutilmoqda",
};
function OrderExceptionBanner({ order }: { order: Order }) {
  const flags = orderExceptions(order);
  if (flags.length === 0) return null;
  return (
    <div className="exception-banner" data-testid="order-exception-banner">
      {flags.map((flag) => (
        <span key={flag} className={`exception-chip exception-${flag.toLowerCase()}`} data-testid={`exception-${flag}`}>
          {orderExceptionLabels[flag](order)}
        </span>
      ))}
    </div>
  );
}
const Badge = ({ status }: { status: OrderStatus }) => (
  <span className={`badge s-${status.toLowerCase()}`}>
    {statusLabels[status]}
  </span>
);
const OrderBadge=({order}:{order:Order})=><span className={`badge s-${order.status.toLowerCase()}`}>{fulfillmentStatusLabel(order)||statusLabels[order.status]}</span>
function UpdateNotice(){const[ready,setReady]=useState(false);useEffect(()=>{const show=()=>setReady(true);window.addEventListener(UPDATE_EVENT,show);return()=>window.removeEventListener(UPDATE_EVENT,show)},[]);return ready?<div className="update-notice" role="status"><span>Ilovaning yangi xavfsiz versiyasi tayyor.</span><button type="button" onClick={requestApplicationUpdate}>Yangilash</button></div>:null}
function Shell({
  children,
  surface = "customer",
}: {
  children: React.ReactNode;
  surface?: "customer" | "staff" | "driver";
}) {
  const { cart } = useApp();
  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  return (
    <div className={`app ${surface}`}>
      <header>
        <Link className="brand" to="/">
          <img src="/icon.svg" />{" "}
          <span>
            ZAYTUN <b>GO</b>
          </span>
        </Link>
        <nav>
          {surface === "customer" ? (
            <>
              <NavLink to="/menu">Menyu</NavLink>
              <NavLink to="/cart">Savat{cartCount > 0 ? ` · ${cartCount}` : ""}</NavLink>
              <NavLink to="/track/ord-new">Kuzatish</NavLink>
            </>
          ) : (
            <>
              <NavLink to="/menu">Buyurtma</NavLink>
              <NavLink to="/restaurant">Restoran</NavLink>
              <NavLink to="/driver">Haydovchi</NavLink>
            </>
          )}
        </nav>
      </header>
      {children}
    </div>
  );
}
function Home() {
  const { publicConfig } = useApp();
  const copy = homeFulfillmentCopy(publicConfig);
  return (
    <Shell>
      <main className="home">
        <section>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h1>Sevimli taomlaringiz, aniq va tez.</h1>
          <p>{copy.supporting}</p>
          {publicConfig?.operatingHours.everyday && <p className="muted">Har kuni: {publicConfig.operatingHours.everyday}</p>}
          <div className="actions">
            <Link className="button primary" to="/menu">
              Menyuni ochish
            </Link>
            <Link className="button secondary" to="/track/ord-new">
              Buyurtmani kuzatish
            </Link>
          </div>
        </section>
        <div className="hero-food">
          🫒<span>{publicConfig ? copy.timing : "Vaqt aniqlanmoqda"}</span>
        </div>
      </main>
    </Shell>
  );
}
function Menu() {
  const location = useLocation();
  const menuNavigation = location.state as { categoryId?: string; cartNotice?: string } | null;
  const [active, setActive] = useState(menuNavigation?.categoryId || "grill");
  const { cart, categories, menuItems, publicDataReady, publicDataError } = useApp();
  const menuState=publicMenuState(publicDataReady,publicDataError,categories.length,menuItems.length);
  useEffect(()=>{if(categories.length&&!categories.some(category=>category.id===active))setActive(categories[0].id)},[active,categories]);
  return (
    <Shell>
      <main className="page">
        <div className="page-title">
          <div>
            <p className="eyebrow">ZAYTUN CAFE</p>
            <h1>Bugun nima yeymiz?</h1>
          </div>
          <Link className="cart-pill" to="/cart" data-testid="cart-pill">
            Savat · {cart.reduce((s, x) => s + x.quantity, 0)}
          </Link>
        </div>
        <div className="chips">
          {categories.map((c) => (
            <button
              className={active === c.id ? "active" : ""}
              onClick={() => setActive(c.id)}
              key={c.id}
            >
              {c.name}
            </button>
          ))}
        </div>
        {menuNavigation?.cartNotice && <p className="success-notice" role="status">{menuNavigation.cartNotice}</p>}
        {menuState==='LOADING' && <div className="empty" role="status">Menyu yuklanmoqda…</div>}
        {menuState==='UNPUBLISHED' && <div className="empty" role="status" data-testid="menu-unpublished"><b>Menyu hali e’lon qilinmagan.</b><span>Taomlar tayyor bo‘lgach shu yerda ko‘rinadi.</span></div>}
        {menuState==='ERROR' && <div className="map-error" role="alert"><b>Menyuni yuklab bo‘lmadi</b><span>{publicDataError}</span><button type="button" onClick={()=>window.location.reload()}>Qayta yuklash</button></div>}
        <div className="menu-grid">
          {menuItems
            .filter((i) => i.categoryId === active)
            .map((i) => (
              <MenuCard key={i.id} item={i} />
            ))}
        </div>
      </main>
    </Shell>
  );
}
export function MenuCard({ item }: { item: MenuItem }) {
  return (
    <article className="menu-card">
      <Link to={`/menu/${item.id}`} className="food-img">
        <ProductImage image={item.image} name={item.name} />
      </Link>
      <div>
        <h3>{item.name}</h3>
        <p>{item.description}</p>
        <footer>
          <b>{money(item.price)}</b>
          <Link
            aria-label={`${item.name} tanlash`}
            to={`/menu/${item.id}`}
            className="round"
          >
            +
          </Link>
        </footer>
      </div>
    </article>
  );
}
function Product() {
  const { id } = useParams();
  const { menuItems, publicDataReady, addToCart, publicConfig } = useApp();
  const item = menuItems.find((i) => i.id === id);
  const nav = useNavigate();
  const [q, setQ] = useState(1);
  const [mods, setMods] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [adding, setAdding] = useState(false);
  const addingRef = useRef(false);
  if (!publicDataReady) return <Shell><main className="narrow"><div className="empty">Taom yuklanmoqda…</div></main></Shell>;
  if (!item) return <Navigate to="/menu" />;
  const unit =
    item.price +
    (item.modifiers || [])
      .filter((m) => mods.includes(m.id))
      .reduce((s, m) => s + m.price, 0);
  const addConfiguredItem = (destination: "/menu" | "/checkout") => {
    if (addingRef.current) return;
    addingRef.current = true;
    setAdding(true);
    flushSync(() => addToCart({id:createUuid(),menuItemId:item.id,name:item.name,unitPrice:unit,quantity:q,modifierIds:mods,modifierNames:(item.modifiers||[]).filter(m=>mods.includes(m.id)).map(m=>m.name),instructions:note}));
    nav(destination,destination==="/menu"?{state:{categoryId:item.categoryId,cartNotice:"Savatga qo‘shildi."}}:undefined);
  };
  return (
    <Shell>
      <main className="narrow">
        <Link to="/menu" className="back">
          ← Menyu
        </Link>
        <div className="product-hero"><ProductImage image={item.image} name={item.name} /></div>
        <h1>{item.name}</h1>
        <p>{item.description}</p>
        {item.modifiers?.map((m) => (
          <label className="check" key={m.id}>
            <input
              type="checkbox"
              checked={mods.includes(m.id)}
              onChange={() =>
                setMods((v) =>
                  v.includes(m.id) ? v.filter((x) => x !== m.id) : [...v, m.id],
                )
              }
            />
            <span>{m.name}</span>
            <b>{m.price ? `+ ${money(m.price)}` : "Bepul"}</b>
          </label>
        ))}
        <label className="field">
          <span>Maxsus ko‘rsatma</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Masalan: piyozsiz"
          />
        </label>
        <div className="sticky-action">
          <div className="stepper">
            <button onClick={() => setQ(Math.max(1, q - 1))}>−</button>
            <b>{q}</b>
            <button onClick={() => setQ(Math.min(publicConfig?.maximumItemQuantity||50,q + 1))}>+</button>
          </div>
          <div className="product-action-buttons">
            <button className="button secondary" type="button" data-testid="add-to-cart" disabled={adding} onClick={() => addConfiguredItem("/menu")}>Savatga qo‘shish</button>
            <button className="button primary" type="button" data-testid="buy-now" disabled={adding} onClick={() => addConfiguredItem("/checkout")}>Hozir buyurtma berish · {money(unit*q)}</button>
          </div>
        </div>
      </main>
    </Shell>
  );
}
function Cart() {
  const { cart, updateQuantity, publicConfig } = useApp();
  const subtotal = calculateOrderTotal(cart);
  const fulfillment = fulfillmentSummary(publicConfig?.deliveryEnabled === true ? "DELIVERY" : "PICKUP");
  return (
    <Shell>
      <main className="narrow">
        <h1>Savat</h1>
        {!cart.length ? (
          <div className="empty">
            <span>🥡</span>
            <h2>Savat bo‘sh</h2>
            <Link className="button primary" to="/menu">
              Menyuga qaytish
            </Link>
          </div>
        ) : (
          <>
            <div className="stack">
              {cart.map((i) => (
                <article className="line-item" key={i.id}>
                  <div>
                    <h3>{i.name}</h3>
                    <small>
                      {i.modifierNames.join(", ")}{" "}
                      {i.instructions && `· ${i.instructions}`}
                    </small>
                    <b>{money(i.unitPrice * i.quantity)}</b>
                  </div>
                  <div className="stepper">
                    <button onClick={() => updateQuantity(i.id, -1)}>−</button>
                    <b>{i.quantity}</b>
                    <button disabled={i.quantity>=(publicConfig?.maximumItemQuantity||50)} onClick={() => updateQuantity(i.id, 1)}>+</button>
                  </div>
                </article>
              ))}
            </div>
            <div className="summary">
              <span>Taomlar</span>
              <b>{money(subtotal)}</b>
              <span>{fulfillment.label}</span>
              <b>{fulfillment.value}</b>
            </div>
            <div className="sticky-action">
              <Link
                className="button primary wide"
                to="/checkout"
                data-testid="go-to-checkout"
              >
                Rasmiylashtirish
              </Link>
            </div>
          </>
        )}
      </main>
    </Shell>
  );
}
const blankAddress: CustomerAddress = {
  customerName: "",
  primaryPhone: "",
  secondaryPhone: "",
  district: "",
  street: "",
  house: "",
  entrance: "",
  floor: "",
  apartment: "",
  landmark: "",
  deliveryNotes: "",
  latitude: undefined,
  longitude: undefined,
  confidence: "CUSTOMER_CONFIRMATION_REQUIRED",
};
function applyMapSelectionToAddress(address: CustomerAddress, selection: MapLocationSelection, publicConfig: RestaurantConfig | null): CustomerAddress {
  const coordinate = selection.coordinate;
  const center = publicConfig ? { latitude: publicConfig.restaurantLatitude, longitude: publicConfig.restaurantLongitude } : undefined;
  const distance = coordinate && center ? haversineKm(center, coordinate) : undefined;
  const zone = publicConfig?.deliveryPolicyMode === "MANUAL_CITY_REVIEW" && coordinate
    ? "ELIGIBLE"
    : distance === undefined || !publicConfig || publicConfig.deliveryRadiusKm == null
      ? undefined
      : distance <= publicConfig.deliveryRadiusKm ? "ELIGIBLE" : "OUTSIDE_ZONE";
  return {
    ...address,
    latitude: coordinate?.latitude,
    longitude: coordinate?.longitude,
    pinConfirmedAt: selection.confirmedAt,
    locationProvider: selection.provider,
    providerPlaceId: selection.suggestion?.providerPlaceId,
    providerFormattedAddress: selection.suggestion?.formattedAddress,
    deliveryDistanceKm: distance,
    deliveryZoneResult: zone,
    confidence: addressConfidence(selection, Boolean(address.district && address.street && address.house), zone === "ELIGIBLE", !selection.suggestion),
  };
}
function DeliveryAddressFields({
  address,
  errors,
  set,
  mapSelection,
  updateMapSelection,
  onApplySuggestion,
}: {
  address: CustomerAddress;
  errors: Record<string, string>;
  set: (key: keyof CustomerAddress, value: string | number) => void;
  mapSelection: MapLocationSelection;
  updateMapSelection: (selection: MapLocationSelection) => void;
  onApplySuggestion: (suggestion: AddressSuggestion) => void;
}) {
  // Starts collapsed on a fresh checkout (blankAddress has every optional
  // field empty); starts open when reopening a form that already has
  // optional data (e.g. AddressRevisionEditor editing an existing order)
  // so previously-entered details are never hidden from the customer. This
  // is component-local UI state only -- the actual field values always
  // live in the parent's `address` state, so toggling never discards or
  // resets anything, whether or not the disclosure's content is mounted.
  const [detailsOpen, setDetailsOpen] = useState(
    () => Boolean(address.entrance || address.floor || address.apartment || address.landmark || address.deliveryNotes),
  );
  // Automatic map-derived autofill: the instant a coordinate resolves (via
  // search, geolocation, or a manual pin move/drag -- MapPicker routes all
  // three through the same choose() pipeline), district/street/house
  // become authoritative from THAT resolved location, replacing whatever
  // was there before -- never merged with a prior, now-stale value. A
  // customer who searched Location A, saw its address populate, then
  // searched or dragged the pin to Location B must see B's address, not a
  // mix of A and B -- a pin at one coordinate with written text describing
  // a different one is exactly the failure this guards against. Courier-
  // specific fields (entrance/floor/apartment/landmark/notes) are never
  // touched here -- applySuggestion (src/maps/core.ts) only ever writes
  // district/street/house. Tracked by suggestion object identity so this
  // fires once per genuinely new resolution, not on every unrelated
  // re-render. Distinct from the explicit "Manzilni qo'llash" button below,
  // which lets the customer force-reapply the same suggestion again after
  // manually editing a field, without needing to re-resolve the pin.
  const autoFilledSuggestion = useRef<AddressSuggestion | undefined>(undefined);
  const [autoFillNotice, setAutoFillNotice] = useState(false);
  useEffect(() => {
    const suggestion = mapSelection.suggestion;
    if (!suggestion || suggestion === autoFilledSuggestion.current) return;
    autoFilledSuggestion.current = suggestion;
    const resolved = applySuggestion({ district: address.district, street: address.street, house: address.house }, suggestion);
    let changedAny = false;
    (["district", "street", "house"] as const).forEach((key) => {
      if (resolved[key] !== address[key]) {
        set(key, resolved[key]);
        changedAny = true;
      }
    });
    if (changedAny) {
      setAutoFillNotice(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapSelection.suggestion]);
  return (
    <>
      <MapPicker
        value={mapSelection}
        onChange={updateMapSelection}
        onApplySuggestion={onApplySuggestion}
      />
      {errors.coordinates && (
        <em className="error">{errors.coordinates}</em>
      )}
      {errors.pinConfirmation && (
        <em className="error">{errors.pinConfirmation}</em>
      )}
      {(errors.deliveryZone || address.deliveryZoneResult === "OUTSIDE_ZONE") && (
        <em className="error" data-testid="delivery-zone-error">
          {errors.deliveryZone || "Bu manzil yetkazish hududidan tashqarida."}
        </em>
      )}
      {autoFillNotice && (
        <p className="success-notice" role="status" data-testid="address-autofilled-notice">
          Manzil xaritadan aniqlandi
        </p>
      )}
      <Field
        label="Mahalla yoki tuman *"
        value={address.district}
        error={errors.district}
        onChange={(v) => set("district", v)}
      />
      <Field
        label="Ko‘cha yoki joylashuv *"
        value={address.street}
        error={errors.street}
        onChange={(v) => set("street", v)}
      />
      <Field
        label="Uy / bino (ixtiyoriy)"
        value={address.house}
        placeholder="Masalan: 24 yoki savdo markazi"
        onChange={(v) => set("house", v)}
      />
      <button
        type="button"
        className="button text disclosure-toggle"
        aria-expanded={detailsOpen}
        aria-controls="address-optional-details"
        data-testid="address-optional-toggle"
        onClick={() => setDetailsOpen((open) => !open)}
      >
        Qo‘shimcha ma’lumotlar (ixtiyoriy) {detailsOpen ? "▲" : "▼"}
      </button>
      {detailsOpen && (
        <div id="address-optional-details" data-testid="address-optional-details">
          <div className="field-row">
            <Field
              label="Kirish"
              value={address.entrance || ""}
              onChange={(v) => set("entrance", v)}
            />
            <Field
              label="Qavat"
              value={address.floor || ""}
              onChange={(v) => set("floor", v)}
            />
            <Field
              label="Xonadon"
              value={address.apartment || ""}
              onChange={(v) => set("apartment", v)}
            />
          </div>
          <Field
            label="Mo‘ljal (ixtiyoriy)"
            value={address.landmark}
            onChange={(v) => set("landmark", v)}
          />
          <Field
            label="Yetkazish izohi (ixtiyoriy)"
            value={address.deliveryNotes}
            onChange={(v) => set("deliveryNotes", v)}
          />
        </div>
      )}
    </>
  );
}
function Checkout() {
  const { cart, submitOrder, clearCart, publicConfig, session, isCustomerAuthenticated, sendCustomerOtp, verifyCustomerOtp, signOut } = useApp();
  const nav = useNavigate();
  const [type, setType] = useState<"DELIVERY" | "PICKUP">("DELIVERY");
  const [address, setAddress] = useState(blankAddress);
  const [payment, setPayment] = useState<PaymentMethod>("CASH");
  const [notes, setNotes] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [mapSelection, setMapSelection] = useState<MapLocationSelection>(() =>
    initialSelection(configuredMapProvider()),
  );
  // Inline phone-OTP step: rendered in place (never a route change) so that
  // submitting a checkout that turns out to require auth never unmounts this
  // component and never discards address/payment/notes/mapSelection, which
  // all live only in this component's local state.
  const [otpStep, setOtpStep] = useState<null | "phone" | "code">(null);
  const [otpPhone, setOtpPhone] = useState("");
  const [otpCanonicalPhone, setOtpCanonicalPhone] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [otpError, setOtpError] = useState("");
  const [otpBusy, setOtpBusy] = useState(false);
  // CAPTCHA gates only the SEND (signInWithOtp) call, never verifyOtp.
  // Turnstile tokens are single-use, so otpCaptchaResetKey is bumped after
  // every send attempt (success or failure) to force TurnstileWidget to
  // remount and issue a fresh token for the next attempt -- simpler than
  // plumbing an imperative reset() through a ref for this one use.
  const [otpCaptchaToken, setOtpCaptchaToken] = useState<string | null>(null);
  const [otpCaptchaResetKey, setOtpCaptchaResetKey] = useState(0);
  // No fallback/default sitekey -- an unconfigured CAPTCHA disables sending
  // entirely (see the otp-captcha-unavailable branch below) rather than
  // silently sending without one. Deliberately unset on production for now
  // (customer_auth_required stays false there, so this step never renders
  // in production yet either way); local/CI environments set it to
  // Cloudflare's public always-pass Turnstile test sitekey.
  const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || "";
  const pendingOrderRef = useRef<Order | null>(null);
  // submitOrder's identity changes the instant isCustomerAuthenticated flips
  // true (see state.tsx's useMemo deps), but the OTP-verify click handler is
  // already running by then -- its closure stays pinned to whatever
  // submitOrder looked like when the click started, so a naive call would
  // silently resubmit through the still-unauthenticated closure and loop
  // back into the OTP step. Always read the latest submitOrder through this
  // ref instead of the destructured value above.
  const submitOrderRef = useRef(submitOrder);
  useEffect(() => {
    submitOrderRef.current = submitOrder;
  }, [submitOrder]);
  // The single canonical source for the verified customer's phone: never
  // assume the client-side session representation is bare digits and
  // manually prefix '+' -- reuse the same normalizer used everywhere else,
  // so a representation change between environments can't produce a
  // malformed value like "++998...". Feeds both the checkout autofill and
  // the masked display below; only the masking itself is a separate,
  // display-only concern.
  const verifiedPhone = session?.user?.phone ? normalizeUzbekPhone(session.user.phone) : null;
  useEffect(() => {
    if (isCustomerAuthenticated && verifiedPhone) {
      setAddress((a) => (a.primaryPhone === verifiedPhone ? a : { ...a, primaryPhone: verifiedPhone }));
    }
  }, [isCustomerAuthenticated, verifiedPhone]);
  const allowedPayments=useMemo(()=>publicConfig?paymentMethodsForFulfillment(publicConfig,type):['CASH'] as PaymentMethod[],[publicConfig,type]);
  useEffect(()=>{if(!allowedPayments.includes(payment))setPayment(allowedPayments[0]||'CASH');if(publicConfig?.deliveryEnabled===false)setType('PICKUP')},[allowedPayments,payment,publicConfig]);
  const submittingRef = useRef(false);
  const subtotal = calculateOrderTotal(cart);
  const estimatedFee = type === "DELIVERY" && publicConfig && (publicConfig.freeDeliveryThreshold == null || subtotal < publicConfig.freeDeliveryThreshold) ? publicConfig.baseDeliveryFee : 0;
  const total = calculateOrderTotal(cart, estimatedFee);
  const fulfillment = fulfillmentSummary(type);
  const clearError = (key: string) =>
    setErrors((er) =>
      er[key]
        ? Object.fromEntries(Object.entries(er).filter(([k]) => k !== key))
        : er,
    );
  const set = (key: keyof CustomerAddress, value: string | number) => {
    const material = ["district", "street", "house"].includes(key);
    setAddress((a) => ({
      ...a,
      [key]: value,
      ...(material && a.pinConfirmedAt
        ? { pinConfirmedAt: undefined, confidence: "CUSTOMER_CONFIRMATION_REQUIRED" as const }
        : {}),
    }));
    if (material)
      setMapSelection((s) => materialAddressChange(s));
    clearError(key);
  };
  const updateMapSelection = (selection: MapLocationSelection) => {
    setMapSelection(selection);
    setAddress((a) => applyMapSelectionToAddress(a, selection, publicConfig));
    clearError("coordinates");
    clearError("pinConfirmation");
    clearError("deliveryZone");
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    const found = validateOrderInput(type, address, payment);
    if(!cart.length)found.cart='Savat bo‘sh. Avval taom tanlang.';
    if(!allowedPayments.includes(payment))found.paymentMethod='Bu buyurtma turi uchun to‘lov usulini qayta tanlang.';
    if (type === "DELIVERY" && publicConfig && subtotal < publicConfig.minimumDeliverySubtotal) {
      found.deliveryMinimum = `Yetkazib berish uchun eng kam buyurtma ${money(publicConfig.minimumDeliverySubtotal)}.`;
    }
    setErrors(found);
    if (Object.keys(found).length || !cart.length) {
      document
        .querySelector(".error")
        ?.closest(".field")
        ?.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    // Idempotency: reuse the pending checkout's id/idempotencyKey across a
    // reload or a same-session retry (network timeout, ambiguous response,
    // etc.) as long as it's still materially the same order. Persisted
    // *before* the RPC fires, so an interrupted request still has its key
    // sitting in sessionStorage for the retry to find. A fingerprint
    // mismatch (cart/address/payment genuinely changed) always mints a
    // fresh id -- an old pending id can never bind to different contents.
    const fingerprint = checkoutFingerprint(type, cart, payment, type === "DELIVERY" ? address : undefined);
    const id = resolvePendingCheckoutId(fingerprint, readPendingCheckout());
    writePendingCheckout({ id, fingerprint });
    const order: Order = {
      id,
      number: `ZG-${String(Date.now()).slice(-4)}`,
      customer: {
        id: createUuid(),
        name: address.customerName,
        primaryPhone: address.primaryPhone,
        secondaryPhone: address.secondaryPhone,
      },
      type,
      address: type === "DELIVERY" ? address : undefined,
      items: cart.map((x) => ({ ...x, total: x.unitPrice * x.quantity })),
      subtotal: calculateOrderTotal(cart),
      deliveryFee: estimatedFee,
      total,
      paymentMethod: payment,
      paymentStatus: "PENDING",
      specialInstructions: notes,
      status: "NEW",
      deliveryReviewStatus: type === "DELIVERY" ? "REVIEW_REQUIRED" : "NOT_REQUIRED",
      createdAt: new Date().toISOString(),
      events: [createEvent(id, null, "NEW", "CUSTOMER", "guest")],
      issues: [],
      assignmentHistory: [],
    };
    await finishSubmit(order);
  };
  // Shared by the initial form submit and by the OTP-verified retry, so a
  // customer_auth_required checkout resumes exactly where it left off
  // instead of re-running validation or asking the user to press submit
  // again.
  const finishSubmit = async (order: Order) => {
    try {
      const saved = await submitOrderRef.current(order);
      // Only a genuine success clears the pending-checkout id -- the
      // CustomerAuthRequiredError branch below and the generic failure
      // branch both deliberately leave it in place so a retry (or the
      // OTP-verified resubmission) still reuses the same id instead of
      // minting a new one and risking a second order.
      clearPendingCheckout();
      clearCart();
      nav(`/confirmation/${saved.id}`);
    } catch (error) {
      if (error instanceof CustomerAuthRequiredError) {
        pendingOrderRef.current = order;
        setOtpError("");
        setOtpPhone(address.primaryPhone || "");
        setOtpStep("phone");
        submittingRef.current = false;
        setSubmitting(false);
        return;
      }
      const message = error instanceof Error ? error.message : "Buyurtma yuborilmadi";
      setErrors({ submit: message.includes("|") ? message.split("|").at(-1)! : message });
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  const handleSendOtp = async () => {
    if (!otpCaptchaToken) return;
    setOtpError("");
    setOtpBusy(true);
    const captchaToken = otpCaptchaToken;
    try {
      const canonical = await sendCustomerOtp(otpPhone, captchaToken);
      setOtpCanonicalPhone(canonical);
      setOtpCode("");
      setOtpStep("code");
    } catch (error) {
      setOtpError(error instanceof Error ? error.message : "Xatolik yuz berdi");
    } finally {
      setOtpBusy(false);
      // The token is single-use regardless of outcome -- clear it and force
      // a fresh widget so the next attempt (initial send or resend) always
      // has to present a new one, never a stale/already-spent token.
      setOtpCaptchaToken(null);
      setOtpCaptchaResetKey((key) => key + 1);
    }
  };
  const handleVerifyOtp = async () => {
    setOtpError("");
    setOtpBusy(true);
    try {
      await verifyCustomerOtp(otpCanonicalPhone, otpCode);
      setOtpStep(null);
      setOtpCode("");
      const order = pendingOrderRef.current;
      pendingOrderRef.current = null;
      if (order) {
        submittingRef.current = true;
        setSubmitting(true);
        await finishSubmit({
          ...order,
          customer: { ...order.customer, primaryPhone: otpCanonicalPhone },
        });
      }
    } catch (error) {
      setOtpError(error instanceof Error ? error.message : "Xatolik yuz berdi");
    } finally {
      setOtpBusy(false);
    }
  };
  return (
    <Shell>
      <main className="checkout">
        <Link to="/cart" className="back">
          ← Savat
        </Link>
        <h1>Buyurtmani rasmiylashtirish</h1>
        <form onSubmit={submit}>
          <section className="form-card">
            <h2>Qanday olasiz?</h2>
            <div className="segmented">
              <button
                type="button"
                data-testid="type-delivery"
                disabled={publicConfig?.deliveryEnabled===false}
                className={type === "DELIVERY" ? "active" : ""}
                onClick={() => setType("DELIVERY")}
              >
                Yetkazib berish
              </button>
              <button
                type="button"
                data-testid="type-pickup"
                className={type === "PICKUP" ? "active" : ""}
                onClick={() => setType("PICKUP")}
              >
                Olib ketish
              </button>
            </div>
            {publicConfig?.deliveryEnabled===false&&<p className="warning">Yetkazib berish vaqtincha o‘chirilgan. Olib ketishni tanlang.</p>}
            {type === "DELIVERY" && publicConfig?.deliveryPolicyMode === "MANUAL_CITY_REVIEW" && (
              <p className="pilot-notice" data-testid="delivery-review-notice">
                {publicConfig.deliveryReviewMessage || "Navoiy shahri bo‘ylab yetkazib berish 150.000 so‘mdan oshiq xaridlarda bepul. Undan kam buyurtmalarga 10.000 so‘m yetkazib berish narxi qo‘shiladi. Manzil operator tomonidan tasdiqlanadi."}
              </p>
            )}
            {errors.deliveryMinimum && <em className="error">{errors.deliveryMinimum}</em>}
          </section>
          <section className="form-card">
            <h2>Aloqa</h2>
            {isCustomerAuthenticated && (
              <p className="customer-session" data-testid="customer-session-badge">
                {formatMaskedPhone(verifiedPhone)}{" "}
                <button
                  type="button"
                  className="button text"
                  data-testid="customer-sign-out"
                  onClick={() => signOut()}
                >
                  Chiqish
                </button>
              </p>
            )}
            <Field
              label="Ism *"
              value={address.customerName}
              error={errors.customerName}
              onChange={(v) => set("customerName", v)}
            />
            {isCustomerAuthenticated ? (
              <Field
                label="Telefon *"
                value={formatMaskedPhone(verifiedPhone)}
                error={errors.primaryPhone}
                onChange={() => {}}
                readOnly
              />
            ) : (
              <UzbekPhoneField
                label="Telefon *"
                value={address.primaryPhone}
                error={errors.primaryPhone}
                onChange={(v) => set("primaryPhone", v)}
              />
            )}
            <Field
              label="Qo‘shimcha telefon"
              value={address.secondaryPhone || ""}
              onChange={(v) => set("secondaryPhone", v)}
            />
          </section>
          {type === "DELIVERY" && (
            <section className="form-card">
              <h2>Yetkazib berish manzilini belgilang</h2>
              <p className="form-card-lead">Kuryer yetib boradigan aniq nuqtani xaritada ko‘rsating.</p>
              <DeliveryAddressFields
                address={address}
                errors={errors}
                set={set}
                mapSelection={mapSelection}
                updateMapSelection={updateMapSelection}
                onApplySuggestion={(suggestion) => {
                  setAddress((a) => ({
                    ...applySuggestion(a, suggestion),
                    providerPlaceId: suggestion.providerPlaceId,
                    providerFormattedAddress: suggestion.formattedAddress,
                    pinConfirmedAt: undefined,
                    confidence: "CUSTOMER_CONFIRMATION_REQUIRED",
                  }));
                  setMapSelection((s) => materialAddressChange(s));
                }}
              />
            </section>
          )}
          <section className="form-card">
            <h2>To‘lov</h2>
            {allowedPayments.includes('CASH')&&<label className="radio">
              <input
                type="radio"
                checked={payment === "CASH"}
                onChange={() => {
                  setPayment("CASH");
                  clearError("paymentMethod");
                }}
              />
              Naqd pul
            </label>}
            {type==='PICKUP'&&allowedPayments.includes('CARD_AT_PICKUP')&&<label className="radio">
              <input
                type="radio"
                checked={payment === "CARD_AT_PICKUP"}
                onChange={() => {
                  setPayment("CARD_AT_PICKUP");
                  clearError("paymentMethod");
                }}
              />
              Restoranda karta orqali
            </label>}
            {type==='DELIVERY'&&allowedPayments.includes('CLICK')&&<label className="radio">
              <input
                type="radio"
                checked={payment === "CLICK"}
                onChange={() => {
                  setPayment("CLICK");
                  clearError("paymentMethod");
                }}
              />
              💳 Click
            </label>}
            {type==='DELIVERY'&&allowedPayments.includes('PAYME')&&<label className="radio">
              <input
                type="radio"
                checked={payment === "PAYME"}
                onChange={() => {
                  setPayment("PAYME");
                  clearError("paymentMethod");
                }}
              />
              💳 Payme
            </label>}
            {isRemotePaymentMethod(payment) && (
              <p className="pilot-notice" data-testid="remote-payment-notice">
                {remotePaymentCustomerNotice}
              </p>
            )}
            <Field label="Buyurtma izohi" value={notes} onChange={setNotes} />
          </section>
          <section className="form-card review">
            <h2>Tekshirish</h2>
            {cart.map((i) => (
              <div key={i.id}>
                <span>
                  {i.quantity} × {i.name}
                </span>
                <b>{money(i.quantity * i.unitPrice)}</b>
              </div>
            ))}
            <div>
              <span>{fulfillment.label}</span>
              <b>{type === "DELIVERY" ? money(estimatedFee) : fulfillment.value}</b>
            </div>
            <div data-testid="review-payment-method"><span>To‘lov</span><b>{paymentLabel(payment)}</b></div>
            <div className="total" data-testid="estimated-total">
              <span>Taxminiy jami</span>
              <b>{money(total)}</b>
            </div>
            <small>{type === "DELIVERY"
              ? "Yakuniy narx menyu va yetkazish sozlamalari asosida serverda tasdiqlanadi."
              : "Yakuniy narx menyu narxlari asosida serverda tasdiqlanadi."}</small>
          </section>
          {!otpStep && (
            <button
              className="button primary wide"
              type="submit"
              data-testid="checkout-submit"
              disabled={submitting}
            >
              {submitting ? "Yuborilmoqda…" : "Buyurtmani yuborish"}
            </button>
          )}
          {errors.submit && <p className="error" role="alert">{errors.submit}</p>}
          {errors.cart && <p className="error" role="alert">{errors.cart}</p>}
          {errors.paymentMethod && <p className="error" role="alert">{errors.paymentMethod}</p>}
          {otpStep && (
            <section className="form-card otp-step" data-testid="customer-otp-step">
              <h2>Telefon raqamingizni tasdiqlang</h2>
              {turnstileSiteKey ? (
                <TurnstileWidget
                  key={otpCaptchaResetKey}
                  siteKey={turnstileSiteKey}
                  onVerify={setOtpCaptchaToken}
                  onExpire={() => {
                    setOtpCaptchaToken(null);
                    setOtpError("Tasdiqlash muddati tugadi. Qaytadan urinib ko‘ring.");
                  }}
                  onError={() => {
                    setOtpCaptchaToken(null);
                    setOtpError("Xavfsizlik tekshiruvini yuklab bo‘lmadi. Internetni tekshiring.");
                  }}
                />
              ) : (
                <p className="error" role="alert" data-testid="otp-captcha-unavailable">
                  Xavfsizlik tekshiruvi sozlanmagan. Birozdan keyin qayta urinib ko‘ring.
                </p>
              )}
              {otpStep === "phone" && (
                <>
                  <Field
                    label="Telefon"
                    value={otpPhone}
                    placeholder="+998 __ ___ __ __"
                    onChange={setOtpPhone}
                  />
                  <button
                    type="button"
                    className="button primary wide"
                    data-testid="otp-send"
                    disabled={otpBusy || !otpCaptchaToken}
                    onClick={handleSendOtp}
                  >
                    {otpBusy ? "Yuborilmoqda…" : "SMS kod yuborish"}
                  </button>
                </>
              )}
              {otpStep === "code" && (
                <>
                  <p>{otpCanonicalPhone} raqamiga yuborilgan kodni kiriting.</p>
                  <Field
                    label="Tasdiqlash kodi"
                    value={otpCode}
                    placeholder="123456"
                    onChange={setOtpCode}
                  />
                  <button
                    type="button"
                    className="button primary wide"
                    data-testid="otp-verify"
                    disabled={otpBusy}
                    onClick={handleVerifyOtp}
                  >
                    {otpBusy ? "Tekshirilmoqda…" : "Tasdiqlash"}
                  </button>
                  <button
                    type="button"
                    className="button text"
                    data-testid="otp-resend"
                    disabled={otpBusy || !otpCaptchaToken}
                    onClick={handleSendOtp}
                  >
                    Kodni qayta yuborish
                  </button>
                </>
              )}
              {otpError && (
                <p className="error" role="alert" data-testid="otp-error">
                  {otpError}
                </p>
              )}
            </section>
          )}
        </form>
      </main>
    </Shell>
  );
}
function Field({
  label,
  value,
  onChange,
  error,
  placeholder,
  readOnly,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  placeholder?: string;
  readOnly?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={(e) => !readOnly && onChange(e.target.value)}
      />
      {error && <em className="error">{error}</em>}
    </label>
  );
}
// Uzbekistan-only checkout phone: a fixed, non-editable "+998" prefix next
// to a 9-digit national-number box, so the customer never types the
// country code. `value` is always the canonical stored form ("" or
// "+998XXXXXXXXX", possibly partial mid-typing) -- extractUzbekNationalDigits
// derives what the editable box shows from it, so an existing/rehydrated
// full value displays correctly split and never loses digits across
// re-renders. onChange always re-emits with the "+998" prefix reapplied
// (or "" once the customer clears the field entirely), so the parent
// (Checkout's `address.primaryPhone`) never sees anything but that same
// canonical shape -- exactly what validateAddress, the server RPC, and
// formatMaskedPhone already expect.
function UzbekPhoneField({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
}) {
  const nationalDigits = extractUzbekNationalDigits(value);
  return (
    <label className="field phone-field">
      <span>{label}</span>
      <div className="phone-field-input">
        <span className="phone-field-prefix" aria-hidden="true">+998</span>
        <input
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          value={nationalDigits}
          placeholder="90 123 45 67"
          onChange={(e) => {
            const digits = extractUzbekNationalDigits(e.target.value);
            onChange(digits ? `+998${digits}` : "");
          }}
        />
      </div>
      {error && <em className="error">{error}</em>}
    </label>
  );
}
// +998901234567 (12 digits incl. country code) -> "+998 90 *** ** 67".
// Display-only: the underlying address.primaryPhone keeps the full verified
// number so validateAddress's phone regex still passes.
function formatMaskedPhone(raw?: string | null): string {
  const digits = (raw || "").replace(/\D/g, "");
  if (digits.length !== 12) return raw ? `+${digits}` : "";
  return `+${digits.slice(0, 3)} ${digits.slice(3, 5)} *** ** ${digits.slice(10, 12)}`;
}
function Confirmation() {
  const { id } = useParams();
  const { orders } = useApp();
  const order = orders.find((entry) => entry.id === id);
  return (
    <Shell>
      <main className="success">
        <div className="success-icon">✓</div>
        <p className="eyebrow">BUYURTMA QABUL QILINDI</p>
        <h1>Rahmat!</h1>
        <p>
          Restoran buyurtmangizni hozir tekshiradi. Holat o‘zgarganda shu
          sahifada ko‘rasiz.
        </p>
        {order && <p data-testid="server-confirmed-total"><b>Server tasdiqlagan jami:</b> {money(order.total)}</p>}
        <Link
          className="button primary"
          to={`/track/${id}`}
          data-testid="track-link"
        >
          Holatni kuzatish
        </Link>
        <Link className="button text" to="/menu">
          Menyuga qaytish
        </Link>
      </main>
    </Shell>
  );
}
// No further transitions are possible from any of these per
// assert_transition (supabase/migrations/20260806100000_pickup_fulfillment.sql)
// -- realtime and the backup poll both stop once the order reaches one of
// these, since nothing will ever change again.
const TERMINAL_TRACKING_STATUSES: OrderStatus[] = ["DELIVERED", "COLLECTED", "REJECTED", "CANCELLED", "RETURNED"];
// Conservative backup poll: realtime is the primary mechanism (see
// src/realtime.ts), this only covers a signal genuinely missed by both
// the broadcast channel and the reconnect/refocus/online recovery
// listeners below -- long enough to never feel like aggressive polling,
// short enough that a customer is never stuck looking at stale state for
// more than half a minute.
const TRACKING_BACKUP_POLL_MS = 25000;
function Track() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const { orders, loadTrackedOrder, publicConfig } = useApp();
  const [trackingReady, setTrackingReady] = useState(false);
  const [trackingError, setTrackingError] = useState("");
  const [editingAddress, setEditingAddress] = useState(false);
  const [justRevised, setJustRevised] = useState(false);
  const order = orders.find((o) => o.id === id);
  // A Telegram deep link (see zaytun-telegram-notify/message.ts) carries
  // the tracking token in the URL, since it may be opened in a different
  // browser/webview than the one that placed the order -- localStorage
  // isn't shared across contexts. Upgrade once, silently; every other
  // code path below continues to use the same localStorage-backed token
  // exactly as before.
  useEffect(() => {
    const urlToken = searchParams.get("token");
    if (id && urlToken && !getStoredTrackingToken(id)) setStoredTrackingToken(id, urlToken);
  }, [id, searchParams]);
  useEffect(() => {
    let disposed = false;
    if (!id || order) {
      setTrackingReady(true);
      return;
    }
    void loadTrackedOrder(id).catch((error: unknown) => {
      if (!disposed) setTrackingError(error instanceof Error ? error.message : "Buyurtma kuzatuvi yuklanmadi");
    }).finally(() => {
      if (!disposed) setTrackingReady(true);
    });
    return () => { disposed = true; };
  }, [id, loadTrackedOrder, order]);
  const refetch = useCallback(() => {
    if (id) void loadTrackedOrder(id).catch(() => { /* recovery/backup refetches fail silently -- the page keeps showing the last known-good state, exactly as if nothing had happened */ });
  }, [id, loadTrackedOrder]);
  const isTerminal = order ? TERMINAL_TRACKING_STATUSES.includes(order.status) : false;
  // Realtime + recovery: subscribe on mount, refetch on every broadcast
  // signal AND on every (re)connect (see subscribeToOrderTracking), plus
  // the browser-level recovery events the task explicitly calls out --
  // tab/window returning to the foreground and the network coming back.
  // A conservative backup poll covers whatever's left; both it and the
  // realtime subscription stop once the order reaches a terminal status.
  useEffect(() => {
    if (!id || isTerminal) return;
    const token = getStoredTrackingToken(id);
    if (!token) return;
    const unsubscribe = subscribeToOrderTracking(id, token, refetch);
    const onVisible = () => { if (document.visibilityState === "visible") refetch(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refetch);
    window.addEventListener("online", refetch);
    const poll = window.setInterval(refetch, TRACKING_BACKUP_POLL_MS);
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refetch);
      window.removeEventListener("online", refetch);
      window.clearInterval(poll);
    };
  }, [id, isTerminal, refetch]);
  useEffect(() => {
    if (editingAddress && order && !isDeliveryAddressRevisable(order)) {
      setEditingAddress(false);
    }
  }, [editingAddress, order]);
  if (!order)
    return (
      <Shell>
        <main className="narrow">
          <h1>{trackingReady ? "Kuzatuv havolasi noto‘g‘ri yoki mavjud emas" : "Yuklanmoqda…"}</h1>
          {trackingError && <p className="error" role="alert">{trackingError}</p>}
        </main>
      </Shell>
    );
  const reviewRequired = order.type === "DELIVERY" && order.status === "NEW" && order.deliveryReviewStatus === "REVIEW_REQUIRED";
  const clarificationRequested = isDeliveryAddressRevisable(order);
  const displayStages = order.type === "PICKUP"
    ? fulfillmentTimeline("PICKUP").map((stage) => ({ label: stage.label, matchesEvent: (e: Order["events"][number]) => e.newStatus === stage.status }))
    : customerDeliveryStages.map((stage, i) => ({ label: stage.label, matchesEvent: customerDeliveryStageEventMatchers[i] }));
  const current = order.type === "PICKUP"
    ? fulfillmentTimeline("PICKUP").findIndex((stage) => stage.status === order.status)
    : customerDeliveryStageIndex(order);
  const normalDeliveryProgress = isNormalDeliveryStatus(order);
  return (
    <Shell>
      <main className="track">
        <div className="page-title">
          <div>
            <p className="eyebrow">{order.number}</p>
            <h1 data-testid="order-status">{clarificationRequested ? "Manzilni aniqlashtirish kerak" : reviewRequired ? "Manzil tasdiqlanmoqda" : normalDeliveryProgress ? customerDeliveryStages[current].label : fulfillmentStatusLabel(order)||statusLabels[order.status]}</h1>
          </div>
          <span className="badge">{order.type==='PICKUP'?'Olib ketish':'Yetkazib berish'}</span>
        </div>
        {order.type === "DELIVERY" && !isTerminal && supabaseConfigured && <TelegramLinkCard orderId={order.id} />}
        {justRevised && <p className="success-notice" data-testid="address-revision-success">✓ Manzil yangilandi. Manzilingiz qayta tekshirish uchun yuborildi.</p>}
        {clarificationRequested && !editingAddress && (
          <section className="pilot-notice clarification-card" data-testid="clarification-required" role="alert">
            <h2>Manzilni aniqlashtirish kerak</h2>
            <p>Buyurtmangizni yetkazish uchun manzil bo‘yicha qo‘shimcha ma’lumot kerak.</p>
            {order.deliveryReviewReason && <p data-testid="clarification-reason"><b>{order.deliveryReviewReason}</b></p>}
            <button
              type="button"
              className="button primary"
              data-testid="edit-delivery-address"
              onClick={() => { setJustRevised(false); setEditingAddress(true); }}
            >
              Manzilni tahrirlash
            </button>
          </section>
        )}
        {editingAddress && (
          <AddressRevisionEditor
            order={order}
            onCancel={() => setEditingAddress(false)}
            onSuccess={() => { setEditingAddress(false); setJustRevised(true); }}
          />
        )}
        {reviewRequired && <p className="pilot-notice" data-testid="tracking-delivery-review">Operator manzil va yetkazish imkoniyatini tekshirmoqda. Zarur bo‘lsa siz bilan telefon orqali bog‘lanamiz.</p>}
        {order.deliveryReviewStatus === "APPROVED" && <p className="success-notice">✓ Yetkazish manzili operator tomonidan tasdiqlandi.</p>}
        {order.deliveryReviewStatus === "REJECTED" && <p className="warning" role="alert">Yetkazish tasdiqlanmadi. {order.deliveryReviewReason || "Restoran bilan bog‘laning."}</p>}
        {order.type==='PICKUP'&&order.status==='READY'&&<p className="success-notice" data-testid="pickup-ready-message">Buyurtmangiz tayyor. Zaytun Kafedan olib ketishingiz mumkin.</p>}
        {order.type==='DELIVERY'&&order.status==='ARRIVED'&&<p className="success-notice" data-testid="driver-arrived-message">Kuryer yetib keldi. Buyurtmangizni qabul qilishga tayyor bo‘ling.</p>}
        <div className="eta">
          <b>
            {order.estimatedMinutes || 35}–{(order.estimatedMinutes || 35) + 10}{" "}
            min
          </b>
          <span>Taxminiy vaqt</span>
        </div>
        <section className="timeline">
          {displayStages.map((stage, i) => {
            const reachedAt = order.events.filter(stage.matchesEvent).sort((a, b) => a.timestamp.localeCompare(b.timestamp))[0];
            return (
              <div className={i <= current ? "done" : ""} key={stage.label}>
                <i>{i < current ? "✓" : i + 1}</i>
                <span>
                  <b>{stage.label}</b>
                  {reachedAt && <small>{time(reachedAt.timestamp)}</small>}
                </span>
              </div>
            );
          })}
        </section>
        {order.type==='PICKUP'&&<section className="form-card pickup-facts" data-testid="pickup-tracking-details"><h2>Olib ketish ma’lumotlari</h2><p><b>{publicConfig?.restaurantName||'Zaytun Kafe'}</b></p><p>{publicConfig?.restaurantAddress}</p><a href={`tel:${publicConfig?.restaurantPhone}`}>{publicConfig?.restaurantPhone}</a><p><b>To‘lov:</b> {paymentLabel(order.paymentMethod)}</p><p>{pickupPaymentGuidance(order.paymentMethod)}</p></section>}
        <section className="form-card">
          <h2>Buyurtma</h2>
          {order.items.map((i) => (
            <p key={i.id}>
              {i.quantity} × {i.name}
            </p>
          ))}
          <b>{money(order.total)}</b>
          {order.type === "DELIVERY" && (
            <p data-testid="tracking-payment-method">
              <b>To‘lov:</b> {paymentLabel(order.paymentMethod)}
            </p>
          )}
          {order.type === "DELIVERY" && isRemotePaymentMethod(order.paymentMethod) && (
            <p className="pilot-notice" data-testid="tracking-remote-payment-notice">
              {remotePaymentCustomerNotice}
            </p>
          )}
        </section>
        <OrderFeedbackCard order={order} />
      </main>
    </Shell>
  );
}
// So the customer still gets the driver-arrival notification even after
// closing this page/tab entirely -- see request_telegram_link (single-
// use, order-scoped, tracking-token authorized, matching every other
// public order-mutating call) and the webhook's /start <token> handler
// that actually consumes it. Never shows/asks for a chat id from the
// customer directly -- Telegram's own webhook payload is the only source
// of that value, once this deep link is opened and "Start" is tapped.
function TelegramLinkCard({ orderId }: { orderId: string }) {
  const { requestTelegramLink } = useApp();
  const [state, setState] = useState<"idle" | "loading" | "error" | "linked">("idle");
  if (state === "linked") {
    return (
      <p className="success-notice" data-testid="telegram-link-success">
        ✅ Telegram ochildi — u yerda “Start” tugmasini bosing, kuryer yetib kelganda shu yerga xabar beramiz.
      </p>
    );
  }
  return (
    <section className="pilot-notice telegram-link-card" data-testid="telegram-link-card">
      <p>Kuryer yetib kelganda Telegram orqali ham xabar oling — sahifani yopib qo‘ysangiz ham.</p>
      <button
        type="button"
        className="button secondary"
        data-testid="telegram-link-button"
        disabled={state === "loading"}
        onClick={async () => {
          setState("loading");
          try {
            const token = await requestTelegramLink(orderId);
            window.open(`https://t.me/ZaytunKafeNavoiy_bot?start=${token}`, "_blank", "noopener,noreferrer");
            setState("linked");
          } catch {
            setState("error");
          }
        }}
      >
        {state === "loading" ? "Yuklanmoqda…" : "🔔 Telegram orqali xabar olish"}
      </button>
      {state === "error" && <em className="error" data-testid="telegram-link-error">Havola yaratilmadi. Birozdan keyin qayta urinib ko‘ring.</em>}
    </section>
  );
}
const deliveryRatingLabels: Record<FeedbackDeliveryRating, string> = {
  FAST: "Tez",
  NORMAL: "O‘z vaqtida",
  LATE: "Kechikdi",
  ISSUE: "Muammo bo‘ldi",
};
const deliveryIssueReasonLabels: Record<FeedbackDeliveryIssueReason, string> = {
  SPILLED_OR_TIPPED: "Taom ag‘darilgan / to‘kilgan",
  POOR_HANDLING: "Buyurtma ehtiyotsiz olib kelingan",
  LOCATION_DIFFICULTY: "Kuryer manzilni topishda qiynaldi",
  VERY_LATE: "Juda kech keldi",
  OTHER: "Boshqa",
};
const foodRatingLabels: Record<FeedbackFoodRating, string> = {
  EXCELLENT: "A’lo",
  GOOD: "Yaxshi",
  OKAY: "Qoniqarli",
  BAD: "Yomon",
};
const foodIssueReasonLabels: Record<FeedbackFoodIssueReason, string> = {
  COLD: "Sovuq edi",
  TASTE: "Ta’mi yoqmadi",
  PREPARATION: "Noto‘g‘ri tayyorlangan",
  MISSING_ITEM: "Mahsulot/buyurtma yetishmadi",
  OTHER: "Boshqa",
};
// H3: a compact, optional, dismissible post-delivery/post-pickup feedback
// card. Never blocks tracking, never appears before the order has actually
// reached the customer, and only ever asks the delivery question for
// DELIVERY orders (PICKUP feedback is food-only).
function OrderFeedbackCard({ order }: { order: Order }) {
  const { submitOrderFeedback } = useApp();
  const [dismissed, setDismissed] = useState(false);
  const [deliveryRating, setDeliveryRating] = useState<FeedbackDeliveryRating | undefined>(undefined);
  const [deliveryIssueReason, setDeliveryIssueReason] = useState<FeedbackDeliveryIssueReason | undefined>(undefined);
  const [foodRating, setFoodRating] = useState<FeedbackFoodRating | undefined>(undefined);
  const [foodIssueReason, setFoodIssueReason] = useState<FeedbackFoodIssueReason | undefined>(undefined);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  if (order.feedback) {
    return (
      <section className="form-card feedback-card" data-testid="feedback-submitted">
        <h2>Fikringiz uchun rahmat!</h2>
        {order.type === "DELIVERY" && order.feedback.deliveryRating && (
          <p>
            <b>Yetkazib berish:</b> {deliveryRatingLabels[order.feedback.deliveryRating]}
          </p>
        )}
        <p>
          <b>Taom:</b> {foodRatingLabels[order.feedback.foodRating]}
        </p>
      </section>
    );
  }
  if (!canSubmitOrderFeedback(order) || dismissed) return null;
  const isDelivery = order.type === "DELIVERY";
  const canSubmit = foodRating && (!isDelivery || deliveryRating);
  const submit = async () => {
    if (!foodRating || (isDelivery && !deliveryRating) || submitting) return;
    setSubmitting(true);
    setError("");
    try {
      await submitOrderFeedback(order.id, {
        foodRating,
        deliveryRating: isDelivery ? deliveryRating : undefined,
        deliveryIssueReason: isDelivery && deliveryRating === "ISSUE" ? deliveryIssueReason : undefined,
        foodIssueReason: foodRating === "OKAY" || foodRating === "BAD" ? foodIssueReason : undefined,
        comment: comment.trim() || undefined,
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Fikrni yuborib bo‘lmadi");
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <section className="form-card feedback-card" data-testid="feedback-card">
      <h2>{isDelivery ? "Buyurtmangiz qanday yetib keldi?" : "Taom sizga qanday yoqdi?"}</h2>
      {isDelivery && (
        <div className="feedback-question">
          <p className="feedback-question-label">Yetkazib berish qanday bo‘ldi?</p>
          <div className="feedback-options">
            {(Object.keys(deliveryRatingLabels) as FeedbackDeliveryRating[]).map((value) => (
              <button
                type="button"
                key={value}
                className={deliveryRating === value ? "active" : ""}
                onClick={() => setDeliveryRating(value)}
                data-testid={`feedback-delivery-${value}`}
              >
                {deliveryRatingLabels[value]}
              </button>
            ))}
          </div>
          {deliveryRating === "ISSUE" && (
            <div className="feedback-issue-reasons" data-testid="feedback-delivery-issue-reasons">
              {(Object.keys(deliveryIssueReasonLabels) as FeedbackDeliveryIssueReason[]).map((value) => (
                <button
                  type="button"
                  key={value}
                  className={deliveryIssueReason === value ? "active" : ""}
                  onClick={() => setDeliveryIssueReason(value)}
                  data-testid={`feedback-delivery-issue-${value}`}
                >
                  {deliveryIssueReasonLabels[value]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="feedback-question">
        <p className="feedback-question-label">Taom qanday edi?</p>
        <div className="feedback-options">
          {(Object.keys(foodRatingLabels) as FeedbackFoodRating[]).map((value) => (
            <button
              type="button"
              key={value}
              className={foodRating === value ? "active" : ""}
              onClick={() => setFoodRating(value)}
              data-testid={`feedback-food-${value}`}
            >
              {foodRatingLabels[value]}
            </button>
          ))}
        </div>
        {(foodRating === "OKAY" || foodRating === "BAD") && (
          <div className="feedback-issue-reasons" data-testid="feedback-food-issue-reasons">
            {(Object.keys(foodIssueReasonLabels) as FeedbackFoodIssueReason[]).map((value) => (
              <button
                type="button"
                key={value}
                className={foodIssueReason === value ? "active" : ""}
                onClick={() => setFoodIssueReason(value)}
                data-testid={`feedback-food-issue-${value}`}
              >
                {foodIssueReasonLabels[value]}
              </button>
            ))}
          </div>
        )}
      </div>
      <label className="feedback-comment-label">
        Qo‘shimcha fikr (ixtiyoriy)
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value.slice(0, 500))}
          maxLength={500}
          data-testid="feedback-comment"
        />
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="feedback-actions">
        <button type="button" className="button secondary" onClick={() => setDismissed(true)} data-testid="feedback-dismiss">
          Keyinroq
        </button>
        <button
          type="button"
          className="button primary"
          disabled={!canSubmit || submitting}
          onClick={() => void submit()}
          data-testid="feedback-submit"
        >
          {submitting ? "Yuborilmoqda…" : "Yuborish"}
        </button>
      </div>
    </section>
  );
}
function AddressRevisionEditor({
  order,
  onCancel,
  onSuccess,
}: {
  order: Order;
  onCancel: () => void;
  onSuccess: () => void;
}) {
  const { getAddressForRevision, reviseDeliveryAddress, loadTrackedOrder, publicConfig } = useApp();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [address, setAddress] = useState<CustomerAddress>(blankAddress);
  const [mapSelection, setMapSelection] = useState<MapLocationSelection>(() =>
    initialSelection(configuredMapProvider()),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const loadStarted = useRef(false);
  useEffect(() => {
    if (loadStarted.current) return;
    loadStarted.current = true;
    void getAddressForRevision(order.id)
      .then((current) => {
        if (!current) {
          setLoadError("Manzil ma’lumotlari topilmadi. Sahifani qayta yuklang.");
          return;
        }
        // A prior confirmation must never carry into a new revision session;
        // the customer explicitly reconfirms the pin again before resubmitting.
        setAddress({ ...current, pinConfirmedAt: undefined });
        if (current.latitude !== undefined && current.longitude !== undefined) {
          const coordinate = { latitude: current.latitude, longitude: current.longitude };
          setMapSelection({
            provider: (current.locationProvider as MapLocationSelection["provider"]) || configuredMapProvider(),
            coordinate,
            state: current.providerFormattedAddress ? "SUGGESTION_AVAILABLE" : "SELECTED",
            suggestion: current.providerFormattedAddress
              ? {
                  label: current.providerFormattedAddress,
                  formattedAddress: current.providerFormattedAddress,
                  coordinate,
                  providerPlaceId: current.providerPlaceId,
                  district: current.district,
                  street: current.street,
                  house: current.house,
                }
              : undefined,
          });
        }
      })
      .catch((error: unknown) => setLoadError(error instanceof Error ? error.message : "Manzil ma’lumotlari yuklanmadi"))
      .finally(() => setLoading(false));
  }, [getAddressForRevision, order.id]);
  const clearError = (key: string) =>
    setErrors((er) =>
      er[key] ? Object.fromEntries(Object.entries(er).filter(([k]) => k !== key)) : er,
    );
  const set = (key: keyof CustomerAddress, value: string | number) => {
    const material = ["district", "street", "house"].includes(key);
    setAddress((a) => ({
      ...a,
      [key]: value,
      ...(material && a.pinConfirmedAt
        ? { pinConfirmedAt: undefined, confidence: "CUSTOMER_CONFIRMATION_REQUIRED" as const }
        : {}),
    }));
    if (material) setMapSelection((s) => materialAddressChange(s));
    clearError(key);
  };
  const updateMapSelection = (selection: MapLocationSelection) => {
    setMapSelection(selection);
    setAddress((a) => applyMapSelectionToAddress(a, selection, publicConfig));
    clearError("coordinates");
    clearError("pinConfirmation");
    clearError("deliveryZone");
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    const found = validateDeliveryLocation(address);
    setErrors(found);
    if (Object.keys(found).length) return;
    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError("");
    try {
      await reviseDeliveryAddress(order.id, address);
      onSuccess();
    } catch (error) {
      setSubmitError(error instanceof Error && error.message ? error.message : "Manzilni yangilab bo‘lmadi. Qayta urinib ko‘ring.");
      // The order's state may have changed server-side since the editor opened
      // (e.g. staff already acted). Reconcile in the background so the parent
      // page reflects reality; Track closes this editor if it's now stale.
      void loadTrackedOrder(order.id);
      submittingRef.current = false;
      setSubmitting(false);
    }
  };
  if (loading)
    return (
      <section className="form-card" data-testid="address-revision-loading">
        Manzil yuklanmoqda…
      </section>
    );
  if (loadError)
    return (
      <section className="form-card">
        <p className="error" role="alert">{loadError}</p>
        <button type="button" className="button secondary" onClick={onCancel}>
          Yopish
        </button>
      </section>
    );
  return (
    <form className="form-card address-revision-editor" data-testid="address-revision-editor" onSubmit={submit}>
      <h2>Manzilni tahrirlash</h2>
      <DeliveryAddressFields
        address={address}
        errors={errors}
        set={set}
        mapSelection={mapSelection}
        updateMapSelection={updateMapSelection}
        onApplySuggestion={(suggestion) => {
          setAddress((a) => ({
            ...applySuggestion(a, suggestion),
            providerPlaceId: suggestion.providerPlaceId,
            providerFormattedAddress: suggestion.formattedAddress,
            pinConfirmedAt: undefined,
            confidence: "CUSTOMER_CONFIRMATION_REQUIRED",
          }));
          setMapSelection((s) => materialAddressChange(s));
        }}
      />
      {submitError && (
        <p className="error" role="alert" data-testid="address-revision-error">
          {submitError}
        </p>
      )}
      <div className="two-actions">
        <button
          type="button"
          className="button secondary"
          data-testid="cancel-address-revision"
          onClick={onCancel}
          disabled={submitting}
        >
          Bekor qilish
        </button>
        <button
          type="submit"
          className="button primary"
          data-testid="submit-address-revision"
          disabled={submitting}
        >
          {submitting ? "Yuborilmoqda…" : "Qayta tekshirishga yuborish"}
        </button>
      </div>
    </form>
  );
}

type BoardGroup = { title: string; statuses: OrderStatus[] };
const groups: BoardGroup[] = [
  { title: "Yangi", statuses: ["NEW"] },
  { title: "Jarayonda", statuses: ["CONFIRMED", "PREPARING"] },
  { title: "Tayyor / haydovchi", statuses: ["READY", "DRIVER_ASSIGNED"] },
  { title: "Yetkazishda", statuses: ["PICKED_UP", "ON_THE_WAY", "ARRIVED"] },
  {
    title: "Yakunlangan",
    statuses: [
      "DELIVERED",
      "COLLECTED",
      "CANCELLED",
      "REJECTED",
      "DELIVERY_FAILED",
      "RETURNED",
    ],
  },
];
// Stable, order-identity-based (not count-based) acknowledgement, so a
// Realtime refresh/reconnect never replays an already-seen order as a
// fresh alert, and each genuinely new order is tracked independently.
// Persisted so a page reload doesn't re-alert for orders staff already saw.
const ACKNOWLEDGED_ORDERS_KEY = "zaytun-go:acknowledged-new-orders";
function loadAcknowledgedOrders(): Set<string> {
  try {
    const raw = localStorage.getItem(ACKNOWLEDGED_ORDERS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
function saveAcknowledgedOrders(ids: Set<string>) {
  try {
    localStorage.setItem(ACKNOWLEDGED_ORDERS_KEY, JSON.stringify([...ids]));
  } catch {
    /* alert simply won't persist across reload -- not critical */
  }
}
// Phase D follow-up: preference, browser unlock and actual readiness are
// deliberately separate. A missing preference means ON; only an explicit
// mute is persisted as OFF. Creating/resuming the AudioContext is silent --
// alert oscillators are still created exclusively by the existing arrival
// effects below, after their hydration baselines have been established.
const SOUND_PREFERENCE_KEY = "zaytun-go:sound-preference";
function soundRepeatMs(): number {
  return (window as typeof window & { __zaytunSoundRepeatMs?: number }).__zaytunSoundRepeatMs ?? 8000;
}
function loadSoundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_PREFERENCE_KEY) !== "muted";
  } catch {
    return true;
  }
}
function saveSoundEnabled(enabled: boolean) {
  try {
    localStorage.setItem(SOUND_PREFERENCE_KEY, enabled ? "enabled" : "muted");
  } catch {
    /* the in-session preference still works */
  }
}
function useOperationalSound() {
  const audioCtxRef = useRef<AudioContext | null>(null);
  const [soundEnabled, setSoundEnabled] = useState(loadSoundEnabled);
  const soundEnabledRef = useRef(soundEnabled);
  const [soundReady, setSoundReady] = useState(false);

  const unlockSound = useCallback(() => {
    if (!soundEnabledRef.current) return;
    try {
      const ctx = audioCtxRef.current ?? new AudioContext();
      audioCtxRef.current = ctx;
      const markReady = () => {
        if (ctx.state === "suspended") return;
        // Avoid restructuring the operational header during the same
        // pointerdown that may also activate an order action underneath.
        setTimeout(() => setSoundReady(true), 0);
      };
      if (ctx.state === "suspended" && typeof ctx.resume === "function") {
        void ctx.resume().then(markReady).catch(() => {});
      } else {
        markReady();
      }
    } catch {
      /* visual notifications remain the source of truth */
    }
  }, []);

  useEffect(() => {
    if (!soundEnabled || soundReady) return;
    document.addEventListener("pointerdown", unlockSound);
    document.addEventListener("keydown", unlockSound);
    return () => {
      document.removeEventListener("pointerdown", unlockSound);
      document.removeEventListener("keydown", unlockSound);
    };
  }, [soundEnabled, soundReady, unlockSound]);

  const toggleSound = useCallback(() => {
    const enabled = !soundEnabledRef.current;
    soundEnabledRef.current = enabled;
    saveSoundEnabled(enabled);
    setSoundEnabled(enabled);
    if (enabled) unlockSound();
  }, [unlockSound]);

  return { audioCtxRef, soundEnabled, soundReady, soundEnabledRef, toggleSound };
}
function SoundStatusControl({
  enabled,
  ready,
  onToggle,
  testIdPrefix,
}: {
  enabled: boolean;
  ready: boolean;
  onToggle: () => void;
  testIdPrefix: string;
}) {
  return (
    <div className="sound-control">
      <span className="sound-status" data-testid={`${testIdPrefix}-sound-status`}>
        {!enabled
          ? "🔕 Ovoz o‘chirilgan"
          : ready
            ? "🔔 Ovoz yoqilgan"
            : "🔔 Ovoz birinchi bosishda faollashadi"}
      </span>
      <button
        type="button"
        className="button text sound-toggle"
        data-testid={`${testIdPrefix}-sound-toggle`}
        onClick={onToggle}
      >
        {enabled ? "Ovozni o‘chirish" : "Ovozni yoqish"}
      </button>
    </div>
  );
}
function Restaurant() {
  const { orders, loaded, operationalError } = useApp();
  const [acknowledged, setAcknowledged] = useState<Set<string>>(() =>
    loadAcknowledgedOrders(),
  );
  const unacknowledgedNew = orders.filter(
    (o) => o.status === "NEW" && !acknowledged.has(o.id),
  );
  const acknowledgeOrder = (id: string) => {
    setAcknowledged((current) => {
      if (current.has(id)) return current;
      const next = new Set(current).add(id);
      saveAcknowledgedOrders(next);
      return next;
    });
  };
  const acknowledgeAllVisible = () => {
    setAcknowledged((current) => {
      const next = new Set(current);
      for (const o of unacknowledgedNew) next.add(o.id);
      saveAcknowledgedOrders(next);
      return next;
    });
  };
  // Armed on the first interaction anywhere on the page (the sign-in click
  // itself qualifies) -- browsers block audio playback before a genuine
  // user gesture, so the AudioContext is created lazily here rather than
  // assumed to work from mount. If it's ever unavailable/blocked, the
  // persistent visual alert below is unaffected -- nothing about order
  // processing ever depends on sound succeeding.
  const { audioCtxRef, soundEnabled, soundReady, soundEnabledRef, toggleSound } = useOperationalSound();
  // Deliberately loud and urgent -- a missed delivery order is far
  // costlier than an occasionally-jarring alert, so this is not tuned as
  // a subtle UI chime. Square-wave oscillators at high gain, a 4-note
  // alternating pattern instead of a soft two-note tone.
  const playAlertChime = useCallback(() => {
    if (!soundEnabledRef.current) return;
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    try {
      const playNote = (frequency: number, startOffset: number, duration: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "square";
        osc.frequency.value = frequency;
        gain.gain.value = 0.6;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + startOffset);
        osc.stop(ctx.currentTime + startOffset + duration);
      };
      playNote(1046, 0, 0.16);
      playNote(1318, 0.18, 0.16);
      playNote(1046, 0.36, 0.16);
      playNote(1318, 0.54, 0.22);
    } catch {
      /* visible alert remains the source of truth -- never block on audio */
    }
  }, [audioCtxRef, soundEnabledRef]);
  const previousUnacknowledgedIds = useRef<Set<string>>(new Set());
  // Phase D: the baseline used to start empty, so the FIRST render after
  // real data loaded (e.g. 6 pre-existing unacknowledged orders on a
  // fresh reload) always looked like 6 "new" arrivals relative to it --
  // an unconditional chime on every page open/reload, not just for
  // genuinely new orders. hasHydratedRef defers baselining until `loaded`
  // is first true, and that seeding render itself never plays a sound.
  const hasHydratedRef = useRef(false);
  useEffect(() => {
    const currentIds = new Set(unacknowledgedNew.map((o) => o.id));
    if (!hasHydratedRef.current) {
      if (!loaded) return;
      hasHydratedRef.current = true;
      previousUnacknowledgedIds.current = currentIds;
      return;
    }
    // Only a genuinely NEW unacknowledged id (not present last render)
    // triggers an immediate alert -- an ordinary Realtime refresh/
    // reconnect that returns the same still-unacknowledged orders never
    // replays them as new. The repeat-until-acknowledged behavior below is
    // separate and keys off count alone, not this arrival edge.
    const hasNewArrival = [...currentIds].some(
      (id) => !previousUnacknowledgedIds.current.has(id),
    );
    previousUnacknowledgedIds.current = currentIds;
    if (hasNewArrival) playAlertChime();
  }, [unacknowledgedNew, playAlertChime, loaded]);
  // Business-critical alert: keeps sounding on an interval for as long as
  // ANY order remains unacknowledged, not just once on arrival -- staff
  // stepping away from the screen must still be paged back. Stops the
  // instant the count reaches zero (acknowledged, individually or via
  // "Barchasini ko'rdim"), and never restarts on a page reload for
  // already-acknowledged orders (acknowledged state is persisted).
  const hasUnacknowledgedOrders = unacknowledgedNew.length > 0;
  useEffect(() => {
    if (!hasUnacknowledgedOrders) return;
    const interval = window.setInterval(playAlertChime, soundRepeatMs());
    return () => window.clearInterval(interval);
  }, [hasUnacknowledgedOrders, playAlertChime]);
  const boardRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const check = () =>
      setScrollable(
        !!boardRef.current &&
          boardRef.current.scrollWidth > boardRef.current.clientWidth + 4,
      );
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [orders]);
  return (
    <Shell surface="staff">
      <RestaurantSubNav active="board" />
      <main className="ops">
        {!loaded && <div className="empty" role="status">Buyurtmalar yuklanmoqda…</div>}
        {operationalError && <p className="error" role="alert">{operationalError}</p>}
        {unacknowledgedNew.length > 0 && (
          <div className="new-order-alert" role="alert" data-testid="new-order-alert">
            <div className="new-order-alert-head">
              <b>🔔 {unacknowledgedNew.length} ta yangi buyurtma!</b>
              <button
                type="button"
                className="button text"
                data-testid="acknowledge-all-orders"
                onClick={acknowledgeAllVisible}
              >
                Barchasini ko‘rdim
              </button>
            </div>
            <div className="new-order-alert-list">
              {unacknowledgedNew.map((o) => (
                <Link
                  key={o.id}
                  to={`/restaurant/orders/${o.id}`}
                  className="new-order-alert-item"
                  data-testid={`new-order-alert-${o.id}`}
                  onClick={() => acknowledgeOrder(o.id)}
                >
                  {o.number} — {o.customer.name}
                </Link>
              ))}
            </div>
          </div>
        )}
        <div className="ops-head">
          <div>
            <p className="eyebrow">DUSHANBA · 3 AVGUST</p>
            <h1>Buyurtmalar</h1>
          </div>
          <div className="notice">
            🔔 {orders.filter((o) => o.status === "NEW").length} yangi buyurtma
          </div>
          <SoundStatusControl enabled={soundEnabled} ready={soundReady} onToggle={toggleSound} testIdPrefix="restaurant" />
        </div>
        <div className="metrics">
          <span>
            <b>{orders.filter((o) => o.status === "NEW").length}</b> Yangi
          </span>
          <span>
            <b>
              {
                orders.filter((o) =>
                  ["CONFIRMED", "PREPARING"].includes(o.status),
                ).length
              }
            </b>{" "}
            Oshxonada
          </span>
          <span>
            <b>{orders.filter((o) => o.status === "READY").length}</b> Haydovchi
            kutmoqda
          </span>
          <span>
            <b>
              {
                orders.filter(
                  (o) =>
                    Date.now() - new Date(o.createdAt).getTime() > 40 * 60000 &&
                    !["DELIVERED", "CANCELLED", "REJECTED"].includes(o.status),
                ).length
              }
            </b>{" "}
            Kechikkan
          </span>
        </div>
        <div className={`board-wrap${scrollable ? " scrollable" : ""}`}>
          <div className="board" ref={boardRef}>
            {groups.map((g) => (
              <section className="column" key={g.title}>
                <h2>
                  {g.title}
                  <span>
                    {orders.filter((o) => g.statuses.includes(o.status)).length}
                  </span>
                </h2>
                {orders
                  .filter((o) => g.statuses.includes(o.status))
                  .map((o) => (
                    <OrderCard order={o} key={o.id} onOpen={acknowledgeOrder} />
                  ))}
              </section>
            ))}
          </div>
        </div>
      </main>
    </Shell>
  );
}
function OrderCard({ order, onOpen }: { order: Order; onOpen?: (id: string) => void }) {
  const waitingOnCustomer = isDeliveryAddressRevisable(order);
  const reviewBadge = deliveryReviewBadges[order.deliveryReviewStatus as NonNullable<Order["deliveryReviewStatus"]>];
  return (
    <Link
      to={`/restaurant/orders/${order.id}`}
      onClick={() => onOpen?.(order.id)}
      data-testid={`order-card-${order.id}`}
      className={`order-card ${order.status === "NEW" && !waitingOnCustomer ? "new" : ""} ${waitingOnCustomer ? "waiting-customer" : ""}`}
    >
      <div>
        <b>{order.number}</b>
        <OrderBadge order={order} />
      </div>
      {order.type === "DELIVERY" && reviewBadge && (
        <small className={`review-state-badge ${reviewBadge.className}`} data-testid={`review-state-${order.id}`}>
          {reviewBadge.label}
        </small>
      )}
      <h3>{order.customer.name}</h3>
      <small>
        {time(order.createdAt)} ·{" "}
        {order.type === "DELIVERY" ? "Yetkazish" : "Olib ketish"}
      </small>
      <p>{order.items.map((i) => `${i.quantity}× ${i.name}`).join(", ")}</p>
      <small className={isRemotePaymentMethod(order.paymentMethod) ? "remote-payment-flag" : "payment-signal"} data-testid={`order-card-payment-${order.id}`}>
        {paymentLabel(order.paymentMethod, true)}
        {isRemotePaymentMethod(order.paymentMethod) && ` · ${paymentStatusLabels[order.paymentStatus]}`}
      </small>
      {order.address && (
        <>
          <p className="address">📍 {order.address.district}, {order.address.street}, {order.address.house}</p>
          <small className="location-signal">
            {order.address.confidence === "COMPLETE" ? "✓ Manzil tasdiqlangan" : "⚠ Aniqlashtirish kerak"}
            {order.address.deliveryDistanceKm !== undefined && ` · ${order.address.deliveryDistanceKm.toFixed(1)} km`}
            {order.address.landmark && ` · ${order.address.landmark}`}
          </small>
        </>
      )}
      {order.issues.some((i) => !i.resolvedAt) && (
        <span className="warning">⚠ Manzil / yetkazish muammosi</span>
      )}
      <footer>
        <b>{money(order.total)}</b>
        <span>Ochish →</span>
      </footer>
    </Link>
  );
}
// H1: compact secondary nav scoped to restaurant-authenticated pages only
// -- Shell's own top nav is shared by every staff/driver/login-gate page
// and deliberately stays untouched (generic Buyurtma/Restoran/Haydovchi).
function RestaurantSubNav({ active }: { active: "board" | "history" | "drivers" }) {
  return (
    <div className="restaurant-subnav">
      <Link to="/restaurant" className={active === "board" ? "active" : ""}>
        Buyurtmalar
      </Link>
      <Link to="/restaurant/history" className={active === "history" ? "active" : ""}>
        Tarix
      </Link>
      <Link to="/restaurant/drivers/history" className={active === "drivers" ? "active" : ""}>
        Haydovchilar
      </Link>
    </div>
  );
}
const assignmentStatusLabels: Record<DriverLedgerEntry["status"], string> = {
  ASSIGNED: "Biriktirilgan",
  ACCEPTED: "Qabul qilingan",
  DECLINED: "Rad etildi",
  SUPERSEDED: "Almashtirildi",
  COMPLETED: "Bajarildi",
  FAILED: "Muvaffaqiyatsiz",
  RETURNED: "Qaytarildi",
  CANCELLED: "Bekor qilindi",
};
function DriverLedgerDetail({
  driverId,
  driverName,
  filters,
  onBack,
}: {
  driverId: string;
  driverName: string;
  filters: Pick<OrderHistoryFilters, "preset" | "customFrom" | "customTo">;
  onBack: () => void;
}) {
  const { fetchDriverLedgerEntries } = useApp();
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<DriverLedgerEntry[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchDriverLedgerEntries(driverId, filters, HISTORY_PAGE_SIZE, page * HISTORY_PAGE_SIZE)
      .then((result) => {
        if (cancelled) return;
        setRows(result.rows);
        setTotalCount(result.totalCount);
      })
      .catch((failure) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "Ledgerni yuklab bo‘lmadi");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [driverId, filters, page, fetchDriverLedgerEntries]);
  const totalPages = Math.max(1, Math.ceil(totalCount / HISTORY_PAGE_SIZE));
  return (
    <div className="driver-ledger-detail">
      <button type="button" className="button text" onClick={onBack} data-testid="ledger-back">
        ← Haydovchilarga qaytish
      </button>
      <h2>{driverName}</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <div className="empty" role="status">
          Yuklanmoqda…
        </div>
      ) : rows.length === 0 ? (
        <div className="empty" data-testid="ledger-detail-empty">
          Bu davr uchun topshiriqlar topilmadi
        </div>
      ) : (
        <>
          <div className="ledger-entries">
            {rows.map((r) => (
              <Link to={`/restaurant/orders/${r.orderId}`} key={r.id} className="ledger-entry" data-testid={`ledger-entry-${r.id}`}>
                <div className="ledger-entry-top">
                  <b>{r.orderNumber}</b>
                  <span>{money(r.total)}</span>
                </div>
                <p>
                  {historyDateTime(r.assignedAt)} · {r.branchName}
                  {r.district ? ` · ${r.district}` : ""}
                </p>
                <div className="ledger-entry-timeline">
                  <span>Biriktirildi {time(r.assignedAt)}</span>
                  {r.acceptedAt && <span>Qabul qilindi {time(r.acceptedAt)}</span>}
                  {r.endedAt && <span>Yakunlandi {time(r.endedAt)}</span>}
                </div>
                <span className={`badge s-${r.status.toLowerCase()}`}>{assignmentStatusLabels[r.status]}</span>
              </Link>
            ))}
          </div>
          <div className="history-pagination">
            <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} data-testid="ledger-prev-page">
              ← Oldingi
            </button>
            <span>
              {page + 1} / {totalPages}
            </span>
            <button type="button" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} data-testid="ledger-next-page">
              Keyingi →
            </button>
          </div>
        </>
      )}
    </div>
  );
}
function DriverLedger() {
  const { fetchDriverLedgerSummary } = useApp();
  const [preset, setPreset] = useState<HistoryDatePreset>("TODAY");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [rows, setRows] = useState<DriverLedgerSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedDriver, setSelectedDriver] = useState<{ id: string; name: string } | null>(null);
  const customRangeIncomplete = preset === "CUSTOM" && (!customFrom || !customTo);
  const filters = useMemo<Pick<OrderHistoryFilters, "preset" | "customFrom" | "customTo">>(
    () => ({
      preset,
      customFrom: preset === "CUSTOM" ? customFrom || undefined : undefined,
      customTo: preset === "CUSTOM" ? customTo || undefined : undefined,
    }),
    [preset, customFrom, customTo],
  );
  useEffect(() => {
    if (customRangeIncomplete) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchDriverLedgerSummary(filters)
      .then((result) => {
        if (!cancelled) setRows(result);
      })
      .catch((failure) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "Ledgerni yuklab bo‘lmadi");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters, customRangeIncomplete, fetchDriverLedgerSummary]);
  return (
    <Shell surface="staff">
      <RestaurantSubNav active="drivers" />
      <main className="ops history">
        <div className="ops-head">
          <div>
            <p className="eyebrow">HISOBOT</p>
            <h1>Haydovchilar — yetkazish tarixi</h1>
          </div>
        </div>
        {!selectedDriver && (
          <>
            <div className="history-filters">
              <div className="segmented" data-testid="ledger-date-presets">
                {HISTORY_PRESETS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    className={preset === p.value ? "active" : ""}
                    onClick={() => setPreset(p.value)}
                    data-testid={`ledger-preset-${p.value}`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {preset === "CUSTOM" && (
                <div className="history-custom-range">
                  <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} data-testid="ledger-custom-from" />
                  <span>—</span>
                  <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} data-testid="ledger-custom-to" />
                </div>
              )}
            </div>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            {customRangeIncomplete ? (
              <div className="empty">Sana oralig‘ini to‘liq tanlang</div>
            ) : loading ? (
              <div className="empty" role="status">
                Yuklanmoqda…
              </div>
            ) : rows.length === 0 ? (
              <div className="empty" data-testid="ledger-empty">
                Bu davr uchun topshiriqlar topilmadi
              </div>
            ) : (
              <div className="driver-ledger-list">
                {rows.map((r) => (
                  <button
                    type="button"
                    key={r.driverId}
                    className="driver-ledger-row"
                    onClick={() => setSelectedDriver({ id: r.driverId, name: r.driverName })}
                    data-testid={`ledger-driver-${r.driverId}`}
                  >
                    <b>{r.driverName}</b>
                    <div className="driver-ledger-stats">
                      <span>
                        <b>{r.completed}</b> Bajarildi
                      </span>
                      <span>
                        <b>{r.accepted}</b> Qabul qilingan
                      </span>
                      <span>
                        <b>{r.failed}</b> Muvaffaqiyatsiz
                      </span>
                      <span>
                        <b>{r.returned}</b> Qaytarildi
                      </span>
                      <span>
                        <b>{r.declined}</b> Rad etildi
                      </span>
                      <span>
                        <b>{r.superseded}</b> Almashtirildi
                      </span>
                    </div>
                    {r.feedbackReceived > 0 && (
                      <div className="driver-ledger-feedback" data-testid={`ledger-feedback-${r.driverId}`}>
                        Yetkazib berish fikri: {r.feedbackReceived} · Tez {r.feedbackFast} · Normal {r.feedbackNormal} · Kechikdi {r.feedbackLate} · Muammo {r.feedbackIssue}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {selectedDriver && (
          <DriverLedgerDetail
            driverId={selectedDriver.id}
            driverName={selectedDriver.name}
            filters={filters}
            onBack={() => setSelectedDriver(null)}
          />
        )}
      </main>
    </Shell>
  );
}
const HISTORY_PRESETS: { value: HistoryDatePreset; label: string }[] = [
  { value: "TODAY", label: "Bugun" },
  { value: "YESTERDAY", label: "Kecha" },
  { value: "LAST_7_DAYS", label: "7 kun" },
  { value: "THIS_MONTH", label: "Shu oy" },
  { value: "CUSTOM", label: "Sana oralig‘i" },
];
const historyFulfillmentLabel = (type: Order["type"]) => (type === "DELIVERY" ? "Yetkazish" : "Olib ketish");
function History() {
  const nav = useNavigate();
  const { fetchOrderHistory, fetchOrderHistorySummary, drivers } = useApp();
  const [preset, setPreset] = useState<HistoryDatePreset>("TODAY");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [status, setStatus] = useState<OrderStatus | "">("");
  const [fulfillment, setFulfillment] = useState<"DELIVERY" | "PICKUP" | "">("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | "">("");
  const [driverId, setDriverId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<OrderHistoryRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [summary, setSummary] = useState<OrderHistorySummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const customRangeIncomplete = preset === "CUSTOM" && (!customFrom || !customTo);
  const filters = useMemo<Omit<OrderHistoryFilters, "limit" | "offset">>(
    () => ({
      preset,
      customFrom: preset === "CUSTOM" ? customFrom || undefined : undefined,
      customTo: preset === "CUSTOM" ? customTo || undefined : undefined,
      status: status || undefined,
      fulfillment: fulfillment || undefined,
      paymentMethod: paymentMethod || undefined,
      driverId: driverId || undefined,
      search: search.trim() || undefined,
    }),
    [preset, customFrom, customTo, status, fulfillment, paymentMethod, driverId, search],
  );
  useEffect(() => {
    setPage(0);
  }, [filters]);
  useEffect(() => {
    if (customRangeIncomplete) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    Promise.all([
      fetchOrderHistory({ ...filters, limit: HISTORY_PAGE_SIZE, offset: page * HISTORY_PAGE_SIZE }),
      fetchOrderHistorySummary(filters),
    ])
      .then(([historyPage, historySummary]) => {
        if (cancelled) return;
        setRows(historyPage.rows);
        setTotalCount(historyPage.totalCount);
        setSummary(historySummary);
      })
      .catch((failure) => {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "Tarixni yuklab bo‘lmadi");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [filters, page, customRangeIncomplete, fetchOrderHistory, fetchOrderHistorySummary]);
  const totalPages = Math.max(1, Math.ceil(totalCount / HISTORY_PAGE_SIZE));
  return (
    <Shell surface="staff">
      <RestaurantSubNav active="history" />
      <main className="ops history">
        <div className="ops-head">
          <div>
            <p className="eyebrow">HISOBOT</p>
            <h1>Buyurtmalar tarixi</h1>
          </div>
        </div>
        <div className="history-filters">
          <div className="segmented" data-testid="history-date-presets">
            {HISTORY_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                className={preset === p.value ? "active" : ""}
                onClick={() => setPreset(p.value)}
                data-testid={`history-preset-${p.value}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset === "CUSTOM" && (
            <div className="history-custom-range">
              <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} data-testid="history-custom-from" />
              <span>—</span>
              <input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} data-testid="history-custom-to" />
            </div>
          )}
          <div className="history-filter-row">
            <select value={fulfillment} onChange={(e) => setFulfillment(e.target.value as typeof fulfillment)} data-testid="history-filter-fulfillment">
              <option value="">Barcha turlar</option>
              <option value="DELIVERY">Yetkazish</option>
              <option value="PICKUP">Olib ketish</option>
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} data-testid="history-filter-status">
              <option value="">Barcha holatlar</option>
              {Object.entries(statusLabels)
                .filter(([value]) => value !== "PICKED_UP")
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
            <select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value as typeof paymentMethod)} data-testid="history-filter-payment">
              <option value="">Barcha to‘lovlar</option>
              <option value="CASH">Naqd</option>
              <option value="CARD_ON_DELIVERY">Karta (yetkazishda)</option>
              <option value="CARD_AT_PICKUP">Karta (restoranda)</option>
              <option value="CLICK">Click</option>
              <option value="PAYME">Payme</option>
            </select>
            <select value={driverId} onChange={(e) => setDriverId(e.target.value)} data-testid="history-filter-driver">
              <option value="">Barcha haydovchilar</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <input
              type="search"
              placeholder="Buyurtma raqami"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="history-search"
            />
          </div>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {summary && (
          <div className="metrics history-summary">
            <span>
              <b>{summary.totalOrders}</b> Jami
            </span>
            <span>
              <b>{summary.delivered}</b> Yetkazildi / Olib ketildi
            </span>
            <span>
              <b>{summary.cancelled}</b> Bekor / Rad
            </span>
            <span>
              <b>{summary.failed}</b> Yetkazilmadi / Qaytarildi
            </span>
            <span>
              <b>{money(summary.totalValue)}</b> Jami summa
            </span>
          </div>
        )}
        {customRangeIncomplete ? (
          <div className="empty">Sana oralig‘ini to‘liq tanlang</div>
        ) : loading ? (
          <div className="empty" role="status">
            Yuklanmoqda…
          </div>
        ) : rows.length === 0 ? (
          <div className="empty" data-testid="history-empty">
            Tanlangan davr uchun buyurtmalar topilmadi
          </div>
        ) : (
          <>
            <table className="history-table" data-testid="history-table">
              <thead>
                <tr>
                  <th>Buyurtma</th>
                  <th>Sana</th>
                  <th>Filial</th>
                  <th>Mijoz</th>
                  <th>Turi</th>
                  <th>Haydovchi</th>
                  <th>To‘lov</th>
                  <th>Summa</th>
                  <th>Holat</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => nav(`/restaurant/orders/${r.id}`)} data-testid={`history-row-${r.id}`}>
                    <td>{r.number}</td>
                    <td>{historyDateTime(r.createdAt)}</td>
                    <td>{r.branchName}</td>
                    <td>{r.customerName}</td>
                    <td>{historyFulfillmentLabel(r.type)}</td>
                    <td>{r.driverName || "—"}</td>
                    <td>{paymentLabel(r.paymentMethod, true)}</td>
                    <td>{money(r.total)}</td>
                    <td>{statusLabels[r.status]}</td>
                    <td>{r.hasFeedback && <span className="feedback-indicator" data-testid={`history-feedback-${r.id}`}>Fikr bor</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="history-cards">
              {rows.map((r) => (
                <Link to={`/restaurant/orders/${r.id}`} key={r.id} className="history-card" data-testid={`history-card-${r.id}`}>
                  <div className="history-card-top">
                    <b>{r.number}</b>
                    <span>{money(r.total)}</span>
                  </div>
                  <p>
                    {historyDateTime(r.createdAt)} · {r.branchName}
                    {r.hasFeedback && (
                      <span className="feedback-indicator" data-testid={`history-feedback-${r.id}`}>
                        {" "}
                        · Fikr bor
                      </span>
                    )}
                  </p>
                  <p>
                    {r.customerName} · {historyFulfillmentLabel(r.type)}
                    {r.driverName ? ` · ${r.driverName}` : ""}
                  </p>
                  <div className="history-card-bottom">
                    <span>{paymentLabel(r.paymentMethod, true)}</span>
                    <span className={`badge s-${r.status.toLowerCase()}`}>{statusLabels[r.status]}</span>
                  </div>
                </Link>
              ))}
            </div>
            <div className="history-pagination">
              <button type="button" disabled={page === 0} onClick={() => setPage((p) => p - 1)} data-testid="history-prev-page">
                ← Oldingi
              </button>
              <span>
                {page + 1} / {totalPages}
              </span>
              <button type="button" disabled={page + 1 >= totalPages} onClick={() => setPage((p) => p + 1)} data-testid="history-next-page">
                Keyingi →
              </button>
            </div>
          </>
        )}
      </main>
    </Shell>
  );
}
function OrderDetail() {
  const { id } = useParams();
  const {
    orders,
    drivers,
    loaded,
    operationalError,
    transition,
    assign,
    setEstimate,
    reportIssue,
    resolveIssue,
    reviewDelivery,
    requestClarification,
    transitionPending,
    getOrder,
  } = useApp();
  const listedOrder = orders.find((o) => o.id === id);
  // H0: the shared `orders` list is now filtered to the live restaurant
  // board -- an older, already-finished order reached via direct URL,
  // bookmark, or browser history won't be in it. Fall back to an
  // unfiltered single-order fetch rather than incorrectly treating "not
  // on the live board" as "doesn't exist" and redirecting away.
  const [fallbackOrder, setFallbackOrder] = useState<Order | undefined>(undefined);
  const [fallbackChecked, setFallbackChecked] = useState(false);
  const fallbackAttempted = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!id || listedOrder || !loaded) return;
    if (fallbackAttempted.current === id) return;
    fallbackAttempted.current = id;
    setFallbackChecked(false);
    void getOrder(id).then((found) => {
      setFallbackOrder(found);
      setFallbackChecked(true);
    });
  }, [id, listedOrder, loaded, getOrder]);
  const order = listedOrder ?? (fallbackOrder?.id === id ? fallbackOrder : undefined);
  // assignedDriverId is never cleared once set (confirmed server-side: the
  // transition RPC only flips the driver's own availability back to
  // AVAILABLE on a terminal status, it never touches orders.assigned_driver_id)
  // -- so this stays populated through DELIVERED/DELIVERY_FAILED/RETURNED too,
  // which is exactly the "who handled this order" historical record staff need.
  const assignedDriver = order?.assignedDriverId ? drivers.find((d) => d.id === order.assignedDriverId) : undefined;
  // P6.10: a small, optional exception note -- never a full history
  // browser inline on the live card. Only the most recent decline matters
  // operationally; the complete trail (if ever needed) lives in
  // order.assignmentHistory itself, not surfaced as its own UI in v1.
  const lastDeclinedAssignment = order?.assignmentHistory.filter((a) => a.status === "DECLINED").at(-1);
  const [reason, setReason] = useState("");
  const [estimate, setEstimateValue] = useState("35");
  const [reviewReason, setReviewReason] = useState("");
  if (!order)
    return !id || (loaded && fallbackChecked) ? (
      <Navigate to="/restaurant" />
    ) : (
      <Shell surface="staff">
        <main className="detail">
          <p>Yuklanmoqda…</p>
        </main>
      </Shell>
    );
  const action = async (
    to: OrderStatus,
    actor: "RESTAURANT" | "DISPATCHER" = "RESTAURANT",
  ) => {
    if (transitionPending(order.id)) return;
    await transition(order.id, to, actor, reason || undefined);
    setReason("");
  };
  return (
    <Shell surface="staff">
      <main className="detail">
        <Link to="/restaurant" className="back">
          ← Buyurtmalar
        </Link>
        <div className="detail-head">
          <div>
            <p className="eyebrow">{order.number}</p>
            <h1>{order.customer.name}</h1>
          </div>
          <OrderBadge order={order} />
        </div>
        <OrderExceptionBanner order={order} />
        <div className="detail-grid">
          <div className="stack">
            <section className="panel">
              <h2>Buyurtma</h2>
              {order.items.map((i) => (
                <div className="row" key={i.id}>
                  <span>
                    {i.quantity} × {i.name}
                    <small>
                      {i.modifierNames.join(", ")} {i.instructions}
                    </small>
                  </span>
                  <b>{money(i.total)}</b>
                </div>
              ))}
              <div className="row total">
                <span>Jami</span>
                <b>{money(order.total)}</b>
              </div>
              <p className={isRemotePaymentMethod(order.paymentMethod) ? "remote-payment-flag" : undefined} data-testid="order-payment-preference">
                <b>To‘lov:</b>{" "}
                {isRemotePaymentMethod(order.paymentMethod) && "⚠ "}
                {paymentLabel(order.paymentMethod,true)}{" "}
                · {paymentStatusLabels[order.paymentStatus]}
              </p>
              {isRemotePaymentMethod(order.paymentMethod) && (
                <p className="warning" data-testid="remote-payment-staff-hint">
                  {remotePaymentStaffHint}
                </p>
              )}
              <p>
                <b>Izoh:</b> {order.specialInstructions || "Yo‘q"}
              </p>
              {order.estimatedMinutes && (
                <p>
                  <b>Taxminiy vaqt:</b> {order.estimatedMinutes} daqiqa
                </p>
              )}
            </section>
            {order.feedback && (
              <section className="panel" data-testid="order-feedback-panel">
                <h2>Mijoz fikri</h2>
                {order.type === "DELIVERY" && order.feedback.deliveryRating && (
                  <p>
                    <b>Yetkazib berish:</b> {deliveryRatingLabels[order.feedback.deliveryRating]}
                    {order.feedback.deliveryIssueReason && ` — ${deliveryIssueReasonLabels[order.feedback.deliveryIssueReason]}`}
                  </p>
                )}
                <p>
                  <b>Taom:</b> {foodRatingLabels[order.feedback.foodRating]}
                  {order.feedback.foodIssueReason && ` — ${foodIssueReasonLabels[order.feedback.foodIssueReason]}`}
                </p>
                {order.feedback.comment && (
                  <p>
                    <b>Izoh:</b> {order.feedback.comment}
                  </p>
                )}
              </section>
            )}
            <section className="panel">
              <h2>Manzil va aloqa</h2>
              <a
                href={`tel:${order.customer.primaryPhone}`}
                className="button secondary"
              >
                ☎ {order.customer.primaryPhone}
              </a>
              {order.customer.secondaryPhone&&<a href={`tel:${order.customer.secondaryPhone}`} className="button secondary">☎ {order.customer.secondaryPhone}</a>}
              {order.address ? (
                <>
                  <p>
                    {[
                      order.address.district,
                      order.address.street,
                      order.address.house,
                      order.address.entrance &&
                        `${order.address.entrance}-kirish`,
                      order.address.floor && `${order.address.floor}-qavat`,
                      order.address.apartment &&
                        `${order.address.apartment}-xonadon`,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                  <p>
                    <b>Mo‘ljal:</b> {order.address.landmark}
                  </p>
                  <p><b>Yetkazish izohi:</b> {order.address.deliveryNotes || "Yo‘q"}</p>
                  {order.address.latitude !== undefined && order.address.longitude !== undefined && (
                    <div className="location-actions">
                      <a className="button primary" href={navigationUrl("yandex",{latitude:order.address.latitude,longitude:order.address.longitude})} target="_blank" rel="noopener noreferrer">📍 Yandex Maps</a>
                      <a className="button secondary" href={navigationUrl("google",{latitude:order.address.latitude,longitude:order.address.longitude})} target="_blank" rel="noopener noreferrer">Google Maps</a>
                    </div>
                  )}
                  <div className="location-facts" data-testid="restaurant-location-detail">
                    <span><b>Manzil ishonchi</b>{addressConfidenceLabels[order.address.confidence]}</span>
                    <span><b>Pin tasdig‘i</b>{order.address.pinConfirmedAt ? "Tasdiqlangan" : "Tasdiqlanmagan"}</span>
                    <span><b>Masofa</b>{order.address.deliveryDistanceKm !== undefined ? `${order.address.deliveryDistanceKm.toFixed(2)} km` : "—"}</span>
                    <span><b>Yetkazish hududi</b>{order.address.deliveryZoneResult ? deliveryZoneLabels[order.address.deliveryZoneResult] : "—"}</span>
                  </div>
                  {order.address.latitude !== undefined && order.address.longitude !== undefined && (
                    <details className="location-debug" data-testid="location-debug">
                      <summary>Texnik ma'lumot</summary>
                      <p>
                        <b>Koordinata:</b> {order.address.latitude.toFixed(6)},{" "}
                        {order.address.longitude.toFixed(6)}
                      </p>
                      <button className="button secondary" onClick={() => void navigator.clipboard?.writeText(`${order.address!.latitude}, ${order.address!.longitude}`)}>Koordinatani nusxalash</button>
                    </details>
                  )}
                </>
              ) : (
                <p>Olib ketish</p>
              )}
              {order.issues.map((i) => (
                <div
                  className={`issue ${i.resolvedAt ? "resolved" : ""}`}
                  key={i.id}
                  data-testid="order-issue"
                >
                  <b>{issueLabels[i.type] || i.type}</b>
                  <span>{i.description}</span>
                  <small>
                    {reportedByLabel(i.reportedBy)} · {time(i.createdAt)}
                  </small>
                  {!i.resolvedAt && (
                    <button onClick={() => resolveIssue(order.id, i.id)}>
                      Hal qilindi
                    </button>
                  )}
                </div>
              ))}
              <button
                className="button secondary"
                onClick={() =>
                  void reportIssue(
                    order.id,
                    "ADDRESS_CLARIFICATION",
                    "Manzilni mijoz bilan aniqlashtirish kerak",
                    "restaurant",
                  )
                }
              >
                Manzil muammosini bildirish
              </button>
            </section>
            {order.type === "DELIVERY" && order.assignedDriverId && (
              <section className="panel assigned-driver" data-testid="assigned-driver">
                <h2>Haydovchi</h2>
                {assignedDriver ? (
                  <>
                    <p>
                      <b>{assignedDriver.name}</b>
                    </p>
                    <a
                      href={`tel:${assignedDriver.phone}`}
                      className="button secondary"
                    >
                      ☎ {assignedDriver.phone}
                    </a>
                    <p>
                      <small>Holat: {driverAvailabilityLabels[assignedDriver.availability]}</small>
                    </p>
                    {/* Driver UI Phase: free -- the data already flows
                        through mapOrder/driver_assignments' existing
                        realtime subscription, this just surfaces it.
                        Driver UI Final Operational UX: widened from
                        DRIVER_ASSIGNED-only to also CONFIRMED/PREPARING/
                        READY, matching mark_driver_at_restaurant's own
                        widened guard -- the driver can check in well
                        before the food is ready now, and staff should see
                        that live too, not just once it's already READY.
                        Still excluded once PICKED_UP or later, where it
                        would read as stale ("still at the restaurant"). */}
                    {["CONFIRMED", "PREPARING", "READY", "DRIVER_ASSIGNED"].includes(order.status) && order.assignmentHistory.find((a) => !a.endedAt)?.arrivedAtRestaurantAt && (
                      <p className="success-notice" data-testid="driver-at-restaurant-notice">📍 Haydovchi restoranda</p>
                    )}
                  </>
                ) : (
                  <p className="warning">Haydovchi ma'lumoti topilmadi</p>
                )}
              </section>
            )}
          </div>
          <aside className="panel action-panel">
            <h2>Keyingi amal</h2>
            <p className="prep-time-hint" data-testid="average-prep-time">⏱ O‘rtacha tayyorlash vaqti: 20–25 daqiqa</p>
            {operationalError && <p className="error" role="alert" data-testid="operational-error">{operationalError}</p>}
            {order.type === "DELIVERY" && order.deliveryReviewStatus === "REVIEW_REQUIRED" && (
              <section className="delivery-review-panel" data-testid="delivery-review-required">
                <b>Manzilni tasdiqlash kerak</b>
                {deliveryAddressWasResubmitted(order) && (
                  <small className="review-state-badge clarification-requested" data-testid="address-resubmitted-cue">
                    Manzil yangilandi — qayta tekshiring
                  </small>
                )}
                <p>Mijoz manzilini, pinini va masofani tekshiring. Buyurtma tasdiqlanmaguncha haydovchiga berilmaydi.</p>
                <button
                  className="button primary"
                  data-testid="approve-delivery"
                  disabled={transitionPending(order.id)}
                  onClick={() => void reviewDelivery(order.id, true)}
                >
                  Manzilni tasdiqlash
                </button>
                <a className="button secondary" data-testid="contact-customer" href={`tel:${order.customer.primaryPhone}`}>
                  ☎ Mijoz bilan bog‘lanish
                </a>
                <input value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} placeholder="Aniqlashtirish yoki rad etish sababi" />
                <button
                  className="button secondary"
                  data-testid="request-clarification"
                  disabled={transitionPending(order.id) || !reviewReason.trim()}
                  onClick={() => { void requestClarification(order.id, reviewReason); setReviewReason(""); }}
                >
                  Manzilni aniqlashtirish
                </button>
                <button
                  className="button danger"
                  data-testid="reject-delivery"
                  disabled={transitionPending(order.id) || !reviewReason.trim()}
                  onClick={() => { void reviewDelivery(order.id, false, reviewReason); setReviewReason(""); }}
                >
                  Yetkazib bo‘lmaydi
                </button>
              </section>
            )}
            {order.type === "DELIVERY" && order.deliveryReviewStatus === "CLARIFICATION_REQUESTED" && (
              <section className="delivery-review-panel clarification-pending" data-testid="delivery-review-clarification-pending">
                <b>Mijozdan aniqlashtirish so‘ralgan</b>
                <p>Mijoz manzilni yangilagach, u yana ko‘rib chiqish uchun shu yerda ko‘rinadi.</p>
                {order.deliveryReviewReason && <p data-testid="clarification-reason-sent"><i>{order.deliveryReviewReason}</i></p>}
                <a className="button secondary" data-testid="contact-customer" href={`tel:${order.customer.primaryPhone}`}>
                  ☎ Mijoz bilan bog‘lanish
                </a>
              </section>
            )}
            {order.type === "DELIVERY" && order.deliveryReviewStatus === "APPROVED" && <p className="success-notice" data-testid="delivery-review-approved">✓ Yetkazish manzili tasdiqlangan</p>}
            {order.status === "NEW" && (
              <>
                <button
                  className="button primary"
                  data-testid="action-confirm"
                  disabled={transitionPending(order.id) || (order.type === "DELIVERY" && order.deliveryReviewStatus !== "APPROVED")}
                  onClick={() => void action("CONFIRMED")}
                >
                  {order.type==='PICKUP'?'Buyurtmani tasdiqlash':'Qabul qilish'}
                </button>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Rad etish sababi"
                />
                <button
                  className="button danger"
                  data-testid="action-reject"
                  disabled={transitionPending(order.id) || !reason}
                  onClick={() => void action("REJECTED")}
                >
                  Rad etish
                </button>
              </>
            )}
            {(order.status === "CONFIRMED" || order.status === "PREPARING") && (
              <div className="estimate-row">
                <input
                  value={estimate}
                  onChange={(e) => setEstimateValue(e.target.value)}
                  inputMode="numeric"
                  placeholder="Daqiqa"
                  aria-label="Taxminiy tayyorlash vaqti"
                />
                <button
                  className="button secondary"
                  data-testid="action-set-estimate"
                  onClick={() => void setEstimate(order.id, Number(estimate))}
                >
                  Vaqtni belgilash
                </button>
              </div>
            )}
            {order.status === "CONFIRMED" && (
              <button
                className="button primary"
                data-testid="action-start-prep"
                disabled={transitionPending(order.id)}
                onClick={() => void action("PREPARING")}
              >
                Tayyorlashni boshlash
              </button>
            )}
            {order.status === "PREPARING" && (
              <button
                className="button primary"
                data-testid="action-mark-ready"
                disabled={transitionPending(order.id)}
                onClick={() => void action("READY")}
              >
                {order.type==='PICKUP'?'Olib ketishga tayyor':'Tayyor deb belgilash'}
              </button>
            )}
            {order.status === "READY" && order.type === "PICKUP" && (
              <button
                className="button primary"
                data-testid="action-mark-pickup-complete"
                disabled={transitionPending(order.id)}
                onClick={() => void action("COLLECTED")}
              >
                Mijoz olib ketdi
              </button>
            )}
            {/* P5.6/P5.7/P5.9: the restaurant is not normally asked "which
                driver?" -- Smart Dispatch already attempted assignment the
                instant this order became READY (transition_order's own
                sweep). This renders that canonical backend state, never
                frontend dispatch logic. Manual assignment is retained
                exactly as-is (same assign() call, same eligibility/capacity
                enforcement server-side) but demoted to an explicit,
                closed-by-default exception control -- normal orders never
                need it. */}
            {lastDeclinedAssignment && (order.status === "READY" || deliveryDispatchPhase(order)) && (
              <p className="dispatch-declined-note" data-testid="dispatch-declined-note">
                {lastDeclinedAssignment.driverName || "Haydovchi"} buyurtmani olmadi
              </p>
            )}
            {order.status === "READY" && order.type === "DELIVERY" && (
              <>
                <div className="dispatch-status dispatch-searching" data-testid="dispatch-searching">
                  <b>Kuryer qidirilmoqda…</b>
                  <p>Bo‘sh kuryer paydo bo‘lishi bilan tizim avtomatik biriktiradi.</p>
                </div>
                <details className="manual-assign" data-testid="manual-assign-panel">
                  <summary>Qo‘lda biriktirish</summary>
                  {drivers.map((d) => (
                    <button
                      className="driver-option"
                      data-testid={`assign-driver-${d.id}`}
                      disabled={transitionPending(order.id) || d.availability !== "AVAILABLE"}
                      key={d.id}
                      onClick={() => void assign(order.id, d.id)}
                    >
                      <span>
                        <b>{d.name}</b>
                        <small>{d.vehicle}</small>
                      </span>
                      <i>{driverAvailabilityLabels[d.availability]}</i>
                    </button>
                  ))}
                  {!drivers.some((d) => d.availability === "AVAILABLE") && (
                    <p className="warning" data-testid="no-driver-available">
                      Hozir bo‘sh haydovchi yo‘q
                    </p>
                  )}
                </details>
              </>
            )}
            {/* P5.8/P5.14: once a courier owns the order, the restaurant
                monitors only -- courier lifecycle controls live exclusively
                on the driver's own surface (Phase 4). No transition button
                is rendered here for any of these statuses. */}
            {deliveryDispatchPhase(order) && deliveryDispatchPhase(order) !== "SEARCHING" && (
              <div className="dispatch-status dispatch-courier" data-testid="dispatch-courier-status">
                <b>Kuryer</b>
                <p>{assignedDriver?.name || "Aniqlanmoqda…"}</p>
                <span className="dispatch-phase-label">{deliveryDispatchPhaseLabels[deliveryDispatchPhase(order)!]}</span>
              </div>
            )}
            {/* Multi-Order Dispatch: while the driver is already known but
                the kitchen isn't done yet, staff should understand why a
                soon-to-be-READY order might sit a few extra minutes --
                the driver may be intentionally waiting on a compatible
                batch partner, never an unexplained delay. */}
            {deliveryDispatchPhase(order) === "EARLY_ASSIGNED" && (
              <p className="hint" data-testid="early-assignment-hint">
                {(() => {
                  const siblingCount = order.pickupBatchId ? orders.filter((o) => o.pickupBatchId === order.pickupBatchId && o.id !== order.id).length : 0;
                  return siblingCount > 0
                    ? `Haydovchi shu olib ketish guruhida yana ${siblingCount} ta buyurtmani ham kutmoqda bo‘lishi mumkin.`
                    : "Haydovchi allaqachon biriktirilgan -- tayyor bo‘lishi bilanoq olib ketadi.";
                })()}
              </p>
            )}
            {/* Full Live Operational Validation: the hint above disappears
                the instant THIS order itself reaches DRIVER_ASSIGNED
                (deliveryDispatchPhase moves on to ACCEPTED), even while
                the driver is still genuinely at the restaurant waiting on
                a not-yet-ready batch partner -- staff watching this exact
                order had no explanation at all for why the driver hadn't
                left yet. Purely additive: a second, separate hint (new
                testid, own condition), never altering the block above. */}
            {order.status === "DRIVER_ASSIGNED" && order.pickupBatchId && orders.some((o) => o.pickupBatchId === order.pickupBatchId && o.id !== order.id && !terminalDeliveryStatuses.includes(o.status)) && (
              <p className="hint" data-testid="driver-waiting-on-batch-partner-hint">
                Kuryer shu buyurtmani oldi, ammo shu olib ketish guruhidagi boshqa buyurtma tayyor bo‘lishini kutmoqda.
              </p>
            )}
            {/* P6.13: manual reassignment while a courier already owns the
                order is a staff-only exception path -- never shown once
                the courier has picked up (superseding mid-route is a
                different, out-of-scope problem). Reuses the exact same
                assign() call as the first assignment and the READY panel
                above; the backend (assign_driver_internal) is what
                actually supersedes the old row, not this component. */}
            {(deliveryDispatchPhase(order) === "ASSIGNED" || deliveryDispatchPhase(order) === "ACCEPTED") && (
              <details className="manual-assign" data-testid="manual-reassign-panel">
                <summary>Boshqa haydovchiga biriktirish</summary>
                <p className="hint">Joriy haydovchi bilan bog‘lanib bo‘lmasa yoki muammo yuzaga kelsa, boshqa haydovchini tanlang.</p>
                {drivers.filter((d) => d.id !== order.assignedDriverId).map((d) => (
                  <button
                    className="driver-option"
                    data-testid={`reassign-driver-${d.id}`}
                    disabled={transitionPending(order.id) || d.availability !== "AVAILABLE"}
                    key={d.id}
                    onClick={() => void assign(order.id, d.id)}
                  >
                    <span>
                      <b>{d.name}</b>
                      <small>{d.vehicle}</small>
                    </span>
                    <i>{driverAvailabilityLabels[d.availability]}</i>
                  </button>
                ))}
                {!drivers.some((d) => d.id !== order.assignedDriverId && d.availability === "AVAILABLE") && (
                  <p className="warning" data-testid="no-alternative-driver-available">
                    Hozir boshqa bo‘sh haydovchi yo‘q
                  </p>
                )}
              </details>
            )}
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Bekor qilish sababi"
            />
            {canTransition(order.status, "CANCELLED") && (
              <button
                className="button danger"
                data-testid="action-cancel"
                disabled={transitionPending(order.id) || !reason}
                onClick={() => void action("CANCELLED")}
              >
                Bekor qilish
              </button>
            )}
            <h2>Holat tarixi</h2>
            <div className="event-list" data-testid="event-list">
              {order.events
                .slice()
                .reverse()
                .map((e) => (
                  <div key={e.id}>
                    <i></i>
                    <span>
                      <b>{eventStatusLabel(e.newStatus)}</b>
                      <small>
                        {time(e.timestamp)} · {actorLabels[e.actorType]}
                      </small>
                      {e.reason && <small>{e.reason}</small>}
                    </span>
                  </div>
                ))}
            </div>
          </aside>
        </div>
      </main>
    </Shell>
  );
}
// P4: statuses a driver's own delivery leaves the "active work" set at.
const terminalDeliveryStatuses: OrderStatus[] = ["DELIVERED", "CANCELLED", "RETURNED", "DELIVERY_FAILED"];
// The moment the driver_assignments row itself was created -- used only to
// order a driver's own multiple simultaneous assignments (current vs.
// queued), never to invent a second source of truth for status itself.
// Deliberately NOT the order's DRIVER_ASSIGNED status-transition event:
// Multi-Order Dispatch assigns a driver as early as CONFIRMED, well before
// that event ever fires (it only fires later, at READY) -- keying off it
// made a still-preparing second order's createdAt fallback sort BEFORE a
// genuinely ready first order's real (later) DRIVER_ASSIGNED timestamp,
// silently swapping which order was "current" the moment the first one
// became ready (found via a real two-order Playwright run: the ready
// order sat in the queue while the still-preparing one wrongly stayed
// front and center).
const driverAssignedAt = (order: Order): string =>
  order.assignmentHistory.find((a) => !a.endedAt)?.assignedAt ?? order.createdAt;
function DriverAvailabilityToggle({
  driver,
  busy,
  hasActiveWork,
  activeCount,
  onStart,
  onEnd,
}: {
  driver: Driver | undefined;
  busy: boolean;
  hasActiveWork: boolean;
  activeCount: number;
  onStart: () => void;
  onEnd: () => void;
}) {
  if (!driver) return null;
  const onDuty = driverAcceptsNewWork(driver);
  const capacity = driver.deliveryCapacity;
  return (
    <div className={`driver-availability ${onDuty ? "on" : "off"}`} data-testid="driver-availability">
      <div>
        <b data-testid="driver-availability-status">{onDuty ? "🟢 Ishga tayyor" : "⚪ Hozir ishlamayapman"}</b>
        {/* Driver UI Final Operational UX: never claim "nothing happening"
            while the driver already holds active work -- show real
            capacity instead, driven by the server's own delivery_capacity,
            never invented client-side. */}
        {onDuty && hasActiveWork ? (
          <small data-testid="driver-capacity">
            {activeCount}/{capacity} buyurtma{activeCount < capacity ? ` — yana ${capacity - activeCount} ta olish mumkin` : " — band"}
          </small>
        ) : (
          <small>{onDuty ? "Yangi buyurtma kutilmoqda" : "Yangi buyurtma kelmaydi"}</small>
        )}
      </div>
      <button
        type="button"
        className="button primary"
        data-testid="driver-shift-toggle"
        disabled={busy || (onDuty && hasActiveWork)}
        title={onDuty && hasActiveWork ? "Faol yetkazish tugagach ishni tugatishingiz mumkin" : undefined}
        onClick={() => (onDuty ? onEnd() : onStart())}
      >
        {onDuty ? "Ishni tugatish" : "Ishni boshlash"}
      </button>
    </div>
  );
}
function DriverApp() {
  const { orders, drivers, loaded, operationalError, profileDisplayName, startShift, endShift, listMyStandbyNotices, listMyBranchIds, listMyPickupBatchContext, transitionPending } = useApp();
  const greetingName = driverGreetingName(profileDisplayName);
  // driver_read's own RLS policy restricts a non-staff caller to id=auth.uid()
  // only, so this array holds exactly the current driver's own row.
  const myDriver = drivers[0] as Driver | undefined;
  const [shiftBusy, setShiftBusy] = useState(false);
  const activeAssignments = useMemo(
    () =>
      orders
        .filter((o) => o.type === "DELIVERY" && o.assignedDriverId && !terminalDeliveryStatuses.includes(o.status))
        .sort((a, b) => {
          // Multi-Order Dispatch: once a route is computed (stop_sequence
          // set, at the first PICKED_UP in a batch), that deliberately-
          // chosen delivery order -- not assignment order -- decides
          // which stop is "current." Pre-pickup, stop_sequence is still
          // null for everyone, so this falls through to the original
          // assignment-order sort unchanged.
          if (a.stopSequence !== undefined && b.stopSequence !== undefined) return a.stopSequence - b.stopSequence;
          if (a.stopSequence !== undefined) return -1;
          if (b.stopSequence !== undefined) return 1;
          return driverAssignedAt(a).localeCompare(driverAssignedAt(b));
        }),
    [orders],
  );
  const current = activeAssignments[0];
  const queued = activeAssignments.slice(1);
  // Driver UI Phase: standby is deliberately its own small, page-local
  // "signal, then refetch via a protected RPC" loop (same architecture as
  // customer tracking), not folded into the shared orders/drivers refresh
  // cycle -- it's Supabase-only (no branch-pool/dispatch concept exists
  // locally) and only ever relevant while there's no current assignment.
  const [standbyNotices, setStandbyNotices] = useState<DriverStandbyNotice[]>([]);
  useEffect(() => {
    if (!supabaseConfigured || !myDriver) return;
    let disposed = false;
    const refetchStandby = () => void listMyStandbyNotices().then((notices) => { if (!disposed) setStandbyNotices(notices); });
    let unsubscribe = () => {};
    void listMyBranchIds().then((branchIds) => {
      if (disposed) return;
      refetchStandby();
      unsubscribe = subscribeToDriverStandby(branchIds, refetchStandby);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [myDriver?.id, listMyStandbyNotices, listMyBranchIds]);
  // Driver UI Final Operational UX: batch-level context (status,
  // actual-wait deadline) drives the "wait briefly for the second order"
  // vs. "leave now" instruction -- server-authoritative, never a
  // client-invented countdown. Piggybacks on the SAME realtime cadence
  // orders/drivers already use (pickup_batches is now in subscribe()'s own
  // watched-table list) rather than opening a second channel: refetches
  // whenever the shared `orders` array reference changes, which already
  // happens on every relevant realtime-triggered refresh.
  const [batchContext, setBatchContext] = useState<PickupBatchContext[]>([]);
  useEffect(() => {
    if (!myDriver) return;
    let disposed = false;
    void listMyPickupBatchContext().then((rows) => { if (!disposed) setBatchContext(rows); });
    return () => {
      disposed = true;
    };
    // Deliberately NOT depending on listMyPickupBatchContext itself: it's
    // a fresh function reference every time useApp()'s own value memo
    // recomputes (same as listMyStandbyNotices/listMyBranchIds above),
    // which previously combined with the `orders` dependency to cause a
    // tight refetch cascade right after sign-in -- fast enough that a
    // Playwright click could land on a button DOM node moments before
    // React replaced it, losing the click's browser-level event entirely
    // (confirmed via trace network logs: two list_my_pickup_batch_context
    // calls ~19ms apart, and accept_assignment never once called). The
    // function is stateless (always the same server call regardless of
    // which render created it), so omitting it from deps loses nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orders, myDriver?.id]);
  // P4.11: attention sounds -- identical default-on, gesture-unlocked
  // preference and seen-ids-baseline-on-first-render pattern as the
  // restaurant new-order alert (Restaurant(), above), so a reload with
  // already-known state never replays a sound, and an ordinary realtime
  // refresh that returns the same set never re-fires one either. Four
  // deliberately distinguishable patterns (spec: "a small set of clearly
  // distinguishable patterns is enough") -- new real assignment, a second
  // order joining an existing pickup, one order becoming ready, and the
  // whole pickup batch becoming ready -- each played at most once per
  // event, never repeated after the driver has moved on.
  const { audioCtxRef, soundEnabled, soundReady, soundEnabledRef, toggleSound } = useOperationalSound();
  const playChime = useCallback((notes: [frequency: number, startOffset: number, duration: number][], gainLevel: number) => {
    if (!soundEnabledRef.current) return;
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    try {
      for (const [frequency, startOffset, duration] of notes) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = frequency;
        gain.gain.value = gainLevel;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + startOffset);
        osc.stop(ctx.currentTime + startOffset + duration);
      }
    } catch {
      /* the visual card remains the source of truth */
    }
  }, [audioCtxRef, soundEnabledRef]);
  // New real assignment (current.id) vs. a second order joining an
  // existing pickup (lands in queued instead) -- distinguished by WHERE
  // the newly-arrived id ends up, not by a separate signal. Deliberately
  // keyed off activeAssignments as a whole (assignedDriverId set, not
  // terminal) rather than anything batch-specific -- an early-assigned,
  // READY-fallback-assigned, batched, or unbatched second order all land
  // here identically: newly assigned to this driver always notifies.
  const previousAssignmentIds = useRef<Set<string>>(new Set());
  // Phase D: same hydration-baseline bug as the restaurant alert -- this
  // used to start from an empty Set, so reopening/reloading Driver UI
  // with existing active assignments played a "new assignment" chime for
  // every one of them. Deferred until `loaded` is first true, and that
  // seeding render never plays anything.
  const hasHydratedAssignmentsRef = useRef(false);
  useEffect(() => {
    const currentIds = new Set(activeAssignments.map((o) => o.id));
    if (!hasHydratedAssignmentsRef.current) {
      if (!loaded) return;
      hasHydratedAssignmentsRef.current = true;
      previousAssignmentIds.current = currentIds;
      return;
    }
    const newIds = [...currentIds].filter((id) => !previousAssignmentIds.current.has(id));
    previousAssignmentIds.current = currentIds;
    if (newIds.length === 0) return;
    if (current && newIds.includes(current.id)) {
      playChime([[660, 0, 0.16], [880, 0.2, 0.22]], 0.2); // 🚗 Yangi buyurtma sizga biriktirildi
    } else {
      playChime([[587, 0, 0.14], [784, 0.16, 0.14], [880, 0.32, 0.2]], 0.18); // 📦 Yana bitta buyurtma qo‘shildi
    }
  }, [activeAssignments, loaded, current, playChime]);
  // Business-critical repeat, same reasoning as the restaurant alert:
  // an assignment still awaiting accept/decline must keep paging the
  // driver, not just chime once on arrival. Stops the instant every
  // active assignment has been answered (accepted or declined/released).
  const hasUnansweredAssignment = activeAssignments.some(
    (o) => !o.assignmentAcceptedAt && !transitionPending(o.id),
  );
  // clearInterval prevents future scheduling, but a callback already
  // queued by the browser may still run once after React observes the
  // accept/decline update. Re-check live state at execution time so that
  // stale callback cannot produce one last alert after the driver acted.
  const hasUnansweredAssignmentRef = useRef(hasUnansweredAssignment);
  useEffect(() => {
    hasUnansweredAssignmentRef.current = hasUnansweredAssignment;
  }, [hasUnansweredAssignment]);
  useEffect(() => {
    if (!hasUnansweredAssignment) return;
    const interval = window.setInterval(
      () => {
        if (hasUnansweredAssignmentRef.current) {
          playChime([[660, 0, 0.16], [880, 0.2, 0.22]], 0.2);
        }
      },
      soundRepeatMs(),
    );
    return () => window.clearInterval(interval);
  }, [hasUnansweredAssignment, playChime]);
  // Food ready (single) vs. the whole batch ready (both members reach
  // DRIVER_ASSIGNED together) -- tracked by each order's own previous
  // status, not a separate poll.
  const previousStatusRef = useRef<Record<string, OrderStatus>>({});
  useEffect(() => {
    const previous = previousStatusRef.current;
    const nextMap: Record<string, OrderStatus> = {};
    let readyFired = false;
    for (const o of activeAssignments) {
      nextMap[o.id] = o.status;
      if (previous[o.id] && previous[o.id] !== "DRIVER_ASSIGNED" && o.status === "DRIVER_ASSIGNED") readyFired = true;
    }
    previousStatusRef.current = nextMap;
    if (!readyFired) return;
    const batchMates = current?.pickupBatchId ? activeAssignments.filter((o) => o.pickupBatchId === current.pickupBatchId) : [];
    const allReady = batchMates.length >= 2 && batchMates.every((o) => o.status === "DRIVER_ASSIGNED");
    if (allReady) {
      playChime([[784, 0, 0.14], [988, 0.14, 0.14], [1175, 0.28, 0.26]], 0.22); // ✅ 2 ta buyurtma tayyor
    } else {
      playChime([[784, 0, 0.18], [988, 0.18, 0.24]], 0.2); // ✅ Buyurtma tayyor
    }
  }, [activeAssignments, current, playChime]);
  // Driver UI Phase: a distinctly different, softer chime for a genuinely
  // new standby notice -- same lazy-armed AudioContext, same
  // seen-ids-baseline pattern, but a clearly lower/softer pitch pair
  // (440/523 Hz vs. the assignment chime's 660/880 Hz) so drivers learn to
  // tell "heads up" apart from "you got one" by ear.
  const previousStandbyIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentIds = new Set(standbyNotices.map((n) => n.orderId));
    const hasNewArrival = [...currentIds].some((id) => !previousStandbyIds.current.has(id));
    previousStandbyIds.current = currentIds;
    if (!hasNewArrival) return;
    if (!soundEnabledRef.current) return;
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    try {
      const playNote = (frequency: number, startOffset: number, duration: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = frequency;
        gain.gain.value = 0.15;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + startOffset);
        osc.stop(ctx.currentTime + startOffset + duration);
      };
      playNote(440, 0, 0.16);
      playNote(523, 0.2, 0.22);
    } catch {
      /* the visual standby card remains the source of truth */
    }
  }, [standbyNotices, audioCtxRef, soundEnabledRef]);
  // Only a positively-known OFF_SHIFT driver sees the off-duty screen --
  // while `myDriver` hasn't loaded yet (e.g. local/offline provider, or a
  // brief moment before the first refresh completes), this must not be
  // mistaken for "not working" and must fall through to the normal
  // idle-ready state instead. Deliberately shiftStatus alone, not
  // driverAcceptsNewWork (which also folds in dispatchStatus): a driver who
  // is ON_SHIFT but PAUSED is still genuinely on duty and must keep seeing
  // pending-demand standby notices -- Multi-Order Dispatch fires those as
  // early as CONFIRMED specifically so an online-but-paused driver knows
  // work is waiting before deciding to resume.
  const operationalState = deriveDriverOperationalState(myDriver, current, standbyNotices.length > 0);
  // Driver UI Final Operational UX: "✅ Barcha yetkazib berishlar
  // yakunlandi" -- a brief confirmation once a genuine multi-stop route
  // (not a trivial single order) finishes completely, before the screen
  // settles back to the normal idle-ready state. hadRouteRef only ever
  // latches true once a real 2-stop route was observed (stopSequence
  // assigned, more than one active order) -- a single-order completion
  // never triggers this, keeping that path exactly as simple as before.
  const hadRouteRef = useRef(false);
  const [showAllDone, setShowAllDone] = useState(false);
  useEffect(() => {
    if (activeAssignments.length > 1 && activeAssignments.some((o) => o.stopSequence !== undefined)) {
      hadRouteRef.current = true;
    }
    if (activeAssignments.length === 0 && hadRouteRef.current) {
      hadRouteRef.current = false;
      setShowAllDone(true);
      const t = setTimeout(() => setShowAllDone(false), 6000);
      return () => clearTimeout(t);
    }
  }, [activeAssignments]);
  // Invariant: any active assignment that belongs to this driver and has
  // not been picked up must appear in the primary panel immediately --
  // never demoted to a passive list. A batch-mate of `current` gets the
  // shared pickup-batch/wait/route treatment (via `batchSibling` below);
  // anything else active (e.g. a second, unbatched order a dispatcher
  // manually assigned to a driver who already holds one -- a real path,
  // assign_driver_internal never sets pickup_batch_id) is not covered by
  // that pairing, so it gets its OWN full DriverMainPanel instance,
  // driven by its own state, with its own accept/decline or primary
  // action -- never just a number-and-district row.
  const batchSibling = current?.pickupBatchId ? queued.find((o) => o.pickupBatchId === current.pickupBatchId) : undefined;
  const otherActiveOrders = queued.filter((o) => o.id !== batchSibling?.id);
  return (
    <Shell surface="driver">
      <main className="driver-page">
        {!loaded && <div className="empty" role="status">Yuklanmoqda…</div>}
        {operationalError && <p className="error" role="alert">{operationalError}</p>}
        <div className="driver-head">
          <div>
            <p className="eyebrow">XAYRLI KUN{greetingName ? `, ${greetingName}` : ""}</p>
            <h1>Bugungi yetkazish</h1>
          </div>
          <SoundStatusControl enabled={soundEnabled} ready={soundReady} onToggle={toggleSound} testIdPrefix="driver" />
        </div>
        <DriverAvailabilityToggle
          driver={myDriver}
          busy={shiftBusy}
          hasActiveWork={activeAssignments.length > 0}
          activeCount={activeAssignments.length}
          onStart={() => {
            setShiftBusy(true);
            void startShift().finally(() => setShiftBusy(false));
          }}
          onEnd={() => {
            setShiftBusy(true);
            void endShift().finally(() => setShiftBusy(false));
          }}
        />
        {showAllDone && (
          <p className="all-done-banner" data-testid="driver-all-stops-complete">✅ Barcha yetkazib berishlar yakunlandi</p>
        )}
        {operationalState === "OFF_SHIFT" ? (
          <div className="empty" data-testid="driver-off-duty">
            <p>Hozir ishlamayapsiz.</p>
          </div>
        ) : operationalState === "STANDBY" ? (
          <DriverStandbyCard notices={standbyNotices} />
        ) : operationalState === "AVAILABLE" ? (
          <div className="empty" data-testid="driver-no-active">
            <span>🟢</span>
            <h2>Buyurtma olishga tayyor</h2>
            <p>Yangi buyurtma kelganda shu yerda ko‘rinadi.</p>
          </div>
        ) : (
          <>
            {current && <DriverMainPanel state={operationalState} order={current} sibling={batchSibling} batchContext={batchContext} />}
            {otherActiveOrders.map((o) => (
              <DriverMainPanel
                key={o.id}
                state={deriveDriverOperationalState(myDriver, o, false)}
                order={o}
                sibling={undefined}
                batchContext={batchContext}
              />
            ))}
          </>
        )}
      </main>
    </Shell>
  );
}
// Driver UI Final Operational UX: the one dispatcher deciding which
// operational screen the driver's own current assignment shows -- answers
// "what should I do right now?" without making the driver interpret raw
// lifecycle statuses. Every path an existing test already exercises
// (pre-acceptance, preparing, single-order in-transit) renders through the
// SAME, unchanged DriverAssignmentCard/DriverPreReadyCard/DriverDelivery
// components; only genuinely new multi-order moments (waiting for a
// batch-mate, both ready, a real multi-stop route) get new components.
function DriverMainPanel({
  state,
  order,
  sibling,
  batchContext,
}: {
  state: DriverOperationalState;
  order: Order;
  sibling: Order | undefined;
  batchContext: PickupBatchContext[];
}) {
  const { publicConfig } = useApp();
  // Production hotfix: "current stop / next stop" (DriverRoute) is a
  // ROUTE framing -- it must only exist once the courier has actually
  // left the restaurant with product in hand. Before that, both orders
  // are still just members of the same PICKUP mission, not stops on a
  // route -- server-computed stop_sequence (set once at the first
  // member's real PICKED_UP) is the one authoritative signal for "has
  // the route actually started," not order.status or acceptance state.
  const stopsAssigned = order.stopSequence !== undefined || sibling?.stopSequence !== undefined;
  const prePickupPair = Boolean(sibling) && !stopsAssigned;
  // Production hotfix: the "one ready / one still cooking" wait card
  // used to key off `order` (whichever order happened to sort first by
  // assignment time) reaching DRIVER_ASSIGNED -- but the restaurant can
  // finish the SECOND-assigned order first. When that happened live
  // (ZG-1067/ZG-1068), the wait/both-ready card never appeared for the
  // real ~17s window because `order` (the earlier-assigned one) was
  // still PREPARING while its sibling was already ready. Now keyed off
  // EITHER member being ready, with whichever one IS ready always
  // passed as DriverReadyWithBatch's `order` -- regardless of which one
  // was assigned first.
  const eitherReady = prePickupPair && (order.status === "DRIVER_ASSIGNED" || sibling!.status === "DRIVER_ASSIGNED");
  // A batch-mate disappearing while genuinely ready-for-pickup or en route
  // means the actual-wait window released it to redispatch -- surfaced
  // here (not inside DriverReadyWithBatch, which would already have
  // unmounted by the time that happens) so the brief explanation survives
  // the transition back to the plain single-order view. Deliberately
  // excluded during NEW_ASSIGNMENT/PREPARING, where a sibling disappearing
  // is ordinary self-service decline, not a server-driven release.
  const lastSiblingRef = useRef<Order | undefined>(undefined);
  const [justReleasedNumber, setJustReleasedNumber] = useState<string | null>(null);
  useEffect(() => {
    if (sibling) {
      lastSiblingRef.current = sibling;
      setJustReleasedNumber(null);
      return;
    }
    if (lastSiblingRef.current && state !== "NEW_ASSIGNMENT" && state !== "PREPARING") {
      const releasedNumber = lastSiblingRef.current.number;
      setJustReleasedNumber(releasedNumber);
      const t = setTimeout(() => setJustReleasedNumber(null), 8000);
      lastSiblingRef.current = undefined;
      return () => clearTimeout(t);
    }
    lastSiblingRef.current = undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sibling?.id, state]);
  return (
    <>
      {justReleasedNumber && (
        <p className="released-banner" data-testid="driver-second-order-released">
          ⚠ {justReleasedNumber} boshqa haydovchiga o‘tkazildi. {order.number} bilan yo‘lga chiqing.
        </p>
      )}
      {eitherReady ? (
        (() => {
          const readyOrder = order.status === "DRIVER_ASSIGNED" ? order : sibling!;
          const waitingOrder = readyOrder === order ? sibling! : order;
          return (
            <DriverReadyWithBatch
              order={readyOrder}
              sibling={waitingOrder}
              batch={batchContext.find((b) => b.batchId === readyOrder.pickupBatchId)}
            />
          );
        })()
      ) : prePickupPair ? (
        <DriverPickupBatchCard
          current={order}
          sibling={sibling!}
          batch={batchContext.find((b) => b.batchId === order.pickupBatchId)}
          restaurantName={publicConfig?.restaurantName || "Zaytun Kafe"}
        />
      ) : state === "NEW_ASSIGNMENT" ? (
        <DriverAssignmentCard order={order} />
      ) : state === "PREPARING" ? (
        <DriverPreReadyCard order={order} />
      ) : state === "READY_FOR_PICKUP" ? (
        <DriverDelivery order={order} />
      ) : sibling ? (
        <DriverRoute order={order} next={sibling} />
      ) : (
        <DriverDelivery order={order} />
      )}
    </>
  );
}
// Shared by DriverPreReadyCard and DriverReadyWithBatch -- purely
// informational (never touches order.status). Widened server-side to
// allow check-in as early as CONFIRMED/PREPARING (previously
// DRIVER_ASSIGNED-only), so the driver can head to the restaurant and
// check in while the food is still cooking, matching the spec's own
// "encourage arrival before ready" requirement.
function CheckInControl({ order }: { order: Order }) {
  const { markDriverAtRestaurant, transitionPending } = useApp();
  const arrived = order.assignmentHistory.find((a) => !a.endedAt)?.arrivedAtRestaurantAt;
  if (arrived) {
    return <p className="at-restaurant-badge" data-testid="driver-at-restaurant-badge">📍 Restoranda</p>;
  }
  return (
    <button
      type="button"
      className="button secondary wide"
      data-testid="driver-mark-at-restaurant"
      disabled={transitionPending(order.id)}
      onClick={() => void markDriverAtRestaurant(order.id)}
    >
      📍 Restoranga yetib keldim
    </button>
  );
}
// A real-data projection (acceptedAt + estimatedMinutes, falling back to
// the same 25-minute default the server itself falls back to) -- never a
// fabricated countdown. The one timing value the UI actually ACTS on (the
// actual-wait deadline in DriverReadyWithBatch) comes from
// list_my_pickup_batch_context() instead, computed authoritatively
// server-side.
function orderReadyEtaLabel(order: Order): string {
  if (order.status === "DRIVER_ASSIGNED" || order.status === "READY") return "✅ Tayyor";
  if (!order.acceptedAt) return "Tayyorlanmoqda";
  const minutes = order.estimatedMinutes ?? 25;
  const readyAt = new Date(order.acceptedAt).getTime() + minutes * 60000;
  const remaining = Math.round((readyAt - Date.now()) / 60000);
  return remaining > 0 ? `~${remaining} daqiqa` : "tez orada";
}
// Production hotfix: the primary pre-pickup presentation for a real
// two-order batch -- both orders rendered as first-class PICKUP BATCH
// MEMBERS, not "one full card + a tiny KEYINGI row." Replaces
// DriverAssignmentCard/DriverPreReadyCard whenever `current` genuinely
// has a live batch-mate that hasn't been picked up yet (see
// DriverMainPanel's prePickupPair). Each member gets its own
// accept/decline if the driver hasn't acted on it yet -- a newly-added
// second order surfaces here immediately, with the same prominence as
// the first, instead of only in the small bottom queue list.
function DriverPickupBatchCard({
  current,
  sibling,
  batch,
  restaurantName,
}: {
  current: Order;
  sibling: Order;
  batch: PickupBatchContext | undefined;
  restaurantName: string;
}) {
  const { acceptAssignment, declineAssignment, transitionPending } = useApp();
  const members = [current, sibling];
  const maxMembers = batch?.maxMembers ?? members.length;
  return (
    <section className="delivery-card batch-mission-card" data-testid="driver-pickup-batch">
      <div className="route-mission-header" data-testid="driver-batch-mission-header">
        <span>📦 {members.length} TA BUYURTMA</span>
        <span>·</span>
        <span>BITTA OLIB KETISH</span>
      </div>
      <p className="assignment-prep-hint">{restaurantName} — olib ketish shu yerdan.</p>
      {members.map((o) => {
        const ready = o.status === "DRIVER_ASSIGNED";
        const label = orderReadyEtaLabel(o);
        return (
          <div className="batch-member-row" key={o.id} data-testid={`driver-batch-member-${o.id}`}>
            <div className="batch-member-top">
              <b>{o.number}</b>
              <span className={ready ? "ready" : "cooking"}>{ready ? label : `🟠 ${label}`}</span>
            </div>
            {!o.assignmentAcceptedAt ? (
              <div className="driver-queue-actions">
                <button
                  type="button"
                  className="button primary"
                  data-testid={`driver-batch-accept-${o.id}`}
                  disabled={transitionPending(o.id)}
                  onClick={() => void acceptAssignment(o.id)}
                >
                  Qabul qilish
                </button>
                <button
                  type="button"
                  className="button secondary"
                  data-testid={`driver-batch-decline-${o.id}`}
                  disabled={transitionPending(o.id)}
                  onClick={() => void declineAssignment(o.id)}
                >
                  Ololmayman
                </button>
              </div>
            ) : (
              o.id === current.id && <CheckInControl order={o} />
            )}
          </div>
        );
      })}
      <p className="batch-panel-footer" data-testid="driver-batch-count">{members.length}/{maxMembers} buyurtma</p>
    </section>
  );
}
// Spec: "group compatible orders visually as one pickup mission... the
// backend batch is real, the UI should make that relationship obvious."
function PickupBatchPanel({ order, siblings, restaurantName }: { order: Order; siblings: Order[]; restaurantName: string }) {
  if (siblings.length === 0) return null;
  const members = [order, ...siblings];
  return (
    <div className="batch-panel" data-testid="driver-batch-group">
      <p className="batch-panel-title">{restaurantName} — {members.length} ta buyurtma olib ketish</p>
      {members.map((o) => (
        <div className="batch-panel-row" key={o.id}>
          <b>{o.number}</b>
          <span>{orderReadyEtaLabel(o)}</span>
        </div>
      ))}
    </div>
  );
}
// The critical "one ready, second ~N minutes behind" and "both ready"
// scenarios: the platform (not the courier) decides and communicates the
// brief wait, driven entirely by list_my_pickup_batch_context()'s
// server-computed deadline -- never a client-invented countdown target,
// though the display may tick down live from that real value.
function DriverReadyWithBatch({ order, sibling, batch }: { order: Order; sibling: Order; batch: PickupBatchContext | undefined }) {
  const { transition, transitionPending } = useApp();
  const [pickupError, setPickupError] = useState("");
  // Re-render periodically so a live wait countdown can tick down without
  // a manual refresh -- minute-granularity display, so a coarse interval
  // is enough.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 20000);
    return () => clearInterval(id);
  }, []);
  const siblingReady = sibling.status === "DRIVER_ASSIGNED";
  const deadline = batch?.waitDeadlineAt ? new Date(batch.waitDeadlineAt).getTime() : undefined;
  const minutesLeft = deadline !== undefined ? Math.ceil((deadline - Date.now()) / 60000) : undefined;
  const deadlinePassed = minutesLeft !== undefined && minutesLeft <= 0;
  const pickupBoth = async () => {
    setPickupError("");
    try {
      await transition(order.id, "PICKED_UP", "DRIVER");
      await transition(sibling.id, "PICKED_UP", "DRIVER");
    } catch (e) {
      // Partial failure is handled safely: whichever transition already
      // succeeded stands (never faked, never rolled back client-side);
      // the driver sees exactly what happened and can retry.
      setPickupError(e instanceof Error ? e.message : "Buyurtmani olishda xatolik yuz berdi");
    }
  };
  if (siblingReady) {
    return (
      <section className="delivery-card batch-ready-card" data-testid="driver-both-ready">
        <p className="ready-badge">✅ 2 TA BUYURTMA TAYYOR</p>
        <div className="batch-ready-list">
          <b>{order.number}</b>
          <b>{sibling.number}</b>
        </div>
        <p className="hint">Ikkalasini birga oling.</p>
        {pickupError && <p className="error" role="alert">{pickupError}</p>}
        <button
          type="button"
          className="button primary wide big"
          data-testid="driver-primary-action"
          disabled={transitionPending(order.id) || transitionPending(sibling.id)}
          onClick={() => void pickupBoth()}
        >
          2 TA BUYURTMANI OLDIM
        </button>
      </section>
    );
  }
  return (
    <section className="delivery-card wait-card" data-testid={deadlinePassed ? "driver-leave-now" : "driver-wait-for-second"}>
      <div className="delivery-top">
        <span>OLIB KETISH</span>
        <Badge status={order.status} />
      </div>
      <h2>{order.number}</h2>
      <p className="ready-badge-inline">✅ TAYYOR</p>
      <CheckInControl order={order} />
      <div className="wait-sibling-line">
        <b>{sibling.number}</b>
        <span className={deadlinePassed ? "warning" : ""}>
          {deadlinePassed ? "⚠ Kechikmoqda" : minutesLeft !== undefined ? `⏱ Taxminan ${minutesLeft} daqiqa` : "Tayyorlanmoqda"}
        </span>
      </div>
      {deadlinePassed ? (
        <>
          <p className="wait-instruction">{sibling.number} kechikmoqda. {order.number} bilan yo‘lga chiqishingiz mumkin.</p>
          <button
            type="button"
            className="button primary wide big"
            data-testid="driver-primary-action"
            disabled={transitionPending(order.id)}
            onClick={() => void transition(order.id, "PICKED_UP", "DRIVER")}
          >
            Buyurtmani oldim
          </button>
        </>
      ) : (
        <>
          <p className="wait-instruction">
            {minutesLeft !== undefined ? `⏱ ${minutesLeft} daqiqa kuting` : "Ikkinchi buyurtmani kuting"} — ikkinchi buyurtma tez orada tayyor bo‘ladi. Ikkalasini birga olib ketasiz.
          </p>
          <button
            type="button"
            className="button secondary wide"
            data-testid="driver-primary-action"
            disabled={transitionPending(order.id)}
            onClick={() => void transition(order.id, "PICKED_UP", "DRIVER")}
          >
            Faqat {order.number} bilan ketish
          </button>
        </>
      )}
    </section>
  );
}
// Spec: "current stop should dominate... next stop secondary." Wraps the
// existing, unchanged DriverDelivery (single-order path stays exactly as
// simple as before -- this wrapper only appears once there's a genuine
// second stop) with the deterministic server-computed stop_sequence.
//
// Production hotfix: the two batched orders looked unrelated -- the second
// stop was reduced to a single small row (order number + district only),
// so the driver had no way to tell "these two orders are one delivery
// mission" until they'd already finished the first one. This still keeps
// stop 1 as the sole actionable card (DriverDelivery, byte-identical) --
// stop 2 gets a real summary (district, street/house, distance, an
// expandable order-contents/collection disclosure) but deliberately NO
// primary action of its own: no ARRIVED/DELIVERED affordance, no way to
// service it out of order. Visibility only, never execution -- Stop 1
// remains the sole authoritative current stop.
function DriverRoute({ order, next }: { order: Order; next: Order }) {
  const nextPayment = driverPaymentSummary(next);
  return (
    <div className="driver-route">
      <div className="route-mission-header" data-testid="driver-route-mission-header">
        <span>2 TA BUYURTMA</span>
        <span>·</span>
        <span>BITTA YO‘NALISH</span>
      </div>
      <div className="route-current-label" data-testid="driver-route-current-stop">
        <span>HOZIRGI MANZIL</span>
        <b>{order.stopSequence ?? 1}-manzil</b>
      </div>
      <DriverDelivery order={order} />
      <div className="route-next-card" data-testid="driver-route-next-stop">
        <div className="route-next-top">
          <span>{next.stopSequence ?? (order.stopSequence ?? 1) + 1}-manzil</span>
          <span>KEYINGI</span>
        </div>
        <h3>{next.number}</h3>
        <p className="route-next-address">
          {next.address?.district || "—"}
          <br />
          {next.address && `${next.address.street}, ${next.address.house}`}
        </p>
        {next.address?.deliveryDistanceKm !== undefined && <b className="route-next-distance">{next.address.deliveryDistanceKm.toFixed(1)} km</b>}
        <details className="route-next-details" data-testid="driver-route-next-details">
          <summary>Tafsilotlarni ko‘rish</summary>
          <div className="route-next-details-body">
            {next.items.map((it) => (
              <p key={it.id}>
                {it.quantity} × {it.name}
              </p>
            ))}
            <p>
              {nextPayment.amount ? "Undirish kerak" : "To‘lov"}: <b>{nextPayment.amount ?? nextPayment.label}</b>
            </p>
          </div>
        </details>
      </div>
    </div>
  );
}
// Driver UI Phase: informational only -- "standby is information, not
// ownership." No accept/decline affordance at all, deliberately styled
// (see .standby-card in styles.css) to be visually unmistakable from
// DriverAssignmentCard's urgent, actionable presentation.
function DriverStandbyCard({ notices }: { notices: DriverStandbyNotice[] }) {
  return (
    <section className="standby-card" data-testid="driver-standby-notice">
      <p className="standby-badge">🔔 TAYYORGARLIK</p>
      <h2>{notices.length > 1 ? `${notices.length} ta yetkazib berish tayyorlanmoqda` : "Yangi yetkazib berish tayyorlanmoqda"}</h2>
      <p>Taxminan 20–25 daqiqa. Tayyor turing.</p>
    </section>
  );
}
// P4.2/P4.3/P6.1: the prominent "new delivery" presentation for an
// assignment the driver hasn't accepted yet. Decline ("Ololmayman") stays
// visually secondary -- a plain secondary button, never styled to compete
// with the primary accept action -- and only reveals the small optional
// reason chips (P6.2) after being tapped, rather than declining
// immediately on one accidental tap. This card is only ever rendered
// pre-acceptance (DriverApp swaps to DriverDelivery once accepted), so
// decline naturally disappears the moment the assignment is accepted --
// no separate condition needed here.
function DriverAssignmentCard({ order }: { order: Order }) {
  const { acceptAssignment, declineAssignment, transitionPending, publicConfig, orders } = useApp();
  const [declineOpen, setDeclineOpen] = useState(false);
  // Multi-Order Dispatch: computed purely from state already in hand (the
  // driver's own RLS-scoped order list) -- no second RPC round-trip.
  const batchSiblingCount = order.pickupBatchId
    ? orders.filter((o) => o.pickupBatchId === order.pickupBatchId && o.id !== order.id).length
    : 0;
  return (
    <section className="assignment-card" data-testid="driver-assignment-card">
      <p className="assignment-badge">🚗 YANGI YETKAZIB BERISH</p>
      <h2>{order.number}</h2>
      <div className="assignment-route">
        <div>
          <small>TAYYOR BO‘LISHI</small>
          <b>{order.estimatedMinutes ? `~${order.estimatedMinutes} daqiqa` : "~20–25 daqiqa"}</b>
        </div>
        <div>
          <small>YETKAZISH HUDUDI</small>
          <b>{order.address?.district || "—"}</b>
        </div>
      </div>
      <p className="assignment-prep-hint">{publicConfig?.restaurantName || "Zaytun Kafe"} — olib ketish shu yerdan.</p>
      {batchSiblingCount > 0 && (
        <p className="assignment-batch-hint" data-testid="assignment-batch-hint">📦 Yana {batchSiblingCount} ta buyurtma shu olib ketish guruhida</p>
      )}
      <button
        type="button"
        className="button primary wide big"
        data-testid="driver-primary-action"
        disabled={transitionPending(order.id)}
        onClick={() => void acceptAssignment(order.id)}
      >
        Qabul qilish
      </button>
      {!declineOpen ? (
        <button
          type="button"
          className="button secondary wide"
          data-testid="driver-decline-assignment"
          disabled={transitionPending(order.id)}
          onClick={() => setDeclineOpen(true)}
        >
          Ololmayman
        </button>
      ) : (
        <div className="decline-reasons" data-testid="decline-reasons">
          <small>Nega olmayapsiz? (ixtiyoriy)</small>
          <div className="decline-reason-options">
            {(Object.keys(declineReasonLabels) as AssignmentDeclineReason[]).map((reason) => (
              <button
                type="button"
                key={reason}
                className="button secondary"
                data-testid={`decline-reason-${reason}`}
                disabled={transitionPending(order.id)}
                onClick={() => void declineAssignment(order.id, reason)}
              >
                {declineReasonLabels[reason]}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="button secondary wide"
            data-testid="decline-cancel"
            onClick={() => setDeclineOpen(false)}
          >
            Ortga
          </button>
        </div>
      )}
    </section>
  );
}
function driverPaymentSummary(order: Order): { label: string; amount?: string } {
  if (isRemotePaymentMethod(order.paymentMethod)) {
    return { label: `${paymentLabel(order.paymentMethod, true)} — restoran tekshiradi` };
  }
  return {
    label: order.paymentMethod === "CARD_ON_DELIVERY" ? "Karta (yetkazishda)" : "Naqd",
    amount: money(order.total),
  };
}
// Multi-Order Dispatch: an accepted order whose kitchen state (order.status)
// hasn't reached READY yet -- the driver has committed, but there is no
// PICKED_UP/ON_THE_WAY/etc action to take yet (next[order.status] would be
// undefined for CONFIRMED/PREPARING). Purely informational: order number,
// a practical prep-time signal, and a batch-partner hint if applicable.
function DriverPreReadyCard({ order }: { order: Order }) {
  const { orders, publicConfig } = useApp();
  const siblings = order.pickupBatchId ? orders.filter((o) => o.pickupBatchId === order.pickupBatchId && o.id !== order.id) : [];
  return (
    <section className="delivery-card pre-ready-card" data-testid="driver-pre-ready-card">
      <div className="delivery-top">
        <span>SIZGA BIRIKTIRILGAN</span>
        <Badge status={order.status} />
      </div>
      <h2>{order.number}</h2>
      <p className="assignment-prep-hint">
        {order.estimatedMinutes ? `Taxminan ${order.estimatedMinutes} daqiqada tayyor bo‘ladi.` : "Taxminan 20–25 daqiqada tayyor bo‘ladi."}
      </p>
      {siblings.length > 0 && (
        <p className="assignment-batch-hint" data-testid="assignment-batch-hint">📦 Yana {siblings.length} ta buyurtma shu olib ketish guruhida</p>
      )}
      {/* Spec: encourage arrival before the food is ready -- check-in is
          now available as early as this screen, not just once READY. */}
      <CheckInControl order={order} />
      <PickupBatchPanel order={order} siblings={siblings} restaurantName={publicConfig?.restaurantName || "Zaytun Kafe"} />
      <p className="hint">Tayyor bo‘lganda shu yerda ko‘rinadi -- hozircha kutib turing.</p>
    </section>
  );
}
function DriverDelivery({ order }: { order: Order }) {
  const { transition, reportIssue, transitionPending } = useApp();
  const [issueOpen, setIssueOpen] = useState(false);
  const [issue, setIssue] = useState("");
  if (order.status === "CONFIRMED" || order.status === "PREPARING") {
    return <DriverPreReadyCard order={order} />;
  }
  const next: Partial<Record<OrderStatus, OrderStatus>> = {
    PICKED_UP: "ON_THE_WAY",
    ON_THE_WAY: "ARRIVED",
    ARRIVED: "DELIVERED",
  };
  const labels: Partial<Record<OrderStatus, string>> = {
    DRIVER_ASSIGNED: "Buyurtmani oldim",
    PICKED_UP: "Yo‘lga chiqdim",
    ON_THE_WAY: "Yetib keldim",
    ARRIVED: "Yetkazildi",
  };
  const target = order.status === "DRIVER_ASSIGNED" ? "PICKED_UP" : next[order.status];
  const coordinate = order.address?.latitude !== undefined && order.address.longitude !== undefined ? {latitude:order.address.latitude,longitude:order.address.longitude} : undefined;
  const payment = driverPaymentSummary(order);
  return (
    <>
      <section className="delivery-card">
        <div className="delivery-top">
          <span>HOZIRGI YETKAZISH</span>
          <Badge status={order.status} />
        </div>
        <h2>{order.number}</h2>
        {/* P4.5 order-information hierarchy: next action first (the
            primary button below), then destination/navigation, then
            customer contact, then delivery notes, then payment, then
            order contents last -- the courier does not need
            restaurant-admin-weight detail on every field. */}
        {target && (
          <button
            className="button primary wide big"
            data-testid="driver-primary-action"
            disabled={transitionPending(order.id)}
            onClick={() => void transition(order.id, target, "DRIVER")}
          >
            {labels[order.status]}
          </button>
        )}
        {/* Driver UI Phase: purely informational, additive -- never
            replaces or disables the primary action above, so the driver
            can proceed to PICKED_UP with or without tapping this. */}
        {order.status === "DRIVER_ASSIGNED" && <CheckInControl order={order} />}
        <div className="pickup customer-dot">
          <i>C</i>
          <div>
            <small>MANZIL</small>
            <b>{order.address?.district}</b>
            <span>{order.address && `${order.address.street}, ${order.address.house}`}</span>
            <em>{order.address?.landmark}</em>
          </div>
        </div>
        {order.address && (order.address.deliveryDistanceKm !== undefined || order.address.confidence !== "COMPLETE" || coordinate) && (
          <div className="driver-location-summary" data-testid="driver-location-detail">
            {order.address.deliveryDistanceKm !== undefined && <b>{order.address.deliveryDistanceKm.toFixed(1)} km</b>}
            {order.address.confidence !== "COMPLETE" && <p className="warning">⚠ Manzilni mijoz bilan aniqlashtiring</p>}
            {/* P4.6: raw coordinates are never part of the normal driver
                UI -- collapsed behind an opt-in disclosure, same pattern
                as the restaurant's own location panel. Exact coordinates
                stay fully available for support/troubleshooting, just not
                displayed by default. */}
            {coordinate && (
              <details className="location-debug" data-testid="driver-location-debug">
                <summary>Texnik ma'lumot</summary>
                <p>
                  {coordinate.latitude.toFixed(6)}, {coordinate.longitude.toFixed(6)}
                </p>
              </details>
            )}
          </div>
        )}
        <div className="two-actions driver-nav-actions">
          <a className="button secondary" href={`tel:${order.customer.primaryPhone}`} data-testid="driver-call-customer">
            ☎ Mijozga qo‘ng‘iroq
          </a>
          {coordinate && (
            <a
              className="button primary"
              href={navigationUrl("yandex", coordinate)}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="driver-open-navigation"
            >
              📍 Yo‘nalishni ochish
            </a>
          )}
        </div>
        {coordinate && (
          <a className="driver-alt-nav" href={navigationUrl("google", coordinate)} target="_blank" rel="noopener noreferrer">
            Google Maps’da ochish
          </a>
        )}
        {(order.specialInstructions || order.address?.deliveryNotes) && (
          <div className="driver-notes">
            {order.address?.deliveryNotes && (
              <p className="driver-note">
                <b>Yetkazish izohi:</b> {order.address.deliveryNotes}
              </p>
            )}
            {order.specialInstructions && (
              <p className="driver-note">
                <b>Buyurtma izohi:</b> {order.specialInstructions}
              </p>
            )}
          </div>
        )}
        <div className="collect">
          <span>
            {payment.amount ? "Undirish kerak" : "To‘lov"}
            <br />
            <small>{payment.label}</small>
          </span>
          {payment.amount && <b>{payment.amount}</b>}
        </div>
        <details className="driver-order-contents">
          <summary>Buyurtma tarkibi</summary>
          {order.items.map((i) => (
            <p key={i.id}>
              {i.quantity} × {i.name}
            </p>
          ))}
        </details>
        <button
          className="button text wide"
          data-testid="driver-report-issue-toggle"
          onClick={() => setIssueOpen(!issueOpen)}
        >
          Muammo haqida xabar berish
        </button>
        {issueOpen && (
          <div className="issue-form">
            <select
              value={issue}
              onChange={(e) => setIssue(e.target.value)}
              aria-label="Muammo turi"
            >
              <option value="">Muammoni tanlang</option>
              <option value="CUSTOMER_NOT_ANSWERING">
                Mijoz javob bermayapti
              </option>
              <option value="ADDRESS_INCORRECT">Manzil noto‘g‘ri</option>
              <option value="PAYMENT_PROBLEM">To‘lov muammosi</option>
            </select>
            <button
              disabled={!issue}
              data-testid="driver-report-issue-submit"
              onClick={() =>
                void reportIssue(
                  order.id,
                  issue as "CUSTOMER_NOT_ANSWERING",
                  "Haydovchi yordam so‘radi",
                  "driver-1",
                )
              }
            >
              Yuborish
            </button>
            <button
              disabled={!issue}
              className="danger-link"
              data-testid="driver-mark-failed"
              onClick={() =>
                void transition(order.id, "DELIVERY_FAILED", "DRIVER", issue)
              }
            >
              Yetkazilmadi deb belgilash
            </button>
          </div>
        )}
      </section>
    </>
  );
}
// Driver login offers two methods on one page: the pre-existing
// phone/email + password form (default -- unchanged behavior, still what
// e2e/auth-local.spec.ts exercises against a real provisioned local driver
// account) and, behind an explicit toggle, closed-enrollment phone+OTP
// login. OTP is additive, not a replacement: production readiness of
// hosted Phone Auth is a separate, independently-gated concern (see
// docs/production-readiness.md), so the proven password path must keep
// working regardless of that state. An unrecognized phone can never gain
// courier access via the OTP path -- sendDriverOtp (state.tsx) always
// passes shouldCreateUser:false, and even a successfully-verified session
// still has to clear AuthGate's own role==="DRIVER" gate afterward before
// /driver renders, exactly like the password path already does.
function DriverLogin({ authError }: { authError: string }) {
  const { signIn, sendDriverOtp, verifyDriverOtp } = useApp();
  const [mode, setMode] = useState<"password" | "otp">("password");
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [otpStep, setOtpStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [canonicalPhone, setCanonicalPhone] = useState("");
  const [code, setCode] = useState("");
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpError, setOtpError] = useState("");
  const [resendCooldown, setResendCooldown] = useState(0);
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => setResendCooldown((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);
  const handleSend = async () => {
    if (otpBusy || resendCooldown > 0) return;
    setOtpError("");
    setOtpBusy(true);
    try {
      const canonical = await sendDriverOtp(phone);
      setCanonicalPhone(canonical);
      setCode("");
      setOtpStep("code");
      setResendCooldown(DRIVER_OTP_RESEND_COOLDOWN_SECONDS);
    } catch (failure) {
      setOtpError(failure instanceof Error ? failure.message : "Xatolik yuz berdi");
    } finally {
      setOtpBusy(false);
    }
  };
  const handleVerify = async () => {
    if (otpBusy) return;
    setOtpError("");
    setOtpBusy(true);
    try {
      await verifyDriverOtp(canonicalPhone, code);
      // Success: the onAuthStateChange listener (state.tsx) picks up the
      // new session and resolves role, and AuthGate re-renders past this
      // component on its own -- no local "done" state needed here.
    } catch (failure) {
      setOtpError(failure instanceof Error ? failure.message : "Xatolik yuz berdi");
    } finally {
      setOtpBusy(false);
    }
  };
  return (
    <Shell surface="driver">
      <main className="narrow">
        <section className="form-card">
          <p className="eyebrow">HAYDOVCHILAR UCHUN</p>
          <h1>Kirish</h1>
          {mode === "password" && (
            <>
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setPasswordError("");
                  try {
                    await signIn(identifier, password);
                  } catch (failure) {
                    setPasswordError(failure instanceof Error ? failure.message : "Kirish amalga oshmadi");
                  }
                }}
              >
                <Field label="Telefon yoki email" value={identifier} onChange={setIdentifier} />
                <Field label="Parol" value={password} onChange={setPassword} />
                {(passwordError || authError) && <p className="error" role="alert">{passwordError || authError}</p>}
                <button className="button primary wide">Kirish</button>
              </form>
              <button
                type="button"
                className="button text"
                data-testid="driver-otp-switch"
                onClick={() => setMode("otp")}
              >
                SMS-kod bilan
              </button>
            </>
          )}
          {mode === "otp" && (
            <>
              {otpStep === "phone" && (
                <>
                  <Field
                    label="Telefon raqamingiz"
                    value={phone}
                    placeholder="+998 __ ___ __ __"
                    onChange={setPhone}
                  />
                  <button
                    type="button"
                    className="button primary wide"
                    data-testid="driver-otp-send"
                    disabled={otpBusy || resendCooldown > 0}
                    onClick={() => void handleSend()}
                  >
                    {otpBusy ? "Yuborilmoqda…" : "Kod yuborish"}
                  </button>
                </>
              )}
              {otpStep === "code" && (
                <>
                  <p>{canonicalPhone} raqamiga yuborilgan kodni kiriting.</p>
                  <Field
                    label="Tasdiqlash kodi"
                    value={code}
                    placeholder="123456"
                    onChange={setCode}
                  />
                  <button
                    type="button"
                    className="button primary wide"
                    data-testid="driver-otp-verify"
                    disabled={otpBusy || !code}
                    onClick={() => void handleVerify()}
                  >
                    {otpBusy ? "Tekshirilmoqda…" : "Kirish"}
                  </button>
                  <button
                    type="button"
                    className="button text"
                    data-testid="driver-otp-resend"
                    disabled={otpBusy || resendCooldown > 0}
                    onClick={() => void handleSend()}
                  >
                    {resendCooldown > 0 ? `Kodni qayta yuborish (${resendCooldown}s)` : "Kodni qayta yuborish"}
                  </button>
                </>
              )}
              {(otpError || authError) && (
                <p className="error" role="alert" data-testid="driver-otp-error">
                  {otpError || authError}
                </p>
              )}
              <button
                type="button"
                className="button text"
                data-testid="driver-password-switch"
                onClick={() => setMode("password")}
              >
                Parol bilan
              </button>
            </>
          )}
        </section>
      </main>
    </Shell>
  );
}
function AuthGate({ children, surface }: { children: React.ReactNode; surface: "restaurant" | "driver" }) {
  const { authReady, session, role, authError, signIn, signOut } = useApp();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const permitted = surface === "driver" ? role === "DRIVER" : role === "RESTAURANT" || role === "DISPATCHER";
  if (!authReady) return <div className="empty" role="status">Sessiya tekshirilmoqda…</div>;
  if (!supabaseConfigured) return <>{children}</>;
  if (session && permitted) return <>{children}<button className="auth-signout" type="button" onClick={() => void signOut().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Chiqish amalga oshmadi"))}>Chiqish</button></>;
  if (session && !permitted) return <Shell surface={surface === "driver" ? "driver" : "staff"}><main className="narrow"><section className="form-card"><h1>Ruxsat yo‘q</h1><p>Bu hisob ushbu operatsion bo‘limga kira olmaydi.</p><button className="button secondary" onClick={() => void signOut()}>Boshqa hisob bilan kirish</button></section></main></Shell>;
  if (surface === "driver") return <DriverLogin authError={authError} />;
  return (
    <Shell surface="staff">
      <main className="narrow">
        <section className="form-card">
          <p className="eyebrow">XODIMLAR UCHUN</p>
          <h1>Kirish</h1>
          <p>
            Restaurant yoki dispatcher Supabase Auth hisobi bilan kiring.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              try {
                await signIn(identifier, password);
              } catch (failure) {
                setError(failure instanceof Error ? failure.message : "Kirish amalga oshmadi");
              }
            }}
          >
            <Field label="Telefon yoki email" value={identifier} onChange={setIdentifier} />
            <Field label="Parol" value={password} onChange={setPassword} />
            {(error || authError) && <p className="error" role="alert">{error || authError}</p>}
            <button className="button primary wide">Kirish</button>
          </form>
          <small>
            Mahalliy hisoblar `supabase/seed.sql` va README’da
            hujjatlashtirilgan.
          </small>
        </section>
      </main>
    </Shell>
  );
}
export default function App() {
  return (
    <><UpdateNotice/><Routes>
      <Route path="/" element={<Home />} />
      <Route path="/menu" element={<Menu />} />
      <Route path="/menu/:id" element={<Product />} />
      <Route path="/cart" element={<Cart />} />
      <Route path="/checkout" element={<Checkout />} />
      <Route path="/confirmation/:id" element={<Confirmation />} />
      <Route path="/track/:id" element={<Track />} />
      <Route
        path="/restaurant"
        element={
          <AuthGate surface="restaurant">
            <Restaurant />
          </AuthGate>
        }
      />
      <Route
        path="/restaurant/orders/:id"
        element={
          <AuthGate surface="restaurant">
            <OrderDetail />
          </AuthGate>
        }
      />
      <Route
        path="/restaurant/history"
        element={
          <AuthGate surface="restaurant">
            <History />
          </AuthGate>
        }
      />
      <Route
        path="/restaurant/drivers/history"
        element={
          <AuthGate surface="restaurant">
            <DriverLedger />
          </AuthGate>
        }
      />
      <Route
        path="/driver"
        element={
          <AuthGate surface="driver">
            <DriverApp />
          </AuthGate>
        }
      />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes></>
  );
}
