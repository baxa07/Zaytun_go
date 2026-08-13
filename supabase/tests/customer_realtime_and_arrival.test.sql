begin;
select plan(24);

-- Customer Realtime + Driver Arrival + Telegram Notification Completion
-- Phase. A dedicated branch with both seed drivers, mirroring the
-- established pattern in automatic_dispatch.test.sql / decline_reassignment.test.sql.
insert into public.branches(id,name,slug,address,latitude,longitude,active)
values ('99000000-0000-4000-8000-0000000000c1','Zaytun RT Branch','rt-phase','Test',40.10,65.41,true);
delete from public.driver_branches where driver_id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
insert into public.driver_branches(driver_id,branch_id) values
  ('10000000-0000-0000-0000-000000000003','99000000-0000-4000-8000-0000000000c1'),
  ('10000000-0000-0000-0000-000000000004','99000000-0000-4000-8000-0000000000c1');
-- Generous capacity: this file creates several sequential order fixtures
-- for the same driver, most of which are deliberately never walked to a
-- terminal state (that's not what they're testing) -- capacity=1 would
-- starve every fixture after the first.
update public.drivers set shift_status='ON_SHIFT',dispatch_status='ACTIVE',delivery_capacity=10
  where id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
update public.orders set status='CANCELLED' where id='20000000-0000-0000-0000-000000000001' and status='READY';
-- Only ...003 eligible, so every order below deterministically auto-assigns to it.
update public.drivers set dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000004';

create or replace function pg_temp.as_driver(p_driver text) returns void language sql as $$
  select set_config('request.jwt.claim.sub',p_driver,true);
$$;

-- Walks a fresh DELIVERY order all the way to ARRIVED (real transition_order
-- calls throughout, never a raw table write) so the enqueue side effect
-- inside transition_order's ARRIVED branch is exercised exactly as
-- production would exercise it.
create or replace function pg_temp.new_arrived_order(p_id text) returns void language plpgsql as $$
begin
  perform public.create_public_order(jsonb_build_object(
    'id', p_id, 'customer', jsonb_build_object('name','RT Test','primaryPhone','+998900000'||right(p_id,3)),
    'type','DELIVERY','paymentMethod','CASH',
    'address', jsonb_build_object('district','Navoiy','street','Test','latitude',40.09,'longitude',65.40,'pinConfirmedAt','2026-08-14T08:00:00Z','locationProvider','mock'),
    'items', jsonb_build_array(jsonb_build_object('menuItemId','plov','quantity',3,'modifierIds','[]'::jsonb))
  ));
  update public.orders set branch_id='99000000-0000-4000-8000-0000000000c1' where id=p_id::uuid;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
  perform public.review_delivery_request(p_id::uuid,true,null);
  perform public.transition_order(p_id::uuid,'CONFIRMED',null,null);
  perform public.transition_order(p_id::uuid,'PREPARING',null,null);
  perform public.transition_order(p_id::uuid,'READY',null,null);
  reset role;
  set local role authenticated;
  perform pg_temp.as_driver('10000000-0000-0000-0000-000000000003');
  perform public.accept_assignment(p_id::uuid);
  perform public.transition_order(p_id::uuid,'PICKED_UP',null,null);
  perform public.transition_order(p_id::uuid,'ON_THE_WAY',null,null);
  reset role;
end;
$$;

