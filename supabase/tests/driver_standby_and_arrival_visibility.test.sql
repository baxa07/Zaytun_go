begin;
select plan(20);

-- Driver UI Phase: list_my_standby_notices() and mark_driver_at_restaurant().
-- Dedicated branch fixture, mirroring the established pattern from
-- restaurant_prep_and_driver_standby.test.sql. Only driver ...003 is
-- pooled into this branch -- driver ...004 stays out of it, which is all
-- the "out of pool sees nothing" assertions need (no extra teardown of
-- either driver's other branch memberships required).
insert into public.branches(id,name,slug,address,latitude,longitude,active)
values ('9b000000-0000-4000-8000-0000000000d2','Zaytun Arrival Branch','arrival-phase','Test',40.11,65.42,true);
insert into public.driver_branches(driver_id,branch_id) values
  ('10000000-0000-0000-0000-000000000003','9b000000-0000-4000-8000-0000000000d2');
update public.drivers set shift_status='ON_SHIFT',dispatch_status='ACTIVE',delivery_capacity=10
  where id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');

-- Walks a fresh delivery order to PREPARING (this fires
-- attempt_driver_standby_notice_internal, same as the Restaurant Phase 1
-- migration's own test) via real transition_order calls, as staff.
create or replace function pg_temp.new_preparing_order(p_id text) returns void language plpgsql as $$
begin
  perform public.create_public_order(jsonb_build_object(
    'id', p_id, 'customer', jsonb_build_object('name','Arrival Test','primaryPhone','+998900000'||right(p_id,3)),
    'type', 'DELIVERY', 'paymentMethod','CASH',
    'items', jsonb_build_array(jsonb_build_object('menuItemId','plov','quantity',3,'modifierIds','[]'::jsonb)),
    'address', jsonb_build_object('district','Navoiy','street','Test','latitude',40.10,'longitude',65.41,'pinConfirmedAt','2026-08-14T08:00:00Z','locationProvider','mock')
  ));
  update public.orders set branch_id='9b000000-0000-4000-8000-0000000000d2' where id=p_id::uuid;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
  perform public.review_delivery_request(p_id::uuid,true,null);
  perform public.transition_order(p_id::uuid,'CONFIRMED',null,null);
  perform public.transition_order(p_id::uuid,'PREPARING',null,null);
  reset role;
end;
$$;

-- Walks a fresh delivery order to DRIVER_ASSIGNED (manual staff assign, so
-- the driver is deterministic rather than left to the sweep) and,
-- optionally, all the way through acceptance.
create or replace function pg_temp.new_assigned_order(p_id text, p_driver uuid, p_accept boolean) returns void language plpgsql as $$
declare current_driver uuid;
begin
  perform public.create_public_order(jsonb_build_object(
    'id', p_id, 'customer', jsonb_build_object('name','Arrival Test','primaryPhone','+998900001'||right(p_id,3)),
    'type', 'DELIVERY', 'paymentMethod','CASH',
    'items', jsonb_build_array(jsonb_build_object('menuItemId','plov','quantity',3,'modifierIds','[]'::jsonb)),
    'address', jsonb_build_object('district','Navoiy','street','Test','latitude',40.10,'longitude',65.41,'pinConfirmedAt','2026-08-14T08:00:00Z','locationProvider','mock')
  ));
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
  perform public.review_delivery_request(p_id::uuid,true,null);
  perform public.transition_order(p_id::uuid,'CONFIRMED',null,null);
  perform public.transition_order(p_id::uuid,'PREPARING',null,null);
  perform public.transition_order(p_id::uuid,'READY',null,null);
  -- Multi-Order Dispatch: the order may already be assigned (possibly to
  -- p_driver already, via automatic early/fair-rotation dispatch) by the
  -- time READY is reached -- only call the MANUAL override when it's
  -- actually needed (unassigned, or assigned to someone else).
  select assigned_driver_id into current_driver from public.orders where id=p_id::uuid;
  if current_driver is distinct from p_driver then
    perform public.assign_driver(p_id::uuid, p_driver);
  end if;
  if p_accept then
    reset role;
    set local role authenticated;
    perform set_config('request.jwt.claim.sub', p_driver::text, true);
    perform public.accept_assignment(p_id::uuid);
  end if;
  reset role;
end;
$$;

-- ============================================================
-- list_my_standby_notices(): branch-pooled driver sees the PREPARING
-- order; out-of-pool driver sees nothing; row disappears once the order
-- leaves PREPARING; staff cannot call it.
--
-- Multi-Order Dispatch: standby now only fires when genuinely nobody is
-- eligible at ACCEPT (a real assignment happens instead otherwise) -- so
-- this scenario pauses driver ...003 (the only driver pooled to this
-- test's branch) first. list_my_standby_notices() itself doesn't care
-- about the CALLING driver's own eligibility, only branch membership, so
-- querying as the still-paused ...003 below is exactly the right check.
-- ============================================================
update public.drivers set dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000003';
select pg_temp.new_preparing_order('e1000000-0000-4000-8000-000000000001');
-- Captured now, at superuser level -- order_read RLS would return NULL
-- for this order once we're acting as a driver who is only standby-aware
-- of it, not assigned to it.
select set_config('zaytun.test_e1_number',(select number from public.orders where id='e1000000-0000-4000-8000-000000000001'::uuid),true);

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select lives_ok($$select * from public.list_my_standby_notices()$$,'branch-pooled driver can call list_my_standby_notices');
select is((select count(*)::integer from public.list_my_standby_notices() where order_id='e1000000-0000-4000-8000-000000000001'::uuid),1,'branch-pooled driver sees exactly one row for the PREPARING order');
select is((select order_number from public.list_my_standby_notices() where order_id='e1000000-0000-4000-8000-000000000001'::uuid),current_setting('zaytun.test_e1_number'),'returned order_number matches the order');
select is((select branch_id from public.list_my_standby_notices() where order_id='e1000000-0000-4000-8000-000000000001'::uuid),'9b000000-0000-4000-8000-0000000000d2'::uuid,'returned branch_id matches the order''s branch');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000004',true);
select is((select count(*)::integer from public.list_my_standby_notices() where order_id='e1000000-0000-4000-8000-000000000001'::uuid),0,'a driver outside the branch pool sees no rows for it');
select lives_ok($$select * from public.list_my_standby_notices()$$,'a driver with zero relevant notices gets an empty resultset, not an error');
reset role;

-- Move the order past PREPARING (staff, real transition) -- the notice
-- row itself is untouched (still recorded, per 20260814500000's own
-- design), but it must no longer surface to the driver via this RPC.
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.transition_order('e1000000-0000-4000-8000-000000000001'::uuid,'READY',null,null);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select is((select count(*)::integer from public.list_my_standby_notices() where order_id='e1000000-0000-4000-8000-000000000001'::uuid),0,'the notice disappears from the RPC once the order leaves PREPARING');
reset role;
update public.drivers set dispatch_status='ACTIVE' where id='10000000-0000-0000-0000-000000000003';

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select throws_ok($$select * from public.list_my_standby_notices()$$,'42501','DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi','staff cannot call list_my_standby_notices');
reset role;

-- ============================================================
-- mark_driver_at_restaurant(): sets the timestamp on the caller's own
-- accepted-but-not-yet-picked-up assignment; idempotent; rejects wrong
-- driver, not-yet-accepted, past-DRIVER_ASSIGNED, and non-drivers.
-- ============================================================
select pg_temp.new_assigned_order('e2000000-0000-4000-8000-000000000001','10000000-0000-0000-0000-000000000003'::uuid,true);

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select lives_ok($$select public.mark_driver_at_restaurant('e2000000-0000-4000-8000-000000000001'::uuid)$$,'the accepted driver can mark themselves at the restaurant');
select isnt((select arrived_at_restaurant_at from public.driver_assignments where order_id='e2000000-0000-4000-8000-000000000001'::uuid and ended_at is null),null,'arrived_at_restaurant_at is now set');
select is((select count(*)::integer from public.order_events where order_id='e2000000-0000-4000-8000-000000000001' and notes='DRIVER_ARRIVED_RESTAURANT'),1,'first arrival creates one immutable order event');

select set_config('zaytun.test_first_arrival_ts',(select arrived_at_restaurant_at::text from public.driver_assignments where order_id='e2000000-0000-4000-8000-000000000001'::uuid and ended_at is null),true);
select pg_sleep(0.01); -- ensure a second now() call would differ if it were (wrongly) overwriting
select public.mark_driver_at_restaurant('e2000000-0000-4000-8000-000000000001'::uuid);
select is(
  (select arrived_at_restaurant_at from public.driver_assignments where order_id='e2000000-0000-4000-8000-000000000001'::uuid and ended_at is null)::text,
  current_setting('zaytun.test_first_arrival_ts'),
  'a second call is idempotent -- the original timestamp is kept, not overwritten'
);
select is((select count(*)::integer from public.order_events where order_id='e2000000-0000-4000-8000-000000000001' and notes='DRIVER_ARRIVED_RESTAURANT'),1,'duplicate arrival remains exactly-once');
reset role;

-- Wrong driver (...004 was never assigned this order) cannot mark it.
select pg_temp.new_assigned_order('e3000000-0000-4000-8000-000000000001','10000000-0000-0000-0000-000000000003'::uuid,true);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000004',true);
select throws_ok($$select public.mark_driver_at_restaurant('e3000000-0000-4000-8000-000000000001'::uuid)$$,'22023','ASSIGNMENT_NOT_FOUND|Faol topshiriq topilmadi','a driver cannot mark another driver''s assignment');
reset role;

-- Not-yet-accepted: assigned but accept_assignment never called.
select pg_temp.new_assigned_order('e4000000-0000-4000-8000-000000000001','10000000-0000-0000-0000-000000000003'::uuid,false);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select throws_ok($$select public.mark_driver_at_restaurant('e4000000-0000-4000-8000-000000000001'::uuid)$$,'22023','ASSIGNMENT_NOT_FOUND|Faol topshiriq topilmadi','a not-yet-accepted assignment cannot be marked');
-- Past DRIVER_ASSIGNED: accept, then move on to PICKED_UP, then try to mark.
select public.accept_assignment('e4000000-0000-4000-8000-000000000001'::uuid);
select public.transition_order('e4000000-0000-4000-8000-000000000001'::uuid,'PICKED_UP',null,null);
select throws_ok($$select public.mark_driver_at_restaurant('e4000000-0000-4000-8000-000000000001'::uuid)$$,'22023','ASSIGNMENT_NOT_FOUND|Faol topshiriq topilmadi','once past DRIVER_ASSIGNED (already PICKED_UP), marking is rejected -- never blocks the real transition, just no longer meaningful');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select throws_ok($$select public.mark_driver_at_restaurant('e2000000-0000-4000-8000-000000000001'::uuid)$$,'42501','DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi','staff cannot call mark_driver_at_restaurant');
reset role;

-- ============================================================
-- Access control: authenticated-only, no anon execute on either function.
-- ============================================================
select ok(has_function_privilege('authenticated','public.list_my_standby_notices()','EXECUTE'),'authenticated role can execute list_my_standby_notices');
select ok(not has_function_privilege('anon','public.list_my_standby_notices()','EXECUTE'),'anon cannot execute list_my_standby_notices');
select ok(not has_function_privilege('anon','public.mark_driver_at_restaurant(uuid)','EXECUTE'),'anon cannot execute mark_driver_at_restaurant');

select * from finish();
rollback;
