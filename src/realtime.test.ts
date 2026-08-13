import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ supabase: null as unknown }));

vi.mock("./supabase", () => ({
  get supabase() {
    return mocks.supabase;
  },
}));

function fakeChannel() {
  const onHandlers: Array<{ event: string; filter: { event: string }; callback: () => void }> = [];
  let statusCallback: ((status: string) => void) | undefined;
  const channel = {
    on: vi.fn((event: string, filter: { event: string }, callback: () => void) => {
      onHandlers.push({ event, filter, callback });
      return channel;
    }),
    subscribe: vi.fn((callback: (status: string) => void) => {
      statusCallback = callback;
      return channel;
    }),
  };
  return {
    channel,
    fireBroadcast: (event: string) => onHandlers.find((h) => h.filter.event === event)?.callback(),
    fireStatus: (status: string) => statusCallback?.(status),
  };
}

function fakeSupabase() {
  const created = fakeChannel();
  const removeChannel = vi.fn();
  return {
    supabase: {
      channel: vi.fn(() => created.channel),
      removeChannel,
    },
    created,
    removeChannel,
  };
}

describe("subscribeToBroadcast / subscribeToOrderTracking", () => {
  afterEach(() => {
    mocks.supabase = null;
    vi.resetModules();
  });

  it("returns a no-op unsubscribe when supabase is not configured, without throwing", async () => {
    mocks.supabase = null;
    const { subscribeToBroadcast } = await import("./realtime");
    const onSignal = vi.fn();
    const unsubscribe = subscribeToBroadcast("topic", "event", onSignal);
    expect(() => unsubscribe()).not.toThrow();
    expect(onSignal).not.toHaveBeenCalled();
  });

  it("subscribes to the given topic/event and invokes onSignal when the broadcast event fires", async () => {
    const { supabase, created } = fakeSupabase();
    mocks.supabase = supabase;
    const { subscribeToBroadcast } = await import("./realtime");
    const onSignal = vi.fn();
    subscribeToBroadcast("my-topic", "order_changed", onSignal);
    expect(supabase.channel).toHaveBeenCalledWith("my-topic", { config: { broadcast: { self: false } } });
    created.fireBroadcast("order_changed");
    expect(onSignal).toHaveBeenCalledTimes(1);
  });

  it("invokes onSignal when the channel (re)enters SUBSCRIBED -- covers both initial connect and reconnect with one code path", async () => {
    const { supabase, created } = fakeSupabase();
    mocks.supabase = supabase;
    const { subscribeToBroadcast } = await import("./realtime");
    const onSignal = vi.fn();
    subscribeToBroadcast("t", "e", onSignal);
    created.fireStatus("SUBSCRIBED");
    created.fireStatus("CHANNEL_ERROR");
    created.fireStatus("SUBSCRIBED");
    expect(onSignal).toHaveBeenCalledTimes(2);
  });

  it("does not invoke onSignal for non-SUBSCRIBED statuses", async () => {
    const { supabase, created } = fakeSupabase();
    mocks.supabase = supabase;
    const { subscribeToBroadcast } = await import("./realtime");
    const onSignal = vi.fn();
    subscribeToBroadcast("t", "e", onSignal);
    created.fireStatus("CHANNEL_ERROR");
    created.fireStatus("TIMED_OUT");
    created.fireStatus("CLOSED");
    expect(onSignal).not.toHaveBeenCalled();
  });

  it("unsubscribe removes the channel exactly once", async () => {
    const { supabase, removeChannel } = fakeSupabase();
    mocks.supabase = supabase;
    const { subscribeToBroadcast } = await import("./realtime");
    const unsubscribe = subscribeToBroadcast("t", "e", vi.fn());
    unsubscribe();
    expect(removeChannel).toHaveBeenCalledTimes(1);
  });

  it("subscribeToOrderTracking scopes the topic to exactly this order id + tracking token, and listens for 'order_changed'", async () => {
    const { supabase, created } = fakeSupabase();
    mocks.supabase = supabase;
    const { subscribeToOrderTracking } = await import("./realtime");
    const onChanged = vi.fn();
    subscribeToOrderTracking("order-abc", "token-xyz", onChanged);
    expect(supabase.channel).toHaveBeenCalledWith("tracking:order-abc:token-xyz", { config: { broadcast: { self: false } } });
    created.fireBroadcast("order_changed");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("subscribeToOrderTracking for a different order id/token produces a different topic -- no cross-order signal leakage", async () => {
    const { supabase } = fakeSupabase();
    mocks.supabase = supabase;
    const { subscribeToOrderTracking } = await import("./realtime");
    subscribeToOrderTracking("order-a", "token-a", vi.fn());
    subscribeToOrderTracking("order-b", "token-b", vi.fn());
    const topics = (supabase.channel as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => call[0]);
    expect(topics).toEqual(["tracking:order-a:token-a", "tracking:order-b:token-b"]);
  });
});
