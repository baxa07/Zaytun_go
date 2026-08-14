begin;
select plan(46);

-- Multi-Order Dispatch: assignment on ACCEPT, 2-order batching,
-- compatibility, actual-wait detachment, decline (classic + early),
-- and a sequential-call proxy for the row-lock concurrency guarantee
-- (same acknowledged-limitation pattern automatic_dispatch.test.sql
-- already documents -- true cross-session concurrency is additionally
-- proven by a standalone Node script issuing genuinely simultaneous
-- RPC calls).
insert into public.branches(id,name,slug,address,latitude,longitude,active)
values ('9d000000-0000-4000-8000-0000000000d4','Zaytun Multi Order Branch','multi-order-phase','Test',40.12,65.43,true);
delete from public.driver_branches where driver_id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
insert into public.driver_branches(driver_id,branch_id) values
  ('10000000-0000-0000-0000-000000000003','9d000000-0000-4000-8000-0000000000d4'),
  ('10000000-0000-0000-0000-000000000004','9d000000-0000-4000-8000-0000000000d4');
update public.drivers set shift_status='ON_SHIFT',dispatch_status='ACTIVE',delivery_capacity=2,availability='AVAILABLE'
  where id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
update public.orders set status='CANCELLED' where id='20000000-0000-0000-0000-000000000001' and status='READY';

create or replace function pg_temp.accept_order(p_id text, p_lat double precision default 40.09, p_lng double precision default 65.40) returns void language plpgsql as $$
begin
  perform public.create_public_order(jsonb_build_object(
    'id', p_id, 'customer', jsonb_build_object('name','Multi Order Test','primaryPhone','+998900002'||right(p_id,3)),
    'type','DELIVERY','paymentMethod','CASH',
    'items', jsonb_build_array(jsonb_build_object('menuItemId','plov','quantity',3,'modifierIds','[]'::jsonb)),
    'address', jsonb_build_object('district','Navoiy','street','Test','latitude',p_lat,'longitude',p_lng,'pinConfirmedAt','2026-08-14T08:00:00Z','locationProvider','mock')
  ));
  update public.orders set branch_id='9d000000-0000-4000-8000-0000000000d4' where id=p_id::uuid;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
  perform public.review_delivery_request(p_id::uuid,true,null);
  perform public.transition_order(p_id::uuid,'CONFIRMED',null,null);
  reset role;
end;
$$;

-- ============================================================
-- 1. Assignment happens on ACCEPT (CONFIRMED), not READY. orders.status
--    itself is untouched -- the assignment/status split holds.
-- ============================================================
update public.drivers set dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000004';
select pg_temp.accept_order('e1000000-0000-4000-8000-000000000001');
select isnt((select assigned_driver_id from public.orders where id='e1000000-0000-4000-8000-000000000001'),null,'a driver is assigned immediately at ACCEPT');
select is((select status::text from public.orders where id='e1000000-0000-4000-8000-000000000001'),'CONFIRMED','order status itself is untouched by early assignment -- still CONFIRMED, not DRIVER_ASSIGNED');
select is((select count(*)::integer from public.driver_assignments where order_id='e1000000-0000-4000-8000-000000000001' and ended_at is null),1,'exactly one active assignment row exists');
select isnt((select pickup_batch_id from public.orders where id='e1000000-0000-4000-8000-000000000001'),null,'the order joins a pickup batch');
select isnt((select accepted_at from public.orders where id='e1000000-0000-4000-8000-000000000001'),null,'accepted_at is recorded');

-- ============================================================
-- 2. READY reuses the existing assignment -- no duplicate, no new search.
-- ============================================================
select set_config('zaytun.e1_assignment_id',(select id::text from public.driver_assignments where order_id='e1000000-0000-4000-8000-000000000001' and ended_at is null),true);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.transition_order('e1000000-0000-4000-8000-000000000001'::uuid,'PREPARING',null,null);
select public.transition_order('e1000000-0000-4000-8000-000000000001'::uuid,'READY',null,null);
reset role;
select is((select status::text from public.orders where id='e1000000-0000-4000-8000-000000000001'),'DRIVER_ASSIGNED','READY resolves straight to DRIVER_ASSIGNED, reusing the existing assignment');
select is((select count(*)::integer from public.driver_assignments where order_id='e1000000-0000-4000-8000-000000000001' and ended_at is null),1,'still exactly one active assignment -- READY never creates a duplicate');
select is((select id::text from public.driver_assignments where order_id='e1000000-0000-4000-8000-000000000001' and ended_at is null),current_setting('zaytun.e1_assignment_id'),'it is literally the SAME assignment row created at ACCEPT');

