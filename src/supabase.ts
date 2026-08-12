import {
  createClient,
  type RealtimeChannel,
  type Session,
} from "@supabase/supabase-js";
import type {
  CustomerAddress,
  Driver,
  DriverAssignment,
  MenuCategory,
  MenuItem,
  RestaurantConfig,
  Order,
  OrderEvent,
  OrderStatus,
  ActorType,
  DeliveryIssueType,
  OrderHistoryFilters,
  OrderHistoryPage,
  OrderHistoryRow,
  OrderHistorySummary,
  DriverLedgerSummaryRow,
  DriverLedgerPage,
  DriverLedgerEntry,
  OrderFeedbackSubmission,
} from "./domain";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY||import.meta.env.VITE_SUPABASE_ANON_KEY;
export const supabaseConfigured = Boolean(url && key);
export const supabase = supabaseConfigured
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
const fail = (error: { message: string; code?: string } | null) => {
  if (!error) return;
  const [machineCode, customerMessage] = error.message.split("|", 2);
  const structured = /^[A-Z][A-Z0-9_]+$/.test(machineCode) && customerMessage?.trim();
  if (import.meta.env.DEV) console.error("[ZAYTUN data error]", { code: error.code || (structured ? machineCode : "SUPABASE_REQUEST_FAILED") });
  throw new Error(structured ? customerMessage.trim() : "Xizmat bilan bog‘lanib bo‘lmadi. Internetni tekshirib, qayta urinib ko‘ring.");
};
type Row = Record<string, unknown>;
const mapOrder = (r: Row): Order => {
  const address = Array.isArray(r.customer_addresses)
    ? (r.customer_addresses[0] as Row | undefined)
    : (r.customer_addresses as Row | undefined);
  return {
    id: String(r.id),
    number: String(r.number),
    customer: {
      id: `customer-${r.id}`,
      name: String(r.customer_name),
      primaryPhone: String(r.primary_phone),
      secondaryPhone: r.secondary_phone ? String(r.secondary_phone) : undefined,
    },
    type: r.order_type as Order["type"],
    address: address
      ? {
          customerName: String(r.customer_name),
          primaryPhone: String(r.primary_phone),
          secondaryPhone: r.secondary_phone
            ? String(r.secondary_phone)
            : undefined,
          district: String(address.district),
          street: String(address.street),
          house: String(address.house),
          entrance: address.entrance ? String(address.entrance) : undefined,
          floor: address.floor ? String(address.floor) : undefined,
          apartment: address.apartment ? String(address.apartment) : undefined,
          landmark: String(address.landmark || ""),
          deliveryNotes: String(address.delivery_notes || ""),
          latitude: Number(address.latitude),
          longitude: Number(address.longitude),
          confidence: address.confidence as Order["address"] extends infer A
            ? A extends { confidence: infer C }
              ? C
              : never
            : never,
          pinConfirmedAt: address.pin_confirmed_at
            ? String(address.pin_confirmed_at)
            : undefined,
          locationProvider: address.location_provider as "mock" | "yandex",
          providerPlaceId: address.provider_place_id
            ? String(address.provider_place_id)
            : undefined,
          providerFormattedAddress: address.provider_formatted_address
            ? String(address.provider_formatted_address)
            : undefined,
          deliveryDistanceKm: address.delivery_distance_km
            ? Number(address.delivery_distance_km)
            : undefined,
          deliveryZoneResult: address.delivery_zone_result as
            | "ELIGIBLE"
            | "OUTSIDE_ZONE"
            | "DELIVERY_DISABLED",
        }
      : undefined,
    items: ((r.order_items || []) as Row[]).map((i) => ({
      id: String(i.id),
      menuItemId: String(i.menu_item_id || ""),
      name: String(i.name),
      unitPrice: Number(i.unit_price),
      quantity: Number(i.quantity),
      modifierIds: (i.modifier_ids as string[]) || [],
      modifierNames: (i.modifier_names as string[]) || [],
      instructions: String(i.instructions || ""),
      total: Number(i.total),
    })),
    subtotal: Number(r.subtotal),
    deliveryFee: Number(r.delivery_fee),
    total: Number(r.total),
    paymentMethod: r.payment_method as Order["paymentMethod"],
    paymentStatus: r.payment_status as Order["paymentStatus"],
    specialInstructions: String(r.special_instructions || ""),
    status: r.status as OrderStatus,
    createdAt: String(r.created_at),
    estimatedMinutes: r.estimated_minutes
      ? Number(r.estimated_minutes)
      : undefined,
    assignedDriverId: r.assigned_driver_id
      ? String(r.assigned_driver_id)
      : undefined,
    assignmentAcceptedAt: r.assignment_accepted_at
      ? String(r.assignment_accepted_at)
      : undefined,
    deliveryReviewStatus: r.delivery_review_status as Order["deliveryReviewStatus"],
    deliveryReviewReason: r.delivery_review_reason ? String(r.delivery_review_reason) : undefined,
    events: ((r.order_events || []) as Row[]).map((e) => ({
      id: String(e.id),
      orderId: String(e.order_id),
      actorType: e.actor_type as ActorType,
      actorId: String(e.actor_id),
      previousStatus: e.previous_status as OrderStatus | null,
      newStatus: e.new_status as OrderStatus,
      timestamp: String(e.occurred_at),
      reason: e.reason ? String(e.reason) : undefined,
      notes: e.notes ? String(e.notes) : undefined,
    })),
    issues: ((r.delivery_issues || []) as Row[]).map((i) => ({
      id: String(i.id),
      orderId: String(i.order_id),
      type: i.issue_type as DeliveryIssueType,
      description: String(i.description),
      createdAt: String(i.created_at),
      reportedBy: String(i.reported_by || ""),
      resolvedAt: i.resolved_at ? String(i.resolved_at) : undefined,
    })),
    feedback: mapFeedback(r),
  };
};
// H3: two different response shapes carry feedback -- get_order_tracking's
// jsonb already returns a flat, camelCase `feedback` object; the raw
// `.from('orders').select(orderSelect)` path (staff surfaces) embeds the
// related table as `order_feedback`, snake_case, possibly array-wrapped
// (a to-one FK embed can come back either way depending on PostgREST
// version). Both are normalized to the same OrderFeedback shape here.
const mapFeedback = (r: Row): Order["feedback"] => {
  const embedded = Array.isArray(r.order_feedback) ? r.order_feedback[0] : r.order_feedback;
  const f = (r.feedback ?? embedded) as Row | null | undefined;
  if (!f) return undefined;
  return {
    deliveryRating: (f.deliveryRating ?? f.delivery_rating) as Order["feedback"] extends infer O ? (O extends { deliveryRating?: infer D } ? D : never) : never,
    deliveryIssueReason: (f.deliveryIssueReason ?? f.delivery_issue_reason) as Order["feedback"] extends infer O ? (O extends { deliveryIssueReason?: infer D } ? D : never) : never,
    foodRating: (f.foodRating ?? f.food_rating) as Order["feedback"] extends infer O ? (O extends { foodRating: infer D } ? D : never) : never,
    foodIssueReason: (f.foodIssueReason ?? f.food_issue_reason) as Order["feedback"] extends infer O ? (O extends { foodIssueReason?: infer D } ? D : never) : never,
    comment: f.comment ? String(f.comment) : undefined,
    submittedAt: String(f.submittedAt ?? f.submitted_at),
  };
};
const orderSelect =
  "*,customer_addresses(*),order_items(*),order_events(*),delivery_issues(*),order_feedback(*)";
