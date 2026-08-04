import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import { categories, menuItems } from "./data";
import {
  calculateOrderTotal,
  canTransition,
  createEvent,
  validateOrderInput,
  type CustomerAddress,
  type MenuItem,
  type Order,
  type OrderStatus,
  type PaymentMethod,
} from "./domain";
import { useApp } from "./state";
import { supabaseConfigured } from "./supabase";
import { MapPicker } from "./components/MapPicker";
import {
  addressConfidence,
  applySuggestion,
  haversineKm,
  initialSelection,
  materialAddressChange,
} from "./maps/core";
import { configuredMapProvider, defaultMapLocation } from "./maps/factory";
import { navigationUrl } from "./maps/navigation";
import type { MapLocationSelection } from "./maps/types";
import { createUuid } from "./uuid";

const money = (n: number) => new Intl.NumberFormat("uz-UZ").format(n) + " so‘m";
const time = (s: string) =>
  new Intl.DateTimeFormat("uz-UZ", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(s));
const statusLabels: Record<OrderStatus, string> = {
  NEW: "Yangi",
  CONFIRMED: "Tasdiqlangan",
  PREPARING: "Tayyorlanmoqda",
  READY: "Tayyor",
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
const statusProgress: OrderStatus[] = [
  "NEW",
  "CONFIRMED",
  "PREPARING",
  "READY",
  "DRIVER_ASSIGNED",
  "PICKED_UP",
  "ON_THE_WAY",
  "ARRIVED",
  "DELIVERED",
];
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
function Shell({
  children,
  surface = "customer",
}: {
  children: React.ReactNode;
  surface?: "customer" | "staff" | "driver";
}) {
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
          <NavLink to="/menu">Buyurtma</NavLink>
          <NavLink to="/restaurant">Restoran</NavLink>
          <NavLink to="/driver">Haydovchi</NavLink>
        </nav>
      </header>
      {children}
    </div>
  );
}
function Home() {
  return (
    <Shell>
      <main className="home">
        <section>
          <p className="eyebrow">NAVOIY · TEZ YETKAZIB BERISH</p>
          <h1>Sevimli taomlaringiz, aniq va tez.</h1>
          <p>
            Zaytun Cafe taomlarini onlayn buyurtma qiling va har bir bosqichni
            kuzating.
          </p>
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
          🫒<span>35–50 min</span>
        </div>
      </main>
    </Shell>
  );
}
function Menu() {
  const [active, setActive] = useState("grill");
  const { cart } = useApp();
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
function MenuCard({ item }: { item: MenuItem }) {
  return (
    <article className="menu-card">
      <Link to={`/menu/${item.id}`} className="food-img">
        {item.image}
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
  const item = menuItems.find((i) => i.id === id);
  const { addToCart } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState(1);
  const [mods, setMods] = useState<string[]>([]);
  const [note, setNote] = useState("");
  if (!item) return <Navigate to="/menu" />;
  const unit =
    item.price +
    (item.modifiers || [])
      .filter((m) => mods.includes(m.id))
      .reduce((s, m) => s + m.price, 0);
  return (
    <Shell>
      <main className="narrow">
        <Link to="/menu" className="back">
          ← Menyu
        </Link>
        <div className="product-hero">{item.image}</div>
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
            <button onClick={() => setQ(q + 1)}>+</button>
          </div>
          <button
            className="button primary"
            data-testid="add-to-cart"
            onClick={() => {
              addToCart({
                id: createUuid(),
                menuItemId: item.id,
                name: item.name,
                unitPrice: unit,
                quantity: q,
                modifierIds: mods,
                modifierNames: (item.modifiers || [])
                  .filter((m) => mods.includes(m.id))
                  .map((m) => m.name),
                instructions: note,
              });
              nav("/cart");
            }}
          >
            Savatga · {money(unit * q)}
          </button>
        </div>
      </main>
    </Shell>
  );
}
function Cart() {
  const { cart, updateQuantity } = useApp();
  const subtotal = calculateOrderTotal(cart);
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
                    <button onClick={() => updateQuantity(i.id, 1)}>+</button>
                  </div>
                </article>
              ))}
            </div>
            <div className="summary">
              <span>Taomlar</span>
              <b>{money(subtotal)}</b>
              <span>Yetkazish</span>
              <b>Manzilga qarab</b>
            </div>
            <Link
              className="button primary wide"
              to="/checkout"
              data-testid="go-to-checkout"
            >
              Rasmiylashtirish
            </Link>
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
function Checkout() {
  const { cart, submitOrder, clearCart } = useApp();
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
  const submittingRef = useRef(false);
  const subtotal = calculateOrderTotal(cart);
  const estimatedFee = type === "DELIVERY" && subtotal < 150000 ? 10000 : 0;
  const total = calculateOrderTotal(cart, estimatedFee);
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
    const coordinate = selection.coordinate;
    const center = defaultMapLocation();
    const distance = coordinate ? haversineKm(center, coordinate) : undefined;
    const zone = distance === undefined ? undefined : distance <= 8 ? "ELIGIBLE" : "OUTSIDE_ZONE";
    setMapSelection(selection);
    setAddress((a) => ({
      ...a,
      latitude: coordinate?.latitude,
      longitude: coordinate?.longitude,
      pinConfirmedAt: selection.confirmedAt,
      locationProvider: selection.provider,
      providerPlaceId: selection.suggestion?.providerPlaceId,
      providerFormattedAddress: selection.suggestion?.formattedAddress,
      deliveryDistanceKm: distance,
      deliveryZoneResult: zone,
      confidence: addressConfidence(
        selection,
        Boolean(a.district && a.street && a.house),
        zone === "ELIGIBLE",
        !selection.suggestion,
      ),
    }));
    clearError("coordinates");
    clearError("pinConfirmation");
    clearError("deliveryZone");
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submittingRef.current) return;
    const found = validateOrderInput(type, address, payment);
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
    const id = createUuid();
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
      createdAt: new Date().toISOString(),
      events: [createEvent(id, null, "NEW", "CUSTOMER", "guest")],
      issues: [],
    };
    try {
      const saved = await submitOrder(order);
      clearCart();
      nav(`/confirmation/${saved.id}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Buyurtma yuborilmadi";
      setErrors({ submit: message.includes("|") ? message.split("|").at(-1)! : message });
      submittingRef.current = false;
      setSubmitting(false);
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
          </section>
          <section className="form-card">
            <h2>Aloqa</h2>
            <Field
              label="Ism *"
              value={address.customerName}
              error={errors.customerName}
              onChange={(v) => set("customerName", v)}
            />
            <Field
              label="Telefon *"
              value={address.primaryPhone}
              error={errors.primaryPhone}
              placeholder="+998 90 123 45 67"
              onChange={(v) => set("primaryPhone", v)}
            />
            <Field
              label="Qo‘shimcha telefon"
              value={address.secondaryPhone || ""}
              onChange={(v) => set("secondaryPhone", v)}
            />
          </section>
          {type === "DELIVERY" && (
            <section className="form-card">
              <h2>Aniq manzil</h2>
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
                label="Uy / bino *"
                value={address.house}
                error={errors.house}
                placeholder="Raqam bo‘lmasa, sababini yozing"
                onChange={(v) => set("house", v)}
              />
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
                label="Mo‘ljal"
                value={address.landmark}
                error={errors.landmark}
                onChange={(v) => set("landmark", v)}
              />
              <Field
                label="Yetkazish izohi"
                value={address.deliveryNotes}
                onChange={(v) => set("deliveryNotes", v)}
              />
              <div className="address-explainer">
                <p><b>Xarita joyi</b> — pin kirish nuqtasini ko‘rsatadi.</p>
                <p><b>Yozma manzil</b> — yuqoridagi maydonlarni o‘zingiz tekshirasiz.</p>
                <p><b>Mo‘ljal va izoh</b> — kuryerga topishga yordam beradi.</p>
              </div>
              <MapPicker
                value={mapSelection}
                onChange={updateMapSelection}
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
              {errors.coordinates && (
                <em className="error">{errors.coordinates}</em>
              )}
              {errors.pinConfirmation && (
                <em className="error">{errors.pinConfirmation}</em>
              )}
              {(errors.deliveryZone || address.deliveryZoneResult === "OUTSIDE_ZONE") && (
                <em className="error" data-testid="delivery-zone-error">
                  {errors.deliveryZone || "Bu manzil 8 km yetkazish hududidan tashqarida."}
                </em>
              )}
            </section>
          )}
          <section className="form-card">
            <h2>To‘lov</h2>
            <label className="radio">
              <input
                type="radio"
                checked={payment === "CASH"}
                onChange={() => {
                  setPayment("CASH");
                  clearError("paymentMethod");
                }}
              />
              Naqd pul
            </label>
            <label className="radio">
              <input
                type="radio"
                checked={payment === "CARD_ON_DELIVERY"}
                onChange={() => {
                  setPayment("CARD_ON_DELIVERY");
                  clearError("paymentMethod");
                }}
              />
              Yetkazilganda karta orqali
            </label>
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
              <span>Yetkazish</span>
              <b>{type === "DELIVERY" ? money(estimatedFee) : "Bepul"}</b>
            </div>
            <div className="total" data-testid="estimated-total">
              <span>Taxminiy jami</span>
              <b>{money(total)}</b>
            </div>
            <small>Yakuniy narx menyu va yetkazish sozlamalari asosida serverda tasdiqlanadi.</small>
          </section>
          <button
            className="button primary wide"
            type="submit"
            data-testid="checkout-submit"
            disabled={submitting}
          >
            {submitting ? "Yuborilmoqda…" : "Buyurtmani yuborish"}
          </button>
          {errors.submit && <p className="error" role="alert">{errors.submit}</p>}
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  placeholder?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <em className="error">{error}</em>}
    </label>
  );
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
  const { orders, loadTrackedOrder } = useApp();
  const [trackingReady, setTrackingReady] = useState(false);
  const [trackingError, setTrackingError] = useState("");
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
  if (!order)
    return (
      <Shell>
        <main className="narrow">
          <h1>{trackingReady ? "Buyurtma topilmadi" : "Yuklanmoqda…"}</h1>
          {trackingError && <p className="error" role="alert">{trackingError}</p>}
        </main>
      </Shell>
    );
  const current = statusProgress.indexOf(order.status);
  return (
    <Shell>
      <main className="track">
        <div className="page-title">
          <div>
            <p className="eyebrow">{order.number}</p>
            <h1 data-testid="order-status">{statusLabels[order.status]}</h1>
          </div>
          <Badge status={order.status} />
        </div>
        <div className="eta">
          <b>
            {order.estimatedMinutes || 35}–{(order.estimatedMinutes || 35) + 10}{" "}
            min
          </b>
          <span>Taxminiy vaqt</span>
        </div>
        <section className="timeline">
          {statusProgress.map((s, i) => (
            <div className={i <= current ? "done" : ""} key={s}>
              <i>{i < current ? "✓" : i + 1}</i>
              <span>
                <b>{statusLabels[s]}</b>
                {order.events.find((e) => e.newStatus === s) && (
                  <small>
                    {time(
                      order.events.find((e) => e.newStatus === s)!.timestamp,
                    )}
                  </small>
                )}
              </span>
            </div>
          ))}
        </section>
        <section className="form-card">
          <h2>Buyurtma</h2>
          {order.items.map((i) => (
            <p key={i.id}>
              {i.quantity} × {i.name}
            </p>
          ))}
          <b>{money(order.total)}</b>
        </section>
      </main>
    </Shell>
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
      "CANCELLED",
      "REJECTED",
      "DELIVERY_FAILED",
      "RETURNED",
    ],
  },
];
function Restaurant() {
  const { orders, loaded, operationalError } = useApp();
  const [newSeen, setNewSeen] = useState(
    orders.filter((o) => o.status === "NEW").length,
  );
  const boardRef = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const count = orders.filter((o) => o.status === "NEW").length;
    if (count > newSeen) {
      setNewSeen(count);
      try {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.15);
      } catch {
        /* visible alert remains */
      }
    }
  }, [orders, newSeen]);
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
                    <OrderCard order={o} key={o.id} />
                  ))}
              </section>
            ))}
          </div>
        </div>
      </main>
    </Shell>
  );
}
function OrderCard({ order }: { order: Order }) {
  return (
    <Link
      to={`/restaurant/orders/${order.id}`}
      data-testid={`order-card-${order.id}`}
      className={`order-card ${order.status === "NEW" ? "new" : ""}`}
    >
      <div>
        <b>{order.number}</b>
        <Badge status={order.status} />
      </div>
      <h3>{order.customer.name}</h3>
      <small>
        {time(order.createdAt)} ·{" "}
        {order.type === "DELIVERY" ? "Yetkazish" : "Olib ketish"}
      </small>
      <p>{order.items.map((i) => `${i.quantity}× ${i.name}`).join(", ")}</p>
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
    transition,
    assign,
    setEstimate,
    reportIssue,
    resolveIssue,
  } = useApp();
  const order = orders.find((o) => o.id === id);
  const [reason, setReason] = useState("");
  const [estimate, setEstimateValue] = useState("35");
  if (!order)
    return loaded ? (
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
    try {
      await transition(order.id, to, actor, reason || undefined);
      setReason("");
    } catch (e) {
      alert(e instanceof Error ? e.message : "Action failed");
    }
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
          <Badge status={order.status} />
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
              <p>
                <b>To‘lov:</b>{" "}
                {order.paymentMethod === "CASH"
                  ? "Naqd"
                  : "Yetkazilganda karta"}{" "}
                · {order.paymentStatus}
              </p>
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
                  <p>
                    <b>Koordinata:</b> {order.address.latitude},{" "}
                    {order.address.longitude}
                  </p>
                  <div className="location-facts" data-testid="restaurant-location-detail">
                    <span><b>Manzil ishonchi</b>{order.address.confidence}</span>
                    <span><b>Pin tasdig‘i</b>{order.address.pinConfirmedAt ? "Tasdiqlangan" : "Tasdiqlanmagan"}</span>
                    <span><b>Masofa</b>{order.address.deliveryDistanceKm !== undefined ? `${order.address.deliveryDistanceKm.toFixed(2)} km` : "—"}</span>
                    <span><b>Yetkazish hududi</b>{order.address.deliveryZoneResult || "—"}</span>
                  </div>
                  <div className="location-preview" aria-label="Yetkazish pinining ixcham xarita ko‘rinishi"><span>📍</span><small>{order.address.latitude?.toFixed(6)}, {order.address.longitude?.toFixed(6)}</small></div>
                  {order.address.latitude !== undefined && order.address.longitude !== undefined && (
                    <div className="location-actions">
                      <a className="button secondary" href={navigationUrl("yandex",{latitude:order.address.latitude,longitude:order.address.longitude})} target="_blank" rel="noopener noreferrer">Yandex Maps</a>
                      <a className="button secondary" href={navigationUrl("google",{latitude:order.address.latitude,longitude:order.address.longitude})} target="_blank" rel="noopener noreferrer">Google Maps</a>
                      <button className="button secondary" onClick={() => void navigator.clipboard?.writeText(`${order.address!.latitude}, ${order.address!.longitude}`)}>Koordinatani nusxalash</button>
                    </div>
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
                    {i.reportedBy} · {time(i.createdAt)}
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
          </div>
          <aside className="panel action-panel">
            <h2>Keyingi amal</h2>
            {order.status === "NEW" && (
              <>
                <button
                  className="button primary"
                  data-testid="action-confirm"
                  onClick={() => void action("CONFIRMED")}
                >
                  Qabul qilish
                </button>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Rad etish sababi"
                />
                <button
                  className="button danger"
                  data-testid="action-reject"
                  disabled={!reason}
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
                onClick={() => void action("PREPARING")}
              >
                Tayyorlashni boshlash
              </button>
            )}
            {order.status === "PREPARING" && (
              <button
                className="button primary"
                data-testid="action-mark-ready"
                onClick={() => void action("READY")}
              >
                Tayyor deb belgilash
              </button>
            )}
            {order.status === "READY" && order.type === "PICKUP" && (
              <button
                className="button primary"
                data-testid="action-mark-pickup-complete"
                onClick={() => void action("DELIVERED")}
              >
                Mijozga topshirildi
              </button>
            )}
            {order.status === "READY" && order.type === "DELIVERY" && (
              <>
                {drivers.map((d) => (
                  <button
                    className="driver-option"
                    data-testid={`assign-driver-${d.id}`}
                    disabled={d.availability !== "AVAILABLE"}
                    key={d.id}
                    onClick={() => void assign(order.id, d.id)}
                  >
                    <span>
                      <b>{d.name}</b>
                      <small>{d.vehicle}</small>
                    </span>
                    <i>{d.availability}</i>
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
                disabled={!reason}
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
                      <b>{statusLabels[e.newStatus]}</b>
                      <small>
                        {time(e.timestamp)} · {e.actorType}
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
  const { orders, loaded, operationalError } = useApp();
  const active = orders.find(
    (o) =>
      o.assignedDriverId &&
      !["DELIVERED", "CANCELLED", "RETURNED", "DELIVERY_FAILED"].includes(
        o.status,
      ),
  );
  const next = orders.find((o) => o.status === "READY");
  return (
    <Shell surface="driver">
      <main className="driver-page">
        {!loaded && <div className="empty" role="status">Topshiriqlar yuklanmoqda…</div>}
        {operationalError && <p className="error" role="alert">{operationalError}</p>}
        <div className="driver-head">
          <div>
            <p className="eyebrow">XAYRLI KUN, AZIZ</p>
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
        {next && (
          <section className="next-card">
            <p className="eyebrow">KEYINGI YETKAZISH</p>
            <b>
              {next.number} · {next.address?.district}
            </b>
            <span>{money(next.total)}</span>
          </section>
        )}
      </main>
    </Shell>
  );
}
function DriverDelivery({ order }: { order: Order }) {
  const { transition, acceptAssignment, reportIssue } = useApp();
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
            <b>Zaytun Cafe</b>
            <span>Islom Karimov ko‘chasi, 17</span>
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
          <span>{order.address.latitude?.toFixed(6)}, {order.address.longitude?.toFixed(6)}</span>
          {order.address.deliveryDistanceKm !== undefined && <b>{order.address.deliveryDistanceKm.toFixed(1)} km</b>}
          {order.address.confidence !== "COMPLETE" && <p className="warning">⚠ Manzilni mijoz bilan aniqlashtiring</p>}
          <small>{order.address.deliveryNotes}</small>
        </div>}
        <div className="two-actions driver-nav-actions">
          <a
            className="button secondary"
            href={`tel:${order.customer.primaryPhone}`}
          >
            ☎ Qo‘ng‘iroq
          </a>
          {coordinate && <a
            className="button secondary"
            href={navigationUrl("yandex",coordinate)}
            target="_blank"
            rel="noopener noreferrer"
          >
            Yandex Maps
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
            onClick={() => void acceptAssignment(order.id)}
          >
            Topshiriqni qabul qilish
          </button>
        ) : (
          target && (
            <button
              className="button primary wide big"
              data-testid="driver-primary-action"
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
function AuthGate({ children, surface }: { children: React.ReactNode; surface: "restaurant" | "driver" }) {
  const { authReady, session, role, authError, signIn, signOut } = useApp();
  const [email, setEmail] = useState(surface === "driver" ? "driver@zaytun.local" : "restaurant@zaytun.local");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const permitted = surface === "driver" ? role === "DRIVER" : role === "RESTAURANT" || role === "DISPATCHER";
  if (!authReady) return <div className="empty" role="status">Sessiya tekshirilmoqda…</div>;
  if (!supabaseConfigured) return <>{children}</>;
  if (session && permitted) return <>{children}<button className="auth-signout" type="button" onClick={() => void signOut().catch((failure: unknown) => setError(failure instanceof Error ? failure.message : "Chiqish amalga oshmadi"))}>Chiqish</button></>;
  if (session && !permitted) return <Shell surface={surface === "driver" ? "driver" : "staff"}><main className="narrow"><section className="form-card"><h1>Ruxsat yo‘q</h1><p>Bu hisob ushbu operatsion bo‘limga kira olmaydi.</p><button className="button secondary" onClick={() => void signOut()}>Boshqa hisob bilan kirish</button></section></main></Shell>;
  return (
    <Shell surface={surface === "driver" ? "driver" : "staff"}>
      <main className="narrow">
        <section className="form-card">
          <p className="eyebrow">XODIMLAR UCHUN</p>
          <h1>Kirish</h1>
          <p>
            Restaurant, dispatcher yoki driver Supabase Auth hisobi bilan
            kiring.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setError("");
              try {
                await signIn(email, password);
              } catch (failure) {
                setError(failure instanceof Error ? failure.message : "Kirish amalga oshmadi");
              }
            }}
          >
            <Field label="Email" value={email} onChange={setEmail} />
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
    <Routes>
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
    </Routes>
  );
}