-- ============================================================
-- 3. A second compatible order (same branch, default ready-time for
--    both -- gap 0) is added to the SAME driver -- both share one batch.
-- ============================================================
select pg_temp.accept_order('e2000000-0000-4000-8000-000000000001');
select is((select assigned_driver_id from public.orders where id='e2000000-0000-4000-8000-000000000001'),(select assigned_driver_id from public.orders where id='e1000000-0000-4000-8000-000000000001'),'the second compatible order is assigned to the SAME driver');
select is((select pickup_batch_id from public.orders where id='e2000000-0000-4000-8000-000000000001'),(select pickup_batch_id from public.orders where id='e1000000-0000-4000-8000-000000000001'),'both orders share the same pickup batch');
select is((select count(*)::integer from public.driver_assignments where driver_id='10000000-0000-0000-0000-000000000003' and ended_at is null),2,'the driver now holds exactly two active assignments');

-- ============================================================
-- 4. A third order is correctly refused (capacity=2 exhausted) -- safely
--    recorded via the standby fallback, never silently lost.
-- ============================================================
select pg_temp.accept_order('e3000000-0000-4000-8000-000000000001');
select is((select assigned_driver_id from public.orders where id='e3000000-0000-4000-8000-000000000001'),null,'a third order is not assigned once the sole eligible driver is at capacity');
select is((select count(*)::integer from public.driver_standby_notices where order_id='e3000000-0000-4000-8000-000000000001'),1,'it is safely recorded as waiting for a driver, not silently lost');

-- ============================================================
-- 5. Completion releases exactly one slot, and the same terminal-
--    transition's own redispatch sweep immediately fills it with the
--    waiting third order -- no client involvement, no separate step. The
--    driver correctly still shows BUSY (availability-conditional fix)
--    since they still hold active work.
-- ============================================================
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.accept_assignment('e1000000-0000-4000-8000-000000000001'::uuid);
select public.transition_order('e1000000-0000-4000-8000-000000000001'::uuid,'PICKED_UP',null,null);
select public.transition_order('e1000000-0000-4000-8000-000000000001'::uuid,'ON_THE_WAY',null,null);
select public.transition_order('e1000000-0000-4000-8000-000000000001'::uuid,'ARRIVED',null,null);
select public.transition_order('e1000000-0000-4000-8000-000000000001'::uuid,'DELIVERED',null,null);
reset role;
-- The terminal transition's own redispatch sweep is synchronous (same
-- call, same transaction) -- capacity frees AND the waiting third order
-- is picked up immediately, so the count is back to 2 (e2 + newly
-- auto-assigned e3) by the time this is checked, not left at 1.
select is((select count(*)::integer from public.driver_assignments where driver_id='10000000-0000-0000-0000-000000000003' and ended_at is null),2,'completing the first order frees a slot, and the same terminal-transition sweep immediately fills it with the waiting third order');
select isnt((select assigned_driver_id from public.orders where id='e3000000-0000-4000-8000-000000000001'),null,'the previously-waiting third order is picked up automatically once capacity opens, with no separate client action');
select is((select availability::text from public.drivers where id='10000000-0000-0000-0000-000000000003'),'BUSY','the driver still shows BUSY -- they still hold active work, not incorrectly freed');

update public.orders set status='CANCELLED' where id in('e2000000-0000-4000-8000-000000000001','e3000000-0000-4000-8000-000000000001');
update public.driver_assignments set ended_at=now(),status='CANCELLED' where driver_id='10000000-0000-0000-0000-000000000003' and ended_at is null;
update public.drivers set availability='AVAILABLE' where id='10000000-0000-0000-0000-000000000003';

