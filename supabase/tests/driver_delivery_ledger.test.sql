begin;
select plan(14);

-- H2: Driver Delivery Ledger. Credit comes strictly from
-- driver_assignments.status, never orders.assigned_driver_id -- so a
-- declined/superseded assignment is never counted as completed work, and a
-- reassigned order's COMPLETED credit lands only on the driver whose own
-- assignment row actually reads COMPLETED.

create or replace function pg_temp.new_order(p_id text, p_branch_id uuid default null) returns void language plpgsql security definer as $$
begin
  perform public.create_public_order(jsonb_build_object(
    'id', p_id, 'customer', jsonb_build_object('name','Ledger Test','primaryPhone','+998900000'||right(p_id,3)),
    'type','DELIVERY','paymentMethod','CASH',
    'address', jsonb_build_object('district','Guliston','street','Test','latitude',40.09,'longitude',65.40,'pinConfirmedAt','2026-08-12T08:00:00Z','locationProvider','mock'),
    'items', jsonb_build_array(jsonb_build_object('menuItemId','plov','quantity',3,'modifierIds','[]'::jsonb))
  ));
  if p_branch_id is not null then
    update public.orders set branch_id=p_branch_id where id=p_id::uuid;
  end if;
end;
$$;
create or replace function pg_temp.new_branch(p_id uuid, p_slug text) returns void language plpgsql security definer as $$
begin
  insert into public.branches(id,name,slug,address,latitude,longitude,active) values (p_id,'Test Branch','ledger-'||p_slug,'Test',40.09,65.40,true);
end;
$$;
-- Raw-insert helper standing in for the not-yet-built decline/reassignment
-- RPC (Smart Dispatch Phase 6): writes a driver_assignments row directly at
-- whatever terminal status/timestamps the test needs.
create or replace function pg_temp.new_assignment(p_order_id text, p_driver_id uuid, p_status public.assignment_status, p_assigned_at timestamptz, p_accepted_at timestamptz default null, p_ended_at timestamptz default null) returns uuid language plpgsql security definer as $$
declare v_id uuid;
begin
  insert into public.driver_assignments(order_id,driver_id,assigned_at,accepted_at,ended_at,status)
  values (p_order_id::uuid, p_driver_id, p_assigned_at, p_accepted_at, p_ended_at, p_status)
  returning id into v_id;
  return v_id;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);

-- 13/16/17. COMPLETED, FAILED, RETURNED each counted in their own bucket.
select pg_temp.new_order('9e000000-0000-4000-8000-000000000001');
select pg_temp.new_assignment('9e000000-0000-4000-8000-000000000001','10000000-0000-0000-0000-000000000003'::uuid,'COMPLETED',now(),now(),now());
select pg_temp.new_order('9e000000-0000-4000-8000-000000000002');
select pg_temp.new_assignment('9e000000-0000-4000-8000-000000000002','10000000-0000-0000-0000-000000000003'::uuid,'FAILED',now(),now(),now());
select pg_temp.new_order('9e000000-0000-4000-8000-000000000003');
select pg_temp.new_assignment('9e000000-0000-4000-8000-000000000003','10000000-0000-0000-0000-000000000003'::uuid,'RETURNED',now(),now(),now());

select is((select completed from public.list_driver_ledger_summary('TODAY') where driver_id='10000000-0000-0000-0000-000000000003'),1,'exactly one COMPLETED assignment is credited to the completing driver');
select is((select failed from public.list_driver_ledger_summary('TODAY') where driver_id='10000000-0000-0000-0000-000000000003'),1,'FAILED is counted in its own bucket, separate from completed');
select is((select returned from public.list_driver_ledger_summary('TODAY') where driver_id='10000000-0000-0000-0000-000000000003'),1,'RETURNED is counted in its own bucket, separate from completed');

