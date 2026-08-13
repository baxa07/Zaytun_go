-- Customer Realtime + Driver Arrival + Telegram Notification Completion
-- Phase. Three additive pieces, none of which touch existing lifecycle
-- rules, RLS, pricing, or tracking-token protections:
--
-- 1. A broadcast-based realtime signal for the customer tracking page.
--    ARRIVED already exists as a full server-controlled lifecycle state
--    (see assert_transition, 20260806100000_pickup_fulfillment.sql) and
--    the driver already has a one-tap "Yetib keldim" action that calls
--    the existing transition_order RPC -- neither needs to change. What's
--    missing is a way for an anonymous, tracking-token-holding customer
--    to learn "something changed" without polling. `orders` has no anon
--    RLS SELECT policy (by design -- see customer_own_order_read vs the
--    complete absence of an anon policy), so postgres_changes is not
--    usable for guest customers. realtime.send(..., private:=false)
--    broadcasts to an open topic instead -- carrying no protected data at
--    all (payload is a bare signal), with the topic name itself acting
--    as the capability: 'tracking:<order id>:<tracking token>'. This is
--    the exact same trust model already used by get_order_tracking
--    (knowledge of id+token = authorization) applied to realtime instead
--    of an RPC argument list. The client always refetches the real state
--    via the existing token-gated get_order_tracking RPC after receiving
--    a signal -- the broadcast itself is never treated as authoritative.
--
-- 2. A per-order Telegram chat association, established through a
--    signed, single-use, time-limited bot deep-link -- NOT a client-
--    submitted chat id (never trusted) and NOT a customers-row-wide
--    association (today's default checkout is anonymous/guest, so most
--    orders have no customers row at all; associating at the order level
--    works for both guest and authenticated-customer checkout without
--    requiring customer_auth_required to be turned on).
--
-- 3. Reuse of the existing notification_outbox durable-dispatch pattern
--    (20260812190000_telegram_notification_outbox.sql) for a new
--    channel, 'TELEGRAM_CUSTOMER_ARRIVED', enqueued from inside
--    transition_order's existing ARRIVED branch. unique(order_id,
--    channel) already provides exactly the idempotency guarantee this
--    needs (a second arrival-adjacent call is a no-op insert, not a
--    duplicate). dispatch_notification_via_pg_net already dispatches any
--    new outbox row generically, and is already exception-safe/inert-
--    until-configured -- no change needed there. A Telegram failure
--    therefore cannot roll back or delay the ARRIVED transition: the
--    outbox insert is a fast local write inside the same transaction,
--    wrapped in its own exception-safe nested block (matching
--    enqueue_new_order_notification's existing pattern exactly); the
--    actual network call happens fully out-of-band via pg_net afterward.

-- ============================================================
-- 1. Per-order Telegram association
-- ============================================================

alter table public.orders add column customer_telegram_chat_id bigint;

-- Single-use, time-limited link tokens. No RLS policies granted to any
-- role -- every access goes through the two SECURITY DEFINER functions
-- below (request_telegram_link, called by the customer's browser via the
-- tracking token; consumption happens directly from the webhook Edge
-- Function using the service-role key, matching how zaytun-telegram-
-- notify already reads/writes notification_outbox and orders directly).
create table public.telegram_link_requests(
  token uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  consumed_at timestamptz
);
create index telegram_link_requests_order_idx on public.telegram_link_requests(order_id);
alter table public.telegram_link_requests enable row level security;
revoke all on public.telegram_link_requests from public, anon, authenticated;

-- Same authorization shape as get_order_tracking: order id + tracking
-- token proves the caller is this order's customer. Does not invalidate
-- any previously issued token for the same order -- unconsumed tokens
-- simply expire naturally, no need for single-active-token bookkeeping.
create or replace function public.request_telegram_link(p_order_id uuid, p_tracking_token uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders; new_token uuid;
begin
  select * into o from public.orders where id=p_order_id and tracking_token=p_tracking_token;
  if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma yoki kuzatuv kodi noto‘g‘ri' using errcode='P0001'; end if;
  if o.order_type<>'DELIVERY' then raise exception 'PICKUP_NO_ARRIVAL|Olib ketish buyurtmasida kuryer kelishi kuzatilmaydi' using errcode='22023'; end if;
  insert into public.telegram_link_requests(order_id) values(p_order_id) returning token into new_token;
  return new_token;
end $$;
revoke execute on function public.request_telegram_link(uuid,uuid) from public;
grant execute on function public.request_telegram_link(uuid,uuid) to anon, authenticated;

-- ============================================================
-- 2. transition_order: enqueue the arrival notification
-- ============================================================
-- Every line reproduced byte-identical from the current body
-- (20260812180000_automatic_dispatch_engine.sql) except the new block
-- immediately after the terminal-state redispatch-sweep block, which
-- enqueues 'TELEGRAM_CUSTOMER_ARRIVED' only when this specific order
-- already has a linked customer_telegram_chat_id -- orders with no link
-- never get an outbox row at all (nothing unresolvable/orphaned sitting
-- in the staff-visible outbox table), which is strictly stronger than
-- required (section 10 only requires that an absent association not
-- block the transition, not that it produce a no-op row).
create or replace function public.transition_order(p_order_id uuid,p_new_status public.order_status,p_reason text default null,p_notes text default null)
returns public.orders language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders; old public.order_status; app_role public.app_role; actor public.actor_type;
begin
  app_role:=public.current_app_role(); if app_role is null then raise exception 'AUTHENTICATION_REQUIRED|Xodim hisobi bilan kiring' using errcode='42501'; end if;
  select * into o from public.orders where id=p_order_id for update; if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi'; end if; old:=o.status;
  if o.order_type='DELIVERY' and o.delivery_review_status<>'APPROVED' and p_new_status not in('REJECTED','CANCELLED') then raise exception 'DELIVERY_REVIEW_REQUIRED|Avval yetkazish manzilini tasdiqlang' using errcode='42501'; end if;
  if o.order_type='PICKUP' and p_new_status in('DRIVER_ASSIGNED','PICKED_UP','ON_THE_WAY','ARRIVED','DELIVERED','DELIVERY_FAILED','RETURNED') then raise exception 'PICKUP_TRANSITION_FORBIDDEN|Olib ketish buyurtmasi haydovchi bosqichiga o‘tmaydi' using errcode='42501'; end if;
  if o.order_type='DELIVERY' and p_new_status='COLLECTED' then raise exception 'DELIVERY_TRANSITION_FORBIDDEN|Yetkazish buyurtmasi olib ketildi deb belgilanmaydi' using errcode='42501'; end if;
  if app_role='DRIVER' then
    if o.order_type='PICKUP' then raise exception 'PICKUP_DRIVER_FORBIDDEN|Haydovchi olib ketish buyurtmasini boshqarmaydi' using errcode='42501'; end if;
    if o.assigned_driver_id is distinct from auth.uid() then raise exception 'DRIVER_NOT_ASSIGNED|Bu buyurtma sizga biriktirilmagan' using errcode='42501'; end if;
    if p_new_status not in('PICKED_UP','ON_THE_WAY','ARRIVED','DELIVERED','DELIVERY_FAILED','RETURNED') then raise exception 'DRIVER_TRANSITION_FORBIDDEN|Haydovchi bu holatni o‘zgartira olmaydi' using errcode='42501'; end if;
    if old='DRIVER_ASSIGNED' and p_new_status='PICKED_UP' and o.assignment_accepted_at is null then raise exception 'ASSIGNMENT_NOT_ACCEPTED|Avval topshiriqni qabul qiling' using errcode='42501'; end if; actor:='DRIVER';
  elsif app_role='DISPATCHER' then actor:='DISPATCHER'; elsif app_role='RESTAURANT' then actor:='RESTAURANT'; else raise exception 'AUTHORIZATION_REQUIRED|Xodim roli talab qilinadi' using errcode='42501'; end if;
  perform public.assert_transition(old,p_new_status);
  if p_new_status in('REJECTED','CANCELLED','DELIVERY_FAILED') and coalesce(trim(p_reason),'')='' then raise exception 'REASON_REQUIRED|Sababni kiriting'; end if;
  update public.orders set status=p_new_status,ready_at=case when p_new_status='READY' and order_type='DELIVERY' then coalesce(ready_at,now()) else ready_at end,rejection_reason=case when p_new_status='REJECTED' then trim(p_reason) else rejection_reason end,cancellation_reason=case when p_new_status='CANCELLED' then trim(p_reason) else cancellation_reason end,payment_status=case when p_new_status in('DELIVERED','COLLECTED') and o.payment_method not in('CLICK','PAYME') then 'COLLECTED' else payment_status end where id=p_order_id returning * into o;
  insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status,reason,notes) values(p_order_id,actor,auth.uid()::text,old,p_new_status,nullif(trim(p_reason),''),nullif(trim(p_notes),''));
  if p_new_status in('DELIVERED','DELIVERY_FAILED','RETURNED','CANCELLED') and o.assigned_driver_id is not null then
    update public.drivers set availability='AVAILABLE' where id=o.assigned_driver_id;
    update public.driver_assignments set ended_at=now(),status=(case p_new_status when 'DELIVERED' then 'COMPLETED' when 'DELIVERY_FAILED' then 'FAILED' when 'RETURNED' then 'RETURNED' when 'CANCELLED' then 'CANCELLED' end)::public.assignment_status where order_id=p_order_id and ended_at is null;
  end if;
  if p_new_status='READY' and o.order_type='DELIVERY' then
    begin
      perform public.attempt_dispatch_sweep_internal();
    exception when others then
      raise warning 'dispatch sweep failed after order % became READY: %', p_order_id, sqlerrm;
    end;
  end if;
  if p_new_status in('DELIVERED','DELIVERY_FAILED','RETURNED','CANCELLED') and o.assigned_driver_id is not null then
    begin
      perform public.attempt_dispatch_sweep_internal();
    exception when others then
      raise warning 'redispatch sweep failed after order % reached %: %', p_order_id, p_new_status, sqlerrm;
    end;
  end if;
  if p_new_status='ARRIVED' and o.customer_telegram_chat_id is not null then
    begin
      insert into public.notification_outbox(order_id, channel) values(p_order_id, 'TELEGRAM_CUSTOMER_ARRIVED') on conflict(order_id, channel) do nothing;
    exception when others then
      raise warning 'failed to enqueue arrival notification for order %: %', p_order_id, sqlerrm;
    end;
  end if;
  return o;
end $$;

-- ============================================================
-- 3. Customer tracking realtime broadcast signal
-- ============================================================
-- Fires broadly (no WHEN clause) on any orders UPDATE -- deliberately
-- over-inclusive rather than risk missing a customer-visible change
-- (delivery address revision, assignment_accepted_at, status, review
-- state, etc. are all written via plain UPDATEs from different RPCs).
-- Refetching get_order_tracking on a no-op signal is cheap and harmless;
-- missing a real one defeats the feature. private:=false is deliberate:
-- the topic name itself (order id + tracking token) is the capability,
-- exactly like get_order_tracking's own arguments -- the payload carries
-- no order data at all, so there is nothing to leak even if the topic
-- were somehow guessed.
create or replace function public.broadcast_order_tracking_change()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  begin
    perform realtime.send(
      jsonb_build_object('type','order_changed'),
      'order_changed',
      'tracking:'||new.id::text||':'||new.tracking_token::text,
      false
    );
  exception when others then
    raise warning 'failed to broadcast tracking change for order %: %', new.id, sqlerrm;
  end;
  return new;
end $$;
create trigger orders_broadcast_tracking_change after update on public.orders
  for each row execute function public.broadcast_order_tracking_change();
