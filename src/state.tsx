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
import { addCartLine } from "./domain";
import type {
  ActorType,
  CartItem,
  DeliveryIssueType,
  Driver,
  MenuCategory,
  MenuItem,
  Order,
  OrderStatus,
  RestaurantConfig,
} from "./domain";
import { supabase, supabaseConfigured } from "./supabase";

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

const terminalStatuses: OrderStatus[] = [
  "DELIVERED",
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
  authError: string;
  refresh: () => Promise<void>;
  loadTrackedOrder: (id: string) => Promise<Order | undefined>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  addToCart: (item: CartItem) => void;
  updateQuantity: (id: string, delta: number) => void;
  clearCart: () => void;
  submitOrder: (order: Order) => Promise<Order>;
  transition: (id: string, to: OrderStatus, actor: ActorType, reason?: string) => Promise<void>;
  assign: (orderId: string, driverId: string) => Promise<void>;
  acceptAssignment: (orderId: string) => Promise<void>;
  setEstimate: (orderId: string, minutes: number) => Promise<void>;
  reviewDelivery: (orderId:string,approved:boolean,reason?:string)=>Promise<void>;
  reportIssue: (orderId: string, type: DeliveryIssueType, description: string, reporter: string) => Promise<void>;
  resolveIssue: (orderId: string, issueId: string) => Promise<void>;
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
  const [authError, setAuthError] = useState("");
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
    setAuthError("");
    if (!nextSession || !supabase) {
      setAuthReady(true);
      return;
    }
    const { data, error } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", nextSession.user.id)
      .single();
    if (error) throw new Error(`Xodim roli yuklanmadi: ${error.message}`);
    setRole(data.role as AppRole);
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
      const nextOrders = await store.list();
      const nextDrivers = !supabaseConfigured || role === "RESTAURANT" || role === "DISPATCHER"
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
  }, [role]);

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
    try {
      await action();
      await refresh();
    } catch (error) {
      setOperationalError(error instanceof Error ? error.message : "Amal bajarilmadi");
    }
  }, [refresh]);

  const loadTrackedOrder = useCallback(async (id: string) => {
    const tracked = "getTracked" in store ? await store.getTracked(id) : await store.get(id);
    if (tracked) setOrders((current) => [tracked, ...current.filter((order) => order.id !== tracked.id)]);
    return tracked;
  }, []);

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
    authError,
    refresh,
    loadTrackedOrder,
    signIn: async (email, password) => {
      if (!supabase) return;
      setAuthError("");
      const { error } = await supabase.auth.signInWithPassword({ email, password });
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
    addToCart: (item) => setCart((current) => addCartLine(current,item,publicConfig?.maximumItemQuantity||50)),
    updateQuantity: (id, delta) => setCart((current) => current.map((entry) => entry.id === id ? { ...entry, quantity: Math.min(entry.quantity + delta,publicConfig?.maximumItemQuantity||50) } : entry).filter((entry) => entry.quantity > 0)),
    clearCart: () => setCart([]),
    submitOrder: async (order) => {
      const saved = await store.save(order);
      setOrders((current) => [saved, ...current.filter((entry) => entry.id !== saved.id)]);
      return saved;
    },
    transition: async (id, to, actor, reason) => runOperation(async () => {
      const order = await store.get(id);
      if (!order) throw new Error("Order not found");
      await store.transition(id, to, actor, reason);
      if (terminalStatuses.includes(to) && order.assignedDriverId && "saveDriver" in store) {
        const driver = drivers.find((entry) => entry.id === order.assignedDriverId);
        if (driver) await store.saveDriver({ ...driver, availability: "AVAILABLE" });
      }
    }),
    assign: async (orderId, driverId) => runOperation(async () => {
      const order = await store.get(orderId);
      const driver = drivers.find((entry) => entry.id === driverId);
      if (!order || !driver) throw new Error("Order or driver not found");
      await store.assign(order, driver);
    }),
    acceptAssignment: async (orderId) => runOperation(() => store.acceptAssignment(orderId)),
    setEstimate: async (orderId, minutes) => runOperation(() => store.setEstimate(orderId, minutes)),
    reviewDelivery: async(orderId,approved,reason)=>runOperation(()=>store.reviewDelivery(orderId,approved,reason)),
    reportIssue: async (orderId, type, description, reporter) => runOperation(() => store.reportIssue(orderId, type, description, reporter)),
    resolveIssue: async (orderId, issueId) => runOperation(() => store.resolveIssue(orderId, issueId)),
  }), [authError, authReady, cart, categories, drivers, loadTrackedOrder, loaded, menuItems, operationalError, orders, publicConfig, publicDataError, publicDataReady, refresh, role, runOperation, session]);

  return <C.Provider value={value}>{children}</C.Provider>;
}

export function useApp() {
  const context = useContext(C);
  if (!context) throw new Error("AppProvider missing");
  return context;
}
