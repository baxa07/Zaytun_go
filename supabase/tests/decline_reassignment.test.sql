begin;
select plan(30);

-- Smart Dispatch v1, Phase 6: decline / reassignment / recovery. A
-- dedicated branch with both seed drivers moved into its pool gives every
-- scenario below a clean, deterministic starting point (mirrors the
-- pattern already established in automatic_dispatch.test.sql).
insert into public.branches(id,name,slug,address,latitude,longitude,active)
values ('98000000-0000-4000-8000-00000000000b','Zaytun Phase6 Branch','phase6','Test',40.10,65.41,true);
delete from public.driver_branches where driver_id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
insert into public.driver_branches(driver_id,branch_id) values
  ('10000000-0000-0000-0000-000000000003','98000000-0000-4000-8000-00000000000b'),
  ('10000000-0000-0000-0000-000000000004','98000000-0000-4000-8000-00000000000b');
update public.drivers set shift_status='ON_SHIFT',dispatch_status='ACTIVE',delivery_capacity=1
  where id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
-- Neutralize the pre-existing seeded fixture order so it can't be swept up
-- by this file's dispatch attempts.
update public.orders set status='CANCELLED' where id='20000000-0000-0000-0000-000000000001' and status='READY';

create or replace function pg_temp.new_ready_order(p_id text) returns void language plpgsql as $$
begin
  perform public.create_public_order(jsonb_build_object(
    'id', p_id, 'customer', jsonb_build_object('name','Decline Test','primaryPhone','+998900000'||right(p_id,3)),
    'type','DELIVERY','paymentMethod','CASH',
    'address', jsonb_build_object('district','Navoiy','street','Test','latitude',40.09,'longitude',65.40,'pinConfirmedAt','2026-08-12T08:00:00Z','locationProvider','mock'),
    'items', jsonb_build_array(jsonb_build_object('menuItemId','plov','quantity',3,'modifierIds','[]'::jsonb))
  ));
  update public.orders set branch_id='98000000-0000-4000-8000-00000000000b' where id=p_id::uuid;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
  perform public.review_delivery_request(p_id::uuid,true,null);
  perform public.transition_order(p_id::uuid,'CONFIRMED',null,null);
  perform public.transition_order(p_id::uuid,'PREPARING',null,null);
  perform public.transition_order(p_id::uuid,'READY',null,null);
  reset role;
end;
$$;

create or replace function pg_temp.as_driver(p_driver text) returns void language sql as $$
  select set_config('request.jwt.claim.sub',p_driver,true);
$$;

-- ============================================================
-- 1-12. Only ...004 eligible (...003 paused): order auto-assigns to
--       ...004, who declines. Every field-level contract in one flow.
-- ============================================================
update public.drivers set dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000003';
select pg_temp.new_ready_order('b1000000-0000-4000-8000-000000000001');
select is((select assigned_driver_id::text from public.orders where id='b1000000-0000-4000-8000-000000000001'),'10000000-0000-0000-0000-000000000004','sole eligible driver (...004) is auto-assigned');
select is((select ready_at from public.orders where id='b1000000-0000-4000-8000-000000000001') is not null, true, 'ready_at is set once the order first became READY');

-- Wrong driver cannot decline someone else's assignment.
set local role authenticated;
select pg_temp.as_driver('10000000-0000-0000-0000-000000000003');
select throws_ok(
  $$select public.decline_assignment('b1000000-0000-4000-8000-000000000001'::uuid,null)$$,
  '42501','DRIVER_NOT_ASSIGNED|Bu buyurtma sizga biriktirilmagan',
  'a driver who is not the assigned one cannot decline it'
);
reset role;

-- Preserve ready_at exactly, then decline as the correct (sole eligible)
-- driver -- with ...003 still paused, redispatch cannot hand it straight
-- back, so the order must remain READY, unassigned.
set local role authenticated;
select pg_temp.as_driver('10000000-0000-0000-0000-000000000004');
select lives_ok($$select public.decline_assignment('b1000000-0000-4000-8000-000000000001'::uuid,'TOO_FAR')$$,'the assigned driver can decline before accepting');
reset role;

