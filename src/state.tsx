import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { store } from "./data";
import { addCartLine, resolveOrderSubmissionMode } from "./domain";
import type {
  ActorType,
  AssignmentDeclineReason,
  CartItem,
  CustomerAddress,
  DeliveryIssueType,
  Driver,
  DriverLedgerPage,
  DriverLedgerSummaryRow,
  MenuCategory,
  MenuItem,
  Order,
  OrderFeedbackSubmission,
  OrderHistoryFilters,
  OrderHistoryPage,
  OrderHistorySummary,
  OrderStatus,
  RestaurantConfig,
} from "./domain";
import { supabase, supabaseConfigured } from "./supabase";
import { normalizeUzbekPhone } from "./phone";

export type AppRole = "RESTAURANT" | "DISPATCHER" | "DRIVER";
export type OperationalSurface = "restaurant" | "driver";

export const operationalSurfaceForPath = (pathname: string): OperationalSurface | null =>
  pathname === "/restaurant" || pathname.startsWith("/restaurant/")
    ? "restaurant"
    : pathname === "/driver" || pathname.startsWith("/driver/")
      ? "driver"
      : null;

export const roleCanAccess = (role: AppRole | null, surface: OperationalSurface) =>
  surface === "restaurant"
    ? role === "RESTAURANT" || role === "DISPATCHER"
    : role === "DRIVER";

// A profile-less authenticated Supabase session must NOT automatically
// count as a valid Zaytun CUSTOMER in frontend state -- only a session that
// is provably (a) not staff/driver, and (b) backed by a confirmed, genuinely
// Uzbek mobile phone counts. This is a frontend-correctness predicate, not
// the security boundary: the backend (create_customer_order,
// ensure_current_customer) independently re-derives and re-verifies
// everything from auth.uid()/auth.users itself and never trusts this.
type SessionPhoneInfo = { user: { phone?: string; phone_confirmed_at?: string } };
export const isVerifiedCustomerSession = (session: SessionPhoneInfo | null, role: AppRole | null): boolean => {
  if (!session || role !== null) return false;
  const { phone, phone_confirmed_at } = session.user;
  if (!phone || !phone_confirmed_at) return false;
  return normalizeUzbekPhone(phone) !== null;
};

// Translates raw Supabase Auth (GoTrue) errors from the customer phone-OTP
// flow into clean Uzbek messages, keyed on GoTrue's stable error `code`
// (never on message-string matching, which isn't guaranteed stable across
// versions). Anything unrecognized falls back to the same generic message
// used elsewhere in this app for unexpected service failures, rather than
// ever showing a raw Supabase error dump to a customer.
export const mapCustomerAuthError = (error: { code?: string; status?: number } | null | undefined, context: "send" | "verify"): string => {
  const code = error?.code;
  if (code === "over_sms_send_rate_limit" || code === "over_request_rate_limit" || error?.status === 429) {
    return "Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.";
  }
  if (code === "sms_send_failed") {
    return "SMS yuborilmadi. Birozdan keyin qayta urinib ko‘ring.";
  }
  if (code === "captcha_failed") {
    return "Robot emasligingizni tasdiqlab bo‘lmadi. Sahifani yangilab, qaytadan urinib ko‘ring.";
  }
  if (code === "otp_expired") {
    return context === "verify"
      ? "Kod noto‘g‘ri yoki muddati tugagan. Qaytadan yuboring."
      : "Kod muddati tugagan. Qaytadan yuboring.";
  }
  if (code === "validation_failed" || code === "phone_provider_disabled") {
    return "Telefon raqamini to‘g‘ri kiriting.";
  }
  return "Xizmat bilan bog‘lanib bo‘lmadi. Internetni tekshirib, qayta urinib ko‘ring.";
};

