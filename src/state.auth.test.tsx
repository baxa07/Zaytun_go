import { render, screen, waitFor } from "@testing-library/react";
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
    transition: vi.fn(),
    assign: vi.fn(),
    acceptAssignment: vi.fn(),
    setEstimate: vi.fn(),
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
