begin;
select plan(11);

-- Production bug: a DELIVERY order reaching READY while no driver is
-- eligible correctly stays READY (attempt_dispatch_sweep_internal ran and
-- found nothing) -- but nothing re-attempts the sweep when a driver LATER
-- becomes eligible via start_shift/resume_dispatch. The order was only
-- ever rescued as an incidental side effect of some UNRELATED order
-- transitioning elsewhere. This file proves start_shift/resume_dispatch
-- (20260814100000) now directly trigger the sweep themselves, with no
-- other order's lifecycle transition involved and no restaurant action.

update public.orders set status='CANCELLED' where id='20000000-0000-0000-0000-000000000001' and status='READY';

-- Same isolated second-branch fixture as automatic_dispatch.test.sql:
-- driver ...004 moved into ITS OWN pool, driver ...003 paused globally, so
-- every scenario below has a clean, deterministic "exactly one eligible
-- driver, in exactly one branch" starting point.
insert into public.branches(id,name,slug,address,latitude,longitude,active)
values ('99000000-0000-4000-8000-00000000000b','Zaytun Fast Food B','fast-food-b','Test',40.10,65.41,true);
delete from public.driver_branches where driver_id='10000000-0000-0000-0000-000000000004';
insert into public.driver_branches(driver_id,branch_id) values('10000000-0000-0000-0000-000000000004','99000000-0000-4000-8000-00000000000b');
update public.drivers set dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000003';
update public.drivers set shift_status='OFF_SHIFT',dispatch_status='PAUSED',delivery_capacity=1 where id='10000000-0000-0000-0000-000000000004';

create or replace function pg_temp.new_ready_order(p_id text, p_branch text) returns void language plpgsql as $$
declare payload jsonb;
begin
  payload := jsonb_build_object(
    'id', p_id, 'customer', jsonb_build_object('name','Redispatch Test','primaryPhone','+998900000'||right(p_id,3)),
    'type','DELIVERY','paymentMethod','CASH',
    'address', jsonb_build_object('district','Navoiy','street','Test','latitude',40.09,'longitude',65.40,'pinConfirmedAt','2026-08-12T08:00:00Z','locationProvider','mock'),
    'items', jsonb_build_array(jsonb_build_object('menuItemId','plov','quantity',3,'modifierIds','[]'::jsonb))
  );
  perform public.create_public_order(payload);
  if p_branch is not null then
    update public.orders set branch_id=p_branch::uuid where id=p_id::uuid;
  end if;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
  perform public.review_delivery_request(p_id::uuid,true,null);
  perform public.transition_order(p_id::uuid,'CONFIRMED',null,null);
  perform public.transition_order(p_id::uuid,'PREPARING',null,null);
  perform public.transition_order(p_id::uuid,'READY',null,null);
  reset role;
end;
$$;

create or replace function pg_temp.as_driver_004(p_sql text) returns void language plpgsql as $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000004',true);
  execute p_sql;
  reset role;
end;
$$;

-- ============================================================
-- 1. READY order with no eligible driver anywhere stays READY.
-- ============================================================
select pg_temp.new_ready_order('b1000000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-00000000000b');
select is((select status::text from public.orders where id='b1000000-0000-4000-8000-000000000001'),'READY','order waits: driver ...004 is OFF_SHIFT/PAUSED, nobody else is in this branch pool');

-- ============================================================
-- 2. Driver becomes ON_SHIFT + ACTIVE via start_shift() -- the waiting
--    order is automatically assigned, with no restaurant action and no
--    other order's lifecycle transition involved.
-- ============================================================
select pg_temp.as_driver_004($$select public.start_shift()$$);
select is((select status::text from public.orders where id='b1000000-0000-4000-8000-000000000001'),'DRIVER_ASSIGNED','start_shift() alone -- not any restaurant action -- gets the waiting order assigned');
select is((select shift_status::text from public.drivers where id='10000000-0000-0000-0000-000000000004'),'ON_SHIFT','driver is genuinely ON_SHIFT after start_shift()');
select is((select dispatch_status::text from public.drivers where id='10000000-0000-0000-0000-000000000004'),'ACTIVE','driver is genuinely ACTIVE after start_shift()');
select is((select assigned_by from public.driver_assignments where order_id='b1000000-0000-4000-8000-000000000001' and ended_at is null),null,'the resulting assignment is AUTO (assigned_by is null), not a manual restaurant pick');
update public.orders set status='CANCELLED' where id='b1000000-0000-4000-8000-000000000001';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id='b1000000-0000-4000-8000-000000000001' and ended_at is null;
update public.drivers set shift_status='OFF_SHIFT',dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000004';