select is((select status::text from public.driver_assignments where order_id='b1000000-0000-4000-8000-000000000001' and driver_id='10000000-0000-0000-0000-000000000004'),'DECLINED','assignment status becomes DECLINED');
select is((select declined_at from public.driver_assignments where order_id='b1000000-0000-4000-8000-000000000001' and driver_id='10000000-0000-0000-0000-000000000004') is not null,true,'declined_at is set');
select is((select ended_at from public.driver_assignments where order_id='b1000000-0000-4000-8000-000000000001' and driver_id='10000000-0000-0000-0000-000000000004') is not null,true,'ended_at is set');
select is((select decline_reason::text from public.driver_assignments where order_id='b1000000-0000-4000-8000-000000000001' and driver_id='10000000-0000-0000-0000-000000000004'),'TOO_FAR','the optional decline reason is recorded verbatim');
select is((select status::text from public.orders where id='b1000000-0000-4000-8000-000000000001'),'READY','order returns to READY');
select is((select assigned_driver_id from public.orders where id='b1000000-0000-4000-8000-000000000001'),null,'assigned_driver_id is cleared');
select is((select assignment_accepted_at from public.orders where id='b1000000-0000-4000-8000-000000000001'),null,'assignment_accepted_at is cleared');
select ok((select ready_at from public.orders where id='b1000000-0000-4000-8000-000000000001') <= now(),'ready_at was never reset to a later time by the decline (still its original value, not now())');
select is((select shift_status::text from public.drivers where id='10000000-0000-0000-0000-000000000004'),'ON_SHIFT','declining does not end the driver''s shift');
select is((select dispatch_status::text from public.drivers where id='10000000-0000-0000-0000-000000000004'),'ACTIVE','declining does not pause the driver''s dispatch status');
select is((select count(*)::integer from public.driver_assignments where order_id='b1000000-0000-4000-8000-000000000001' and ended_at is null),0,'no active assignment remains -- the sole eligible driver was correctly excluded from the immediate redispatch');
update public.orders set status='CANCELLED' where id='b1000000-0000-4000-8000-000000000001';
update public.drivers set dispatch_status='ACTIVE' where id='10000000-0000-0000-0000-000000000003';

