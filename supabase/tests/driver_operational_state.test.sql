begin;
select plan(17);

-- Smart Dispatch v1, Phase 1: shift/dispatch/capacity as three orthogonal
-- concepts, replacing (eventually) the single conflated `availability`.

select has_column('public','drivers','shift_status','drivers track shift presence');
select has_column('public','drivers','dispatch_status','drivers track dispatch acceptance');
select has_column('public','drivers','delivery_capacity','drivers track workload capacity');

-- Backfill: seed drivers were AVAILABLE -- must land ON_SHIFT/ACTIVE, never
-- OFF_SHIFT, and `availability` itself is left completely untouched by
-- this migration (still authoritative for manual assignment).
select is((select shift_status::text from public.drivers where id='10000000-0000-0000-0000-000000000003'),'ON_SHIFT','AVAILABLE backfills to ON_SHIFT');
select is((select dispatch_status::text from public.drivers where id='10000000-0000-0000-0000-000000000003'),'ACTIVE','backfill defaults dispatch_status to ACTIVE');
select is((select delivery_capacity from public.drivers where id='10000000-0000-0000-0000-000000000003'),1,'delivery_capacity defaults to 1');
select is((select availability::text from public.drivers where id='10000000-0000-0000-0000-000000000003'),'AVAILABLE','availability itself is untouched by this migration');

-- Self-service RPCs: a driver can only ever act on their own row (no
-- order/driver id parameter exists to target anyone else).
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select lives_ok($$select public.end_shift()$$,'driver can end their own shift');
select is((select shift_status::text from public.drivers where id='10000000-0000-0000-0000-000000000003'),'OFF_SHIFT','end_shift sets OFF_SHIFT');
select throws_ok($$select public.pause_dispatch()$$,'42501','NOT_ON_SHIFT|Avval ishni boshlang','cannot pause while off shift');
select lives_ok($$select public.start_shift()$$,'driver can start their own shift');
select is((select shift_status::text from public.drivers where id='10000000-0000-0000-0000-000000000003'),'ON_SHIFT','start_shift sets ON_SHIFT');
select lives_ok($$select public.pause_dispatch()$$,'driver can pause while on shift');
select is((select dispatch_status::text from public.drivers where id='10000000-0000-0000-0000-000000000003'),'PAUSED','pause_dispatch sets PAUSED');
select lives_ok($$select public.resume_dispatch()$$,'driver can resume from paused');
reset role;

-- end_shift must reject while an active assignment exists.
select public.create_public_order('{"id":"96000000-0000-4000-8000-000000000001","customer":{"name":"Shift Guard Test","primaryPhone":"+998900000030"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"ayran","quantity":1,"modifierIds":[]}]}'::jsonb);
insert into public.driver_assignments(order_id,driver_id,assigned_by) values('96000000-0000-4000-8000-000000000001','10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select throws_ok($$select public.end_shift()$$,'42501','ACTIVE_ASSIGNMENTS_EXIST|Faol yetkazishlar tugagach ishni tugating','end_shift rejected while an active assignment exists');
reset role;
update public.driver_assignments set ended_at=now() where order_id='96000000-0000-4000-8000-000000000001';

-- Not a driver -- rejected outright.
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select throws_ok($$select public.start_shift()$$,'42501','DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi','restaurant staff cannot call driver shift RPCs');
reset role;

select * from finish();
rollback;