export const toAddressPayload = (address: CustomerAddress) => ({
  district: address.district,
  street: address.street,
  house: address.house,
  entrance: address.entrance,
  floor: address.floor,
  apartment: address.apartment,
  landmark: address.landmark,
  deliveryNotes: address.deliveryNotes,
  latitude: address.latitude,
  longitude: address.longitude,
  confidence: address.confidence,
  pinConfirmedAt: address.pinConfirmedAt,
  locationProvider: address.locationProvider,
  providerPlaceId: address.providerPlaceId,
  providerFormattedAddress: address.providerFormattedAddress,
});
export const toPublicOrderPayload = (order: Order) => ({
  id: order.id,
  idempotencyKey: order.id,
  customer: {
    name: order.customer.name,
    primaryPhone: order.customer.primaryPhone,
    secondaryPhone: order.customer.secondaryPhone,
  },
  type: order.type,
  paymentMethod: order.paymentMethod,
  specialInstructions: order.specialInstructions,
  address: order.address ? toAddressPayload(order.address) : undefined,
  items: order.items.map((item) => ({
    menuItemId: item.menuItemId,
    quantity: item.quantity,
    modifierIds: item.modifierIds,
    instructions: item.instructions,
  })),
});
const mapAddressForRevision = (r: Row): CustomerAddress => ({
  customerName: "",
  primaryPhone: "",
  district: String(r.district || ""),
  street: String(r.street || ""),
  house: String(r.house || ""),
  entrance: r.entrance ? String(r.entrance) : undefined,
  floor: r.floor ? String(r.floor) : undefined,
  apartment: r.apartment ? String(r.apartment) : undefined,
  landmark: String(r.landmark || ""),
  deliveryNotes: String(r.deliveryNotes || ""),
  latitude: r.latitude === null || r.latitude === undefined ? undefined : Number(r.latitude),
  longitude: r.longitude === null || r.longitude === undefined ? undefined : Number(r.longitude),
  confidence: (r.confidence as CustomerAddress["confidence"]) || "CUSTOMER_CONFIRMATION_REQUIRED",
  // pinConfirmedAt is intentionally omitted: a prior confirmation must never
  // be carried into a new revision session, the customer reconfirms fresh.
  locationProvider: r.locationProvider as CustomerAddress["locationProvider"],
  providerPlaceId: r.providerPlaceId ? String(r.providerPlaceId) : undefined,
  providerFormattedAddress: r.providerFormattedAddress ? String(r.providerFormattedAddress) : undefined,
});
export class SupabaseStore {
  async getRestaurantConfig(){const{data,error}=await supabase!.rpc('get_public_restaurant_config');fail(error);if(!data)throw new Error('Restoran sozlamalari topilmadi');return data as RestaurantConfig}
  async getCategories() {
    const { data, error } = await supabase!
      .from("menu_categories")
      .select("*")
      .order("sort_order");
    fail(error);
    return (data || []).map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
    })) as MenuCategory[];
  }
  async getItems() {
    const { data, error } = await supabase!
      .from("menu_items")
      .select("*,menu_modifiers(*)")
      .order("sort_order");
    fail(error);
    return (data || []).map((r) => ({
      id: r.id,
      categoryId: r.category_id,
      name: r.name,
      description: r.description,
      price: r.price,
      image: r.image,
      available: r.available,
      modifiers: r.menu_modifiers?.map((m: Row) => ({
        id: String(m.id),
        name: String(m.name),
        price: Number(m.price),
      })),
    })) as MenuItem[];
  }
  async list(surface?: "restaurant" | "driver") {
    // H0: the live restaurant board is an operational workspace, not an
    // unlimited archive -- list_live_restaurant_order_ids() (server-side,
    // business-day-aware) decides which orders belong on it. Every other
    // surface (driver, or this method's own generic callers) keeps the
    // exact previous unfiltered behavior -- this is a restaurant
    // read-model change only.
    if (surface === "restaurant") {
      const { data: ids, error: liveIdsError } = await supabase!.rpc(
        "list_live_restaurant_order_ids",
      );
      fail(liveIdsError);
      if (!ids || ids.length === 0) return [];
      const { data, error } = await supabase!
        .from("orders")
        .select(orderSelect)
        .in("id", ids)
        .order("created_at", { ascending: false });
      fail(error);
      return (data || []).map((r) => mapOrder(r as Row));
    }
    const { data, error } = await supabase!
      .from("orders")
      .select(orderSelect)
      .order("created_at", { ascending: false });
    fail(error);
    return (data || []).map((r) => mapOrder(r as Row));
  }
  async get(id: string) {
    const { data, error } = await supabase!
      .from("orders")
      .select(orderSelect)
      .eq("id", id)
      .maybeSingle();
    fail(error);
    return data ? mapOrder(data as Row) : undefined;
  }
  async getTracked(id: string) {
    const token = (
      JSON.parse(localStorage.getItem("zgo.tracking") || "{}") as Record<
        string,
        string
      >
    )[id];
    if (!token) return undefined;
    const tracked = await supabase!.rpc("get_order_tracking", {
      p_order_id: id,
      p_tracking_token: token,
    });
    fail(tracked.error);
    return tracked.data ? mapOrder(tracked.data as Row) : undefined;
  }
  // H3: submission is authorized the exact same way every other public
  // order-mutating RPC is -- id + the same tracking_token getTracked()
  // already reads from localStorage, never a bare order_id. Returns the
  // fresh tracking response so the caller can render the confirmed state
  // immediately, with no extra round trip.
  async submitOrderFeedback(id: string, submission: OrderFeedbackSubmission) {
    const token = (
      JSON.parse(localStorage.getItem("zgo.tracking") || "{}") as Record<string, string>
    )[id];
    if (!token) throw new Error("Bu buyurtma uchun kuzatish ruxsati topilmadi");
    const { data, error } = await supabase!.rpc("submit_order_feedback", {
      p_order_id: id,
      p_tracking_token: token,
      p_food_rating: submission.foodRating,
      p_delivery_rating: submission.deliveryRating ?? null,
      p_delivery_issue_reason: submission.deliveryIssueReason ?? null,
      p_food_issue_reason: submission.foodIssueReason ?? null,
      p_comment: submission.comment ?? null,
    });
    fail(error);
    return mapOrder(data as Row);
  }
  async save(order: Order) {
    return this.submitOrderVia("create_public_order", order);
  }
  // Authenticated-customer path: identical shape/response handling to the
  // anonymous path, only the RPC differs. The server derives customer_id
  // and the verified phone itself (create_customer_order never trusts
  // anything from this payload for identity) -- this method exists only
  // to route to that RPC, not to add any client-side trust.
  async saveAsCustomer(order: Order) {
    return this.submitOrderVia("create_customer_order", order);
  }
  private async submitOrderVia(rpcName: "create_public_order" | "create_customer_order", order: Order) {
    const { data, error } = await supabase!.rpc(rpcName, { p_order: toPublicOrderPayload(order) });
    fail(error);
    const tokens = JSON.parse(localStorage.getItem("zgo.tracking") || "{}");
    tokens[data.id] = data.trackingToken;
    localStorage.setItem("zgo.tracking", JSON.stringify(tokens));
    return {
      ...order,
      id: data.id,
      number: data.number,
      items: data.items,
      subtotal: data.subtotal,
      deliveryFee: data.deliveryFee,
      total: data.total,
      deliveryReviewStatus: order.type === "DELIVERY" ? "REVIEW_REQUIRED" : "NOT_REQUIRED",
    } satisfies Order;
  }
  // Resolves (creating or linking as needed) the canonical customers row
  // for the current Supabase Auth session, entirely server-side -- the
  // caller never supplies a customer id or phone. Called once right after
  // a successful OTP verification, before the caller is told sign-in
  // succeeded, so a customer_auth_required=true checkout can proceed
  // immediately afterward.
  async ensureCurrentCustomer(): Promise<void> {
    const { error } = await supabase!.rpc("ensure_current_customer");
    fail(error);
  }
  async listDrivers() {
    const { data, error } = await supabase!
      .from("drivers")
      .select("*,profiles(display_name)");
    fail(error);
    return (data || []).map((r) => ({
      id: r.id,
      name: r.profiles?.display_name || "Driver",
      phone: r.phone,
      vehicle: r.vehicle,
      availability: r.availability,
      shiftStatus: r.shift_status,
      dispatchStatus: r.dispatch_status,
      deliveryCapacity: Number(r.delivery_capacity),
    })) as Driver[];
  }
  // P4.1: self-service only -- both RPCs act on auth.uid() alone, a driver
  // can never touch another driver's row.
  async startShift() {
    const { error } = await supabase!.rpc("start_shift");
    fail(error);
  }
  async endShift() {
    const { error } = await supabase!.rpc("end_shift");
    fail(error);
  }
  async saveDriver(driver: Driver) {
    return driver;
  }
  async listAssignments() {
    const { data, error } = await supabase!
      .from("driver_assignments")
      .select("*");
    fail(error);
    return (data || []).map((r) => ({
      id: r.id,
      orderId: r.order_id,
      driverId: r.driver_id,
      assignedAt: r.assigned_at,
      acceptedAt: r.accepted_at,
    })) as DriverAssignment[];
  }
  async listEvents(orderId: string) {
    const { data, error } = await supabase!
      .from("order_events")
      .select("*")
      .eq("order_id", orderId);
    fail(error);
    return (data || []) as unknown as OrderEvent[];
  }
  async append() {
    throw new Error("Events are created by database functions");
  }
  async assign(order: Order, driver: Driver) {
    const { data, error } = await supabase!.rpc("assign_driver", {
      p_order_id: order.id,
      p_driver_id: driver.id,
    });
    fail(error);
    return {
      id: data.id,
      orderId: data.order_id,
      driverId: data.driver_id,
      assignedAt: data.assigned_at,
    } as DriverAssignment;
  }
  async transition(
    id: string,
    to: OrderStatus,
    _actor: ActorType,
    reason?: string,
  ) {
    const { error } = await supabase!.rpc("transition_order", {
      p_order_id: id,
      p_new_status: to,
      p_reason: reason || null,
      p_notes: null,
    });
    fail(error);
  }
  async acceptAssignment(id: string) {
    const { error } = await supabase!.rpc("accept_assignment", {
      p_order_id: id,
    });
    fail(error);
  }
  async setEstimate(id: string, minutes: number) {
    const { error } = await supabase!.rpc("set_preparation_estimate", {
      p_order_id: id,
      p_minutes: minutes,
    });
    fail(error);
  }
  async reviewDelivery(id: string, approved: boolean, reason?: string) {
    const { error } = await supabase!.rpc("review_delivery_request", {p_order_id:id,p_approved:approved,p_reason:reason||null});
    fail(error);
  }
  async requestClarification(id: string, reason: string) {
    const { error } = await supabase!.rpc("request_delivery_clarification", { p_order_id: id, p_reason: reason });
    fail(error);
  }
  async getAddressForRevision(id: string) {
    const token = (JSON.parse(localStorage.getItem("zgo.tracking") || "{}") as Record<string, string>)[id];
    if (!token) return undefined;
    const { data, error } = await supabase!.rpc("get_delivery_address_for_revision", { p_order_id: id, p_tracking_token: token });
    fail(error);
    return data ? mapAddressForRevision(data as Row) : undefined;
  }
  async reviseAddress(id: string, address: CustomerAddress) {
    const token = (JSON.parse(localStorage.getItem("zgo.tracking") || "{}") as Record<string, string>)[id];
    if (!token) throw new Error("Kuzatuv havolasi topilmadi. Sahifani qayta yuklang.");
    const { data, error } = await supabase!.rpc("revise_delivery_address", { p_order_id: id, p_tracking_token: token, p_address: toAddressPayload(address) });
    fail(error);
    return data ? mapOrder(data as Row) : undefined;
  }
  async reportIssue(id: string, type: DeliveryIssueType, description: string) {
    const { error } = await supabase!.rpc("report_delivery_issue", {
      p_order_id: id,
      p_type: type,
      p_description: description,
    });
    fail(error);
  }
  async resolveIssue(_orderId: string, issueId: string) {
    const { error } = await supabase!.rpc("resolve_delivery_issue", {
      p_issue_id: issueId,
    });
    fail(error);
  }
  subscribe(refresh: () => void, surface: "restaurant" | "driver" = "restaurant", disconnected?: () => void) {
    const channel = supabase!.channel("zaytun-operations");
    const tables = surface === "restaurant"
      ? ["orders", "order_events", "driver_assignments", "delivery_issues", "drivers"]
      : ["orders", "order_events", "driver_assignments", "delivery_issues"];
    for (const table of tables)
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        refresh,
      );
    channel.subscribe((status) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") disconnected?.();
    });
    return () => void supabase!.removeChannel(channel as RealtimeChannel);
  }
  async signOut() {
    await supabase!.auth.signOut();
  }
  async session(): Promise<Session | null> {
    return (await supabase!.auth.getSession()).data.session;
  }
  // H1: Order History. Both RPCs resolve date presets/custom ranges
  // server-side (Asia/Tashkent) and enforce staff-only access themselves
  // -- this is a thin passthrough, never a client-side filter over the
  // full order history.
  async fetchOrderHistory(filters: OrderHistoryFilters): Promise<OrderHistoryPage> {
    const { data, error } = await supabase!.rpc("list_restaurant_order_history", {
      p_preset: filters.preset,
      p_custom_from: filters.customFrom ?? null,
      p_custom_to: filters.customTo ?? null,
      p_branch_id: filters.branchId ?? null,
      p_driver_id: filters.driverId ?? null,
      p_status: filters.status ?? null,
      p_fulfillment: filters.fulfillment ?? null,
      p_payment_method: filters.paymentMethod ?? null,
      p_search: filters.search ?? null,
      p_limit: filters.limit ?? 25,
      p_offset: filters.offset ?? 0,
    });
    fail(error);
    const rows = ((data || []) as Row[]).map(
      (r): OrderHistoryRow => ({
        id: String(r.id),
        number: String(r.number),
        createdAt: String(r.created_at),
        finishedAt: r.finished_at ? String(r.finished_at) : undefined,
        branchId: String(r.branch_id),
        branchName: String(r.branch_name),
        customerName: String(r.customer_name),
        type: r.order_type as OrderHistoryRow["type"],
        status: r.status as OrderStatus,
        assignedDriverId: r.assigned_driver_id ? String(r.assigned_driver_id) : undefined,
        driverName: r.driver_name ? String(r.driver_name) : undefined,
        paymentMethod: r.payment_method as OrderHistoryRow["paymentMethod"],
        total: Number(r.total),
        hasFeedback: Boolean(r.has_feedback),
      }),
    );
    const totalCount = data && data.length > 0 ? Number((data[0] as Row).total_count) : 0;
    return { rows, totalCount };
  }
  async fetchOrderHistorySummary(
    filters: Omit<OrderHistoryFilters, "limit" | "offset">,
  ): Promise<OrderHistorySummary> {
    const { data, error } = await supabase!.rpc("get_restaurant_order_history_summary", {
      p_preset: filters.preset,
      p_custom_from: filters.customFrom ?? null,
      p_custom_to: filters.customTo ?? null,
      p_branch_id: filters.branchId ?? null,
      p_driver_id: filters.driverId ?? null,
      p_status: filters.status ?? null,
      p_fulfillment: filters.fulfillment ?? null,
      p_payment_method: filters.paymentMethod ?? null,
      p_search: filters.search ?? null,
    });
    fail(error);
    const summary = (data || {}) as Row;
    return {
      totalOrders: Number(summary.totalOrders || 0),
      delivered: Number(summary.delivered || 0),
      cancelled: Number(summary.cancelled || 0),
      failed: Number(summary.failed || 0),
      totalValue: Number(summary.totalValue || 0),
    };
  }
  // H2: Driver Delivery Ledger. Both RPCs enforce staff-only access
  // themselves and derive credit strictly from driver_assignments.status.
  async fetchDriverLedgerSummary(
    filters: Omit<OrderHistoryFilters, "limit" | "offset" | "status" | "fulfillment" | "paymentMethod" | "driverId" | "search">,
  ): Promise<DriverLedgerSummaryRow[]> {
    const { data, error } = await supabase!.rpc("list_driver_ledger_summary", {
      p_preset: filters.preset,
      p_custom_from: filters.customFrom ?? null,
      p_custom_to: filters.customTo ?? null,
      p_branch_id: filters.branchId ?? null,
    });
    fail(error);
    return ((data || []) as Row[]).map(
      (r): DriverLedgerSummaryRow => ({
        driverId: String(r.driver_id),
        driverName: String(r.driver_name),
        totalAssignments: Number(r.total_assignments),
        accepted: Number(r.accepted),
        completed: Number(r.completed),
        failed: Number(r.failed),
        returned: Number(r.returned),
        declined: Number(r.declined),
        superseded: Number(r.superseded),
        feedbackReceived: Number(r.feedback_received),
        feedbackFast: Number(r.feedback_fast),
        feedbackNormal: Number(r.feedback_normal),
        feedbackLate: Number(r.feedback_late),
        feedbackIssue: Number(r.feedback_issue),
      }),
    );
  }
  async fetchDriverLedgerEntries(
    driverId: string,
    filters: Omit<OrderHistoryFilters, "limit" | "offset" | "status" | "fulfillment" | "paymentMethod" | "driverId" | "search" | "branchId">,
    limit: number,
    offset: number,
  ): Promise<DriverLedgerPage> {
    const { data, error } = await supabase!.rpc("list_driver_assignment_ledger", {
      p_driver_id: driverId,
      p_preset: filters.preset,
      p_custom_from: filters.customFrom ?? null,
      p_custom_to: filters.customTo ?? null,
      p_limit: limit,
      p_offset: offset,
    });
    fail(error);
    const rows = ((data || []) as Row[]).map(
      (r): DriverLedgerEntry => ({
        id: String(r.id),
        orderId: String(r.order_id),
        orderNumber: String(r.order_number),
        branchId: String(r.branch_id),
        branchName: String(r.branch_name),
        district: r.district ? String(r.district) : undefined,
        type: r.order_type as DriverLedgerEntry["type"],
        assignedAt: String(r.assigned_at),
        acceptedAt: r.accepted_at ? String(r.accepted_at) : undefined,
        endedAt: r.ended_at ? String(r.ended_at) : undefined,
        status: r.status as DriverLedgerEntry["status"],
        total: Number(r.total),
      }),
    );
    const totalCount = data && data.length > 0 ? Number((data[0] as Row).total_count) : 0;
    return { rows, totalCount };
  }
}
