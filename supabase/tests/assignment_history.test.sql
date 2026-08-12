begin;
select plan(15);

-- Smart Dispatch v1, Phase 2: driver_assignments gains an explicit status
-- classification and a partial (active-only) uniqueness constraint,
-- replacing the old whole-lifetime UNIQUE(order_id). decline/manual-
-- supersede get their own dedicated RPC-level tests in Phase 6; here we
-- verify the schema itself (constraint shape, and every transition_order-
-- driven ending) is correct.

select has_column('public','driver_assignments','status','driver_assignments record why an assignment ended');
select has_column('public','driver_assignments','declined_at','driver_assignments record decline timing separately');
select ok(not exists(select 1 from pg_constraint where conname='driver_assignments_order_id_key'),'the old whole-lifetime UNIQUE(order_id) constraint is gone');
select ok(exists(select 1 from pg_indexes where indexname='driver_assignments_active_order_idx'),'a partial unique index protects at-most-one-active-assignment');

-- assign -> accept -> DELIVERED leaves a COMPLETED history row.
select public.create_public_order('{"id":"97000000-0000-4000-8000-000000000001","customer":{"name":"History Complete","primaryPhone":"+998900000040"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-12T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.review_delivery_request('97000000-0000-4000-8000-000000000001',true,null);
select public.transition_order('97000000-0000-4000-8000-000000000001','CONFIRMED',null,null);
select public.transition_order('97000000-0000-4000-8000-000000000001','PREPARING',null,null);
select public.transition_order('97000000-0000-4000-8000-000000000001','READY',null,null);
select public.assign_driver('97000000-0000-4000-8000-000000000001','10000000-0000-0000-0000-000000000003');
reset role;
select is((select status::text from public.driver_assignments where order_id='97000000-0000-4000-8000-000000000001'),'ASSIGNED','assign_driver leaves ASSIGNED');

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.accept_assignment('97000000-0000-4000-8000-000000000001');
reset role;
select is((select status::text from public.driver_assignments where order_id='97000000-0000-4000-8000-000000000001'),'ACCEPTED','accept_assignment leaves ACCEPTED');

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.transition_order('97000000-0000-4000-8000-000000000001','PICKED_UP',null,null);
select public.transition_order('97000000-0000-4000-8000-000000000001','ON_THE_WAY',null,null);
select public.transition_order('97000000-0000-4000-8000-000000000001','ARRIVED',null,null);
select public.transition_order('97000000-0000-4000-8000-000000000001','DELIVERED',null,null);
reset role;
select is((select status::text from public.driver_assignments where order_id='97000000-0000-4000-8000-000000000001'),'COMPLETED','DELIVERED leaves COMPLETED');
select isnt((select ended_at from public.driver_assignments where order_id='97000000-0000-4000-8000-000000000001'),null,'COMPLETED assignment has ended_at set');

-- A second order, driven to DELIVERY_FAILED, then on to RETURNED. RETURNED
-- is only reachable from DELIVERY_FAILED for an already-ended assignment
-- (assert_transition requires DELIVERY_FAILED->RETURNED here since the
-- courier already failed the delivery first) -- the assignment row is
-- already ended_at-set at the FAILED step, so the terminal-branch update's
-- `where ended_at is null` guard correctly leaves it alone: FAILED is the
-- durable, accurate record of what the courier's attempt actually was,
-- and RETURNED is a subsequent order-level outcome, not a re-classification
-- of the courier's own assignment.
select public.create_public_order('{"id":"97000000-0000-4000-8000-000000000002","customer":{"name":"History Failed","primaryPhone":"+998900000041"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-12T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.review_delivery_request('97000000-0000-4000-8000-000000000002',true,null);
select public.transition_order('97000000-0000-4000-8000-000000000002','CONFIRMED',null,null);
select public.transition_order('97000000-0000-4000-8000-000000000002','PREPARING',null,null);
select public.transition_order('97000000-0000-4000-8000-000000000002','READY',null,null);
select public.assign_driver('97000000-0000-4000-8000-000000000002','10000000-0000-0000-0000-000000000003');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.accept_assignment('97000000-0000-4000-8000-000000000002');
select public.transition_order('97000000-0000-4000-8000-000000000002','PICKED_UP',null,null);
select public.transition_order('97000000-0000-4000-8000-000000000002','ON_THE_WAY',null,null);
select public.transition_order('97000000-0000-4000-8000-000000000002','DELIVERY_FAILED','Mijoz javob bermadi',null);
reset role;
select is((select status::text from public.driver_assignments where order_id='97000000-0000-4000-8000-000000000002'),'FAILED','DELIVERY_FAILED leaves FAILED');

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.transition_order('97000000-0000-4000-8000-000000000002','RETURNED',null,null);
reset role;
select is((select status::text from public.driver_assignments where order_id='97000000-0000-4000-8000-000000000002'),'FAILED','a later RETURNED order transition does not re-touch the already-ended FAILED assignment row');

-- A different order, RETURNED reached *directly* (courier had to turn
-- back without the delivery ever formally failing first) -- this path
-- hits the assignment row while it is still active (ended_at null), so it
-- correctly gets classified RETURNED, not left at ASSIGNED/ACCEPTED.
select public.create_public_order('{"id":"97000000-0000-4000-8000-000000000004","customer":{"name":"History Returned Directly","primaryPhone":"+998900000043"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-12T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.review_delivery_request('97000000-0000-4000-8000-000000000004',true,null);
select public.transition_order('97000000-0000-4000-8000-000000000004','CONFIRMED',null,null);
select public.transition_order('97000000-0000-4000-8000-000000000004','PREPARING',null,null);
select public.transition_order('97000000-0000-4000-8000-000000000004','READY',null,null);
select public.assign_driver('97000000-0000-4000-8000-000000000004','10000000-0000-0000-0000-000000000003');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.accept_assignment('97000000-0000-4000-8000-000000000004');
select public.transition_order('97000000-0000-4000-8000-000000000004','PICKED_UP',null,null);
select public.transition_order('97000000-0000-4000-8000-000000000004','RETURNED',null,null);
reset role;
select is((select status::text from public.driver_assignments where order_id='97000000-0000-4000-8000-000000000004'),'RETURNED','a direct (not failed-first) RETURNED correctly classifies the still-active assignment as RETURNED');

-- A third order, cancelled while a courier was actively assigned.
select public.create_public_order('{"id":"97000000-0000-4000-8000-000000000003","customer":{"name":"History Cancelled","primaryPhone":"+998900000042"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-12T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.review_delivery_request('97000000-0000-4000-8000-000000000003',true,null);
select public.transition_order('97000000-0000-4000-8000-000000000003','CONFIRMED',null,null);
select public.transition_order('97000000-0000-4000-8000-000000000003','PREPARING',null,null);
select public.transition_order('97000000-0000-4000-8000-000000000003','READY',null,null);
select public.assign_driver('97000000-0000-4000-8000-000000000003','10000000-0000-0000-0000-000000000004');
select public.transition_order('97000000-0000-4000-8000-000000000003','CANCELLED','Mijoz bekor qildi',null);
reset role;
select is((select status::text from public.driver_assignments where order_id='97000000-0000-4000-8000-000000000003'),'CANCELLED','CANCELLED while assigned leaves CANCELLED');

-- The partial unique index: a second row is allowed once the first has
-- ended (this is the whole point of Phase 2 -- proves reassignment is now
-- structurally possible), but two simultaneously-active rows are still
-- rejected exactly as before.
select lives_ok(
  $$insert into public.driver_assignments(order_id,driver_id,assigned_by,status) values('97000000-0000-4000-8000-000000000003','10000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000001','ASSIGNED')$$,
  'a new active row is allowed once the prior one has ended_at set'
);
select throws_ok(
  $$insert into public.driver_assignments(order_id,driver_id,assigned_by,status) values('97000000-0000-4000-8000-000000000003','10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001','ASSIGNED')$$,
  '23505',
  null,
  'a second simultaneously-active row for the same order is still rejected'
);
select is((select count(*)::integer from public.driver_assignments where order_id='97000000-0000-4000-8000-000000000003'),2,'full history retained: two rows exist for the reassigned order, not one overwritten row');

select * from finish();
rollback;
