import type {
  CustomerAddress,
  Driver,
  DriverAssignment,
  MenuCategory,
  MenuItem,
  Order,
  OrderEvent,
  DriverLedgerEntry,
  DriverLedgerPage,
  DriverLedgerSummaryRow,
  OrderFeedbackSubmission,
  OrderHistoryFilters,
  OrderHistoryPage,
  OrderHistoryRow,
  OrderHistorySummary,
  OrderStatus,
  RestaurantConfig,
} from "./domain";
import { createEvent, createIssue, transitionOrder } from "./domain";
import { SupabaseStore, supabaseConfigured } from "./supabase";
import { createUuid } from "./uuid";

export interface MenuRepository {
  getCategories(): Promise<MenuCategory[]>;
  getItems(): Promise<MenuItem[]>;
}
export interface ConfigurationRepository { getRestaurantConfig():Promise<RestaurantConfig> }
export interface OrderRepository {
  list(surface?: "restaurant" | "driver"): Promise<Order[]>;
  get(id: string): Promise<Order | undefined>;
  save(order: Order): Promise<Order>;
  submitOrderFeedback(id: string, submission: OrderFeedbackSubmission): Promise<Order>;
}
export interface DriverRepository {
  listDrivers(): Promise<Driver[]>;
  saveDriver(driver: Driver): Promise<Driver>;
}
export interface AssignmentRepository {
  listAssignments(): Promise<DriverAssignment[]>;
  assign(order: Order, driver: Driver): Promise<DriverAssignment>;
}
export interface OrderEventRepository {
  listEvents(orderId: string): Promise<OrderEvent[]>;
  append(event: OrderEvent): Promise<void>;
}
export interface OrderHistoryRepository {
  fetchOrderHistory(filters: OrderHistoryFilters): Promise<OrderHistoryPage>;
  fetchOrderHistorySummary(filters: Omit<OrderHistoryFilters, "limit" | "offset">): Promise<OrderHistorySummary>;
}
export interface DriverLedgerRepository {
  fetchDriverLedgerSummary(
    filters: Pick<OrderHistoryFilters, "preset" | "customFrom" | "customTo" | "branchId">,
  ): Promise<DriverLedgerSummaryRow[]>;
  fetchDriverLedgerEntries(
    driverId: string,
    filters: Pick<OrderHistoryFilters, "preset" | "customFrom" | "customTo">,
    limit: number,
    offset: number,
  ): Promise<DriverLedgerPage>;
}

