import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { AppProvider, useApp, type AppRole } from "./state";
import type { Order, RestaurantConfig } from "./domain";

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
  session: null as { user: { id: string } } | null,
  role: null as AppRole | null,
  list: vi.fn<() => Promise<Order[]>>(),
  listDrivers: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  get: vi.fn(),
  save: vi.fn(),
  transition: vi.fn(),
  assign: vi.fn(),
  reviewDelivery: vi.fn(),
  requestClarification: vi.fn(),
  authCallback: null as ((event: string, session: unknown) => void) | null,
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
    acceptAssignment: vi.fn(),
    setEstimate: vi.fn(),
    reviewDelivery: mocks.reviewDelivery,
    requestClarification: mocks.requestClarification,
    reportIssue: vi.fn(),
    resolveIssue: vi.fn(),
    saveDriver: vi.fn(),
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
      signInWithPassword: vi.fn(async () => ({ error: null })),
      signOut: vi.fn(async () => ({ error: null })),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          single: vi.fn(async () => ({ data: { role: mocks.role }, error: null })),
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
  mocks.list.mockReset().mockResolvedValue([]);
  mocks.listDrivers.mockReset().mockResolvedValue([]);
  mocks.transition.mockReset();
  mocks.assign.mockReset();
  mocks.reviewDelivery.mockReset();
  mocks.requestClarification.mockReset();
  mocks.get.mockReset();
  mocks.subscribe.mockClear();
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
