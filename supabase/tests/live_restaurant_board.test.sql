begin;
select plan(13);

-- H0: Live Restaurant Board Cleanup. list_live_restaurant_order_ids()
-- always includes every non-terminal order regardless of created_at, and
-- includes terminal orders only when their CANONICAL terminal transition
-- (order_events.occurred_at where new_status = the order's own status)
-- falls inside today's Asia/Tashkent business day. Nothing is deleted,
-- archived, or mutated -- purely a read filter.

-- security definer: these raw UPDATE/INSERT test-setup helpers need
-- table-owner privileges regardless of which role calls them (the tests
-- below deliberately run as `authenticated`, which by design has no
-- direct table-level UPDATE grant on orders -- only through RPCs).
create or replace function pg_temp.new_order(p_id text, p_status public.order_status) returns void language plpgsql security definer as $$
begin
  perform public.create_public_order(jsonb_build_object(
    'id', p_id, 'customer', jsonb_build_object('name','Board Test','primaryPhone','+998900000'||right(p_id,3)),
    'type','PICKUP','paymentMethod','CASH',
    'items', jsonb_build_array(jsonb_build_object('menuItemId','ayran','quantity',1,'modifierIds','[]'::jsonb))
  ));
  update public.orders set status=p_status,delivery_review_status='APPROVED' where id=p_id::uuid;
end;
$$;
-- Records the (only) order_events row for a terminal status at an
-- explicit, arbitrary point in time -- this is the row the RPC's EXISTS
-- check actually keys on; a raw status overwrite alone (above) never
-- creates one, so every raw-bypass test case must call this explicitly
-- for whichever timestamp it wants to be true, independent of created_at.
create or replace function pg_temp.record_terminal_event(p_id text, p_status public.order_status, p_at timestamptz) returns void language plpgsql security definer as $$
begin
  insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status,occurred_at)
  values (p_id::uuid,'RESTAURANT','seed','PREPARING',p_status,p_at);
end;
$$;
create or replace function pg_temp.backdate_created_at(p_id text, p_at timestamptz) returns void language plpgsql security definer as $$
begin
  update public.orders set created_at=p_at where id=p_id::uuid;
end;
$$;
-- A genuine DELIVERY order, approved and progressed to ARRIVED, so the
-- real transition_order RPC can legitimately be exercised end to end
-- (raw-bypass orders above are PICKUP-shaped and would be correctly
-- rejected by transition_order's own PICKUP_TRANSITION_FORBIDDEN guard).
create or replace function pg_temp.new_arrived_delivery_order(p_id text) returns void language plpgsql security definer as $$
begin
  perform public.create_public_order(jsonb_build_object(
    'id', p_id, 'customer', jsonb_build_object('name','Board Test','primaryPhone','+998900000'||right(p_id,3)),
    'type','DELIVERY','paymentMethod','CASH',
    'address', jsonb_build_object('district','Navoiy','street','Test','latitude',40.09,'longitude',65.40,'pinConfirmedAt','2026-08-12T08:00:00Z','locationProvider','mock'),
    'items', jsonb_build_array(jsonb_build_object('menuItemId','plov','quantity',3,'modifierIds','[]'::jsonb))
  ));
  update public.orders set status='ARRIVED',delivery_review_status='APPROVED',assigned_driver_id='10000000-0000-0000-0000-000000000003' where id=p_id::uuid;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);

-- 1. A non-terminal order created "yesterday" (created_at backdated) is
--    always included, regardless of date.
select pg_temp.new_order('9c000000-0000-4000-8000-000000000001','ON_THE_WAY');
select pg_temp.backdate_created_at('9c000000-0000-4000-8000-000000000001', now()-interval '1 day');
select ok('9c000000-0000-4000-8000-000000000001'::uuid in (select * from public.list_live_restaurant_order_ids()),'an old but still-active order remains on the live board');

-- 2. A terminal order whose canonical transition happened yesterday is
--    excluded from today's board.
select pg_temp.new_order('9c000000-0000-4000-8000-000000000002','DELIVERED');
select pg_temp.record_terminal_event('9c000000-0000-4000-8000-000000000002','DELIVERED',now()-interval '1 day');
select ok('9c000000-0000-4000-8000-000000000002'::uuid not in (select * from public.list_live_restaurant_order_ids()),'a terminal order finished yesterday is absent from today''s live board');

