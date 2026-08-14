import { supabase } from "./supabase";

// Shared realtime foundation for Zaytun Go. The model throughout this
// file is deliberately "signal, then refetch" -- never "replace client
// state with the realtime payload directly":
//
//   database state changes -> realtime signal -> client refetches the
//   authoritative state via an existing, already-protected RPC -> UI
//   updates.
//
// This keeps every existing server-authoritative rule (pricing,
// lifecycle transitions, tracking-token gating, RLS) exactly as strict
// as it already is -- realtime only ever tells a subscriber "go refetch",
// it never carries the protected data itself.
export type RealtimeSignal = () => void;

// Generic broadcast-channel primitive, reusable for any future topic
// (restaurant/driver realtime can build on this too, or keep their
// existing postgres_changes-based subscribe() -- both are legitimate;
// this is additive, not a replacement). Invokes onSignal() once per
// named broadcast `event` received, AND once whenever the channel
// (re)enters SUBSCRIBED -- covering "just connected" and "just
// reconnected after a drop" with the same one code path, since both
// cases mean "something may have changed while we weren't listening,
// refetch to be sure." Returns an unsubscribe function; a no-op function
// is returned when Supabase isn't configured (local/mock data provider).
export function subscribeToBroadcast(topic: string, event: string, onSignal: RealtimeSignal): () => void {
  const client = supabase;
  if (!client) return () => {};
  const channel = client.channel(topic, { config: { broadcast: { self: false } } });
  channel.on("broadcast", { event }, () => onSignal());
  channel.subscribe((status) => {
    if (status === "SUBSCRIBED") onSignal();
  });
  return () => {
    void client.removeChannel(channel);
  };
}

// Customer order tracking: one broadcast topic per order, named after
// the same order id + tracking token pair that already gates
// get_order_tracking (see orders_broadcast_tracking_change trigger,
// 20260814300000_customer_realtime_and_arrival_notification.sql). The
// topic name itself is the capability -- exactly the same trust model
// get_order_tracking already uses for its RPC arguments, just applied to
// a channel name instead. The broadcast payload carries no order data at
// all, so onChanged must always refetch through the existing token-gated
// RPC rather than trusting anything about the signal itself.
export function subscribeToOrderTracking(orderId: string, trackingToken: string, onChanged: RealtimeSignal): () => void {
  return subscribeToBroadcast(`tracking:${orderId}:${trackingToken}`, "order_changed", onChanged);
}

// Driver UI Phase: one broadcast topic per branch, matching exactly what
// attempt_driver_standby_notice_internal already sends
// ('driver-standby:'||branch_id, event 'driver_standby',
// 20260814500000) -- a driver subscribes to every branch in their own
// pool. The payload carries no order data (and even the order id in it is
// never trusted directly); onChanged always refetches via
// list_my_standby_notices(), which independently re-derives branch
// membership and PREPARING-only visibility server-side. Every order
// today always has a branch_id (not null since branch_foundation_v1), so
// the internal function's 'driver-standby:none' fallback topic is
// currently unreachable and deliberately not subscribed to here.
export function subscribeToDriverStandby(branchIds: string[], onChanged: RealtimeSignal): () => void {
  const unsubscribes = branchIds.map((branchId) => subscribeToBroadcast(`driver-standby:${branchId}`, "driver_standby", onChanged));
  return () => unsubscribes.forEach((unsubscribe) => unsubscribe());
}
