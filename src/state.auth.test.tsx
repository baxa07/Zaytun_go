import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { AppProvider, useApp, isVerifiedCustomerSession, mapCustomerAuthError, mapDriverAuthError, type AppRole } from "./state";
import type { Order, OrderStatus, RestaurantConfig } from "./domain";

const publicConfig: RestaurantConfig = {
  restaurantName: "Test Zaytun",
  restaurantAddress: "Test address",
  restaurantPhone: "+998000000000",
  restaurantLatitude: 40.1,
  restaurantLongitude: 65.3,
  operatingHours: { monday: "09:00-22:00" },
  deliveryEnabled: true,
  deliveryRadiusKm: 8,
  deliveryAreaDescription: "Test area",
  minimumDeliverySubtotal: 0,
  baseDeliveryFee: 10000,
  freeDeliveryThreshold: null,
  maximumItemQuantity: 20,
  supportedPaymentMethods: ["CASH", "CARD_ON_DELIVERY"],
  pickupPaymentMethods: ["CASH", "CARD_AT_PICKUP"],
  deliveryPaymentMethods: ["CASH"],
  estimatedPreparationMinutes: 25,
  estimatedDeliveryMinutes: 45,
  defaultMapZoom: 14,
};

const mocks = vi.hoisted(() => ({
  session: null as { user: { id: string; phone?: string; phone_confirmed_at?: string } } | null,
  role: null as AppRole | null,
  displayName: null as string | null,
  list: vi.fn<() => Promise<Order[]>>(),
  listDrivers: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  get: vi.fn(),
  save: vi.fn(),
  transition: vi.fn(),
  assign: vi.fn(),
  reviewDelivery: vi.fn(),
  requestClarification: vi.fn(),
  acceptAssignment: vi.fn(),
  authCallback: null as ((event: string, session: unknown) => void) | null,
  signInWithPassword: vi.fn(async () => ({ error: null })),
  signInWithOtp: vi.fn<(args: { phone: string; options?: { captchaToken?: string; shouldCreateUser?: boolean } }) => Promise<{ error: { code?: string; status?: number; message?: string } | null }>>(async () => ({ error: null })),
  verifyOtp: vi.fn<() => Promise<{ data: { session: { user: { id: string; phone?: string; phone_confirmed_at?: string } } | null }; error: { code?: string; status?: number; message?: string } | null }>>(async () => ({ data: { session: { user: { id: "customer-otp-1", phone: "998901234567", phone_confirmed_at: "2026-08-10T00:00:00.000Z" } } }, error: null })),
  ensureCurrentCustomer: vi.fn(async () => undefined),
  signOut: vi.fn(async () => ({ error: null })),
}));

vi.mock("./data", () => ({
  categories: [],
  menuItems: [],
  store: {
    getCategories: vi.fn(async () => []),
    getItems: vi.fn(async () => []),
    getRestaurantConfig: vi.fn(async () => publicConfig),
    list: mocks.list,
    listDrivers: mocks.listDrivers,
    subscribe: mocks.subscribe,
    get: mocks.get,
    save: mocks.save,
    transition: mocks.transition,
    assign: mocks.assign,
    acceptAssignment: mocks.acceptAssignment,
    setEstimate: vi.fn(),
    reviewDelivery: mocks.reviewDelivery,
    requestClarification: mocks.requestClarification,
    reportIssue: vi.fn(),
    resolveIssue: vi.fn(),
    saveDriver: vi.fn(),
    ensureCurrentCustomer: mocks.ensureCurrentCustomer,
    saveAsCustomer: vi.fn(),
  },
}));

vi.mock("./supabase", () => ({
  supabaseConfigured: true,
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: mocks.session }, error: null })),
      onAuthStateChange: vi.fn((callback: (event: string, session: unknown) => void) => {
        mocks.authCallback = callback;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      }),
      signInWithPassword: mocks.signInWithPassword,
      signInWithOtp: mocks.signInWithOtp,
      verifyOtp: mocks.verifyOtp,
      signOut: mocks.signOut,
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          // A customer (phone-OTP) session has no profiles row by design;
          // maybeSingle (not single) is what makes that resolve to
          // role=null instead of a thrown PostgREST "zero rows" error.
          maybeSingle: vi.fn(async () => ({ data: mocks.role ? { role: mocks.role, display_name: mocks.displayName } : null, error: null })),
        })),
      })),
    })),
  },
}));

const renderAt = (path: string, child: React.ReactNode = <App />) => render(
  <MemoryRouter initialEntries={[path]}>
    <AppProvider>{child}</AppProvider>
  </MemoryRouter>,
);

function OperationalProbe() {
  const { loaded, orders, operationalError } = useApp();
  return <div>{loaded ? `loaded:${orders.length}` : "waiting"}{operationalError && ` error:${operationalError}`}</div>;
}

beforeEach(() => {
  mocks.session = null;
  mocks.role = null;
  mocks.displayName = null;
  mocks.list.mockReset().mockResolvedValue([]);
  mocks.listDrivers.mockReset().mockResolvedValue([]);
  mocks.transition.mockReset();
  mocks.assign.mockReset();
  mocks.reviewDelivery.mockReset();
  mocks.requestClarification.mockReset();
  mocks.acceptAssignment.mockReset();
  mocks.get.mockReset();
  mocks.subscribe.mockClear();
  mocks.signInWithPassword.mockReset().mockResolvedValue({ error: null });
  mocks.signInWithOtp.mockReset().mockResolvedValue({ error: null });
  mocks.verifyOtp.mockReset().mockResolvedValue({ data: { session: { user: { id: "customer-otp-1", phone: "998901234567", phone_confirmed_at: "2026-08-10T00:00:00.000Z" } } }, error: null });
  mocks.ensureCurrentCustomer.mockReset().mockResolvedValue(undefined);
  mocks.signOut.mockReset().mockResolvedValue({ error: null });
});

afterEach(() => vi.clearAllMocks());

