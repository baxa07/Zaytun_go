begin;
select plan(23);

-- Smart Dispatch v1, Phase 3: automatic dispatch engine. Neutralize the
-- pre-existing seeded fixture order (a deliberate READY-with-no-driver
-- order used elsewhere) so it can't be opportunistically swept up by this
-- file's dispatch attempts and interfere with exact-count assertions --
-- itself a genuine, desirable emergent property of a global sweep, just
-- one this file needs to control for to stay deterministic.
update public.orders set status='CANCELLED' where id='20000000-0000-0000-0000-000000000001' and status='READY';

-- A second branch, with driver-1 (...004) moved into ITS pool instead of
-- Kafe's, and driver-2 (...003) paused globally -- gives every scenario
-- below a clean, deterministic "exactly one eligible driver, in exactly
-- one branch" starting point without needing to provision new drivers.
insert into public.branches(id,name,slug,address,latitude,longitude,active)
values ('99000000-0000-4000-8000-00000000000a','Zaytun Fast Food A','fast-food-a','Test',40.10,65.41,true);
delete from public.driver_branches where driver_id='10000000-0000-0000-0000-000000000004';
insert into public.driver_branches(driver_id,branch_id) values('10000000-0000-0000-0000-000000000004','99000000-0000-4000-8000-00000000000a');
update public.drivers set dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000003';
update public.drivers set shift_status='ON_SHIFT',dispatch_status='ACTIVE',delivery_capacity=1 where id='10000000-0000-0000-0000-000000000004';