-- ============================================================
-- 3. Same proof via resume_dispatch(): driver already ON_SHIFT but
--    PAUSED (e.g. returning from a break) -- resuming alone dispatches
--    the waiting order.
-- ============================================================
update public.drivers set shift_status='ON_SHIFT',dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000004';
select pg_temp.new_ready_order('b3000000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-00000000000b');
select is((select status::text from public.orders where id='b3000000-0000-4000-8000-000000000001'),'READY','order waits while driver ...004 is ON_SHIFT but PAUSED');
select pg_temp.as_driver_004($$select public.resume_dispatch()$$);
select is((select status::text from public.orders where id='b3000000-0000-4000-8000-000000000001'),'DRIVER_ASSIGNED','resume_dispatch() alone gets the waiting order assigned');
update public.orders set status='CANCELLED' where id='b3000000-0000-4000-8000-000000000001';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id='b3000000-0000-4000-8000-000000000001' and ended_at is null;
update public.drivers set dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000004';

-- ============================================================
-- 4. Wrong-branch waiting order is not touched when the driver becomes
--    eligible -- it is only in Fast Food B's pool, never Kafe's.
-- ============================================================
select pg_temp.new_ready_order('b4000000-0000-4000-8000-000000000001', null); -- default branch = Kafe
select pg_temp.as_driver_004($$select public.start_shift()$$);
select is((select status::text from public.orders where id='b4000000-0000-4000-8000-000000000001'),'READY','a Kafe-branch waiting order is not dispatched to a driver who only just became eligible for Fast Food B');
update public.orders set status='CANCELLED' where id='b4000000-0000-4000-8000-000000000001';
update public.drivers set shift_status='OFF_SHIFT',dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000004';

-- ============================================================
-- 5. Capacity still enforced: two waiting orders, capacity=1 -- becoming
--    eligible clears exactly one, the other still waits.
-- ============================================================
select pg_temp.new_ready_order('b5000000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-00000000000b');
select pg_temp.new_ready_order('b5000000-0000-4000-8000-000000000002', '99000000-0000-4000-8000-00000000000b');
select pg_temp.as_driver_004($$select public.start_shift()$$);
select is((select count(*)::integer from public.orders where id in('b5000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000002') and status='DRIVER_ASSIGNED'),1,'exactly one of the two waiting orders is assigned -- capacity=1 still enforced by the eligibility-triggered sweep');
select is((select count(*)::integer from public.orders where id in('b5000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000002') and status='READY'),1,'the other waiting order genuinely remains READY, not silently dropped');
update public.orders set status='CANCELLED' where id in('b5000000-0000-4000-8000-000000000001','b5000000-0000-4000-8000-000000000002');
update public.driver_assignments set ended_at=now(),status='CANCELLED' where driver_id='10000000-0000-0000-0000-000000000004' and ended_at is null;
update public.drivers set shift_status='OFF_SHIFT',dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000004';

-- ============================================================
-- 6. No duplicate active assignment: resume_dispatch() called twice in a
--    row (e.g. a double-tap) never produces two assignments for the same
--    order.
-- ============================================================
update public.drivers set shift_status='ON_SHIFT',dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000004';
select pg_temp.new_ready_order('b6000000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-00000000000b');
select pg_temp.as_driver_004($$select public.resume_dispatch()$$);
select pg_temp.as_driver_004($$select public.pause_dispatch()$$);
select pg_temp.as_driver_004($$select public.resume_dispatch()$$);
select is((select count(*)::integer from public.driver_assignments where order_id='b6000000-0000-4000-8000-000000000001' and ended_at is null),1,'repeated resume_dispatch() calls never produce more than one active assignment for the same waiting order');
update public.orders set status='CANCELLED' where id='b6000000-0000-4000-8000-000000000001';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id='b6000000-0000-4000-8000-000000000001' and ended_at is null;
update public.drivers set shift_status='OFF_SHIFT',dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000004';

select * from finish();
rollback;