-- ============================================================
-- 6. Decline releases capacity (classic path, order already reached
--    DRIVER_ASSIGNED) -- byte-identical semantics to before batching.
-- ============================================================
select pg_temp.accept_order('e4000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.transition_order('e4000000-0000-4000-8000-000000000001'::uuid,'PREPARING',null,null);
select public.transition_order('e4000000-0000-4000-8000-000000000001'::uuid,'READY',null,null);
reset role;
select is((select status::text from public.orders where id='e4000000-0000-4000-8000-000000000001'),'DRIVER_ASSIGNED','order reaches DRIVER_ASSIGNED via the reused early assignment');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.decline_assignment('e4000000-0000-4000-8000-000000000001'::uuid,'CANNOT_GO_NOW');
reset role;
select is((select count(*)::integer from public.driver_assignments where driver_id='10000000-0000-0000-0000-000000000003' and ended_at is null),0,'declining (classic, post-DRIVER_ASSIGNED path) fully releases the driver''s capacity');
select is((select status::text from public.orders where id='e4000000-0000-4000-8000-000000000001'),'READY','the classic decline path reverts the order to READY for redispatch, byte-identical to before');
update public.orders set status='CANCELLED' where id='e4000000-0000-4000-8000-000000000001';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id='e4000000-0000-4000-8000-000000000001' and ended_at is null;
update public.drivers set availability='AVAILABLE' where id='10000000-0000-0000-0000-000000000003';

-- ============================================================
-- 7. Early decline (order never reached READY) -- new capability, not
--    possible before this migration. Status is left untouched. The
--    declining driver is excluded from the immediate retry, so they are
--    never re-offered their own declined order.
-- ============================================================
select pg_temp.accept_order('e5000000-0000-4000-8000-000000000001');
select is((select status::text from public.orders where id='e5000000-0000-4000-8000-000000000001'),'CONFIRMED','order is early-assigned, still CONFIRMED');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select lives_ok($$select public.decline_assignment('e5000000-0000-4000-8000-000000000001'::uuid,'TOO_FAR')$$,'a driver can decline an EARLY (pre-READY) assignment');
reset role;
select is((select status::text from public.orders where id='e5000000-0000-4000-8000-000000000001'),'CONFIRMED','status is left untouched by an early decline -- the order was never READY');
select is((select assigned_driver_id from public.orders where id='e5000000-0000-4000-8000-000000000001'),null,'the declining driver is excluded from the immediate retry (...004 is still paused) -- not silently re-offered to themselves');
select is((select count(*)::integer from public.driver_standby_notices where order_id='e5000000-0000-4000-8000-000000000001'),1,'the order is safely recorded as waiting again');
update public.orders set status='CANCELLED' where id='e5000000-0000-4000-8000-000000000001';

-- ============================================================
-- 8. Compatibility: a clearly incompatible ready-time gap does not force
--    batching -- the order is left safely pending instead.
-- ============================================================
select pg_temp.accept_order('e6000000-0000-4000-8000-000000000001');
update public.orders set estimated_minutes=10 where id='e6000000-0000-4000-8000-000000000001'; -- driver's one active order: ready ~10 min after accept
select pg_temp.accept_order('e7000000-0000-4000-8000-000000000001');
update public.orders set estimated_minutes=170 where id='e7000000-0000-4000-8000-000000000001'; -- forces a re-attempt below; this order alone has a huge gap vs e6
select public.attempt_dispatch_sweep_internal(); -- re-evaluate now that the estimate is set
select is((select assigned_driver_id from public.orders where id='e7000000-0000-4000-8000-000000000001'),null,'a clearly incompatible ready-time gap (160 min) does not force batching onto the busy driver');
select is((select count(*)::integer from public.driver_standby_notices where order_id='e7000000-0000-4000-8000-000000000001'),1,'it is safely recorded as waiting instead');
update public.orders set status='CANCELLED' where id in('e6000000-0000-4000-8000-000000000001','e7000000-0000-4000-8000-000000000001');
update public.driver_assignments set ended_at=now(),status='CANCELLED' where driver_id='10000000-0000-0000-0000-000000000003' and ended_at is null;
update public.drivers set availability='AVAILABLE' where id='10000000-0000-0000-0000-000000000003';

-- ============================================================
-- 9. Compatibility: a driver who has already departed (picked up another
--    order) is not offered a fresh restaurant pickup even though
--    technically under capacity.
-- ============================================================
select pg_temp.accept_order('e8000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.transition_order('e8000000-0000-4000-8000-000000000001'::uuid,'PREPARING',null,null);
select public.transition_order('e8000000-0000-4000-8000-000000000001'::uuid,'READY',null,null);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.accept_assignment('e8000000-0000-4000-8000-000000000001'::uuid);
select public.transition_order('e8000000-0000-4000-8000-000000000001'::uuid,'PICKED_UP',null,null);
reset role;
select pg_temp.accept_order('e9000000-0000-4000-8000-000000000001');
select is((select assigned_driver_id from public.orders where id='e9000000-0000-4000-8000-000000000001'),null,'a driver who has already picked up another order is not offered a new restaurant pickup, despite being under capacity');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.transition_order('e8000000-0000-4000-8000-000000000001'::uuid,'ON_THE_WAY',null,null);
select public.transition_order('e8000000-0000-4000-8000-000000000001'::uuid,'ARRIVED',null,null);
select public.transition_order('e8000000-0000-4000-8000-000000000001'::uuid,'DELIVERED',null,null);
reset role;
update public.orders set status='CANCELLED' where id='e9000000-0000-4000-8000-000000000001';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where driver_id='10000000-0000-0000-0000-000000000003' and ended_at is null;
update public.drivers set availability='AVAILABLE' where id='10000000-0000-0000-0000-000000000003';

-- ============================================================
-- 10. Actual-wait expiry: once the configured wait window (since the
--     batch's first member became READY) has elapsed, a still-not-ready
--     sibling is fully RELEASED from the departing driver, not just
--     unbatched -- the assignment is closed (SUPERSEDED, capacity freed)
--     and it is put straight back through server-authoritative
--     redispatch. It is never left silently owned by a driver who has
--     already departed with the other delivery. The departing driver's
--     own batch (down to just the departed order) advances OPEN ->
--     IN_TRANSIT the same call.
-- ============================================================
select pg_temp.accept_order('ea000000-0000-4000-8000-000000000001');
select pg_temp.accept_order('eb000000-0000-4000-8000-000000000001'); -- batches with ea (gap 0, same branch)
select is((select pickup_batch_id from public.orders where id='eb000000-0000-4000-8000-000000000001'),(select pickup_batch_id from public.orders where id='ea000000-0000-4000-8000-000000000001'),'both orders share a batch, as a baseline for the wait scenario');
select is((select status::text from public.pickup_batches where id=(select pickup_batch_id from public.orders where id='ea000000-0000-4000-8000-000000000001')),'OPEN','the batch starts OPEN');
select set_config('zaytun.eb_assignment_id',(select id::text from public.driver_assignments where order_id='eb000000-0000-4000-8000-000000000001' and ended_at is null),true);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.transition_order('ea000000-0000-4000-8000-000000000001'::uuid,'PREPARING',null,null);
select public.transition_order('ea000000-0000-4000-8000-000000000001'::uuid,'READY',null,null); -- sets first_member_ready_at
reset role;
-- Backdate first_member_ready_at well past the configured wait window --
-- eb never actually became READY (still CONFIRMED), simulating a
-- delayed second order.
update public.pickup_batches set first_member_ready_at = now() - interval '30 minutes' where id = (select pickup_batch_id from public.orders where id='ea000000-0000-4000-8000-000000000001');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.accept_assignment('ea000000-0000-4000-8000-000000000001'::uuid);
select public.transition_order('ea000000-0000-4000-8000-000000000001'::uuid,'PICKED_UP',null,null); -- triggers the actual-wait evaluation
reset role;
select is((select pickup_batch_id from public.orders where id='eb000000-0000-4000-8000-000000000001'),null,'the still-not-ready sibling is detached from the batch once the wait window has elapsed');
select is((select assigned_driver_id from public.orders where id='eb000000-0000-4000-8000-000000000001'),null,'and fully released -- NOT left silently owned by the now-departed driver (...004 stays paused, so no other candidate exists to redispatch to)');
select is((select status::text from public.driver_assignments where id=current_setting('zaytun.eb_assignment_id')::uuid),'SUPERSEDED','the closed assignment is recorded as SUPERSEDED, preserving assignment history rather than being deleted');
select isnt((select ended_at from public.driver_assignments where id=current_setting('zaytun.eb_assignment_id')::uuid),null,'its ended_at is set');
select is((select count(*)::integer from public.driver_standby_notices where order_id='eb000000-0000-4000-8000-000000000001'),1,'it is safely put back through redispatch and recorded as waiting again, not lost');
select is((select status::text from public.pickup_batches where id=(select pickup_batch_id from public.orders where id='ea000000-0000-4000-8000-000000000001')),'IN_TRANSIT','the departing driver''s own batch (down to just ea) has advanced to IN_TRANSIT');
update public.orders set status='CANCELLED' where id in('ea000000-0000-4000-8000-000000000001','eb000000-0000-4000-8000-000000000001');
update public.driver_assignments set ended_at=now(),status='CANCELLED' where driver_id='10000000-0000-0000-0000-000000000003' and ended_at is null;
update public.drivers set availability='AVAILABLE' where id='10000000-0000-0000-0000-000000000003';

-- ============================================================
-- 11. Stop-sequence determinism: computed once, at first PICKED_UP,
--     nearest-to-restaurant (smallest delivery_distance_km) first.
-- ============================================================
select pg_temp.accept_order('ec000000-0000-4000-8000-000000000001');
select pg_temp.accept_order('ed000000-0000-4000-8000-000000000001');
update public.customer_addresses set delivery_distance_km=5.0 where order_id='ec000000-0000-4000-8000-000000000001'; -- far
update public.customer_addresses set delivery_distance_km=1.2 where order_id='ed000000-0000-4000-8000-000000000001'; -- near
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.transition_order('ec000000-0000-4000-8000-000000000001'::uuid,'PREPARING',null,null);
select public.transition_order('ec000000-0000-4000-8000-000000000001'::uuid,'READY',null,null);
select public.transition_order('ed000000-0000-4000-8000-000000000001'::uuid,'PREPARING',null,null);
select public.transition_order('ed000000-0000-4000-8000-000000000001'::uuid,'READY',null,null);
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.accept_assignment('ec000000-0000-4000-8000-000000000001'::uuid);
select public.transition_order('ec000000-0000-4000-8000-000000000001'::uuid,'PICKED_UP',null,null);
reset role;
select is((select stop_sequence from public.orders where id='ed000000-0000-4000-8000-000000000001'),1,'the nearer stop (1.2km) is sequenced first');
select is((select stop_sequence from public.orders where id='ec000000-0000-4000-8000-000000000001'),2,'the farther stop (5.0km) is sequenced second, even though it was picked up first');
update public.orders set status='CANCELLED' where id in('ec000000-0000-4000-8000-000000000001','ed000000-0000-4000-8000-000000000001');
update public.driver_assignments set ended_at=now(),status='CANCELLED' where driver_id='10000000-0000-0000-0000-000000000003' and ended_at is null;
update public.drivers set availability='AVAILABLE' where id='10000000-0000-0000-0000-000000000003';

-- ============================================================
-- 12. Capacity is concurrency-safe: the same row-locking pattern
--     assign_driver_internal already relies on (proven by
--     automatic_dispatch.test.sql scenario 4) applies identically here
--     -- two sequential attempts against a driver with exactly one slot
--     remaining never both succeed. Genuine cross-session concurrency is
--     additionally proven by a standalone script issuing real
--     simultaneous RPC calls (outside what a single-connection pgTAP
--     script can directly simulate).
-- ============================================================
update public.drivers set delivery_capacity=1 where id='10000000-0000-0000-0000-000000000003';
select pg_temp.accept_order('ee000000-0000-4000-8000-000000000001');
select pg_temp.accept_order('ef000000-0000-4000-8000-000000000001'); -- capacity already exhausted by ee
select is((select count(*)::integer from public.driver_assignments where driver_id='10000000-0000-0000-0000-000000000003' and ended_at is null),1,'capacity=1 admits exactly one active assignment, never two, across two immediately-sequential accept attempts');
update public.orders set status='CANCELLED' where id in('ee000000-0000-4000-8000-000000000001','ef000000-0000-4000-8000-000000000001');
update public.driver_assignments set ended_at=now(),status='CANCELLED' where driver_id='10000000-0000-0000-0000-000000000003' and ended_at is null;
update public.drivers set delivery_capacity=2,availability='AVAILABLE' where id='10000000-0000-0000-0000-000000000003';

-- ============================================================
-- 13. Batch lifecycle: OPEN -> READY_TO_DEPART -> IN_TRANSIT -> COMPLETED,
--     the normal happy path with no actual-wait timeout involved (both
--     members become READY well within the window).
-- ============================================================
select pg_temp.accept_order('f0000000-0000-4000-8000-000000000001');
select is((select status::text from public.pickup_batches where id=(select pickup_batch_id from public.orders where id='f0000000-0000-4000-8000-000000000001')),'OPEN','a fresh batch starts OPEN');
select pg_temp.accept_order('f1000000-0000-4000-8000-000000000001'); -- batches with eg (gap 0, same branch)
select is((select pickup_batch_id from public.orders where id='f1000000-0000-4000-8000-000000000001'),(select pickup_batch_id from public.orders where id='f0000000-0000-4000-8000-000000000001'),'both orders share a batch');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.transition_order('f0000000-0000-4000-8000-000000000001'::uuid,'PREPARING',null,null);
select public.transition_order('f0000000-0000-4000-8000-000000000001'::uuid,'READY',null,null);
reset role;
select is((select status::text from public.pickup_batches where id=(select pickup_batch_id from public.orders where id='f0000000-0000-4000-8000-000000000001')),'OPEN','still OPEN -- eh has not become READY yet, so there is still something to wait for');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.transition_order('f1000000-0000-4000-8000-000000000001'::uuid,'PREPARING',null,null);
select public.transition_order('f1000000-0000-4000-8000-000000000001'::uuid,'READY',null,null);
reset role;
select is((select status::text from public.pickup_batches where id=(select pickup_batch_id from public.orders where id='f0000000-0000-4000-8000-000000000001')),'READY_TO_DEPART','both members are now READY -- the batch advances to READY_TO_DEPART with nothing left to wait for');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.accept_assignment('f0000000-0000-4000-8000-000000000001'::uuid);
select public.accept_assignment('f1000000-0000-4000-8000-000000000001'::uuid);
select public.transition_order('f0000000-0000-4000-8000-000000000001'::uuid,'PICKED_UP',null,null);
reset role;
select is((select status::text from public.pickup_batches where id=(select pickup_batch_id from public.orders where id='f0000000-0000-4000-8000-000000000001')),'IN_TRANSIT','the driver has now genuinely departed with at least one member -- IN_TRANSIT');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.transition_order('f0000000-0000-4000-8000-000000000001'::uuid,'ON_THE_WAY',null,null);
select public.transition_order('f0000000-0000-4000-8000-000000000001'::uuid,'ARRIVED',null,null);
select public.transition_order('f0000000-0000-4000-8000-000000000001'::uuid,'DELIVERED',null,null);
select public.transition_order('f1000000-0000-4000-8000-000000000001'::uuid,'PICKED_UP',null,null);
select public.transition_order('f1000000-0000-4000-8000-000000000001'::uuid,'ON_THE_WAY',null,null);
select public.transition_order('f1000000-0000-4000-8000-000000000001'::uuid,'ARRIVED',null,null);
select public.transition_order('f1000000-0000-4000-8000-000000000001'::uuid,'DELIVERED',null,null);
reset role;
select is((select status::text from public.pickup_batches where id=(select pickup_batch_id from public.orders where id='f0000000-0000-4000-8000-000000000001')),'COMPLETED','both members delivered -- the batch reaches COMPLETED');
update public.drivers set availability='AVAILABLE' where id='10000000-0000-0000-0000-000000000003';

-- ============================================================
-- 14. Driver selection must continue after an incompatible/failing
--     candidate: a capacity-available driver whose assignment attempt
--     fails must not terminate the whole dispatch attempt when a
--     different eligible driver exists. Deterministically forced via the
--     test-only zaytun.test_force_assign_failure_for_driver hook (a real
--     race between phase-1/2 candidate selection and
--     assign_driver_early_internal's own row-locked re-check is what this
--     stands in for -- see the hook's own comment).
-- ============================================================
-- ...004 stays PAUSED for this baseline order (as it has been throughout
-- the file) so ...003 is deterministically the sole eligible candidate --
-- avoids depending on select_best_driver_internal's assigned_at
-- nulls-first tie-break, which would otherwise favor whichever driver has
-- no prior assignment history in this test run.
select pg_temp.accept_order('f2000000-0000-4000-8000-000000000001'); -- driver ...003's one active order (compatible partner candidate)
select is((select assigned_driver_id from public.orders where id='f2000000-0000-4000-8000-000000000001'),'10000000-0000-0000-0000-000000000003','baseline: the sole existing order goes to ...003 as expected');
update public.drivers set dispatch_status='ACTIVE' where id='10000000-0000-0000-0000-000000000004'; -- now genuinely eligible, 0 active
select set_config('zaytun.test_force_assign_failure_for_driver','10000000-0000-0000-0000-000000000003',true);
select pg_temp.accept_order('f3000000-0000-4000-8000-000000000001'); -- would normally batch with ei onto ...003 (phase 1's natural first pick)
select set_config('zaytun.test_force_assign_failure_for_driver','',true);
select is((select assigned_driver_id from public.orders where id='f3000000-0000-4000-8000-000000000001'),'10000000-0000-0000-0000-000000000004','...003''s attempt was forced to fail, but dispatch continued the search and reached the other genuinely eligible driver instead of giving up');
update public.orders set status='CANCELLED' where id in('f2000000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001');
update public.driver_assignments set ended_at=now(),status='CANCELLED' where driver_id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004') and ended_at is null;
update public.drivers set availability='AVAILABLE' where id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
update public.drivers set dispatch_status='ACTIVE' where id='10000000-0000-0000-0000-000000000004';

select * from finish();
rollback;