-- 3. Cross-midnight: created yesterday, delivered today -> visible today
--    (this is the exact case created_at-based filtering would get wrong).
select pg_temp.new_order('9c000000-0000-4000-8000-000000000003','DELIVERED');
select pg_temp.backdate_created_at('9c000000-0000-4000-8000-000000000003', now()-interval '1 day');
select pg_temp.record_terminal_event('9c000000-0000-4000-8000-000000000003','DELIVERED',now());
select ok('9c000000-0000-4000-8000-000000000003'::uuid in (select * from public.list_live_restaurant_order_ids()),'created yesterday but delivered today: visible today (canonical transition time wins, not created_at)');

-- 4. Today's COLLECTED (pickup) is visible.
select pg_temp.new_order('9c000000-0000-4000-8000-000000000004','COLLECTED');
select pg_temp.record_terminal_event('9c000000-0000-4000-8000-000000000004','COLLECTED',now());
select ok('9c000000-0000-4000-8000-000000000004'::uuid in (select * from public.list_live_restaurant_order_ids()),'today''s COLLECTED pickup order is visible');

-- 5. Every other terminal status, backdated to yesterday -> excluded;
--    today -> included.
select pg_temp.new_order('9c000000-0000-4000-8000-000000000005','CANCELLED');
select pg_temp.record_terminal_event('9c000000-0000-4000-8000-000000000005','CANCELLED',now()-interval '1 day');
select ok('9c000000-0000-4000-8000-000000000005'::uuid not in (select * from public.list_live_restaurant_order_ids()),'yesterday''s CANCELLED order is absent today');

select pg_temp.new_order('9c000000-0000-4000-8000-000000000006','REJECTED');
select pg_temp.record_terminal_event('9c000000-0000-4000-8000-000000000006','REJECTED',now()-interval '1 day');
select ok('9c000000-0000-4000-8000-000000000006'::uuid not in (select * from public.list_live_restaurant_order_ids()),'yesterday''s REJECTED order is absent today');

select pg_temp.new_order('9c000000-0000-4000-8000-000000000007','DELIVERY_FAILED');
select pg_temp.record_terminal_event('9c000000-0000-4000-8000-000000000007','DELIVERY_FAILED',now());
select ok('9c000000-0000-4000-8000-000000000007'::uuid in (select * from public.list_live_restaurant_order_ids()),'today''s DELIVERY_FAILED order is visible');

select pg_temp.new_order('9c000000-0000-4000-8000-000000000008','RETURNED');
select pg_temp.record_terminal_event('9c000000-0000-4000-8000-000000000008','RETURNED',now());
select ok('9c000000-0000-4000-8000-000000000008'::uuid in (select * from public.list_live_restaurant_order_ids()),'today''s RETURNED order is visible');

-- 6. A brand-new, still-NEW order is always visible (sanity).
select pg_temp.new_order('9c000000-0000-4000-8000-000000000009','NEW');
select ok('9c000000-0000-4000-8000-000000000009'::uuid in (select * from public.list_live_restaurant_order_ids()),'a brand-new order is visible');

reset role;

-- 7. Lifecycle continuity: an order that transitions from active to
--    terminal TODAY, via the real transition_order RPC (not a raw
--    backdate), remains visible and correctly lands in "today's finished".
select pg_temp.new_arrived_delivery_order('9c000000-0000-4000-8000-000000000010');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.transition_order('9c000000-0000-4000-8000-000000000010'::uuid,'DELIVERED',null,null);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select ok('9c000000-0000-4000-8000-000000000010'::uuid in (select * from public.list_live_restaurant_order_ids()),'an order delivered today via the real transition RPC is visible (moves into YAKUNLANGAN, doesn''t vanish)');
reset role;

-- 8. Non-staff cannot call this RPC at all.
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000004',true);
select throws_ok($$select * from public.list_live_restaurant_order_ids()$$,'42501','STAFF_ROLE_REQUIRED|Xodim roli talab qilinadi','a driver cannot call the restaurant board RPC');
reset role;

-- 9. Nothing is deleted/mutated by any of this -- the underlying rows and
--    their history remain fully intact regardless of live-board visibility.
select is((select count(*)::integer from public.orders where id='9c000000-0000-4000-8000-000000000002'),1,'an excluded order''s row still exists');
select ok((select count(*)::integer from public.order_events where order_id='9c000000-0000-4000-8000-000000000002')>0,'its order_events history is retained, not deleted, despite being hidden from the live board');

select * from finish();
rollback;