-- 14/15. DECLINED and SUPERSEDED are never credited as completed work.
select pg_temp.new_order('9e000000-0000-4000-8000-000000000004');
select pg_temp.new_assignment('9e000000-0000-4000-8000-000000000004','10000000-0000-0000-0000-000000000004'::uuid,'DECLINED',now(),null,now());
select pg_temp.new_order('9e000000-0000-4000-8000-000000000005');
select pg_temp.new_assignment('9e000000-0000-4000-8000-000000000005','10000000-0000-0000-0000-000000000004'::uuid,'SUPERSEDED',now(),null,now());
select is((select completed from public.list_driver_ledger_summary('TODAY') where driver_id='10000000-0000-0000-0000-000000000004'),0,'DECLINED is never credited as a completed delivery');
select is((select declined from public.list_driver_ledger_summary('TODAY') where driver_id='10000000-0000-0000-0000-000000000004'),1,'DECLINED has its own count');
select is((select superseded from public.list_driver_ledger_summary('TODAY') where driver_id='10000000-0000-0000-0000-000000000004'),1,'SUPERSEDED has its own count, also never credited as completed');

-- 18. Reassignment: driver A declined, driver B completed the SAME order --
--     completed credit belongs only to B.
select pg_temp.new_order('9e000000-0000-4000-8000-000000000006');
select pg_temp.new_assignment('9e000000-0000-4000-8000-000000000006','10000000-0000-0000-0000-000000000003'::uuid,'DECLINED',now(),null,now());
select pg_temp.new_assignment('9e000000-0000-4000-8000-000000000006','10000000-0000-0000-0000-000000000004'::uuid,'COMPLETED',now(),now(),now());
select ok(exists(select 1 from public.list_driver_assignment_ledger('10000000-0000-0000-0000-000000000004','TODAY') where order_id='9e000000-0000-4000-8000-000000000006'::uuid and status='COMPLETED'),'the completing driver''s own ledger shows this order as COMPLETED');
select ok(exists(select 1 from public.list_driver_assignment_ledger('10000000-0000-0000-0000-000000000003','TODAY') where order_id='9e000000-0000-4000-8000-000000000006'::uuid and status='DECLINED'),'the declining driver''s own ledger shows this same order as DECLINED, not completed');

-- 19. Same driver across multiple branches aggregates correctly in the
--     franchise-wide summary (no branch filter).
select pg_temp.new_branch('9e000000-0000-4000-9000-000000000001','a');
select pg_temp.new_order('9e000000-0000-4000-8000-000000000007','9e000000-0000-4000-9000-000000000001'::uuid);
select pg_temp.new_assignment('9e000000-0000-4000-8000-000000000007','10000000-0000-0000-0000-000000000003'::uuid,'COMPLETED',now(),now(),now());
select is((select completed from public.list_driver_ledger_summary('TODAY') where driver_id='10000000-0000-0000-0000-000000000003'),2,'completed deliveries across two different branches aggregate into one franchise-wide total for the driver');
select is((select completed from public.list_driver_ledger_summary('TODAY', p_branch_id => '9e000000-0000-4000-9000-000000000001'::uuid) where driver_id='10000000-0000-0000-0000-000000000003'),1,'branch filter narrows the same driver down to just that branch''s completed count');

-- 20. Date range: an assignment assigned yesterday is absent from TODAY,
--     present under YESTERDAY.
select pg_temp.new_order('9e000000-0000-4000-8000-000000000008');
select pg_temp.new_assignment('9e000000-0000-4000-8000-000000000008','10000000-0000-0000-0000-000000000003'::uuid,'COMPLETED',now()-interval '1 day',now()-interval '1 day',now()-interval '1 day');
select ok(not exists(select 1 from public.list_driver_assignment_ledger('10000000-0000-0000-0000-000000000003','TODAY') where order_id='9e000000-0000-4000-8000-000000000008'::uuid),'an assignment from yesterday is absent from TODAY''s ledger');
select ok(exists(select 1 from public.list_driver_assignment_ledger('10000000-0000-0000-0000-000000000003','YESTERDAY') where order_id='9e000000-0000-4000-8000-000000000008'::uuid),'that same assignment appears under the YESTERDAY preset');

reset role;

-- 21. A driver cannot read the franchise-wide ledger at all.
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select throws_ok($$select * from public.list_driver_ledger_summary('TODAY')$$,'42501','STAFF_ROLE_REQUIRED|Xodim roli talab qilinadi','a driver cannot call list_driver_ledger_summary');
select throws_ok($$select * from public.list_driver_assignment_ledger('10000000-0000-0000-0000-000000000003','TODAY')$$,'42501','STAFF_ROLE_REQUIRED|Xodim roli talab qilinadi','a driver cannot call list_driver_assignment_ledger, not even for their own id');
reset role;

select * from finish();
rollback;