-- ============================================================
-- request_telegram_link
-- ============================================================
select pg_temp.new_arrived_order('c1000000-0000-4000-8000-000000000001');
select ok(
  (select public.request_telegram_link('c1000000-0000-4000-8000-000000000001'::uuid,(select tracking_token from public.orders where id='c1000000-0000-4000-8000-000000000001'))) is not null,
  'a valid order id + tracking token returns a link token'
);
select is((select count(*)::integer from public.telegram_link_requests where order_id='c1000000-0000-4000-8000-000000000001'::uuid),1,'exactly one link request row was created');
select throws_ok(
  $$select public.request_telegram_link('c1000000-0000-4000-8000-000000000001'::uuid,'00000000-0000-0000-0000-000000000099'::uuid)$$,
  'P0001','ORDER_NOT_FOUND|Buyurtma yoki kuzatuv kodi noto‘g‘ri','a wrong tracking token is rejected, same as get_order_tracking'
);
select lives_ok($$select public.create_public_order(jsonb_build_object('id','c1000000-0000-4000-8000-000000000002','customer',jsonb_build_object('name','Pickup RT','primaryPhone','+998900000777'),'type','PICKUP','paymentMethod','CASH','items',jsonb_build_array(jsonb_build_object('menuItemId','plov','quantity',1,'modifierIds','[]'::jsonb))))$$,'pickup fixture order accepted');
select throws_ok(
  $$select public.request_telegram_link('c1000000-0000-4000-8000-000000000002'::uuid,(select tracking_token from public.orders where id='c1000000-0000-4000-8000-000000000002'))$$,
  '22023','PICKUP_NO_ARRIVAL|Olib ketish buyurtmasida kuryer kelishi kuzatilmaydi','a pickup order cannot request an arrival-link (pickup has no driver-arrival concept)'
);
select ok(has_function_privilege('anon','public.request_telegram_link(uuid,uuid)','EXECUTE'),'anon can call request_telegram_link (a guest customer must be able to)');
select ok(has_function_privilege('authenticated','public.request_telegram_link(uuid,uuid)','EXECUTE'),'authenticated can also call request_telegram_link');

-- ============================================================
-- ARRIVED enqueues the notification exactly once, only when linked
-- ============================================================
select pg_temp.new_arrived_order('c2000000-0000-4000-8000-000000000001');
update public.orders set customer_telegram_chat_id=555111222 where id='c2000000-0000-4000-8000-000000000001'::uuid;
set local role authenticated;
select pg_temp.as_driver('10000000-0000-0000-0000-000000000003');
select lives_ok($$select public.transition_order('c2000000-0000-4000-8000-000000000001'::uuid,'ARRIVED',null,null)$$,'assigned driver marks a linked delivery ARRIVED');
reset role;
select is((select status::text from public.orders where id='c2000000-0000-4000-8000-000000000001'),'ARRIVED','order status is now ARRIVED');
select is((select count(*)::integer from public.notification_outbox where order_id='c2000000-0000-4000-8000-000000000001'::uuid and channel='TELEGRAM_CUSTOMER_ARRIVED'),1,'exactly one arrival notification is enqueued for a linked order');
select is((select status from public.notification_outbox where order_id='c2000000-0000-4000-8000-000000000001'::uuid and channel='TELEGRAM_CUSTOMER_ARRIVED'),'PENDING','the enqueued row starts PENDING, dispatched asynchronously by the existing pg_net trigger');

-- Idempotency: the exact mechanism relied on (unique(order_id,channel) +
-- on conflict do nothing) is proven directly -- a second enqueue attempt
-- for the same order+channel is a silent no-op, never a second row, which
-- is the actual guarantee against duplicate customer notifications.
select lives_ok($$insert into public.notification_outbox(order_id,channel) values('c2000000-0000-4000-8000-000000000001'::uuid,'TELEGRAM_CUSTOMER_ARRIVED') on conflict(order_id,channel) do nothing$$,'a repeated enqueue attempt for the same order+channel does not error');
select is((select count(*)::integer from public.notification_outbox where order_id='c2000000-0000-4000-8000-000000000001'::uuid and channel='TELEGRAM_CUSTOMER_ARRIVED'),1,'still exactly one row after the repeated enqueue attempt -- no duplicate notification is possible');