describe("route-aware Supabase loading", () => {
  it("describes an empty published menu as not yet published rather than a network failure", async () => {
    renderAt("/menu");
    expect((await screen.findByTestId("menu-unpublished")).textContent).toContain("Menyu hali e’lon qilinmagan");
    expect(screen.queryByText("Menyuni yuklab bo‘lmadi")).toBeNull();
  });

  it("does not query orders or drivers on an anonymous customer route", async () => {
    renderAt("/checkout", <div>customer checkout</div>);
    await screen.findByText("customer checkout");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.listDrivers).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("shows restaurant login before any operational query", async () => {
    renderAt("/restaurant");
    expect(await screen.findByRole("heading", { name: "Kirish" })).toBeTruthy();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.listDrivers).not.toHaveBeenCalled();
  });

  it("shows driver login before any operational query", async () => {
    renderAt("/driver");
    expect(await screen.findByRole("heading", { name: "Kirish" })).toBeTruthy();
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.listDrivers).not.toHaveBeenCalled();
  });

  it("loads orders and the roster for an authenticated restaurant role", async () => {
    mocks.session = { user: { id: "staff-1" } };
    mocks.role = "RESTAURANT";
    renderAt("/restaurant", <OperationalProbe />);
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
    expect(mocks.listDrivers).toHaveBeenCalledOnce();
    expect(mocks.subscribe).toHaveBeenCalledWith(expect.any(Function), "restaurant", expect.any(Function));
  });

  it("loads only RLS-filtered orders and no roster for an authenticated driver", async () => {
    mocks.session = { user: { id: "driver-1" } };
    mocks.role = "DRIVER";
    mocks.list.mockResolvedValue([{ id: "assigned-order" } as Order]);
    renderAt("/driver", <OperationalProbe />);
    expect(await screen.findByText("loaded:1")).toBeTruthy();
    expect(mocks.listDrivers).not.toHaveBeenCalled();
    expect(mocks.subscribe).toHaveBeenCalledWith(expect.any(Function), "driver", expect.any(Function));
  });

  it("greets a signed-in driver by their own profile name, never a different person's", async () => {
    mocks.session = { user: { id: "driver-2" } };
    mocks.role = "DRIVER";
    mocks.displayName = "Jasur Toshmatov";
    mocks.list.mockResolvedValue([]);
    renderAt("/driver");
    expect(await screen.findByText("JASUR", { exact: false })).toBeTruthy();
    expect(screen.queryByText("AZIZ", { exact: false })).toBeNull();
  });

  it("shows a neutral driver greeting with no name when the profile display name is unavailable", async () => {
    mocks.session = { user: { id: "driver-3" } };
    mocks.role = "DRIVER";
    mocks.displayName = null;
    mocks.list.mockResolvedValue([]);
    renderAt("/driver");
    expect(await screen.findByText("Bugungi yetkazish")).toBeTruthy();
    expect(screen.queryByText("AZIZ", { exact: false })).toBeNull();
    expect(screen.queryByText(/XAYRLI KUN,/)).toBeNull();
  });

  it("turns rejected operational loads into a recoverable state", async () => {
    mocks.session = { user: { id: "staff-1" } };
    mocks.role = "RESTAURANT";
    mocks.list.mockRejectedValue(new Error("permission denied"));
    renderAt("/restaurant", <OperationalProbe />);
    expect(await screen.findByText(/error:permission denied/)).toBeTruthy();
  });
});

const lifecycleOrder = (status: Order["status"]): Order => ({
  id: "order-1",
  number: "ZG-TEST",
  customer: { id: "customer-1", name: "Release Test", primaryPhone: "+998900000000" },
  type: "PICKUP",
  items: [{ id: "item-1", menuItemId: "plov", name: "Plov", unitPrice: 10000, quantity: 1, modifierIds: [], modifierNames: [], instructions: "", total: 10000 }],
  subtotal: 10000,
  deliveryFee: 0,
  total: 10000,
  paymentMethod: "CASH",
  paymentStatus: "PENDING",
  specialInstructions: "",
  status,
  createdAt: "2026-08-07T00:00:00.000Z",
  events: [],
  issues: [],
});