// Translates raw Supabase Auth (GoTrue) errors from the driver phone-OTP
// login flow into clean Uzbek messages, keyed on GoTrue's stable error
// `code` (never message-string matching, mirroring mapCustomerAuthError).
// A phone with no existing DRIVER auth.users identity surfaces as
// `otp_disabled` here specifically because sendDriverOtp always passes
// shouldCreateUser:false -- GoTrue refuses to send an OTP for an unknown
// identity under that option instead of silently creating one, which is
// exactly the closed-enrollment behavior this flow depends on.
export const mapDriverAuthError = (error: { code?: string; status?: number } | null | undefined, context: "send" | "verify"): string => {
  const code = error?.code;
  if (code === "over_sms_send_rate_limit" || code === "over_request_rate_limit" || error?.status === 429) {
    return "Juda ko‘p urinish. Birozdan keyin qayta urinib ko‘ring.";
  }
  if (code === "otp_disabled") {
    return "Bu raqam kuryer sifatida ro‘yxatga olinmagan.";
  }
  if (code === "sms_send_failed") {
    return "SMS yuborilmadi. Birozdan keyin qayta urinib ko‘ring.";
  }
  if (code === "otp_expired") {
    return context === "verify"
      ? "Kod noto‘g‘ri yoki muddati tugagan. Qaytadan yuboring."
      : "Kod muddati tugagan. Qaytadan yuboring.";
  }
  if (code === "validation_failed" || code === "phone_provider_disabled") {
    return "Telefon raqamini to‘g‘ri kiriting.";
  }
  return "Xizmat bilan bog‘lanib bo‘lmadi. Internetni tekshirib, qayta urinib ko‘ring.";
};

// Thrown by submitOrder instead of a plain Error so Checkout can reliably
// distinguish "you must verify your phone first" (open the inline OTP
// step, preserving all already-entered checkout state) from any other
// order-creation failure (show it as a plain error), without string-
// matching a message.
export class CustomerAuthRequiredError extends Error {
  constructor() {
    super("Buyurtma berish uchun telefon raqamingizni tasdiqlang");
    this.name = "CustomerAuthRequiredError";
  }
}

const terminalStatuses: OrderStatus[] = [
  "DELIVERED",
  "COLLECTED",
  "DELIVERY_FAILED",
  "RETURNED",
  "CANCELLED",
];