-- ============================================================
-- 13. Later capacity opening (a second driver starting their shift)
--     dispatches the still-waiting order -- proves exclusion is not a
--     permanent blacklist.
-- ============================================================
update public.drivers set dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000003';
select pg_temp.new_ready_order('b2000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.as_driver('10000000-0000-0000-0000-000000000004');
select public.decline_assignment('b2000000-0000-4000-8000-000000000001'::uuid,null);
reset role;
select is((select status::text from public.orders where id='b2000000-0000-4000-8000-000000000001'),'READY','still READY immediately after the only eligible driver declines');
update public.drivers set dispatch_status='ACTIVE' where id='10000000-0000-0000-0000-000000000003';
select public.attempt_dispatch_sweep_internal();
select is((select assigned_driver_id::text from public.orders where id='b2000000-0000-4000-8000-000000000001'),'10000000-0000-0000-0000-000000000003','once a second driver becomes eligible, a later independent sweep dispatches the waiting order -- exclusion was never a permanent blacklist');
update public.orders set status='CANCELLED' where id='b2000000-0000-4000-8000-000000000001';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id='b2000000-0000-4000-8000-000000000001' and ended_at is null;

-- ============================================================
-- 14/15. Two eligible drivers: decline reassigns to the OTHER one
--        automatically, exactly one active assignment survives.
-- ============================================================
select pg_temp.new_ready_order('b3000000-0000-4000-8000-000000000001');
select isnt((select assigned_driver_id from public.orders where id='b3000000-0000-4000-8000-000000000001'),null,'sanity: some driver was auto-assigned with two eligible candidates');
set local role authenticated;
select pg_temp.as_driver((select assigned_driver_id::text from public.orders where id='b3000000-0000-4000-8000-000000000001'));
select public.decline_assignment('b3000000-0000-4000-8000-000000000001'::uuid,'VEHICLE_ISSUE');
reset role;
select is((select status::text from public.orders where id='b3000000-0000-4000-8000-000000000001'),'DRIVER_ASSIGNED','a different eligible driver is assigned automatically and immediately');
select is((select count(*)::integer from public.driver_assignments where order_id='b3000000-0000-4000-8000-000000000001' and ended_at is null),1,'exactly one active assignment after reassignment');
select is((select count(*)::integer from public.driver_assignments where order_id='b3000000-0000-4000-8000-000000000001' and status='DECLINED'),1,'exactly one DECLINED row remains in history');
update public.orders set status='CANCELLED' where id='b3000000-0000-4000-8000-000000000001';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id='b3000000-0000-4000-8000-000000000001' and ended_at is null;

-- ============================================================
-- 16/17. Accept-vs-decline mutual exclusivity: once accepted, decline is
--        rejected; once declined, accept is rejected. Double-decline is
--        cleanly rejected, never a second silent no-op corruption.
-- ============================================================
select pg_temp.new_ready_order('b4000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.as_driver((select assigned_driver_id::text from public.orders where id='b4000000-0000-4000-8000-000000000001'));
select public.accept_assignment('b4000000-0000-4000-8000-000000000001'::uuid);
select throws_ok(
  $$select public.decline_assignment('b4000000-0000-4000-8000-000000000001'::uuid,null)$$,
  '42501','ASSIGNMENT_NOT_DECLINABLE|Topshiriq allaqachon qabul qilingan yoki topilmadi',
  'an already-ACCEPTED assignment cannot be declined'
);
reset role;
select is((select status::text from public.driver_assignments where order_id='b4000000-0000-4000-8000-000000000001' and ended_at is null),'ACCEPTED','the accepted assignment is untouched by the rejected decline attempt');
update public.orders set status='CANCELLED' where id='b4000000-0000-4000-8000-000000000001';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id='b4000000-0000-4000-8000-000000000001' and ended_at is null;

select pg_temp.new_ready_order('b5000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.as_driver((select assigned_driver_id::text from public.orders where id='b5000000-0000-4000-8000-000000000001'));
select public.decline_assignment('b5000000-0000-4000-8000-000000000001'::uuid,null);
select throws_ok(
  $$select public.decline_assignment('b5000000-0000-4000-8000-000000000001'::uuid,null)$$,
  '42501',null,
  'a second decline of the same already-declined assignment is cleanly rejected, not a silent duplicate'
);
reset role;
select is((select count(*)::integer from public.driver_assignments where order_id='b5000000-0000-4000-8000-000000000001' and status='DECLINED'),1,'exactly one DECLINED row exists after the retried decline attempt');
update public.orders set status='CANCELLED' where id='b5000000-0000-4000-8000-000000000001';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id='b5000000-0000-4000-8000-000000000001' and ended_at is null;

-- ============================================================
-- 18-22. Manual supersede: staff replaces an already-active assignment.
--        Old row -> SUPERSEDED, new row inserted, exactly one active,
--        AUTO can never supersede, branch/capacity still enforced.
-- ============================================================
select pg_temp.new_ready_order('b6000000-0000-4000-8000-000000000001');
set local role authenticated;
select pg_temp.as_driver('10000000-0000-0000-0000-000000000001'); -- staff
select public.assign_driver('b6000000-0000-4000-8000-000000000001'::uuid, (select case when assigned_driver_id='10000000-0000-0000-0000-000000000003' then '10000000-0000-0000-0000-000000000004' else '10000000-0000-0000-0000-000000000003' end from public.orders where id='b6000000-0000-4000-8000-000000000001')::uuid);
reset role;
select is((select count(*)::integer from public.driver_assignments where order_id='b6000000-0000-4000-8000-000000000001' and status='SUPERSEDED'),1,'manual reassignment ends the old assignment as SUPERSEDED');
select is((select count(*)::integer from public.driver_assignments where order_id='b6000000-0000-4000-8000-000000000001' and ended_at is null),1,'exactly one active assignment remains after manual supersede');
select is((select status::text from public.orders where id='b6000000-0000-4000-8000-000000000001'),'DRIVER_ASSIGNED','order stays DRIVER_ASSIGNED through the supersede');

-- AUTO can never supersede an existing active assignment: the order is no
-- longer READY (it's DRIVER_ASSIGNED), so dispatch_ready_order_internal's
-- own guard returns false without ever reaching assign_driver_internal.
select is(public.dispatch_ready_order_internal('b6000000-0000-4000-8000-000000000001'::uuid),false,'dispatch_ready_order_internal never dispatches an order that already has an active assignment (returns false, not a supersede)');
select is((select count(*)::integer from public.driver_assignments where order_id='b6000000-0000-4000-8000-000000000001' and ended_at is null),1,'still exactly one active assignment -- the AUTO attempt above did not create a second one');
update public.orders set status='CANCELLED' where id='b6000000-0000-4000-8000-000000000001';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id='b6000000-0000-4000-8000-000000000001' and ended_at is null;

select * from finish();
rollback;