describe("restaurant lifecycle transition guard", () => {
  beforeEach(() => {
    mocks.session = { user: { id: "staff-1" } };
    mocks.role = "RESTAURANT";
  });

  it("disables the action and suppresses a rapid duplicate request for the same order", async () => {
    const order = lifecycleOrder("CONFIRMED");
    let resolveTransition!: () => void;
    mocks.list.mockResolvedValue(order ? [order] : []);
    mocks.get.mockResolvedValue(order);
    mocks.transition.mockImplementation(() => new Promise<void>((resolve) => { resolveTransition = resolve; }));
    renderAt(`/restaurant/orders/${order.id}`);

    const button = await screen.findByTestId("action-start-prep");
    fireEvent.click(button);
    await waitFor(() => expect(mocks.transition).toHaveBeenCalledOnce());
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.transition).toHaveBeenCalledOnce();
    resolveTransition();
  });

  it("clears pending state after success and exposes the next action after reconciliation", async () => {
    const confirmed = lifecycleOrder("CONFIRMED");
    const preparing = lifecycleOrder("PREPARING");
    mocks.list.mockResolvedValueOnce([confirmed]).mockResolvedValue([preparing]);
    mocks.get.mockResolvedValue(confirmed);
    mocks.transition.mockResolvedValue(undefined);
    renderAt(`/restaurant/orders/${confirmed.id}`);

    fireEvent.click(await screen.findByTestId("action-start-prep"));
    expect((await screen.findByTestId("action-mark-ready") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId("action-start-prep")).toBeNull();
  });

  it("clears pending state after failure so the action can be retried", async () => {
    const order = lifecycleOrder("CONFIRMED");
    mocks.list.mockResolvedValue([order]);
    mocks.get.mockResolvedValue(order);
    mocks.transition.mockRejectedValueOnce(new Error("transition failed"));
    renderAt(`/restaurant/orders/${order.id}`);

    const button = await screen.findByTestId("action-start-prep");
    fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(mocks.transition).toHaveBeenCalledOnce();
  });

  it("allows a different order to transition while the first order is pending", async () => {
    const first = lifecycleOrder("CONFIRMED");
    const second = { ...lifecycleOrder("CONFIRMED"), id: "order-2", number: "ZG-TEST-2" };
    let resolveFirst!: () => void;
    const pendingById = new Map<string, () => void>();
    mocks.list.mockResolvedValue([first, second]);
    mocks.get.mockImplementation(async (id: string) => id === first.id ? first : second);
    mocks.transition.mockImplementation(async (id: string) => new Promise<void>((resolve) => { pendingById.set(id, resolve); if (id === first.id) resolveFirst = resolve; }));
    function TwoOrdersProbe() {
      const { transition, transitionPending } = useApp();
      return <><button disabled={transitionPending(first.id)} onClick={() => void transition(first.id, "PREPARING", "RESTAURANT")}>first</button><button disabled={transitionPending(second.id)} onClick={() => void transition(second.id, "PREPARING", "RESTAURANT")}>second</button></>;
    }
    renderAt("/restaurant", <TwoOrdersProbe />);
    const firstButton = await screen.findByText("first");
    const secondButton = screen.getByText("second");
    fireEvent.click(firstButton);
    await waitFor(() => expect(mocks.transition).toHaveBeenCalledWith(first.id, "PREPARING", "RESTAURANT", undefined));
    expect((firstButton as HTMLButtonElement).disabled).toBe(true);
    expect((secondButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(secondButton);
    await waitFor(() => expect(mocks.transition).toHaveBeenCalledWith(second.id, "PREPARING", "RESTAURANT", undefined));
    resolveFirst();
    pendingById.get(second.id)?.();
  });

  it("keeps pickup and delivery action labels fulfillment-aware", async () => {
    const pickup = lifecycleOrder("PREPARING");
    mocks.list.mockResolvedValue([pickup]);
    mocks.get.mockResolvedValue(pickup);
    const rendered = renderAt(`/restaurant/orders/${pickup.id}`);
    expect((await screen.findByTestId("action-mark-ready")).textContent).toContain("Olib ketishga tayyor");
    rendered.unmount();

    const delivery = { ...pickup, type: "DELIVERY" as const, address: { customerName: "Release Test", primaryPhone: "+998900000000", district: "Navoiy", street: "Street", house: "1", landmark: "Landmark", deliveryNotes: "", latitude: 40, longitude: 65, confidence: "COMPLETE" as const, pinConfirmedAt: "2026-08-07T00:00:00.000Z", locationProvider: "mock" as const } };
    mocks.list.mockResolvedValue([delivery]);
    mocks.get.mockResolvedValue(delivery);
    renderAt(`/restaurant/orders/${delivery.id}`);
    expect((await screen.findByTestId("action-mark-ready")).textContent).toContain("Tayyor deb belgilash");
  });
});

const deliveryAddress = { customerName: "Release Test", primaryPhone: "+998900000000", district: "Navoiy", street: "Street", house: "1", landmark: "Landmark", deliveryNotes: "", latitude: 40, longitude: 65, confidence: "COMPLETE" as const, pinConfirmedAt: "2026-08-07T00:00:00.000Z", locationProvider: "mock" as const };
const deliveryOrder = (status: Order["status"], deliveryReviewStatus: Order["deliveryReviewStatus"]): Order => ({
  ...lifecycleOrder(status),
  type: "DELIVERY",
  deliveryReviewStatus,
  address: deliveryAddress,
});

describe("delivery address review and assignment guard (withOrderLock)", () => {
  beforeEach(() => {
    mocks.session = { user: { id: "staff-1" } };
    mocks.role = "RESTAURANT";
  });

  it("suppresses a rapid duplicate address approval, disables the button, and re-enables after success", async () => {
    const order = deliveryOrder("NEW", "REVIEW_REQUIRED");
    let resolveReview!: () => void;
    mocks.list.mockResolvedValueOnce([order]).mockResolvedValue([{ ...order, deliveryReviewStatus: "APPROVED" }]);
    mocks.get.mockResolvedValue(order);
    mocks.reviewDelivery.mockImplementation(() => new Promise<void>((resolve) => { resolveReview = resolve; }));
    renderAt(`/restaurant/orders/${order.id}`);

    const button = await screen.findByTestId("approve-delivery");
    expect(button.textContent).toContain("Manzilni tasdiqlash");
    fireEvent.click(button);
    await waitFor(() => expect(mocks.reviewDelivery).toHaveBeenCalledOnce());
    expect(mocks.reviewDelivery).toHaveBeenCalledWith(order.id, true, undefined);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.reviewDelivery).toHaveBeenCalledOnce();
    resolveReview();
    await waitFor(() => expect(screen.queryByTestId("delivery-review-required")).toBeNull());
    expect(await screen.findByTestId("delivery-review-approved")).toBeTruthy();
  });

  it("clears the lock after a failed approval and surfaces a visible, sanitized error", async () => {
    const order = deliveryOrder("NEW", "REVIEW_REQUIRED");
    mocks.list.mockResolvedValue([order]);
    mocks.get.mockResolvedValue(order);
    mocks.reviewDelivery.mockRejectedValueOnce(new Error("Yetkazishni tasdiqlab bo‘lmadi"));
    renderAt(`/restaurant/orders/${order.id}`);

    const button = await screen.findByTestId("approve-delivery");
    fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(mocks.reviewDelivery).toHaveBeenCalledOnce();
    expect((await screen.findByTestId("operational-error")).textContent).toContain("Yetkazishni tasdiqlab bo‘lmadi");
    // Retry is possible because the lock cleared.
    fireEvent.click(button);
    await waitFor(() => expect(mocks.reviewDelivery).toHaveBeenCalledTimes(2));
  });

  it("suppresses a rapid duplicate clarification request", async () => {
    const order = deliveryOrder("NEW", "REVIEW_REQUIRED");
    let resolveClarify!: () => void;
    mocks.list.mockResolvedValue([order]);
    mocks.get.mockResolvedValue(order);
    mocks.requestClarification.mockImplementation(() => new Promise<void>((resolve) => { resolveClarify = resolve; }));
    renderAt(`/restaurant/orders/${order.id}`);

    const input = (await screen.findByPlaceholderText("Aniqlashtirish yoki rad etish sababi")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Uy raqamini aniqlashtiring" } });
    const button = screen.getByTestId("request-clarification");
    fireEvent.click(button);
    await waitFor(() => expect(mocks.requestClarification).toHaveBeenCalledOnce());
    expect(mocks.requestClarification).toHaveBeenCalledWith(order.id, "Uy raqamini aniqlashtiring");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.requestClarification).toHaveBeenCalledOnce();
    resolveClarify();
  });

  it("suppresses a rapid duplicate terminal rejection", async () => {
    const order = deliveryOrder("NEW", "REVIEW_REQUIRED");
    let resolveReject!: () => void;
    mocks.list.mockResolvedValue([order]);
    mocks.get.mockResolvedValue(order);
    mocks.reviewDelivery.mockImplementation(() => new Promise<void>((resolve) => { resolveReject = resolve; }));
    renderAt(`/restaurant/orders/${order.id}`);

    const input = (await screen.findByPlaceholderText("Aniqlashtirish yoki rad etish sababi")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Hudud xizmat doirasidan tashqarida" } });
    const button = screen.getByTestId("reject-delivery");
    expect(button.textContent).toContain("Yetkazib bo‘lmaydi");
    fireEvent.click(button);
    await waitFor(() => expect(mocks.reviewDelivery).toHaveBeenCalledOnce());
    expect(mocks.reviewDelivery).toHaveBeenCalledWith(order.id, false, "Hudud xizmat doirasidan tashqarida");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.reviewDelivery).toHaveBeenCalledOnce();
    resolveReject();
  });

  it("suppresses a rapid duplicate driver assignment and re-enables after success", async () => {
    const order = deliveryOrder("READY", "APPROVED");
    const driver = { id: "driver-1", name: "Aziz", phone: "+998900000001", vehicle: "Spark", availability: "AVAILABLE" as const };
    let resolveAssign!: () => void;
    mocks.list.mockResolvedValue([order]);
    mocks.get.mockResolvedValue(order);
    mocks.listDrivers.mockResolvedValue([driver]);
    mocks.assign.mockImplementation(() => new Promise<void>((resolve) => { resolveAssign = resolve; }));
    renderAt(`/restaurant/orders/${order.id}`);

    const button = await screen.findByTestId(`assign-driver-${driver.id}`);
    fireEvent.click(button);
    await waitFor(() => expect(mocks.assign).toHaveBeenCalledOnce());
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.assign).toHaveBeenCalledOnce();
    resolveAssign();
  });

  it("keeps an unrelated order actionable while one order is pending an address approval", async () => {
    const first = deliveryOrder("NEW", "REVIEW_REQUIRED");
    const second = { ...deliveryOrder("NEW", "REVIEW_REQUIRED"), id: "order-2", number: "ZG-TEST-2" };
    let resolveFirst!: () => void;
    mocks.list.mockResolvedValue([first, second]);
    mocks.get.mockImplementation(async (id: string) => (id === first.id ? first : second));
    mocks.reviewDelivery.mockImplementation(async (id: string) => new Promise<void>((resolve) => { if (id === first.id) resolveFirst = resolve; else resolve(); }));
    function TwoOrdersProbe() {
      const { reviewDelivery, transitionPending } = useApp();
      return <><button data-testid="approve-first" disabled={transitionPending(first.id)} onClick={() => void reviewDelivery(first.id, true)}>first</button><button data-testid="approve-second" disabled={transitionPending(second.id)} onClick={() => void reviewDelivery(second.id, true)}>second</button></>;
    }
    renderAt("/restaurant", <TwoOrdersProbe />);
    const firstButton = await screen.findByTestId("approve-first");
    const secondButton = screen.getByTestId("approve-second");
    fireEvent.click(firstButton);
    await waitFor(() => expect(mocks.reviewDelivery).toHaveBeenCalledWith(first.id, true, undefined));
    expect((firstButton as HTMLButtonElement).disabled).toBe(true);
    expect((secondButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(secondButton);
    await waitFor(() => expect(mocks.reviewDelivery).toHaveBeenCalledWith(second.id, true, undefined));
    resolveFirst();
  });
});

describe("waiting-on-customer state isolates restaurant actions", () => {
  beforeEach(() => {
    mocks.session = { user: { id: "staff-1" } };
    mocks.role = "RESTAURANT";
  });

  it("hides the review panel's actions and disables order confirmation while awaiting the customer", async () => {
    const order = deliveryOrder("NEW", "CLARIFICATION_REQUESTED");
    mocks.list.mockResolvedValue([order]);
    mocks.get.mockResolvedValue(order);
    renderAt(`/restaurant/orders/${order.id}`);

    expect(await screen.findByTestId("delivery-review-clarification-pending")).toBeTruthy();
    expect(screen.queryByTestId("delivery-review-required")).toBeNull();
    expect(screen.queryByTestId("approve-delivery")).toBeNull();
    expect(screen.queryByTestId("request-clarification")).toBeNull();
    expect(screen.queryByTestId("reject-delivery")).toBeNull();
    expect(screen.queryByTestId(/^assign-driver-/)).toBeNull();

    const confirmButton = screen.getByTestId("action-confirm") as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    fireEvent.click(confirmButton);
    expect(mocks.transition).not.toHaveBeenCalled();

    expect(screen.getByTestId("contact-customer").getAttribute("href")).toBe(`tel:${order.customer.primaryPhone}`);
  });
});

describe("resubmitted-address cue on the review panel", () => {
  beforeEach(() => {
    mocks.session = { user: { id: "staff-1" } };
    mocks.role = "RESTAURANT";
  });

  it("does not show for a brand-new order's first review", async () => {
    const order = { ...deliveryOrder("NEW", "REVIEW_REQUIRED"), events: [{ id: "e1", orderId: "order-1", actorType: "CUSTOMER" as const, actorId: "guest", previousStatus: null, newStatus: "NEW" as const, timestamp: "2026-08-08T00:00:00.000Z" }] };
    mocks.list.mockResolvedValue([order]);
    mocks.get.mockResolvedValue(order);
    renderAt(`/restaurant/orders/${order.id}`);

    await screen.findByTestId("delivery-review-required");
    expect(screen.queryByTestId("address-resubmitted-cue")).toBeNull();
  });

  it("shows once the customer has revised after a clarification request", async () => {
    const order = {
      ...deliveryOrder("NEW", "REVIEW_REQUIRED"),
      events: [
        { id: "e1", orderId: "order-1", actorType: "CUSTOMER" as const, actorId: "guest", previousStatus: null, newStatus: "NEW" as const, timestamp: "2026-08-08T00:00:00.000Z" },
        { id: "e2", orderId: "order-1", actorType: "RESTAURANT" as const, actorId: "staff-1", previousStatus: "NEW" as const, newStatus: "NEW" as const, timestamp: "2026-08-08T00:01:00.000Z", notes: "DELIVERY_CLARIFICATION_REQUESTED" },
        { id: "e3", orderId: "order-1", actorType: "CUSTOMER" as const, actorId: "guest", previousStatus: "NEW" as const, newStatus: "NEW" as const, timestamp: "2026-08-08T00:02:00.000Z", notes: "DELIVERY_ADDRESS_REVISED" },
      ],
    };
    mocks.list.mockResolvedValue([order]);
    mocks.get.mockResolvedValue(order);
    renderAt(`/restaurant/orders/${order.id}`);

    expect((await screen.findByTestId("address-resubmitted-cue")).textContent).toContain("Manzil yangilandi");
  });
});

describe("pickup isolation from delivery review UI", () => {
  beforeEach(() => {
    mocks.session = { user: { id: "staff-1" } };
    mocks.role = "RESTAURANT";
  });

  it("never shows a delivery review badge or waiting-customer styling on a pickup card, even with a stray review status", async () => {
    const pickup = { ...lifecycleOrder("NEW"), id: "pickup-1", type: "PICKUP" as const, deliveryReviewStatus: "CLARIFICATION_REQUESTED" as const };
    mocks.list.mockResolvedValue([pickup]);
    renderAt("/restaurant");

    const card = await screen.findByTestId(`order-card-${pickup.id}`);
    expect(card.className).not.toContain("waiting-customer");
    expect(within(card).queryByTestId(`review-state-${pickup.id}`)).toBeNull();
  });

  it("does not gate pickup order confirmation on delivery review status", async () => {
    const pickup = { ...lifecycleOrder("NEW"), type: "PICKUP" as const };
    mocks.list.mockResolvedValue([pickup]);
    mocks.get.mockResolvedValue(pickup);
    mocks.transition.mockResolvedValue(undefined);
    renderAt(`/restaurant/orders/${pickup.id}`);

    const confirmButton = (await screen.findByTestId("action-confirm")) as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(false);
    fireEvent.click(confirmButton);
    await waitFor(() => expect(mocks.transition).toHaveBeenCalledOnce());
  });

  it("shows no delivery-review panel, clarification panel, or address badge for pickup", async () => {
    const pickup = { ...lifecycleOrder("NEW"), type: "PICKUP" as const };
    mocks.list.mockResolvedValue([pickup]);
    mocks.get.mockResolvedValue(pickup);
    renderAt(`/restaurant/orders/${pickup.id}`);

    await screen.findByTestId("action-confirm");
    expect(screen.queryByTestId("delivery-review-required")).toBeNull();
    expect(screen.queryByTestId("delivery-review-clarification-pending")).toBeNull();
    expect(screen.queryByTestId("delivery-review-approved")).toBeNull();
  });
});

const assignedDelivery = (status: Order["status"], extra: Partial<Order> = {}): Order => ({
  ...deliveryOrder(status, "APPROVED"),
  id: "assigned-1",
  assignedDriverId: "driver-1",
  ...extra,
});

describe("driver work surface: Keyingi yetkazish removed, active assignment preserved", () => {
  beforeEach(() => {
    mocks.session = { user: { id: "driver-1" } };
    mocks.role = "DRIVER";
  });

  it("never shows a 'next delivery' preview, even if another ready order is present in state", async () => {
    const active = assignedDelivery("DRIVER_ASSIGNED", { assignmentAcceptedAt: "2026-08-09T00:00:00.000Z" });
    // Real RLS would never return this to a driver at all; included defensively
    // to prove the removed preview cannot resurface even from stray client state.
    const otherReady = { ...deliveryOrder("READY", "APPROVED"), id: "other-ready" };
    mocks.list.mockResolvedValue([active, otherReady]);
    renderAt("/driver");

    await screen.findByTestId("driver-primary-action");
    expect(screen.queryByText(/Keyingi yetkazish/i)).toBeNull();
    expect(document.querySelector(".next-card")).toBeNull();
  });

  it("shows no active-delivery card and no crash when nothing is assigned", async () => {
    mocks.list.mockResolvedValue([]);
    renderAt("/driver");
    expect(await screen.findByTestId("driver-no-active")).toBeTruthy();
  });

  it("requires explicit acceptance before progressing, then walks PICKED_UP -> ON_THE_WAY -> ARRIVED -> DELIVERED", async () => {
    const assigned = assignedDelivery("DRIVER_ASSIGNED");
    const accepted = { ...assigned, assignmentAcceptedAt: "2026-08-09T00:00:00.000Z" };
    const pickedUp = { ...accepted, status: "PICKED_UP" as const };
    const onTheWay = { ...accepted, status: "ON_THE_WAY" as const };
    const arrived = { ...accepted, status: "ARRIVED" as const };
    mocks.list
      .mockResolvedValueOnce([assigned])
      .mockResolvedValueOnce([accepted])
      .mockResolvedValueOnce([pickedUp])
      .mockResolvedValueOnce([onTheWay])
      .mockResolvedValue([arrived]);
    mocks.acceptAssignment.mockResolvedValue(undefined);
    mocks.transition.mockResolvedValue(undefined);
    mocks.get.mockResolvedValue(accepted);
    renderAt("/driver");

    expect((await screen.findByTestId("driver-primary-action")).textContent).toContain("Topshiriqni qabul qilish");
    fireEvent.click(screen.getByTestId("driver-primary-action"));
    await waitFor(() => expect(mocks.acceptAssignment).toHaveBeenCalledWith("assigned-1"));

    expect((await screen.findByTestId("driver-primary-action")).textContent).toContain("Olib ketdim");
    fireEvent.click(screen.getByTestId("driver-primary-action"));
    await waitFor(() => expect(mocks.transition).toHaveBeenCalledWith("assigned-1", "PICKED_UP", "DRIVER", undefined));

    expect((await screen.findByTestId("driver-primary-action")).textContent).toContain("Yo‘lga chiqdim");
    fireEvent.click(screen.getByTestId("driver-primary-action"));
    await waitFor(() => expect(mocks.transition).toHaveBeenCalledWith("assigned-1", "ON_THE_WAY", "DRIVER", undefined));

    expect((await screen.findByTestId("driver-primary-action")).textContent).toContain("Yetib keldim");
    fireEvent.click(screen.getByTestId("driver-primary-action"));
    await waitFor(() => expect(mocks.transition).toHaveBeenCalledWith("assigned-1", "ARRIVED", "DRIVER", undefined));

    expect((await screen.findByTestId("driver-primary-action")).textContent).toContain("Yetkazildi");
  });

  it("keeps issue-reporting and delivery-failed actions available as before", async () => {
    const order = assignedDelivery("ON_THE_WAY", { assignmentAcceptedAt: "2026-08-09T00:00:00.000Z" });
    mocks.list.mockResolvedValue([order]);
    renderAt("/driver");

    await screen.findByTestId("driver-primary-action");
    fireEvent.click(screen.getByTestId("driver-report-issue-toggle"));
    expect(screen.getByTestId("driver-report-issue-submit")).toBeTruthy();
    expect(screen.getByTestId("driver-mark-failed")).toBeTruthy();
  });

  it("pickup never renders in the driver work surface, even defensively if state contained an assigned pickup order", async () => {
    // assign_driver rejects PICKUP orders server-side (Phase A pgTAP), so this
    // can't happen for real; DriverApp's active-order finder now also filters
    // by type as a defense-in-depth check independent of that backend guarantee.
    const pickup = { ...lifecycleOrder("DRIVER_ASSIGNED" as OrderStatus), assignedDriverId: "driver-1" };
    mocks.list.mockResolvedValue([pickup]);
    renderAt("/driver");

    expect(await screen.findByTestId("driver-no-active")).toBeTruthy();
    expect(screen.queryByTestId("driver-primary-action")).toBeNull();
  });
});

describe("acceptAssignment duplicate-interaction guard", () => {
  beforeEach(() => {
    mocks.session = { user: { id: "driver-1" } };
    mocks.role = "DRIVER";
  });

  it("suppresses a rapid duplicate accept, disables the button, and re-enables after success", async () => {
    const assigned = assignedDelivery("DRIVER_ASSIGNED");
    const accepted = { ...assigned, assignmentAcceptedAt: "2026-08-09T00:00:00.000Z" };
    let resolveAccept!: () => void;
    mocks.list.mockResolvedValueOnce([assigned]).mockResolvedValue([accepted]);
    mocks.acceptAssignment.mockImplementation(() => new Promise<void>((resolve) => { resolveAccept = resolve; }));
    renderAt("/driver");

    const button = await screen.findByTestId("driver-primary-action");
    fireEvent.click(button);
    await waitFor(() => expect(mocks.acceptAssignment).toHaveBeenCalledOnce());
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.acceptAssignment).toHaveBeenCalledOnce();
    resolveAccept();
    expect(await screen.findByText("Olib ketdim")).toBeTruthy();
  });

  it("clears the lock after a failed accept, surfaces a visible error, and allows a retry", async () => {
    const assigned = assignedDelivery("DRIVER_ASSIGNED");
    mocks.list.mockResolvedValue([assigned]);
    mocks.acceptAssignment.mockRejectedValueOnce(new Error("Topshiriqni qabul qilib bo‘lmadi"));
    renderAt("/driver");

    const button = await screen.findByTestId("driver-primary-action");
    fireEvent.click(button);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(mocks.acceptAssignment).toHaveBeenCalledOnce();
    expect(await screen.findByText("Topshiriqni qabul qilib bo‘lmadi")).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(mocks.acceptAssignment).toHaveBeenCalledTimes(2));
  });
});

