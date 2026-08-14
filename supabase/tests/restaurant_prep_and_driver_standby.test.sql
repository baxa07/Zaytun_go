begin;
select plan(19);

-- Multi-Order Dispatch: driver_standby_notices repurposed. It no longer
-- fires unconditionally at PREPARING (that meant "may become an
-- assignment later," which is no longer the normal path) -- it now fires
-- at CONFIRMED (restaurant ACCEPT) only when genuinely no eligible driver
-- exists, i.e. "waiting for a driver," and is guarded at PREPARING so it
-- can never contradict an order that already has a real assignment.
insert into public.branches(id,name,slug,address,latitude,longitude,active)
values ('9c000000-0000-4000-8000-0000000000d3','Zaytun Standby Branch','standby-phase','Test',40.10,65.41,true);
delete from public.driver_branches where driver_id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
insert into public.driver_branches(driver_id,branch_id) values
  ('10000000-0000-0000-0000-000000000003','9c000000-0000-4000-8000-0000000000d3'),
  ('10000000-0000-0000-0000-000000000004','9c000000-0000-4000-8000-0000000000d3');
update public.drivers set shift_status='ON_SHIFT',dispatch_status='ACTIVE',delivery_capacity=10
  where id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
update public.orders set status='CANCELLED' where id='20000000-0000-0000-0000-000000000001' and status='READY';

-- Walks a fresh order to CONFIRMED (restaurant ACCEPT) via a real
-- transition_order call -- this is now the moment early dispatch (or its
-- standby fallback) fires.
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
  if p_type='DELIVERY' then update public.orders set branch_id='9c000000-0000-4000-8000-0000000000d3' where id=p_id::uuid; end if;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
  if p_type='DELIVERY' then perform public.review_delivery_request(p_id::uuid,true,null); end if;
  perform public.transition_order(p_id::uuid,'CONFIRMED',null,null);
  reset role;
end;
$$;

-- ============================================================
-- A. Eligible drivers present at ACCEPT -> real assignment happens
--    immediately, NO standby notice -- ever, including after PREPARING.
--    This is the direct test for spec's "never both ASSIGNED and
--    STANDBY for the same order" contradiction.
-- ============================================================
select lives_ok($$select pg_temp.new_confirmed_order('d1000000-0000-4000-8000-000000000001')$$,'restaurant accepts an approved delivery order with eligible drivers present');
select isnt((select assigned_driver_id from public.orders where id='d1000000-0000-4000-8000-000000000001'),null,'a driver is genuinely assigned immediately at ACCEPT');
select is((select count(*)::integer from public.driver_standby_notices where order_id='d1000000-0000-4000-8000-000000000001'::uuid),0,'no standby notice is recorded when a real assignment already exists');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.transition_order('d1000000-0000-4000-8000-000000000001'::uuid,'PREPARING',null,null)$$,'staff moves the already-assigned order into PREPARING');
reset role;
select is((select count(*)::integer from public.driver_standby_notices where order_id='d1000000-0000-4000-8000-000000000001'::uuid),0,'still no standby notice after PREPARING -- an assigned order is never also presented as standby');

-- ============================================================
-- B. No eligible driver at ACCEPT -> standby fires immediately (at
--    CONFIRMED, not PREPARING), recording "waiting for a driver."
--    Retry/sweep then picks it up automatically once a driver becomes
--    eligible again, with no client/page-refresh involvement.
-- ============================================================
update public.drivers set dispatch_status='PAUSED' where id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
select lives_ok($$select pg_temp.new_confirmed_order('d2000000-0000-4000-8000-000000000001')$$,'restaurant accepts an approved delivery order with zero eligible drivers');
select is((select assigned_driver_id from public.orders where id='d2000000-0000-4000-8000-000000000001'),null,'no driver is assigned yet -- genuinely pending, not silently lost');
select is((select count(*)::integer from public.driver_standby_notices where order_id='d2000000-0000-4000-8000-000000000001'::uuid),1,'a standby notice is recorded at ACCEPT time itself, not deferred to PREPARING');
select is((select eligible_driver_count from public.driver_standby_notices where order_id='d2000000-0000-4000-8000-000000000001'::uuid),0,'the notice records zero eligible drivers rather than erroring or being skipped');
select is((select branch_id from public.driver_standby_notices where order_id='d2000000-0000-4000-8000-000000000001'::uuid),'9c000000-0000-4000-8000-0000000000d3'::uuid,'the notice records the order''s own branch');

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select lives_ok($$select public.resume_dispatch()$$,'the driver resumes dispatch (becomes eligible again)');
reset role;
select isnt((select assigned_driver_id from public.orders where id='d2000000-0000-4000-8000-000000000001'),null,'the previously-waiting order is picked up automatically by the eligibility-triggered sweep -- no page refresh, no restaurant action needed');
update public.drivers set dispatch_status='ACTIVE' where id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');

-- ============================================================
-- C. Pickup orders never get a standby notice -- there is no delivery
--    driver to notify.
-- ============================================================
select lives_ok($$select pg_temp.new_confirmed_order('d3000000-0000-4000-8000-000000000001','PICKUP')$$,'pickup order is accepted normally');
select is((select count(*)::integer from public.driver_standby_notices where order_id='d3000000-0000-4000-8000-000000000001'::uuid),0,'no standby notice is ever recorded for a pickup order');

-- ============================================================
-- D. Duplicate prevention: the underlying primary key is the actual
--    guarantee.
-- ============================================================
select lives_ok($$select public.attempt_driver_standby_notice_internal('d2000000-0000-4000-8000-000000000001'::uuid)$$,'a second, direct call for the same order does not error');
select is((select count(*)::integer from public.driver_standby_notices where order_id='d2000000-0000-4000-8000-000000000001'::uuid),1,'still exactly one row after the repeated call -- no duplicate standby notice is possible');

-- ============================================================
-- Access control: staff-only, no direct write surface for anyone
-- ============================================================
select ok(has_table_privilege('authenticated','public.driver_standby_notices','SELECT'),'authenticated (staff) can read standby notices');
select ok(not has_table_privilege('anon','public.driver_standby_notices','SELECT'),'anon has no read access to standby notices');
select ok(not has_table_privilege('authenticated','public.driver_standby_notices','INSERT'),'no role can insert directly -- only attempt_driver_standby_notice_internal (SECURITY DEFINER) writes this table');

select * from finish();
rollback;
