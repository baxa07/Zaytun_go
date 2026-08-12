import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
  type ActorType,
  type AddressConfidence,
  type CustomerAddress,
  type DriverAvailability,
  type MenuItem,
  type Order,
  type OrderStatus,
  type PaymentCollectionStatus,
  type PaymentMethod,
  type PendingCheckout,
  type RestaurantConfig,
} from "./domain";
import { useApp, CustomerAuthRequiredError } from "./state";
import { normalizeUzbekPhone } from "./phone";
import { supabaseConfigured } from "./supabase";
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
import {customerDeliveryStageEventMatchers,customerDeliveryStageIndex,customerDeliveryStages,fulfillmentStatusLabel,fulfillmentTimeline,isNormalDeliveryStatus,isRemotePaymentMethod,paymentLabel,paymentMethodsForFulfillment,pickupPaymentGuidance,remotePaymentCustomerNotice,remotePaymentStaffHint} from './fulfillmentLifecycle'
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
  // Automatic empty-field-only autofill (distinct from the explicit
  // "Manzilni qo'llash" apply below): the instant a reverse-geocode
  // suggestion resolves, quietly fill only whichever of district/street/
  // house are still empty -- never touch a field the customer already
  // typed into. Tracked by object identity so this fires once per genuine
  // new suggestion, not on every unrelated re-render.
  const autoFilledSuggestion = useRef<AddressSuggestion | undefined>(undefined);
  const [autoFillNotice, setAutoFillNotice] = useState(false);
  useEffect(() => {
    const suggestion = mapSelection.suggestion;
    if (!suggestion || suggestion === autoFilledSuggestion.current) return;
    autoFilledSuggestion.current = suggestion;
    let filledAny = false;
    (["district", "street", "house"] as const).forEach((key) => {
      const suggested = suggestion[key];
      if (suggested && !address[key].trim()) {
        set(key, suggested);
        filledAny = true;
      }
    });
    if (filledAny) {
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
                {publicConfig.deliveryReviewMessage || "Navoiy shahri bo‘ylab yetkazib berish bepul. Manzil operator tomonidan tasdiqlanadi."}
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
            <Field
              label="Telefon *"
              value={isCustomerAuthenticated ? formatMaskedPhone(verifiedPhone) : address.primaryPhone}
              error={errors.primaryPhone}
              placeholder="+998 90 123 45 67"
              onChange={(v) => set("primaryPhone", v)}
              readOnly={isCustomerAuthenticated}
            />
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
function Track() {
  const { id } = useParams();
  const { orders, loadTrackedOrder, publicConfig } = useApp();
  const [trackingReady, setTrackingReady] = useState(false);
  const [trackingError, setTrackingError] = useState("");
  const [editingAddress, setEditingAddress] = useState(false);
  const [justRevised, setJustRevised] = useState(false);
  const order = orders.find((o) => o.id === id);
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
      </main>
    </Shell>
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
  const audioCtxRef = useRef<AudioContext | null>(null);
  useEffect(() => {
    const arm = () => {
      if (audioCtxRef.current) return;
      try {
        audioCtxRef.current = new AudioContext();
      } catch {
        /* persistent visual alert remains the source of truth */
      }
    };
    document.addEventListener("pointerdown", arm, { once: true });
    document.addEventListener("keydown", arm, { once: true });
    return () => {
      document.removeEventListener("pointerdown", arm);
      document.removeEventListener("keydown", arm);
    };
  }, []);
  const previousUnacknowledgedIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const currentIds = new Set(unacknowledgedNew.map((o) => o.id));
    // Only a genuinely NEW unacknowledged id (not present last render)
    // triggers a fresh alert sound -- an ordinary Realtime refresh/
    // reconnect that returns the same still-unacknowledged orders never
    // replays them as new.
    const hasNewArrival = [...currentIds].some(
      (id) => !previousUnacknowledgedIds.current.has(id),
    );
    previousUnacknowledgedIds.current = currentIds;
    if (!hasNewArrival) return;
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    try {
      const playNote = (frequency: number, startOffset: number, duration: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = frequency;
        gain.gain.value = 0.2;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime + startOffset);
        osc.stop(ctx.currentTime + startOffset + duration);
      };
      playNote(880, 0, 0.18);
      playNote(1108, 0.22, 0.24);
    } catch {
      /* visible alert remains the source of truth -- never block on audio */
    }
  }, [unacknowledgedNew]);
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
        {isRemotePaymentMethod(order.paymentMethod) && "⚠ "}
        To‘lov: {paymentLabel(order.paymentMethod, true)}
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
                  </>
                ) : (
                  <p className="warning">Haydovchi ma'lumoti topilmadi</p>
                )}
              </section>
            )}
          </div>
          <aside className="panel action-panel">
            <h2>Keyingi amal</h2>
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
            {order.status === "READY" && order.type === "DELIVERY" && (
              <>
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
              </>
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
function DriverApp() {
  const { orders, loaded, operationalError, profileDisplayName } = useApp();
  const greetingName = driverGreetingName(profileDisplayName);
  const active = orders.find(
    (o) =>
      o.type === "DELIVERY" &&
      o.assignedDriverId &&
      !["DELIVERED", "CANCELLED", "RETURNED", "DELIVERY_FAILED"].includes(
        o.status,
      ),
  );
  return (
    <Shell surface="driver">
      <main className="driver-page">
        {!loaded && <div className="empty" role="status">Topshiriqlar yuklanmoqda…</div>}
        {operationalError && <p className="error" role="alert">{operationalError}</p>}
        <div className="driver-head">
          <div>
            <p className="eyebrow">XAYRLI KUN{greetingName ? `, ${greetingName}` : ""}</p>
            <h1>Bugungi yetkazish</h1>
          </div>
          <span className="online">● Band</span>
        </div>
        {active ? (
          <DriverDelivery order={active} />
        ) : (
          <div className="empty" data-testid="driver-no-active">
            <span>✓</span>
            <h2>Faol yetkazish yo‘q</h2>
            <p>Yangi topshiriq shu yerda ko‘rinadi.</p>
          </div>
        )}
      </main>
    </Shell>
  );
}
function DriverDelivery({ order }: { order: Order }) {
  const { transition, acceptAssignment, reportIssue, publicConfig, transitionPending } = useApp();
  const [issueOpen, setIssueOpen] = useState(false);
  const [issue, setIssue] = useState("");
  const next: Partial<Record<OrderStatus, OrderStatus>> = {
    DRIVER_ASSIGNED: "PICKED_UP",
    PICKED_UP: "ON_THE_WAY",
    ON_THE_WAY: "ARRIVED",
    ARRIVED: "DELIVERED",
  };
  const labels: Partial<Record<OrderStatus, string>> = {
    DRIVER_ASSIGNED: "Olib ketdim",
    PICKED_UP: "Yo‘lga chiqdim",
    ON_THE_WAY: "Yetib keldim",
    ARRIVED: "Yetkazildi",
  };
  const target = next[order.status];
  const needsAcceptance =
    order.status === "DRIVER_ASSIGNED" && !order.assignmentAcceptedAt;
  const coordinate = order.address?.latitude !== undefined && order.address.longitude !== undefined ? {latitude:order.address.latitude,longitude:order.address.longitude} : undefined;
  return (
    <>
      <section className="delivery-card">
        <div className="delivery-top">
          <span>HOZIRGI YETKAZISH</span>
          <Badge status={order.status} />
        </div>
        <h2>{order.number}</h2>
        <div className="pickup">
          <i>R</i>
          <div>
            <small>OLIB KETISH</small>
            <b>{publicConfig?.restaurantName||"Zaytun Cafe"}</b>
            <span>{publicConfig?.restaurantAddress||"Restoran manzili yuklanmoqda"}</span>
          </div>
        </div>
        <div className="route-line"></div>
        <div className="pickup customer-dot">
          <i>C</i>
          <div>
            <small>MIJOZ</small>
            <b>{order.customer.name}</b>
            <span>
              {order.address &&
                `${order.address.district}, ${order.address.street}, ${order.address.house}`}
            </span>
            <em>{order.address?.landmark}</em>
          </div>
        </div>
        {order.address && <div className="driver-location-summary" data-testid="driver-location-detail">
          {order.address.deliveryDistanceKm !== undefined && <b>{order.address.deliveryDistanceKm.toFixed(1)} km</b>}
          {order.address.confidence !== "COMPLETE" && <p className="warning">⚠ Manzilni mijoz bilan aniqlashtiring</p>}
          <small>{order.address.deliveryNotes}</small>
          {coordinate && (
            <details className="location-debug" data-testid="driver-location-debug">
              <summary>Texnik ma'lumot</summary>
              <p>{coordinate.latitude.toFixed(6)}, {coordinate.longitude.toFixed(6)}</p>
            </details>
          )}
        </div>}
        <div className="two-actions driver-nav-actions">
          <a
            className="button secondary"
            href={`tel:${order.customer.primaryPhone}`}
          >
            ☎ Qo‘ng‘iroq
          </a>
          {coordinate && <a
            className="button primary"
            href={navigationUrl("yandex",coordinate)}
            target="_blank"
            rel="noopener noreferrer"
          >
            📍 Yandex Maps
          </a>}
          {coordinate && <a className="button secondary" href={navigationUrl("google",coordinate)} target="_blank" rel="noopener noreferrer">Google Maps</a>}
        </div>
        <div className="collect">
          <span>
            Undirish kerak
            <br />
            <small>
              {order.paymentMethod === "CASH" ? "Naqd pul" : "Karta"}
            </small>
          </span>
          <b>{money(order.total)}</b>
        </div>
        {order.specialInstructions && (
          <p className="driver-note">
            <b>Buyurtma izohi:</b> {order.specialInstructions}
          </p>
        )}
        {order.address?.deliveryNotes && (
          <p className="driver-note">
            <b>Yetkazish izohi:</b> {order.address.deliveryNotes}
          </p>
        )}
        {needsAcceptance ? (
          <button
            className="button primary wide big"
            data-testid="driver-primary-action"
            disabled={transitionPending(order.id)}
            onClick={() => void acceptAssignment(order.id)}
          >
            Topshiriqni qabul qilish
          </button>
        ) : (
          target && (
            <button
              className="button primary wide big"
              data-testid="driver-primary-action"
              disabled={transitionPending(order.id)}
              onClick={() => void transition(order.id, target, "DRIVER")}
            >
              {labels[order.status]}
            </button>
          )
        )}
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