type State = {
  orders: Order[];
  drivers: Driver[];
  cart: CartItem[];
  loaded: boolean;
  operationalError: string;
  categories: MenuCategory[];
  menuItems: MenuItem[];
  publicConfig: RestaurantConfig | null;
  publicDataReady: boolean;
  publicDataError: string;
  authReady: boolean;
  session: Session | null;
  role: AppRole | null;
  // The authenticated user's own profiles.display_name, if any -- null for
  // customer sessions (no profiles row) and while unauthenticated. Used to
  // greet a signed-in DRIVER by their real identity instead of a hard-coded
  // placeholder name.
  profileDisplayName: string | null;
  authError: string;
  // True once a session exists AND it's confirmed not to be a staff/driver
  // session (role===null after authReady). Never conflated with "signed
  // out" -- that's session===null.
  isCustomerAuthenticated: boolean;
  refresh: () => Promise<void>;
  loadTrackedOrder: (id: string) => Promise<Order | undefined>;
  signIn: (identifier: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  // Customer-facing phone+OTP auth, deliberately separate from signIn
  // (staff email/password, driver phone/password) -- no password involved.
  // sendCustomerOtp returns the canonical +998... phone so the caller can
  // reuse the exact value for verifyCustomerOtp without re-normalizing.
  sendCustomerOtp: (phone: string, captchaToken?: string) => Promise<string>;
  verifyCustomerOtp: (phone: string, code: string) => Promise<void>;
  // Driver-facing phone+OTP login (LOGIN only, never registration): sends
  // via signInWithOtp with shouldCreateUser:false so an unrecognized phone
  // can never provision a new Auth identity, then verifies via verifyOtp.
  // Role/route access is decided entirely by AuthGate's existing
  // role==="DRIVER" gate afterward, exactly as it already is for
  // password-based driver sign-in -- this never grants /driver by itself.
  sendDriverOtp: (phone: string) => Promise<string>;
  verifyDriverOtp: (phone: string, code: string) => Promise<void>;
  addToCart: (item: CartItem) => void;
  updateQuantity: (id: string, delta: number) => void;
  clearCart: () => void;
  submitOrder: (order: Order) => Promise<Order>;
  transition: (id: string, to: OrderStatus, actor: ActorType, reason?: string) => Promise<void>;
  transitionPending: (id: string) => boolean;
  // H0: the shared `orders` list is now filtered (live restaurant board
  // only, when surface==='restaurant') -- an individual order detail page
  // for an order NOT on that list (e.g. an old, already-finished one,
  // reached via direct URL/bookmark/history) needs its own unfiltered
  // fetch. store.get() already exists and is RLS-scoped exactly like
  // everything else (staff or the assigned driver); this just exposes it.
  getOrder: (id: string) => Promise<Order | undefined>;
  assign: (orderId: string, driverId: string) => Promise<void>;
  acceptAssignment: (orderId: string) => Promise<void>;
  // P6.1/P6.3: self-service, pre-acceptance only -- server enforces every
  // other condition (caller is the assigned driver, still ASSIGNED, not
  // yet accepted); this just exposes the RPC through the same lock.
  declineAssignment: (orderId: string, reason?: AssignmentDeclineReason) => Promise<void>;
  // P4.1: self-service work-state toggle -- acts on the current driver's
  // own row only (enforced server-side by start_shift/end_shift, which
  // key off auth.uid(), never a passed-in id).
  startShift: () => Promise<void>;
  endShift: () => Promise<void>;
  setEstimate: (orderId: string, minutes: number) => Promise<void>;
  reviewDelivery: (orderId:string,approved:boolean,reason?:string)=>Promise<void>;
  requestClarification: (orderId: string, reason: string) => Promise<void>;
  getAddressForRevision: (orderId: string) => Promise<CustomerAddress | undefined>;
  reviseDeliveryAddress: (orderId: string, address: CustomerAddress) => Promise<void>;
  reportIssue: (orderId: string, type: DeliveryIssueType, description: string, reporter: string) => Promise<void>;
  resolveIssue: (orderId: string, issueId: string) => Promise<void>;
  // H1: Order History -- a separate, staff-only, server-side-filtered and
  // paginated report, independent of the live-board `orders` state above.
  fetchOrderHistory: (filters: OrderHistoryFilters) => Promise<OrderHistoryPage>;
  fetchOrderHistorySummary: (filters: Omit<OrderHistoryFilters, "limit" | "offset">) => Promise<OrderHistorySummary>;
  // H2: Driver Delivery Ledger -- credit sourced strictly from
  // driver_assignments.status server-side, never orders.assigned_driver_id.
  fetchDriverLedgerSummary: (
    filters: Pick<OrderHistoryFilters, "preset" | "customFrom" | "customTo" | "branchId">,
  ) => Promise<DriverLedgerSummaryRow[]>;
  fetchDriverLedgerEntries: (
    driverId: string,
    filters: Pick<OrderHistoryFilters, "preset" | "customFrom" | "customTo">,
    limit: number,
    offset: number,
  ) => Promise<DriverLedgerPage>;
  // H3: Customer Feedback -- tracking-token authorized, same capability
  // model as every other public order-mutating call.
  submitOrderFeedback: (orderId: string, submission: OrderFeedbackSubmission) => Promise<Order>;
};

const C = createContext<State | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const surface = operationalSurfaceForPath(pathname);
  const [orders, setOrders] = useState<Order[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [operationalError, setOperationalError] = useState("");
  const [categories, setCategories] = useState<MenuCategory[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [publicConfig, setPublicConfig] = useState<RestaurantConfig | null>(null);
  const [publicDataReady, setPublicDataReady] = useState(false);
  const [publicDataError, setPublicDataError] = useState("");
  const [authReady, setAuthReady] = useState(!supabaseConfigured);
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<AppRole | null>(null);
  const [profileDisplayName, setProfileDisplayName] = useState<string | null>(null);
  const [authError, setAuthError] = useState("");
  const pendingTransitions = useRef(new Set<string>());
  const [pendingTransitionState, setPendingTransitionState] = useState<Record<string, boolean>>({});
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const publicLoadStarted = useRef(false);

  useEffect(() => {
    if (publicLoadStarted.current) return;
    publicLoadStarted.current = true;
    void Promise.all([store.getCategories(), store.getItems(), store.getRestaurantConfig()])
      .then(([nextCategories,nextItems,nextConfig]) => {
        setCategories(nextCategories);
        setMenuItems(nextItems);
        setPublicConfig(nextConfig);
        setPublicDataError("");
      })
      .catch(() => setPublicDataError("Menyu yoki restoran ma’lumotlari yuklanmadi. Internetni tekshirib, qayta urinib ko‘ring."))
      .finally(() => setPublicDataReady(true));
  }, []);

  const applySession = useCallback(async (nextSession: Session | null) => {
    setSession(nextSession);
    setRole(null);
    setProfileDisplayName(null);
    setAuthError("");
    if (!nextSession || !supabase) {
      setAuthReady(true);
      return;
    }
    // maybeSingle(), not single(): a CUSTOMER session (phone OTP) has no
    // profiles row by design -- that must resolve to role=null quietly,
    // not throw. single() would treat "zero rows" as a PostgREST error,
    // incorrectly surfacing a staff-facing "Xodim roli yuklanmadi" error
    // to every customer who signs in.
    const { data, error } = await supabase
      .from("profiles")
      .select("role,display_name")
      .eq("id", nextSession.user.id)
      .maybeSingle();
    if (error) throw new Error(`Xodim roli yuklanmadi: ${error.message}`);
    setRole((data?.role as AppRole | undefined) ?? null);
    setProfileDisplayName((data?.display_name as string | undefined) ?? null);
    setAuthReady(true);
  }, []);

  useEffect(() => {
    if (!supabase) return;
    let disposed = false;
    setAuthReady(false);
    const resolve = async (nextSession: Session | null) => {
      try {
        await applySession(nextSession);
      } catch (error) {
        if (!disposed) {
          setSession(nextSession);
          setRole(null);
          setAuthError(error instanceof Error ? error.message : "Xodim sessiyasi tekshirilmadi");
          setAuthReady(true);
        }
      }
    };
    void supabase.auth.getSession().then(({ data, error }) => {
      if (error) throw error;
      return resolve(data.session);
    }).catch((error: unknown) => {
      if (!disposed) {
        setAuthError(error instanceof Error ? error.message : "Sessiya tiklanmadi");
        setAuthReady(true);
      }
    });
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!disposed) void resolve(nextSession);
    });
    return () => {
      disposed = true;
      data.subscription.unsubscribe();
    };
  }, [applySession]);

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const task = (async () => {
      const nextOrders = await store.list(surface ?? undefined);
      // P4.1: a DRIVER also needs `drivers` populated -- not to see other
      // couriers (driver_read's own RLS policy restricts a non-staff caller
      // to id=auth.uid() only), but so the driver surface can read/control
      // its own shift_status/dispatch_status via the exact same listDrivers()
      // call RESTAURANT/DISPATCHER already use.
      const nextDrivers = !supabaseConfigured || role === "RESTAURANT" || role === "DISPATCHER" || role === "DRIVER"
        ? await store.listDrivers()
        : [];
      setOrders(nextOrders);
      setDrivers(nextDrivers);
      setLoaded(true);
      setOperationalError("");
    })();
    refreshInFlight.current = task;
    try {
      await task;
    } finally {
      refreshInFlight.current = null;
    }
  }, [role, surface]);

  useEffect(() => {
    if (!supabaseConfigured) {
      void refresh().catch((error: unknown) => {
        setOperationalError(error instanceof Error ? error.message : "Ma’lumotlar yuklanmadi");
        setLoaded(true);
      });
      return;
    }
    if (!surface || !authReady || !session || !roleCanAccess(role, surface)) {
      setLoaded(false);
      setOperationalError("");
      return;
    }
    let disposed = false;
    const safeRefresh = () => refresh().catch((error: unknown) => {
      if (!disposed) {
        setOperationalError(error instanceof Error ? error.message : "Operatsion ma’lumotlar yuklanmadi");
        setLoaded(true);
      }
    });
    void safeRefresh();
    const unsubscribe = store.subscribe(
      () => void safeRefresh(),
      surface,
      () => {
        if (!disposed) setOperationalError("Jonli yangilanish uzildi. Ma’lumotlarni yangilash uchun sahifani qayta oching.");
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [authReady, refresh, role, session, surface]);

  const runOperation = useCallback(async (action: () => Promise<void>) => {
    setOperationalError("");
    let actionError: string | null = null;
    try {
      await action();
    } catch (error) {
      actionError = error instanceof Error && error.message ? error.message : "Amal bajarilmadi. Qayta urinib ko‘ring.";
    }
    // Reconcile from the server whether the action succeeded or failed, so a
    // failure caused by the order's state already having changed (e.g. another
    // staff tab acted first) replaces stale controls with the real state
    // instead of leaving the UI showing options that no longer apply. A
    // successful refresh clears operationalError as a side effect, so the
    // action's own error (if any) is re-asserted afterward.
    try {
      await refresh();
    } catch {
      // The action's own error (if any) is still surfaced below; a refresh
      // failure here just means the UI stays as-is until the next success.
    }
    if (actionError) setOperationalError(actionError);
  }, [refresh]);

  const setTransitionPending = useCallback((id: string, pending: boolean) => {
    if (pending) pendingTransitions.current.add(id);
    else pendingTransitions.current.delete(id);
    setPendingTransitionState((current) => {
      const next = { ...current };
      if (pending) next[id] = true;
      else delete next[id];
      return next;
    });
  }, []);

  // Shared per-order in-flight lock: any action here (kitchen transition,
  // driver assignment, address review/clarification) on the same order id
  // is serialized, so a rapid double-click or two staff tabs cannot fire two
  // concurrent mutating requests against one order.
  const withOrderLock = useCallback(async (id: string, action: () => Promise<void>) => {
    if (pendingTransitions.current.has(id)) return;
    setTransitionPending(id, true);
    try {
      await runOperation(action);
    } finally {
      setTransitionPending(id, false);
    }
  }, [runOperation, setTransitionPending]);

  const loadTrackedOrder = useCallback(async (id: string) => {
    const tracked = "getTracked" in store ? await store.getTracked(id) : await store.get(id);
    if (tracked) setOrders((current) => [tracked, ...current.filter((order) => order.id !== tracked.id)]);
    return tracked;
  }, []);

  const submitOrderFeedback = useCallback(async (orderId: string, submission: OrderFeedbackSubmission) => {
    const updated = await store.submitOrderFeedback(orderId, submission);
    setOrders((current) => [updated, ...current.filter((order) => order.id !== updated.id)]);
    return updated;
  }, []);

  const isCustomerAuthenticated = authReady && isVerifiedCustomerSession(session, role);

  const value = useMemo<State>(() => ({
    orders,
    drivers,
    cart,
    loaded,
    operationalError,
    categories,
    menuItems,
    publicConfig,
    publicDataReady,
    publicDataError,
    authReady,
    session,
    role,
    profileDisplayName,
    authError,
    isCustomerAuthenticated,
    refresh,
    loadTrackedOrder,
    signIn: async (identifier, password) => {
      if (!supabase) return;
      setAuthError("");
      const trimmed = identifier.trim();
      if (trimmed.includes("@")) {
        const { error } = await supabase.auth.signInWithPassword({ email: trimmed, password });
        if (error) throw new Error(error.message);
        return;
      }
      const normalizedPhone = normalizeUzbekPhone(trimmed);
      if (!normalizedPhone) {
        throw new Error("Email yoki telefon raqamini to'g'ri kiriting.");
      }
      const { error } = await supabase.auth.signInWithPassword({
        phone: normalizedPhone,
        password,
      });
      if (error) throw new Error(error.message);
    },
    signOut: async () => {
      if (!supabase) return;
      const { error } = await supabase.auth.signOut();
      if (error) throw new Error(error.message);
      setOrders([]);
      setDrivers([]);
      setLoaded(false);
    },
    sendCustomerOtp: async (phone, captchaToken) => {
      if (!supabase) throw new Error("Xizmat sozlanmagan.");
      const normalized = normalizeUzbekPhone(phone);
      if (!normalized) throw new Error("Telefon raqamini to'g'ri kiriting.");
      // captchaToken is omitted entirely (not sent as undefined/empty) when
      // the caller has none, so this stays a no-op when CAPTCHA isn't
      // configured/enabled -- matches today's production behavior exactly.
      const { error } = await supabase.auth.signInWithOtp({
        phone: normalized,
        ...(captchaToken ? { options: { captchaToken } } : {}),
      });
      if (error) throw new Error(mapCustomerAuthError(error, "send"));
      return normalized;
    },
    verifyCustomerOtp: async (phone, code) => {
      if (!supabase) throw new Error("Xizmat sozlanmagan.");
      const normalized = normalizeUzbekPhone(phone);
      if (!normalized) throw new Error("Telefon raqamini to'g'ri kiriting.");
      const trimmedCode = code.trim();
      if (!trimmedCode) throw new Error("Tasdiqlash kodini kiriting.");
      const { data, error } = await supabase.auth.verifyOtp({ phone: normalized, token: trimmedCode, type: "sms" });
      if (error) throw new Error(mapCustomerAuthError(error, "verify"));
      // verifyOtp already established GoTrue's own client session at this
      // point regardless of what happens next, so ensure_current_customer
      // below can use it -- but React-facing auth state (session/role/
      // isCustomerAuthenticated) is deliberately NOT finalized via
      // applySession yet. Sanity-check the session GoTrue just handed back
      // before trusting it at all (defensive: verifyOtp with type "sms"
      // should always yield a confirmed Uzbek phone, but never assume).
      if (!data.session || !isVerifiedCustomerSession(data.session, null)) {
        await supabase.auth.signOut();
        throw new Error("Telefon raqami tasdiqlanmadi. Qaytadan urinib ko'ring.");
      }
      try {
        // Resolve/link the canonical customer record BEFORE telling the
        // rest of the app a customer is authenticated. If this fails (e.g.
        // CUSTOMER_PHONE_CONFLICT, CUSTOMER_PHONE_ALREADY_IN_USE,
        // PHONE_NOT_VERIFIED), the app must never be left half-signed-in:
        // a CUSTOMER-looking Supabase session with no valid Zaytun customer
        // behind it. Tear down the session verifyOtp just established for
        // THIS attempt so React never sees it -- this only ever signs out
        // the brand-new session created a moment ago by the verifyOtp call
        // above, never a pre-existing RESTAURANT/DRIVER session (verifyOtp
        // already replaced whatever session existed before it was called).
        await store.ensureCurrentCustomer();
      } catch (customerError) {
        await supabase.auth.signOut();
        throw customerError instanceof Error ? customerError : new Error("Hisobni aniqlab bo'lmadi.");
      }
      // Only now finalize customer-facing React state, synchronously rather
      // than waiting on onAuthStateChange's async event: a caller that
      // immediately resubmits a checkout right after verification
      // (customer_auth_required flow) needs isCustomerAuthenticated to
      // already be true the moment this promise resolves.
      await applySession(data.session);
    },
    sendDriverOtp: async (phone) => {
      if (!supabase) throw new Error("Xizmat sozlanmagan.");
      const normalized = normalizeUzbekPhone(phone);
      if (!normalized) throw new Error("Telefon raqamini to'g'ri kiriting.");
      const { error } = await supabase.auth.signInWithOtp({
        phone: normalized,
        options: { shouldCreateUser: false },
      });
      if (error) throw new Error(mapDriverAuthError(error, "send"));
      return normalized;
    },
    verifyDriverOtp: async (phone, code) => {
      if (!supabase) throw new Error("Xizmat sozlanmagan.");
      const normalized = normalizeUzbekPhone(phone);
      if (!normalized) throw new Error("Telefon raqamini to'g'ri kiriting.");
      const trimmedCode = code.trim();
      if (!trimmedCode) throw new Error("Tasdiqlash kodini kiriting.");
      const { error } = await supabase.auth.verifyOtp({ phone: normalized, token: trimmedCode, type: "sms" });
      if (error) throw new Error(mapDriverAuthError(error, "verify"));
      // Session/role resolution flows through the existing
      // onAuthStateChange listener -> applySession, exactly like
      // password-based sign-in above -- no special-cased finalization
      // needed here (unlike verifyCustomerOtp, nothing needs the result
      // synchronously the instant this promise resolves).
    },
    addToCart: (item) => setCart((current) => addCartLine(current,item,publicConfig?.maximumItemQuantity||50)),
    updateQuantity: (id, delta) => setCart((current) => current.map((entry) => entry.id === id ? { ...entry, quantity: Math.min(entry.quantity + delta,publicConfig?.maximumItemQuantity||50) } : entry).filter((entry) => entry.quantity > 0)),
    clearCart: () => setCart([]),
    submitOrder: async (order) => {
      const mode = resolveOrderSubmissionMode(Boolean(publicConfig?.customerAuthRequired), isCustomerAuthenticated);
      if (mode === "REQUIRES_CUSTOMER_AUTH") throw new CustomerAuthRequiredError();
      const saved = mode === "CUSTOMER" ? await store.saveAsCustomer(order) : await store.save(order);
      setOrders((current) => [saved, ...current.filter((entry) => entry.id !== saved.id)]);
      return saved;
    },
    transition: (id, to, actor, reason) => withOrderLock(id, async () => {
      const order = await store.get(id);
      if (!order) throw new Error("Order not found");
      await store.transition(id, to, actor, reason);
      if (terminalStatuses.includes(to) && order.assignedDriverId && "saveDriver" in store) {
        const driver = drivers.find((entry) => entry.id === order.assignedDriverId);
        if (driver) await store.saveDriver({ ...driver, availability: "AVAILABLE" });
      }
    }),
    transitionPending: (id) => Boolean(pendingTransitionState[id]),
    getOrder: (id) => store.get(id),
    fetchOrderHistory: (filters) => store.fetchOrderHistory(filters),
    fetchOrderHistorySummary: (filters) => store.fetchOrderHistorySummary(filters),
    fetchDriverLedgerSummary: (filters) => store.fetchDriverLedgerSummary(filters),
    fetchDriverLedgerEntries: (driverId, filters, limit, offset) =>
      store.fetchDriverLedgerEntries(driverId, filters, limit, offset),
    submitOrderFeedback,
    assign: (orderId, driverId) => withOrderLock(orderId, async () => {
      const order = await store.get(orderId);
      const driver = drivers.find((entry) => entry.id === driverId);
      if (!order || !driver) throw new Error("Order or driver not found");
      await store.assign(order, driver);
    }),
    acceptAssignment: (orderId) => withOrderLock(orderId, () => store.acceptAssignment(orderId)),
    declineAssignment: (orderId, reason) => withOrderLock(orderId, () => store.declineAssignment(orderId, reason)),
    startShift: () => runOperation(() => store.startShift()),
    endShift: () => runOperation(() => store.endShift()),
    setEstimate: async (orderId, minutes) => runOperation(() => store.setEstimate(orderId, minutes)),
    reviewDelivery: (orderId, approved, reason) => withOrderLock(orderId, () => store.reviewDelivery(orderId, approved, reason)),
    requestClarification: (orderId, reason) => withOrderLock(orderId, () => store.requestClarification(orderId, reason)),
    getAddressForRevision: (orderId) => store.getAddressForRevision(orderId),
    reviseDeliveryAddress: async (orderId, address) => {
      const updated = await store.reviseAddress(orderId, address);
      if (updated) setOrders((current) => [updated, ...current.filter((entry) => entry.id !== updated.id)]);
    },
    reportIssue: async (orderId, type, description, reporter) => runOperation(() => store.reportIssue(orderId, type, description, reporter)),
    resolveIssue: async (orderId, issueId) => runOperation(() => store.resolveIssue(orderId, issueId)),
  }), [applySession, authError, authReady, cart, categories, drivers, isCustomerAuthenticated, loadTrackedOrder, loaded, menuItems, operationalError, orders, pendingTransitionState, profileDisplayName, publicConfig, publicDataError, publicDataReady, refresh, role, runOperation, session, submitOrderFeedback, withOrderLock]);

  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useApp() {
  const context = useContext(C);
  if (!context) throw new Error("AppProvider missing");
  return context;
}