-- No Telegram link -> ARRIVED still succeeds, but nothing is enqueued
-- (stronger than merely "not blocked"): no orphaned unreachable row sits
-- in the staff-visible outbox table for an order nobody can ever notify.
select pg_temp.new_arrived_order('c3000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.as_driver('10000000-0000-0000-0000-000000000003');
select lives_ok($$select public.transition_order('c3000000-0000-4000-8000-000000000001'::uuid,'ARRIVED',null,null)$$,'an unlinked delivery can still be marked ARRIVED -- Telegram is never a lifecycle dependency');
reset role;
select is((select status::text from public.orders where id='c3000000-0000-4000-8000-000000000001'),'ARRIVED','order status is ARRIVED even with no Telegram link');
select is((select count(*)::integer from public.notification_outbox where order_id='c3000000-0000-4000-8000-000000000001'::uuid and channel='TELEGRAM_CUSTOMER_ARRIVED'),0,'no notification is enqueued for an order with no linked Telegram chat');

-- ============================================================
-- Arrival authorization / lifecycle guards
-- ============================================================
select pg_temp.new_arrived_order('c4000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.as_driver('10000000-0000-0000-0000-000000000004');
select throws_ok(
  $$select public.transition_order('c4000000-0000-4000-8000-000000000001'::uuid,'ARRIVED',null,null)$$,
  '42501','DRIVER_NOT_ASSIGNED|Bu buyurtma sizga biriktirilmagan',
  'a driver who is not the one assigned to this order cannot mark it ARRIVED'
);
reset role;
select is((select status::text from public.orders where id='c4000000-0000-4000-8000-000000000001'),'ON_THE_WAY','order status is unchanged after the unauthorized attempt');

select public.create_public_order(jsonb_build_object('id','c5000000-0000-4000-8000-000000000001','customer',jsonb_build_object('name','RT Invalid State','primaryPhone','+998900000888'),'type','DELIVERY','paymentMethod','CASH','address',jsonb_build_object('district','Navoiy','street','Test','latitude',40.09,'longitude',65.40,'pinConfirmedAt','2026-08-14T08:00:00Z','locationProvider','mock'),'items',jsonb_build_array(jsonb_build_object('menuItemId','plov','quantity',3,'modifierIds','[]'::jsonb))));
update public.orders set branch_id='99000000-0000-4000-8000-0000000000c1' where id='c5000000-0000-4000-8000-000000000001'::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.review_delivery_request('c5000000-0000-4000-8000-000000000001'::uuid,true,null);
select public.transition_order('c5000000-0000-4000-8000-000000000001'::uuid,'CONFIRMED',null,null);
select public.transition_order('c5000000-0000-4000-8000-000000000001'::uuid,'PREPARING',null,null);
select public.transition_order('c5000000-0000-4000-8000-000000000001'::uuid,'READY',null,null);
reset role;
set local role authenticated;
select pg_temp.as_driver('10000000-0000-0000-0000-000000000003');
select public.accept_assignment('c5000000-0000-4000-8000-000000000001'::uuid);
-- Still DRIVER_ASSIGNED (never picked up) -- ARRIVED must be rejected.
select throws_ok(
  $$select public.transition_order('c5000000-0000-4000-8000-000000000001'::uuid,'ARRIVED',null,null)$$,
  '23514',null,
  'ARRIVED is rejected from DRIVER_ASSIGNED -- PICKED_UP and ON_THE_WAY cannot be skipped'
);
reset role;

-- ============================================================
-- get_order_tracking never exposes the Telegram chat id or link tokens
-- ============================================================
select ok(
  not (public.get_order_tracking('c2000000-0000-4000-8000-000000000001'::uuid,(select tracking_token from public.orders where id='c2000000-0000-4000-8000-000000000001')) ? 'customer_telegram_chat_id'),
  'get_order_tracking never returns customer_telegram_chat_id, even for an order that has one linked'
);
select ok(not has_table_privilege('anon','public.telegram_link_requests','SELECT'),'anon has no direct SELECT on telegram_link_requests');
select ok(not has_table_privilege('authenticated','public.telegram_link_requests','SELECT'),'authenticated has no direct SELECT on telegram_link_requests either -- every access goes through request_telegram_link / the webhook''s service-role client');

-- ============================================================
-- Realtime broadcast trigger exists and is wired to orders
-- ============================================================
select ok(exists(select 1 from pg_trigger where tgname='orders_broadcast_tracking_change' and tgrelid='public.orders'::regclass),'the tracking-change broadcast trigger is installed on orders');
select has_function('public','broadcast_order_tracking_change',array[]::text[],'broadcast_order_tracking_change function exists');

select * from finish();
rollback;