export const categories: MenuCategory[] = [
  { id: "grill", name: "Gril", description: "Olovda yangi tayyorlanadi" },
  { id: "mains", name: "Issiq taomlar", description: "Zaytun oshxonasidan" },
  {
    id: "drinks",
    name: "Ichimliklar",
    description: "Sovuq va tetiklantiruvchi",
  },
];
export const menuItems: MenuItem[] = [
  {
    id: "chicken",
    categoryId: "grill",
    name: "Zaytun tovuq grili",
    description: "Marinadlangan tovuq, kartoshka va sarimsoqli sous",
    price: 68000,
    image: "🔥",
    available: true,
    modifiers: [
      { id: "spicy", name: "Achchiq", price: 0 },
      { id: "sauce", name: "Qo‘shimcha sous", price: 5000 },
    ],
  },
  {
    id: "kebab",
    categoryId: "grill",
    name: "Mol go‘shtli kabob",
    description: "Ko‘mirda pishgan kabob, piyoz va non",
    price: 42000,
    image: "🥩",
    available: true,
  },
  {
    id: "plov",
    categoryId: "mains",
    name: "Navoiy oshi",
    description: "Lazer guruch, mol go‘shti va sabzi",
    price: 48000,
    image: "🍚",
    available: true,
  },
  {
    id: "salad",
    categoryId: "mains",
    name: "Zaytun salati",
    description: "Pomidor, bodring, zaytun va feta",
    price: 32000,
    image: "🥗",
    available: true,
  },
  {
    id: "ayran",
    categoryId: "drinks",
    name: "Uy ayrani",
    description: "Sovutilgan, 0.5 l",
    price: 12000,
    image: "🥛",
    available: true,
  },
];
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60000).toISOString();
const item = (id: string, name: string, unitPrice: number, quantity = 1) => ({
  id: `oi-${id}`,
  menuItemId: id,
  name,
  unitPrice,
  quantity,
  modifierIds: [],
  modifierNames: [],
  instructions: "",
  total: unitPrice * quantity,
});
const customer = {
  id: "c-seed",
  name: "Dilnoza Karimova",
  primaryPhone: "+998 90 123 45 67",
};
const fullAddress = {
  customerName: customer.name,
  primaryPhone: customer.primaryPhone,
  district: "Karmana tumani, Yangiariq MFY",
  street: "Amir Temur ko‘chasi",
  house: "24B",
  entrance: "2",
  floor: "3",
  apartment: "18",
  landmark: "12-maktab ro‘parasida",
  deliveryNotes: "Ko‘k darvoza, kirishda qo‘ng‘iroq qiling",
  latitude: 40.1039,
  longitude: 65.3688,
  confidence: "COMPLETE" as const,
  pinConfirmedAt: new Date().toISOString(),
  locationProvider: "mock" as const,
  deliveryDistanceKm: 2.4,
  deliveryZoneResult: "ELIGIBLE" as const,
};
function seeded(
  id: string,
  number: string,
  status: Order["status"],
  minutes: number,
  overrides: Partial<Order> = {},
): Order {
  const base: Order = {
    id,
    number,
    customer,
    type: "DELIVERY",
    address: fullAddress,
    items: [
      item("chicken", "Zaytun tovuq grili", 68000),
      item("ayran", "Uy ayrani", 12000, 2),
    ],
    subtotal: 92000,
    deliveryFee: 10000,
    total: 102000,
    paymentMethod: "CASH",
    paymentStatus: "PENDING",
    specialInstructions: "Sousni alohida soling",
    status,
    deliveryReviewStatus: "APPROVED",
    createdAt: ago(minutes),
    events: [createEvent(id, null, "NEW", "CUSTOMER", "guest")],
    issues: [],
  };
  return { ...base, ...overrides };
}
const history = (
  id: string,
  statuses: Order["status"][],
  actor: (s: Order["status"]) => [string, string],
) => {
  let prev: Order["status"] | null = null;
  return statuses.map((s) => {
    const [actorType, actorId] = actor(s);
    const e = createEvent(
      id,
      prev,
      s,
      actorType as Order["events"][number]["actorType"],
      actorId,
    );
    prev = s;
    return e;
  });
};
const seedOrders: Order[] = [
  seeded("ord-new", "ZG-1042", "NEW", 4),
  seeded("ord-clarify", "ZG-1041", "NEW", 6, {
    address: {
      ...fullAddress,
      house: "Bino raqami noma’lum",
      landmark: "",
      confidence: "NEEDS_CLARIFICATION",
    },
    deliveryReviewStatus: "CLARIFICATION_REQUESTED",
    deliveryReviewReason: "Uy raqami yoki mo‘ljalni aniqlashtiring.",
    events: [createEvent("ord-clarify", null, "NEW", "CUSTOMER", "guest")],
  }),
  seeded("ord-address", "ZG-1039", "CONFIRMED", 25, {
    address: {
      ...fullAddress,
      house: "Bino raqami noma’lum",
      confidence: "NEEDS_CLARIFICATION",
    },
    issues: [
      {
        id: "issue-address",
        orderId: "ord-address",
        type: "ADDRESS_CLARIFICATION",
        description: "Mijoz bino raqamini tasdiqlashi kerak",
        createdAt: ago(10),
        reportedBy: "restaurant",
      },
    ],
    events: history("ord-address", ["NEW", "CONFIRMED"], (s) =>
      s === "NEW" ? ["CUSTOMER", "guest"] : ["RESTAURANT", "staff-1"],
    ),
  }),
  seeded("ord-ready", "ZG-1037", "READY", 44, {
    events: [
      createEvent("ord-ready", null, "NEW", "CUSTOMER", "guest"),
      createEvent("ord-ready", "NEW", "CONFIRMED", "RESTAURANT", "staff-1"),
      createEvent(
        "ord-ready",
        "CONFIRMED",
        "PREPARING",
        "RESTAURANT",
        "staff-1",
      ),
      createEvent("ord-ready", "PREPARING", "READY", "RESTAURANT", "staff-1"),
    ],
  }),
  seeded("ord-active", "ZG-1035", "ON_THE_WAY", 58, {
    assignedDriverId: "driver-1",
    issues: [
      {
        id: "issue-phone",
        orderId: "ord-active",
        type: "CUSTOMER_NOT_ANSWERING",
        description: "Ikki marta qo‘ng‘iroq qilindi, javob yo‘q",
        createdAt: ago(3),
        reportedBy: "driver-1",
      },
    ],
    events: history(
      "ord-active",
      [
        "NEW",
        "CONFIRMED",
        "PREPARING",
        "READY",
        "DRIVER_ASSIGNED",
        "PICKED_UP",
        "ON_THE_WAY",
      ],
      (s) =>
        s === "NEW"
          ? ["CUSTOMER", "guest"]
          : s === "DRIVER_ASSIGNED"
            ? ["DISPATCHER", "dispatcher-1"]
            : ["PICKED_UP", "ON_THE_WAY"].includes(s)
              ? ["DRIVER", "driver-1"]
              : ["RESTAURANT", "staff-1"],
    ),
  }),
  seeded("ord-done", "ZG-1029", "DELIVERED", 120, {
    assignedDriverId: "driver-1",
    paymentStatus: "COLLECTED",
    events: history(
      "ord-done",
      [
        "NEW",
        "CONFIRMED",
        "PREPARING",
        "READY",
        "DRIVER_ASSIGNED",
        "PICKED_UP",
        "ON_THE_WAY",
        "ARRIVED",
        "DELIVERED",
      ],
      (s) =>
        s === "NEW"
          ? ["CUSTOMER", "guest"]
          : s === "DRIVER_ASSIGNED"
            ? ["DISPATCHER", "dispatcher-1"]
            : ["PICKED_UP", "ON_THE_WAY", "ARRIVED", "DELIVERED"].includes(s)
              ? ["DRIVER", "driver-1"]
              : ["RESTAURANT", "staff-1"],
    ),
  }),
];
export const seedDrivers: Driver[] = [
  {
    id: "driver-1",
    name: "Aziz Bekov",
    phone: "+998 93 555 12 12",
    vehicle: "Chevrolet Spark · 01 A 777 AA",
    availability: "BUSY",
  },
  {
    id: "driver-2",
    name: "Sardor Aliyev",
    phone: "+998 91 222 90 90",
    vehicle: "Skuter · 414",
    availability: "OFFLINE",
  },
];
export const developmentRestaurantConfig:RestaurantConfig={restaurantName:'Zaytun Kafe — LOCAL PILOT',restaurantAddress:'Guliston mavzesi 649, Navoiy shahri',restaurantPhone:'+998507440005',restaurantLatitude:40.087274,restaurantLongitude:65.402551,operatingHours:{everyday:'10:00–00:00'},deliveryEnabled:true,deliveryPolicyMode:'MANUAL_CITY_REVIEW',deliveryReviewMessage:'Navoiy shahri bo‘ylab yetkazib berish bepul. Manzil operator tomonidan tasdiqlanadi.',deliveryRadiusKm:null,deliveryAreaDescription:'Navoiy shahri',minimumDeliverySubtotal:100000,baseDeliveryFee:0,freeDeliveryThreshold:null,maximumItemQuantity:50,supportedPaymentMethods:['CASH','CARD_AT_PICKUP'],pickupPaymentMethods:['CASH','CARD_AT_PICKUP'],deliveryPaymentMethods:['CASH','CLICK','PAYME'],estimatedPreparationMinutes:null,estimatedDeliveryMinutes:null,defaultMapZoom:17,customerAuthRequired:false}
class LocalStore
  implements
    MenuRepository,
    OrderRepository,
    DriverRepository,
    AssignmentRepository,
    OrderEventRepository,
    OrderHistoryRepository,
    DriverLedgerRepository
{
  private orders: Order[];
  private drivers: Driver[];
  private assignments: DriverAssignment[] = [];
  constructor() {
    try {
      this.orders =
        JSON.parse(localStorage.getItem("zgo.orders") || "null") || seedOrders;
      this.drivers =
        JSON.parse(localStorage.getItem("zgo.drivers") || "null") ||
        seedDrivers;
    } catch {
      this.orders = seedOrders;
      this.drivers = seedDrivers;
    }
  }
  private persist() {
    localStorage.setItem("zgo.orders", JSON.stringify(this.orders));
    localStorage.setItem("zgo.drivers", JSON.stringify(this.drivers));
  }
  async getCategories() {
    return categories;
  }
  async getItems() {
    return menuItems;
  }
  async getRestaurantConfig(){return structuredClone(developmentRestaurantConfig)}
  async list() {
    return structuredClone(this.orders);
  }
  async listDrivers() {
    return structuredClone(this.drivers);
  }
  async get(id: string) {
    return structuredClone(this.orders.find((o) => o.id === id));
  }
  async save(order: Order) {
    const i = this.orders.findIndex((o) => o.id === order.id);
    if (i < 0) this.orders.unshift(order);
    else this.orders[i] = order;
    this.persist();
    return structuredClone(order);
  }
  // H3: local/offline demo provider. No tracking-token capability model
  // exists locally (the whole order list is already in-memory/unauthenticated
  // by design) -- the one real invariant worth enforcing here is the same
  // one the server enforces: one feedback record per order, ever.
  async submitOrderFeedback(id: string, submission: OrderFeedbackSubmission) {
    const order = await this.get(id);
    if (!order) throw new Error("Buyurtma topilmadi");
    if (order.feedback) throw new Error("Fikr allaqachon yuborilgan");
    const eligible = order.type === "DELIVERY" ? order.status === "DELIVERED" : order.status === "COLLECTED";
    if (!eligible) throw new Error("Fikr faqat yetkazib berilgandan/olib ketilgandan keyin qoldiriladi");
    const updated: Order = {
      ...order,
      feedback: {
        foodRating: submission.foodRating,
        deliveryRating: submission.deliveryRating,
        deliveryIssueReason: submission.deliveryIssueReason,
        foodIssueReason: submission.foodIssueReason,
        comment: submission.comment,
        submittedAt: new Date().toISOString(),
      },
    };
    await this.save(updated);
    return updated;
  }
  // Authenticated-customer order creation is a Supabase Auth (phone OTP)
  // feature; the local, non-Supabase dev store has no auth sessions at
  // all, so this path is unreachable there by construction. Throwing
  // loudly beats a silent no-op if that invariant is ever violated.
  async saveAsCustomer(order: Order): Promise<Order> {
    throw new Error(`Customer order creation requires the Supabase data provider (order ${order.id})`);
  }
  async ensureCurrentCustomer(): Promise<void> {
    throw new Error("Customer identity resolution requires the Supabase data provider");
  }
  async assign(order: Order, driver: Driver) {
    if(order.type!=="DELIVERY")throw new Error("Pickup orders cannot be assigned to drivers");
    if (order.status !== "READY")
      throw new Error("Only ready orders can be assigned");
    if(order.type==="DELIVERY"&&order.deliveryReviewStatus!=="APPROVED")throw new Error("Delivery review is required");
    if (driver.availability !== "AVAILABLE")
      throw new Error("Driver is not available");
    const assignment = {
      id: createUuid(),
      orderId: order.id,
      driverId: driver.id,
      assignedAt: new Date().toISOString(),
    };
    this.assignments.push(assignment);
    await this.save(
      transitionOrder(
        { ...order, assignedDriverId: driver.id },
        "DRIVER_ASSIGNED",
        "DISPATCHER",
        "dispatcher-1",
      ),
    );
    await this.saveDriver({ ...driver, availability: "BUSY" });
    return assignment;
  }
  async saveDriver(driver: Driver) {
    const i = this.drivers.findIndex((d) => d.id === driver.id);
    this.drivers[i] = driver;
    this.persist();
    return driver;
  }
  async listAssignments() {
    return structuredClone(this.assignments);
  }
  async append() {
    return;
  }
  async listEvents(orderId: string) {
    return this.orders.find((o) => o.id === orderId)?.events || [];
  }
  async transition(
    id: string,
    to: Order["status"],
    actor: OrderEvent["actorType"],
    reason?: string,
  ) {
    const order = await this.get(id);
    if (!order) throw new Error("Order not found");
    if(order.type==="DELIVERY"&&order.deliveryReviewStatus!=="APPROVED"&&!['REJECTED','CANCELLED'].includes(to))throw new Error("Delivery review is required");
    await this.save(
      transitionOrder(order, to, actor, actor.toLowerCase(), reason),
    );
  }
  async acceptAssignment(id: string) {
    const order = await this.get(id);
    if (!order) throw new Error("Order not found");
    await this.save({
      ...order,
      assignmentAcceptedAt: new Date().toISOString(),
    });
  }
  async setEstimate(id: string, minutes: number) {
    const order = await this.get(id);
    if (!order) throw new Error("Order not found");
    await this.save({ ...order, estimatedMinutes: minutes });
  }
  async reviewDelivery(id:string,approved:boolean,reason?:string){const order=await this.get(id);if(!order||order.type!=="DELIVERY"||order.deliveryReviewStatus!=="REVIEW_REQUIRED")throw new Error("Delivery review is not required");if(!approved&&!reason?.trim())throw new Error("Review reason is required");if(approved){await this.save({...order,deliveryReviewStatus:"APPROVED",deliveryReviewReason:undefined,events:[...order.events,createEvent(id,order.status,order.status,"DISPATCHER","dispatcher-1",undefined,"DELIVERY_REVIEW_APPROVED")]})}else{await this.save({...order,status:"REJECTED",deliveryReviewStatus:"REJECTED",deliveryReviewReason:reason,rejectionReason:reason,events:[...order.events,createEvent(id,order.status,"REJECTED","DISPATCHER","dispatcher-1",reason,"DELIVERY_REVIEW_REJECTED")]})}}
  async requestClarification(id:string,reason:string){const order=await this.get(id);if(!order||order.type!=="DELIVERY"||order.status!=="NEW"||order.deliveryReviewStatus!=="REVIEW_REQUIRED")throw new Error("Delivery review is not required");if(!reason.trim())throw new Error("Clarification reason is required");await this.save({...order,deliveryReviewStatus:"CLARIFICATION_REQUESTED",deliveryReviewReason:reason,events:[...order.events,createEvent(id,order.status,order.status,"RESTAURANT","staff-1",reason,"DELIVERY_CLARIFICATION_REQUESTED")]})}
  async getAddressForRevision(id:string){const order=await this.get(id);if(!order||order.type!=="DELIVERY"||order.status!=="NEW"||order.deliveryReviewStatus!=="CLARIFICATION_REQUESTED"||!order.address)return undefined;return{...order.address,pinConfirmedAt:undefined}}
  async reviseAddress(id:string,address:CustomerAddress){const order=await this.get(id);if(!order)throw new Error("Order not found");if(order.type!=="DELIVERY"||order.status!=="NEW"||order.deliveryReviewStatus!=="CLARIFICATION_REQUESTED")throw new Error("Address revision is not allowed for this order");const updated={...order,address,deliveryReviewStatus:"REVIEW_REQUIRED" as const,deliveryReviewReason:undefined,events:[...order.events,createEvent(id,order.status,order.status,"CUSTOMER","guest",undefined,"DELIVERY_ADDRESS_REVISED")]};await this.save(updated);return updated}
  async reportIssue(
    id: string,
    type: Order["issues"][number]["type"],
    description: string,
    reporter: string,
  ) {
    const order = await this.get(id);
    if (!order) throw new Error("Order not found");
    await this.save({
      ...order,
      issues: [...order.issues, createIssue(id, type, description, reporter)],
    });
  }
  async resolveIssue(_orderId: string, issueId: string) {
    const order = this.orders.find((o) =>
      o.issues.some((i) => i.id === issueId),
    );
    if (order)
      await this.save({
        ...order,
        issues: order.issues.map((i) =>
          i.id === issueId ? { ...i, resolvedAt: new Date().toISOString() } : i,
        ),
      });
  }
  subscribe(refresh: () => void, surface?: "restaurant" | "driver", disconnected?: () => void) {
    void disconnected;
    void refresh;
    void surface;
    return () => undefined;
  }
  // H1: Order History, local/offline demo provider only. Real Supabase
  // filtering happens entirely server-side (see SupabaseStore); this
  // in-memory equivalent exists solely so the offline dev/demo mode has a
  // working History screen too, using browser-local time (acceptable here
  // since this provider never talks to the real business).
  private historyWindow(filters: OrderHistoryFilters): [Date, Date] {
    const now = new Date();
    const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = startOfDay(now);
    switch (filters.preset) {
      case "YESTERDAY": {
        const y = new Date(today);
        y.setDate(y.getDate() - 1);
        return [y, today];
      }
      case "LAST_7_DAYS": {
        const from = new Date(today);
        from.setDate(from.getDate() - 6);
        const to = new Date(today);
        to.setDate(to.getDate() + 1);
        return [from, to];
      }
      case "THIS_MONTH":
        return [new Date(today.getFullYear(), today.getMonth(), 1), new Date(today.getFullYear(), today.getMonth() + 1, 1)];
      case "CUSTOM":
        return [
          filters.customFrom ? new Date(filters.customFrom) : today,
          filters.customTo ? new Date(new Date(filters.customTo).getTime() + 86400000) : new Date(today.getTime() + 86400000),
        ];
      default: {
        const to = new Date(today);
        to.setDate(to.getDate() + 1);
        return [today, to];
      }
    }
  }
  private matchingHistoryOrders(filters: OrderHistoryFilters) {
    const [from, to] = this.historyWindow(filters);
    const search = filters.search?.trim().toLowerCase();
    return this.orders
      .filter((o) => {
        const createdAt = new Date(o.createdAt);
        if (createdAt < from || createdAt >= to) return false;
        if (filters.driverId && o.assignedDriverId !== filters.driverId) return false;
        if (filters.status && o.status !== filters.status) return false;
        if (filters.fulfillment && o.type !== filters.fulfillment) return false;
        if (filters.paymentMethod && o.paymentMethod !== filters.paymentMethod) return false;
        if (search && !o.number.toLowerCase().includes(search)) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  async fetchOrderHistory(filters: OrderHistoryFilters): Promise<OrderHistoryPage> {
    const matched = this.matchingHistoryOrders(filters);
    const terminal: OrderStatus[] = ["DELIVERED", "COLLECTED", "CANCELLED", "REJECTED", "DELIVERY_FAILED", "RETURNED"];
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 25;
    const rows: OrderHistoryRow[] = matched.slice(offset, offset + limit).map((o) => ({
      id: o.id,
      number: o.number,
      createdAt: o.createdAt,
      finishedAt: terminal.includes(o.status)
        ? o.events.find((e) => e.newStatus === o.status)?.timestamp
        : undefined,
      branchId: "local-branch",
      branchName: "Zaytun Kafe",
      customerName: o.customer.name,
      type: o.type,
      status: o.status,
      assignedDriverId: o.assignedDriverId,
      driverName: this.drivers.find((d) => d.id === o.assignedDriverId)?.name,
      paymentMethod: o.paymentMethod,
      total: o.total,
      hasFeedback: !!o.feedback,
    }));
    return { rows, totalCount: matched.length };
  }
  async fetchOrderHistorySummary(filters: Omit<OrderHistoryFilters, "limit" | "offset">): Promise<OrderHistorySummary> {
    const matched = this.matchingHistoryOrders(filters);
    return {
      totalOrders: matched.length,
      delivered: matched.filter((o) => o.status === "DELIVERED" || o.status === "COLLECTED").length,
      cancelled: matched.filter((o) => o.status === "CANCELLED" || o.status === "REJECTED").length,
      failed: matched.filter((o) => o.status === "DELIVERY_FAILED" || o.status === "RETURNED").length,
      totalValue: matched.reduce((sum, o) => sum + o.total, 0),
    };
  }
  // H2: Driver Delivery Ledger, local/offline demo provider only. The
  // local domain model has no assignment_status/reassignment concept (real
  // Supabase credit derivation lives entirely in SupabaseStore) -- this
  // approximates each assignment's outcome from its order's CURRENT
  // status, which is exact for this provider since it never supports
  // decline/reassignment.
  private assignmentStatus(order: Order): DriverLedgerEntry["status"] {
    if (order.status === "DELIVERED" || order.status === "COLLECTED") return "COMPLETED";
    if (order.status === "DELIVERY_FAILED") return "FAILED";
    if (order.status === "RETURNED") return "RETURNED";
    if (order.status === "CANCELLED") return "CANCELLED";
    return order.assignmentAcceptedAt ? "ACCEPTED" : "ASSIGNED";
  }
  private matchingAssignments(filters: Pick<OrderHistoryFilters, "preset" | "customFrom" | "customTo" | "branchId">, driverId?: string) {
    const [from, to] = this.historyWindow(filters);
    return this.assignments
      .filter((a) => {
        const assignedAt = new Date(a.assignedAt);
        if (assignedAt < from || assignedAt >= to) return false;
        if (driverId && a.driverId !== driverId) return false;
        return true;
      })
      .map((a) => ({ assignment: a, order: this.orders.find((o) => o.id === a.orderId) }))
      .filter((row): row is { assignment: DriverAssignment; order: Order } => !!row.order)
      .sort((a, b) => b.assignment.assignedAt.localeCompare(a.assignment.assignedAt));
  }
  async fetchDriverLedgerSummary(
    filters: Pick<OrderHistoryFilters, "preset" | "customFrom" | "customTo" | "branchId">,
  ): Promise<DriverLedgerSummaryRow[]> {
    const rows = this.matchingAssignments(filters);
    const byDriver = new Map<string, DriverLedgerSummaryRow>();
    for (const { assignment, order } of rows) {
      const status = this.assignmentStatus(order);
      const driver = this.drivers.find((d) => d.id === assignment.driverId);
      if (!driver) continue;
      const entry = byDriver.get(driver.id) || {
        driverId: driver.id,
        driverName: driver.name,
        totalAssignments: 0,
        accepted: 0,
        completed: 0,
        failed: 0,
        returned: 0,
        declined: 0,
        superseded: 0,
        feedbackReceived: 0,
        feedbackFast: 0,
        feedbackNormal: 0,
        feedbackLate: 0,
        feedbackIssue: 0,
      };
      entry.totalAssignments += 1;
      if (assignment.acceptedAt) entry.accepted += 1;
      if (status === "COMPLETED") entry.completed += 1;
      if (status === "FAILED") entry.failed += 1;
      if (status === "RETURNED") entry.returned += 1;
      if (status === "COMPLETED" && order.feedback?.deliveryRating) {
        entry.feedbackReceived += 1;
        if (order.feedback.deliveryRating === "FAST") entry.feedbackFast += 1;
        if (order.feedback.deliveryRating === "NORMAL") entry.feedbackNormal += 1;
        if (order.feedback.deliveryRating === "LATE") entry.feedbackLate += 1;
        if (order.feedback.deliveryRating === "ISSUE") entry.feedbackIssue += 1;
      }
      byDriver.set(driver.id, entry);
    }
    return Array.from(byDriver.values()).sort((a, b) => b.completed - a.completed || a.driverName.localeCompare(b.driverName));
  }
  async fetchDriverLedgerEntries(
    driverId: string,
    filters: Pick<OrderHistoryFilters, "preset" | "customFrom" | "customTo">,
    limit: number,
    offset: number,
  ): Promise<DriverLedgerPage> {
    const rows = this.matchingAssignments(filters, driverId);
    const page = rows.slice(offset, offset + limit).map(
      ({ assignment, order }): DriverLedgerEntry => ({
        id: assignment.id,
        orderId: order.id,
        orderNumber: order.number,
        branchId: "local-branch",
        branchName: "Zaytun Kafe",
        district: order.address?.district,
        type: order.type,
        assignedAt: assignment.assignedAt,
        acceptedAt: assignment.acceptedAt,
        endedAt: undefined,
        status: this.assignmentStatus(order),
        total: order.total,
      }),
    );
    return { rows: page, totalCount: rows.length };
  }
}
export const store: LocalStore | SupabaseStore = import.meta.env.VITE_DATA_PROVIDER==='supabase'&&supabaseConfigured
  ? new SupabaseStore()
  : new LocalStore();