describe("identifier-based sign-in (email or Uzbek phone)", () => {
  const submitLogin = async (identifier: string, password = "zaytun-local-2026") => {
    renderAt("/restaurant");
    fireEvent.change(await screen.findByLabelText("Telefon yoki email"), { target: { value: identifier } });
    fireEvent.change(screen.getByLabelText("Parol"), { target: { value: password } });
    fireEvent.click(screen.getByRole("button", { name: "Kirish" }));
  };

  it("signs in with email exactly as before, unchanged", async () => {
    await submitLogin("restaurant@zaytun.local");
    await waitFor(() => expect(mocks.signInWithPassword).toHaveBeenCalledOnce());
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({ email: "restaurant@zaytun.local", password: "zaytun-local-2026" });
  });

  it.each([
    ["90 123 45 67"],
    ["901234567"],
    ["998901234567"],
    ["+998901234567"],
    ["90-123-45-67"],
  ])("normalizes phone input %s to the canonical '+998...' Supabase phone param", async (identifier) => {
    await submitLogin(identifier);
    await waitFor(() => expect(mocks.signInWithPassword).toHaveBeenCalledOnce());
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({ phone: "+998901234567", password: "zaytun-local-2026" });
  });

  it("rejects a too-short number without calling Supabase", async () => {
    await submitLogin("12345");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it("does not silently treat arbitrary non-phone, non-email text as a phone number", async () => {
    await submitLogin("not-a-phone");
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it("does not mutate the profile role based on the login method used", async () => {
    mocks.role = "RESTAURANT";
    await submitLogin("+998901234567");
    await waitFor(() => expect(mocks.signInWithPassword).toHaveBeenCalledOnce());
    // Role is only ever read from the mocked profiles select, never derived
    // from the identifier the user typed; a phone-based sign-in call cannot
    // by itself grant any role.
    expect(mocks.signInWithPassword).toHaveBeenCalledWith({ phone: "+998901234567", password: "zaytun-local-2026" });
  });
});

describe("role gate is independent of auth method", () => {
  it("blocks a DRIVER-role session from the restaurant surface", async () => {
    mocks.session = { user: { id: "driver-1" } };
    mocks.role = "DRIVER";
    renderAt("/restaurant");
    expect(await screen.findByRole("heading", { name: "Ruxsat yo‘q" })).toBeTruthy();
  });

  it("blocks a RESTAURANT-role session from the driver surface", async () => {
    mocks.session = { user: { id: "staff-1" } };
    mocks.role = "RESTAURANT";
    renderAt("/driver");
    expect(await screen.findByRole("heading", { name: "Ruxsat yo‘q" })).toBeTruthy();
  });
});

function CustomerAuthProbe() {
  const { isCustomerAuthenticated, authReady, authError } = useApp();
  return (
    <div>
      <div data-testid="customer-auth-state">{!authReady ? "loading" : isCustomerAuthenticated ? "yes" : "no"}</div>
      {authError && <div data-testid="probe-auth-error">{authError}</div>}
    </div>
  );
}

describe("isVerifiedCustomerSession (frontend customer-session predicate)", () => {
  const sessionWith = (phone?: string, phone_confirmed_at?: string) => ({ user: { phone, phone_confirmed_at } });

  it("role-less + confirmed valid Uzbek phone -> customer", () => {
    expect(isVerifiedCustomerSession(sessionWith("998901234567", "2026-08-10T00:00:00.000Z"), null)).toBe(true);
  });

  it("role-less + no phone -> not customer", () => {
    expect(isVerifiedCustomerSession(sessionWith(undefined, "2026-08-10T00:00:00.000Z"), null)).toBe(false);
  });

  it("role-less + unconfirmed phone -> not customer", () => {
    expect(isVerifiedCustomerSession(sessionWith("998901234567", undefined), null)).toBe(false);
  });

  it("role-less + malformed/non-Uzbek phone -> not customer", () => {
    expect(isVerifiedCustomerSession(sessionWith("15551234567", "2026-08-10T00:00:00.000Z"), null)).toBe(false);
    expect(isVerifiedCustomerSession(sessionWith("not-a-phone", "2026-08-10T00:00:00.000Z"), null)).toBe(false);
  });

  it.each(["RESTAURANT", "DISPATCHER", "DRIVER"] as const)("%s session -> never customer, even with a confirmed valid Uzbek phone", (role) => {
    expect(isVerifiedCustomerSession(sessionWith("998901234567", "2026-08-10T00:00:00.000Z"), role)).toBe(false);
  });

  it("no session -> not customer", () => {
    expect(isVerifiedCustomerSession(null, null)).toBe(false);
  });
});

describe("mapCustomerAuthError (clean Uzbek messages for GoTrue's stable error codes)", () => {
  it("maps captcha_failed to a clean Uzbek message, not a raw Supabase dump", () => {
    const message = mapCustomerAuthError({ code: "captcha_failed" }, "send");
    expect(message).toBe("Robot emasligingizni tasdiqlab bo‘lmadi. Sahifani yangilab, qaytadan urinib ko‘ring.");
  });

  it("maps rate-limit codes to the same throttling message regardless of send/verify context", () => {
    expect(mapCustomerAuthError({ code: "over_sms_send_rate_limit" }, "send")).toContain("Juda ko‘p urinish");
    expect(mapCustomerAuthError({ status: 429 }, "verify")).toContain("Juda ko‘p urinish");
  });

  it("falls back to a generic service message for an unrecognized code", () => {
    expect(mapCustomerAuthError({ code: "some_new_unmapped_code" }, "send")).toContain("Xizmat bilan bog‘lanib bo‘lmadi");
  });
});

describe("customer phone-OTP session (no profiles row required)", () => {
  it("resolves a role-less session with a confirmed Uzbek phone to isCustomerAuthenticated=true without a staff-role error", async () => {
    mocks.session = { user: { id: "customer-1", phone: "998901234567", phone_confirmed_at: "2026-08-10T00:00:00.000Z" } };
    mocks.role = null;
    renderAt("/checkout", <CustomerAuthProbe />);
    expect(await screen.findByText("yes")).toBeTruthy();
    expect(screen.queryByTestId("probe-auth-error")).toBeNull();
  });

  it("does not resolve isCustomerAuthenticated for a role-less session with no phone on it", async () => {
    mocks.session = { user: { id: "customer-1" } };
    mocks.role = null;
    renderAt("/checkout", <CustomerAuthProbe />);
    expect(await screen.findByText("no")).toBeTruthy();
  });

  it("does not resolve isCustomerAuthenticated for a staff session, even with a confirmed Uzbek phone on it", async () => {
    mocks.session = { user: { id: "staff-1", phone: "998901234567", phone_confirmed_at: "2026-08-10T00:00:00.000Z" } };
    mocks.role = "RESTAURANT";
    renderAt("/checkout", <CustomerAuthProbe />);
    expect(await screen.findByText("no")).toBeTruthy();
  });

  it("stays isCustomerAuthenticated=false with no session at all", async () => {
    mocks.session = null;
    renderAt("/checkout", <CustomerAuthProbe />);
    expect(await screen.findByText("no")).toBeTruthy();
  });

  it("a role-less session cannot reach /restaurant or /driver and does not crash", async () => {
    mocks.session = { user: { id: "customer-1", phone: "998901234567", phone_confirmed_at: "2026-08-10T00:00:00.000Z" } };
    mocks.role = null;
    renderAt("/restaurant");
    expect(await screen.findByRole("heading", { name: "Ruxsat yo‘q" })).toBeTruthy();

    mocks.session = { user: { id: "customer-1", phone: "998901234567", phone_confirmed_at: "2026-08-10T00:00:00.000Z" } };
    mocks.role = null;
    renderAt("/driver");
    expect(await screen.findByRole("heading", { name: "Ruxsat yo‘q" })).toBeTruthy();
  });
});

function CustomerOtpProbe() {
  const { sendCustomerOtp, verifyCustomerOtp } = useApp();
  return (
    <div>
      <button onClick={() => void sendCustomerOtp("901234567").catch(() => {})}>send</button>
      <button onClick={() => void sendCustomerOtp("901234567", "fake-turnstile-token").catch(() => {})}>send-with-captcha</button>
      <button onClick={() => void verifyCustomerOtp("+998901234567", "111111").catch(() => {})}>verify</button>
    </div>
  );
}

describe("customer phone-OTP actions (sendCustomerOtp / verifyCustomerOtp)", () => {
  it("sends the normalized phone via signInWithOtp, not signInWithPassword", async () => {
    renderAt("/checkout", <CustomerOtpProbe />);
    fireEvent.click(await screen.findByText("send"));
    await waitFor(() => expect(mocks.signInWithOtp).toHaveBeenCalledWith({ phone: "+998901234567" }));
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it("forwards a captchaToken as options.captchaToken when the caller provides one", async () => {
    renderAt("/checkout", <CustomerOtpProbe />);
    fireEvent.click(await screen.findByText("send-with-captcha"));
    await waitFor(() =>
      expect(mocks.signInWithOtp).toHaveBeenCalledWith({
        phone: "+998901234567",
        options: { captchaToken: "fake-turnstile-token" },
      }),
    );
  });

  it("omits options entirely (not options:{captchaToken:undefined}) when no token is provided", async () => {
    renderAt("/checkout", <CustomerOtpProbe />);
    fireEvent.click(await screen.findByText("send"));
    await waitFor(() => expect(mocks.signInWithOtp).toHaveBeenCalledOnce());
    const call = mocks.signInWithOtp.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(call, "options")).toBe(false);
  });

  it("verifies via verifyOtp with type sms, then resolves the canonical customer record", async () => {
    renderAt("/checkout", <CustomerOtpProbe />);
    fireEvent.click(await screen.findByText("verify"));
    await waitFor(() => expect(mocks.verifyOtp).toHaveBeenCalledWith({ phone: "+998901234567", token: "111111", type: "sms" }));
    await waitFor(() => expect(mocks.ensureCurrentCustomer).toHaveBeenCalledOnce());
  });

  it("does not call ensureCurrentCustomer when verification fails", async () => {
    mocks.verifyOtp.mockResolvedValueOnce({ data: { session: null }, error: { code: "otp_expired", message: "Token has expired" } });
    renderAt("/checkout", <CustomerOtpProbe />);
    fireEvent.click(await screen.findByText("verify"));
    await waitFor(() => expect(mocks.verifyOtp).toHaveBeenCalledOnce());
    expect(mocks.ensureCurrentCustomer).not.toHaveBeenCalled();
  });

  it("rejects, signs the failed attempt's session out, and never finalizes customer auth state when canonical customer resolution fails after a successful OTP verify", async () => {
    // GoTrue verification succeeds (verifyOtp resolves with a session), but
    // Zaytun's own customer resolution rejects it (e.g. CUSTOMER_PHONE_CONFLICT).
    // This is exactly the half-authenticated scenario the sequencing fix
    // guards against: Supabase would have a CUSTOMER-looking session while
    // no valid Zaytun customer backs it.
    mocks.ensureCurrentCustomer.mockRejectedValueOnce(new Error("Bu telefon raqami allaqachon boshqa hisobga bog‘langan"));
    let caught: unknown;
    function FailingVerifyProbe() {
      const { verifyCustomerOtp, isCustomerAuthenticated } = useApp();
      return (
        <div>
          <div data-testid="auth-state">{isCustomerAuthenticated ? "yes" : "no"}</div>
          <button
            onClick={() =>
              void verifyCustomerOtp("+998901234567", "111111").catch((error: unknown) => {
                caught = error;
              })
            }
          >
            verify
          </button>
        </div>
      );
    }
    renderAt("/checkout", <FailingVerifyProbe />);
    fireEvent.click(await screen.findByText("verify"));

    // Error is shown (surfaced to the caller).
    await waitFor(() => expect(caught).toBeInstanceOf(Error));
    expect((caught as Error).message).toContain("boshqa hisobga bog‘langan");

    // The session GoTrue just established for this failed attempt is torn
    // down -- never left dangling as a half-signed-in customer session.
    await waitFor(() => expect(mocks.ensureCurrentCustomer).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledOnce());

    // Customer is never considered authenticated -- no half-authenticated
    // window, not even momentarily (applySession is never reached).
    expect(screen.getByTestId("auth-state").textContent).toBe("no");
  });
});

function DriverOtpProbe() {
  const { sendDriverOtp, verifyDriverOtp } = useApp();
  return (
    <div>
      <button onClick={() => void sendDriverOtp("901234567").catch(() => {})}>driver-send</button>
      <button onClick={() => void verifyDriverOtp("+998901234567", "222222").catch(() => {})}>driver-verify</button>
    </div>
  );
}

describe("driver phone-OTP actions (sendDriverOtp / verifyDriverOtp)", () => {
  it("sends via signInWithOtp with shouldCreateUser:false -- never signInWithPassword, never a create-user OTP", async () => {
    renderAt("/checkout", <DriverOtpProbe />);
    fireEvent.click(await screen.findByText("driver-send"));
    await waitFor(() =>
      expect(mocks.signInWithOtp).toHaveBeenCalledWith({
        phone: "+998901234567",
        options: { shouldCreateUser: false },
      }),
    );
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it("verifies via verifyOtp with type sms, same as the customer flow", async () => {
    renderAt("/checkout", <DriverOtpProbe />);
    fireEvent.click(await screen.findByText("driver-verify"));
    await waitFor(() => expect(mocks.verifyOtp).toHaveBeenCalledWith({ phone: "+998901234567", token: "222222", type: "sms" }));
  });
});

describe("driver phone-OTP login flow (UI, /driver)", () => {
  // Password login stays the default view (the pre-existing, real-world
  // path -- see e2e/auth-local.spec.ts); OTP is reached via an explicit
  // toggle, never the initial render.
  const switchToOtp = async () => fireEvent.click(await screen.findByTestId("driver-otp-switch"));

  it("password login remains the default view on /driver, unchanged", async () => {
    renderAt("/driver");
    expect(await screen.findByLabelText("Telefon yoki email")).toBeTruthy();
    expect(await screen.findByLabelText("Parol")).toBeTruthy();
  });

  it("A/B: a provisioned DRIVER phone can start the OTP login path with shouldCreateUser:false", async () => {
    renderAt("/driver");
    await switchToOtp();
    fireEvent.change(await screen.findByLabelText("Telefon raqamingiz"), { target: { value: "901234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Kod yuborish" }));
    await waitFor(() =>
      expect(mocks.signInWithOtp).toHaveBeenCalledWith({
        phone: "+998901234567",
        options: { shouldCreateUser: false },
      }),
    );
    expect(await screen.findByLabelText("Tasdiqlash kodi")).toBeTruthy();
  });

  it("C: routes a provisioned DRIVER phone to /driver after OTP verification, exactly like password-based driver sign-in", async () => {
    mocks.role = "DRIVER";
    renderAt("/driver");
    await switchToOtp();
    fireEvent.change(await screen.findByLabelText("Telefon raqamingiz"), { target: { value: "901234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Kod yuborish" }));
    await waitFor(() => expect(mocks.signInWithOtp).toHaveBeenCalledOnce());
    fireEvent.change(await screen.findByLabelText("Tasdiqlash kodi"), { target: { value: "222222" } });
    fireEvent.click(screen.getByRole("button", { name: "Kirish" }));
    await waitFor(() => expect(mocks.verifyOtp).toHaveBeenCalledOnce());
    // Real GoTrue fires onAuthStateChange internally the instant verifyOtp
    // establishes a session; this hand-rolled test double doesn't do that
    // automatically, so simulate it explicitly, same as production.
    mocks.session = { user: { id: "driver-otp-1" } };
    await waitFor(() => expect(mocks.authCallback).toBeTruthy());
    mocks.authCallback!("SIGNED_IN", mocks.session);
    expect(await screen.findByText("Bugungi yetkazish")).toBeTruthy();
  });

  it("D: an OTP-authenticated session with no DRIVER role is denied /driver (same role gate as password sign-in)", async () => {
    mocks.role = "RESTAURANT";
    renderAt("/driver");
    await switchToOtp();
    fireEvent.change(await screen.findByLabelText("Telefon raqamingiz"), { target: { value: "901234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Kod yuborish" }));
    await waitFor(() => expect(mocks.signInWithOtp).toHaveBeenCalledOnce());
    fireEvent.change(await screen.findByLabelText("Tasdiqlash kodi"), { target: { value: "222222" } });
    fireEvent.click(screen.getByRole("button", { name: "Kirish" }));
    await waitFor(() => expect(mocks.verifyOtp).toHaveBeenCalledOnce());
    mocks.session = { user: { id: "non-driver-otp-1" } };
    await waitFor(() => expect(mocks.authCallback).toBeTruthy());
    mocks.authCallback!("SIGNED_IN", mocks.session);
    expect(await screen.findByRole("heading", { name: "Ruxsat yo‘q" })).toBeTruthy();
  });

  it("E: an unrecognized phone is refused via otp_disabled before any code is ever sent -- never becomes a DRIVER", async () => {
    mocks.signInWithOtp.mockResolvedValueOnce({ error: { code: "otp_disabled", message: "Signups not allowed for otp" } });
    renderAt("/driver");
    await switchToOtp();
    fireEvent.change(await screen.findByLabelText("Telefon raqamingiz"), { target: { value: "901234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Kod yuborish" }));
    await waitFor(() => expect(mocks.signInWithOtp).toHaveBeenCalledOnce());
    expect((await screen.findByTestId("driver-otp-error")).textContent).toBe("Bu raqam kuryer sifatida ro‘yxatga olinmagan.");
    expect(screen.queryByLabelText("Tasdiqlash kodi")).toBeNull();
    expect(mocks.verifyOtp).not.toHaveBeenCalled();
  });

  it("disables resend and shows a cooldown after a successful send, preventing obvious resend hammering", async () => {
    renderAt("/driver");
    await switchToOtp();
    fireEvent.change(await screen.findByLabelText("Telefon raqamingiz"), { target: { value: "901234567" } });
    fireEvent.click(screen.getByRole("button", { name: "Kod yuborish" }));
    await waitFor(() => expect(mocks.signInWithOtp).toHaveBeenCalledOnce());
    const resendButton = await screen.findByTestId("driver-otp-resend");
    expect((resendButton as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("mapDriverAuthError (clean Uzbek messages for GoTrue's stable error codes)", () => {
  it("maps otp_disabled to the closed-enrollment message for an unrecognized phone", () => {
    expect(mapDriverAuthError({ code: "otp_disabled" }, "send")).toBe("Bu raqam kuryer sifatida ro‘yxatga olinmagan.");
  });
  it("maps rate-limit codes to the same throttling message regardless of send/verify context", () => {
    expect(mapDriverAuthError({ code: "over_sms_send_rate_limit" }, "send")).toBe(
      mapDriverAuthError({ status: 429 }, "verify"),
    );
  });
  it("falls back to a generic service message for an unrecognized code", () => {
    expect(mapDriverAuthError({ code: "something_new" }, "send")).toBe(
      "Xizmat bilan bog‘lanib bo‘lmadi. Internetni tekshirib, qayta urinib ko‘ring.",
    );
  });
});
