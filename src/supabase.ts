import {
  createClient,
  type RealtimeChannel,
  type Session,
} from "@supabase/supabase-js";
import type {
  Driver,
  DriverAssignment,
  MenuCategory,
  MenuItem,
  Order,
  OrderEvent,
  OrderStatus,
  ActorType,
  DeliveryIssueType,
} from "./domain";

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
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
const fail = (error: { message: string } | null) => {
  if (error) throw new Error(error.message);
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
  };
};
const orderSelect =
  "*,customer_addresses(*),order_items(*),order_events(*),delivery_issues(*)";
export class SupabaseStore {
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
  async list() {
    const { data, error } = await supabase!
      .from("orders")
      .select(orderSelect)
      .order("created_at", { ascending: false });
    if (!error) {
      const rows = (data || []).map((r) => mapOrder(r as Row));
      if (rows.length) return rows;
    }
    const tokens = JSON.parse(
      localStorage.getItem("zgo.tracking") || "{}",
    ) as Record<string, string>;
    return (
      await Promise.all(Object.keys(tokens).map((id) => this.get(id)))
    ).filter(Boolean) as Order[];
  }
  async get(id: string) {
    const { data } = await supabase!
      .from("orders")
      .select(orderSelect)
      .eq("id", id)
      .maybeSingle();
    if (data) return mapOrder(data as Row);
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
  async save(order: Order) {
    let existing: Order | undefined;
    try {
      existing = await this.get(order.id);
    } catch {
      existing = undefined;
    }
    if (!existing) {
      const { data, error } = await supabase!.rpc("create_order", {
        p_order: order,
      });
      fail(error);
      const tokens = JSON.parse(localStorage.getItem("zgo.tracking") || "{}");
      tokens[data.id] = data.trackingToken;
      localStorage.setItem("zgo.tracking", JSON.stringify(tokens));
      return {
        ...order,
        id: data.id,
        number: data.number,
        deliveryFee: data.deliveryFee,
        total: data.total,
      };
    }
    if (existing.status !== order.status) {
      await this.transition(
        order.id,
        order.status,
        "SYSTEM",
        order.rejectionReason || order.cancellationReason,
      );
    } else if (
      order.estimatedMinutes !== existing.estimatedMinutes &&
      order.estimatedMinutes
    ) {
      const { error } = await supabase!.rpc("set_preparation_estimate", {
        p_order_id: order.id,
        p_minutes: order.estimatedMinutes,
      });
      fail(error);
    }
    return (await this.get(order.id))!;
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
    })) as Driver[];
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
  async reportIssue(id: string, type: DeliveryIssueType, description: string) {
    const { error } = await supabase!.rpc("report_delivery_issue", {
      p_order_id: id,
      p_type: type,
      p_description: description,
    });
    fail(error);
  }
  async resolveIssue(issueId: string) {
    const { error } = await supabase!.rpc("resolve_delivery_issue", {
      p_issue_id: issueId,
    });
    fail(error);
  }
  subscribe(refresh: () => void) {
    const channel = supabase!.channel("zaytun-operations");
    for (const table of [
      "orders",
      "order_events",
      "driver_assignments",
      "delivery_issues",
      "drivers",
    ])
      channel.on(
        "postgres_changes",
        { event: "*", schema: "public", table },
        refresh,
      );
    channel.subscribe();
    return () => void supabase!.removeChannel(channel as RealtimeChannel);
  }
  async signIn(email: string, password: string) {
    const { error } = await supabase!.auth.signInWithPassword({
      email,
      password,
    });
    fail(error);
  }
  async signOut() {
    await supabase!.auth.signOut();
  }
  async session(): Promise<Session | null> {
    return (await supabase!.auth.getSession()).data.session;
  }
}