create or replace function pg_temp.new_ready_order(p_id text, p_branch text) returns void language plpgsql as $$
declare payload jsonb;
begin
  payload := jsonb_build_object(
    'id', p_id, 'customer', jsonb_build_object('name','Dispatch Test','primaryPhone','+998900000'||right(p_id,3)),
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

-- ============================================================
-- 1. CORRECTION 1: an unserviceable oldest-branch order must not
--    head-of-line-block a newer, serviceable, different-branch order.
-- ============================================================
update public.drivers set dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000004';
select pg_temp.new_ready_order('a1000000-0000-4000-8000-000000000001', null); -- Kafe (default branch), no eligible driver right now
update public.drivers set dispatch_status='ACTIVE' where id='10000000-0000-0000-0000-000000000004';
select pg_temp.new_ready_order('a1000000-0000-4000-8000-000000000002', '99000000-0000-4000-8000-00000000000a'); -- Fast Food A, ...004 eligible
select is((select status::text from public.orders where id='a1000000-0000-4000-8000-000000000001'),'READY','oldest Kafe order with no eligible driver remains READY, not blocking anything');
select is((select status::text from public.orders where id='a1000000-0000-4000-8000-000000000002'),'DRIVER_ASSIGNED','newer Fast Food A order is dispatched despite the older unserviceable Kafe order still waiting');
update public.orders set status='CANCELLED' where id in('a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002');
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id in('a1000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000002') and ended_at is null;

-- ============================================================
-- 2. Two READY orders, one capacity slot: exactly one assignment, the
--    other remains READY.
-- ============================================================
select pg_temp.new_ready_order('a2000000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-00000000000a');
select pg_temp.new_ready_order('a2000000-0000-4000-8000-000000000002', '99000000-0000-4000-8000-00000000000a');
select is((select status::text from public.orders where id='a2000000-0000-4000-8000-000000000001'),'DRIVER_ASSIGNED','the older of two competing orders gets the one available slot');
select is((select status::text from public.orders where id='a2000000-0000-4000-8000-000000000002'),'READY','the newer one waits -- exactly one slot existed');
select is((select count(*)::integer from public.driver_assignments where order_id in('a2000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000002') and ended_at is null),1,'exactly one active assignment resulted from the pair');
update public.orders set status='CANCELLED' where id in('a2000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000002');
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id in('a2000000-0000-4000-8000-000000000001','a2000000-0000-4000-8000-000000000002') and ended_at is null;

-- ============================================================
-- 3. Two sweep attempts against the same still-waiting state: the second
--    is a safe no-op, never a duplicate assignment. (True cross-session
--    concurrency is exercised by the FOR UPDATE SKIP LOCKED mechanism
--    itself -- a well-established Postgres pattern -- and is outside what
--    a single-connection pgTAP script can directly simulate; this proves
--    the idempotent-outcome property that guarantee is designed to give.)
-- ============================================================
select pg_temp.new_ready_order('a3000000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-00000000000a');
select public.attempt_dispatch_sweep_internal();
select is((select count(*)::integer from public.driver_assignments where order_id='a3000000-0000-4000-8000-000000000001' and ended_at is null),1,'two sweep calls against the same state never produce a duplicate assignment');
update public.orders set status='CANCELLED' where id='a3000000-0000-4000-8000-000000000001';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id='a3000000-0000-4000-8000-000000000001' and ended_at is null;

-- ============================================================
-- 4. Same order dispatched twice/retried: exactly one active assignment.
-- ============================================================
-- Created directly as a READY order (bypassing the new_ready_order helper,
-- which would auto-dispatch it immediately) so this test controls exactly
-- when the first dispatch attempt happens.
select public.create_public_order(jsonb_build_object('id','a4000000-0000-4000-8000-000000000001','customer',jsonb_build_object('name','Dispatch Retry','primaryPhone','+998900000401'),'type','DELIVERY','paymentMethod','CASH','address',jsonb_build_object('district','Navoiy','street','Test','latitude',40.09,'longitude',65.40,'pinConfirmedAt','2026-08-12T08:00:00Z','locationProvider','mock'),'items',jsonb_build_array(jsonb_build_object('menuItemId','plov','quantity',3,'modifierIds','[]'::jsonb))));
update public.orders set branch_id='99000000-0000-4000-8000-00000000000a',delivery_review_status='APPROVED',status='READY' where id='a4000000-0000-4000-8000-000000000001';
select is(public.dispatch_ready_order_internal('a4000000-0000-4000-8000-000000000001'::uuid),true,'first dispatch attempt succeeds');
select is(public.dispatch_ready_order_internal('a4000000-0000-4000-8000-000000000001'::uuid),false,'retrying dispatch on an already-assigned order is a safe no-op');
select is((select count(*)::integer from public.driver_assignments where order_id='a4000000-0000-4000-8000-000000000001' and ended_at is null),1,'exactly one active assignment survives the retry');
update public.orders set status='CANCELLED' where id='a4000000-0000-4000-8000-000000000001';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id='a4000000-0000-4000-8000-000000000001' and ended_at is null;

-- ============================================================
-- 5. Driver already at capacity cannot receive another assignment (tested
--    at capacity=2, to prove the mechanism is a genuine `< capacity`
--    comparison, not a hidden binary busy/free flag -- production stays
--    at capacity=1 everywhere; this only proves the architecture).
-- ============================================================
update public.drivers set delivery_capacity=2 where id='10000000-0000-0000-0000-000000000004';
select pg_temp.new_ready_order('a5000000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-00000000000a');
select pg_temp.new_ready_order('a5000000-0000-4000-8000-000000000002', '99000000-0000-4000-8000-00000000000a');
select is((select count(*)::integer from public.driver_assignments where driver_id='10000000-0000-0000-0000-000000000004' and ended_at is null),2,'capacity=2 admits a second concurrent assignment for the same driver');
select pg_temp.new_ready_order('a5000000-0000-4000-8000-000000000003', '99000000-0000-4000-8000-00000000000a');
select is((select status::text from public.orders where id='a5000000-0000-4000-8000-000000000003'),'READY','a third order is correctly refused once active_assignment_count reaches delivery_capacity');
update public.orders set status='CANCELLED' where id in('a5000000-0000-4000-8000-000000000001','a5000000-0000-4000-8000-000000000002','a5000000-0000-4000-8000-000000000003');
update public.driver_assignments set ended_at=now(),status='CANCELLED' where driver_id='10000000-0000-0000-0000-000000000004' and ended_at is null;
update public.drivers set delivery_capacity=1 where id='10000000-0000-0000-0000-000000000004';

-- ============================================================
-- 6. ON_SHIFT + PAUSED cannot receive an assignment.
-- ============================================================
update public.drivers set dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000004';
select pg_temp.new_ready_order('a6000000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-00000000000a');
select is((select status::text from public.orders where id='a6000000-0000-4000-8000-000000000001'),'READY','a PAUSED driver, though ON_SHIFT and free, is not eligible');
update public.orders set status='CANCELLED' where id='a6000000-0000-4000-8000-000000000001';
update public.drivers set dispatch_status='ACTIVE' where id='10000000-0000-0000-0000-000000000004';

-- ============================================================
-- 7. OFF_SHIFT + ACTIVE cannot receive an assignment.
-- ============================================================
update public.drivers set shift_status='OFF_SHIFT' where id='10000000-0000-0000-0000-000000000004';
select pg_temp.new_ready_order('a7000000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-00000000000a');
select is((select status::text from public.orders where id='a7000000-0000-4000-8000-000000000001'),'READY','an OFF_SHIFT driver, though dispatch_status=ACTIVE, is not eligible');
update public.orders set status='CANCELLED' where id='a7000000-0000-4000-8000-000000000001';
update public.drivers set shift_status='ON_SHIFT' where id='10000000-0000-0000-0000-000000000004';

-- ============================================================
-- 8. Driver eligible for Branch A but not Branch B cannot receive a
--    Branch B order (...004 is only in Fast Food A's pool -- a Kafe
--    order must not reach it even though it is fully ON_SHIFT+ACTIVE+free).
-- ============================================================
select pg_temp.new_ready_order('a8000000-0000-4000-8000-000000000001', null); -- default branch = Kafe
select is((select status::text from public.orders where id='a8000000-0000-4000-8000-000000000001'),'READY','a Kafe order is not dispatched to a driver who is only Fast-Food-A-eligible');
update public.orders set status='CANCELLED' where id='a8000000-0000-4000-8000-000000000001';

-- ============================================================
-- 9. No driver available at all: the order remains READY, and the READY
--    transition itself still succeeds (never rolled back by dispatch).
-- ============================================================
update public.drivers set dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000004';
select lives_ok(
  $$select pg_temp.new_ready_order('a9000000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-00000000000a')$$,
  'the READY transition succeeds even when no driver is available anywhere'
);
select is((select status::text from public.orders where id='a9000000-0000-4000-8000-000000000001'),'READY','order genuinely remains READY, waiting for courier');
update public.orders set status='CANCELLED' where id='a9000000-0000-4000-8000-000000000001';
update public.drivers set dispatch_status='ACTIVE' where id='10000000-0000-0000-0000-000000000004';

-- ============================================================
-- 10. A forced internal dispatch failure must never roll back the READY
--     write itself (test-only GUC, inert unless explicitly set -- proves
--     the exception boundary without weakening any real code path).
-- ============================================================
set local zaytun.test_force_dispatch_failure = 'true';
select lives_ok(
  $$select pg_temp.new_ready_order('aa000000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-00000000000a')$$,
  'a forced dispatch-sweep failure does not propagate and roll back the READY transition'
);
set local zaytun.test_force_dispatch_failure = 'false';
select is((select status::text from public.orders where id='aa000000-0000-4000-8000-000000000001'),'READY','order is genuinely READY (dispatch never actually ran, since it was forced to fail)');
update public.orders set status='CANCELLED' where id='aa000000-0000-4000-8000-000000000001';

-- ============================================================
-- 11. Completing an assignment frees derived capacity and a waiting
--     eligible order gets dispatched automatically -- no browser/client
--     involvement, purely from the terminal transition's own redispatch.
-- ============================================================
select pg_temp.new_ready_order('ab000000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-00000000000a'); -- takes the one slot
select pg_temp.new_ready_order('ab000000-0000-4000-8000-000000000002', '99000000-0000-4000-8000-00000000000a'); -- waits
select is((select status::text from public.orders where id='ab000000-0000-4000-8000-000000000002'),'READY','second order waits while the only driver is busy with the first');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000004',true);
select public.accept_assignment('ab000000-0000-4000-8000-000000000001'::uuid);
select public.transition_order('ab000000-0000-4000-8000-000000000001'::uuid,'PICKED_UP',null,null);
select public.transition_order('ab000000-0000-4000-8000-000000000001'::uuid,'ON_THE_WAY',null,null);
select public.transition_order('ab000000-0000-4000-8000-000000000001'::uuid,'ARRIVED',null,null);
select public.transition_order('ab000000-0000-4000-8000-000000000001'::uuid,'DELIVERED',null,null);
reset role;
select isnt((select ended_at from public.driver_assignments where order_id='ab000000-0000-4000-8000-000000000001'),null,'completing the first assignment sets its ended_at');
select is((select status::text from public.orders where id='ab000000-0000-4000-8000-000000000002'),'DRIVER_ASSIGNED','the waiting order is automatically dispatched the moment capacity opens, with no client involvement');
update public.orders set status='CANCELLED' where id in('ab000000-0000-4000-8000-000000000001','ab000000-0000-4000-8000-000000000002');
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id='ab000000-0000-4000-8000-000000000002' and ended_at is null;

-- ============================================================
-- 12. Legacy `availability` must never control automatic dispatch --
--     only the canonical shift_status/dispatch_status/capacity/branch
--     rule does.
-- ============================================================
-- 12a. availability='OFFLINE' but the canonical fields say eligible ->
--      dispatch proceeds anyway (canonical rule wins).
update public.drivers set availability='OFFLINE' where id='10000000-0000-0000-0000-000000000004';
select pg_temp.new_ready_order('ac000000-0000-4000-8000-000000000001', '99000000-0000-4000-8000-00000000000a');
select is((select status::text from public.orders where id='ac000000-0000-4000-8000-000000000001'),'DRIVER_ASSIGNED','stale availability=OFFLINE does not block dispatch when shift_status/dispatch_status/capacity all say eligible');
update public.orders set status='CANCELLED' where id='ac000000-0000-4000-8000-000000000001';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id='ac000000-0000-4000-8000-000000000001' and ended_at is null;
update public.drivers set availability='AVAILABLE' where id='10000000-0000-0000-0000-000000000004';

-- 12b. availability='AVAILABLE' but shift_status='OFF_SHIFT' -> must NOT
--      dispatch (canonical rule wins the other direction too).
update public.drivers set shift_status='OFF_SHIFT' where id='10000000-0000-0000-0000-000000000004';
select pg_temp.new_ready_order('ac000000-0000-4000-8000-000000000002', '99000000-0000-4000-8000-00000000000a');
select is((select status::text from public.orders where id='ac000000-0000-4000-8000-000000000002'),'READY','stale availability=AVAILABLE does not force dispatch when shift_status=OFF_SHIFT');
update public.orders set status='CANCELLED' where id='ac000000-0000-4000-8000-000000000002';
update public.drivers set shift_status='ON_SHIFT' where id='10000000-0000-0000-0000-000000000004';

select * from finish();
rollback;
