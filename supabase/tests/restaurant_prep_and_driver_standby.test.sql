begin;
select plan(15);

-- Restaurant UI Phase 1: driver standby notice on PREPARING. Dedicated
-- branch + both seed drivers, mirroring the established pattern already
-- used across the Smart Dispatch / decline-reassignment / customer-
-- realtime test files.
insert into public.branches(id,name,slug,address,latitude,longitude,active)
values ('9a000000-0000-4000-8000-0000000000d1','Zaytun Standby Branch','standby-phase','Test',40.10,65.41,true);
delete from public.driver_branches where driver_id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
insert into public.driver_branches(driver_id,branch_id) values
  ('10000000-0000-0000-0000-000000000003','9a000000-0000-4000-8000-0000000000d1'),
  ('10000000-0000-0000-0000-000000000004','9a000000-0000-4000-8000-0000000000d1');
update public.drivers set shift_status='ON_SHIFT',dispatch_status='ACTIVE',delivery_capacity=10
  where id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
update public.orders set status='CANCELLED' where id='20000000-0000-0000-0000-000000000001' and status='READY';

-- Walks a fresh order to CONFIRMED (one step short of PREPARING) via real
-- transition_order calls, so each test only needs to fire the one
-- transition it's actually exercising.
create or replace function pg_temp.new_confirmed_order(p_id text, p_type public.order_type default 'DELIVERY') returns void language plpgsql as $$
declare payload jsonb;
begin
  payload := jsonb_build_object(
    'id', p_id, 'customer', jsonb_build_object('name','Standby Test','primaryPhone','+998900000'||right(p_id,3)),
    'type', p_type, 'paymentMethod','CASH',
    'items', jsonb_build_array(jsonb_build_object('menuItemId','plov','quantity',3,'modifierIds','[]'::jsonb))
  );
  if p_type='DELIVERY' then
    payload := payload || jsonb_build_object('address', jsonb_build_object('district','Navoiy','street','Test','latitude',40.09,'longitude',65.40,'pinConfirmedAt','2026-08-14T08:00:00Z','locationProvider','mock'));
  end if;
  perform public.create_public_order(payload);
  if p_type='DELIVERY' then update public.orders set branch_id='9a000000-0000-4000-8000-0000000000d1' where id=p_id::uuid; end if;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
  if p_type='DELIVERY' then perform public.review_delivery_request(p_id::uuid,true,null); end if;
  perform public.transition_order(p_id::uuid,'CONFIRMED',null,null);
  reset role;
end;
$$;

-- ============================================================
-- Eligible drivers present -> standby notice recorded with a positive count
-- ============================================================
select pg_temp.new_confirmed_order('d1000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.transition_order('d1000000-0000-4000-8000-000000000001'::uuid,'PREPARING',null,null)$$,'staff moves an approved, accepted delivery order into PREPARING');
reset role;
select is((select status::text from public.orders where id='d1000000-0000-4000-8000-000000000001'),'PREPARING','order status is now PREPARING');
select is((select count(*)::integer from public.driver_standby_notices where order_id='d1000000-0000-4000-8000-000000000001'::uuid),1,'exactly one standby notice row is recorded');
select is((select eligible_driver_count from public.driver_standby_notices where order_id='d1000000-0000-4000-8000-000000000001'::uuid),2,'both branch-pooled ON_SHIFT/ACTIVE drivers are counted as eligible');
select is((select branch_id from public.driver_standby_notices where order_id='d1000000-0000-4000-8000-000000000001'::uuid),'9a000000-0000-4000-8000-0000000000d1'::uuid,'the notice records the order''s own branch');

-- ============================================================
-- No available driver is handled safely: still recorded, count=0, no error
-- ============================================================
update public.drivers set dispatch_status='PAUSED' where id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
select pg_temp.new_confirmed_order('d2000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.transition_order('d2000000-0000-4000-8000-000000000001'::uuid,'PREPARING',null,null)$$,'PREPARING succeeds even when zero drivers are currently eligible');
reset role;
select is((select status::text from public.orders where id='d2000000-0000-4000-8000-000000000001'),'PREPARING','order status is still correctly PREPARING with no driver available');
select is((select eligible_driver_count from public.driver_standby_notices where order_id='d2000000-0000-4000-8000-000000000001'::uuid),0,'the notice records zero eligible drivers rather than erroring or being skipped');
update public.drivers set dispatch_status='ACTIVE' where id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');

-- ============================================================
-- Pickup orders never get a standby notice -- there is no delivery driver
-- to notify.
-- ============================================================
select pg_temp.new_confirmed_order('d3000000-0000-4000-8000-000000000001','PICKUP');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.transition_order('d3000000-0000-4000-8000-000000000001'::uuid,'PREPARING',null,null)$$,'pickup order also moves into PREPARING normally');
reset role;
select is((select count(*)::integer from public.driver_standby_notices where order_id='d3000000-0000-4000-8000-000000000001'::uuid),0,'no standby notice is ever recorded for a pickup order');

-- ============================================================
-- Duplicate prevention: the underlying primary key is the actual
-- guarantee (PREPARING can only ever be entered once per order per
-- assert_transition, so this proves the mechanism directly rather than
-- relying solely on that lifecycle fact).
-- ============================================================
select lives_ok($$select public.attempt_driver_standby_notice_internal('d1000000-0000-4000-8000-000000000001'::uuid)$$,'a second, direct call for the same order does not error');
select is((select count(*)::integer from public.driver_standby_notices where order_id='d1000000-0000-4000-8000-000000000001'::uuid),1,'still exactly one row after the repeated call -- no duplicate standby notice is possible');

-- ============================================================
-- Access control: staff-only, no direct write surface for anyone
-- ============================================================
select ok(has_table_privilege('authenticated','public.driver_standby_notices','SELECT'),'authenticated (staff) can read standby notices');
select ok(not has_table_privilege('anon','public.driver_standby_notices','SELECT'),'anon has no read access to standby notices');
select ok(not has_table_privilege('authenticated','public.driver_standby_notices','INSERT'),'no role can insert directly -- only attempt_driver_standby_notice_internal (SECURITY DEFINER) writes this table');

select * from finish();
rollback;
