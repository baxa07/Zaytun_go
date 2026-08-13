begin;
select plan(35);

-- Smart Dispatch v1, Phase 7: full pilot simulation. Exercises P7.1-P7.7,
-- P7.16 against the exact franchise fixture requested -- three branches,
-- three named drivers with specified shift/capacity/pool state.
--
-- Known, deliberately-unchanged product boundary this simulation makes
-- visible: create_public_order resolves branch_id from delivery_settings'
-- own single branch_id pointer (see 20260812150000_branch_foundation_v1.sql)
-- -- there is no customer-facing branch *selection* yet, only branch-aware
-- driver pools. Every order below is created via create_public_order (which
-- always resolves to whatever branch delivery_settings currently points
-- to, i.e. Zaytun Kafe) and then has branch_id explicitly overridden where
-- a scenario needs a different branch -- the exact same technique already
-- established in automatic_dispatch.test.sql's own pg_temp.new_ready_order
-- helper, reused here rather than reinvented.

insert into public.branches(id,name,slug,address,latitude,longitude,active) values
  ('70000000-0000-4000-8000-00000000fa01','Zaytun Fast Food A','pilot-fast-food-a','Test A',40.11,65.42,true),
  ('70000000-0000-4000-8000-00000000fa02','Zaytun Fast Food B','pilot-fast-food-b','Test B',40.12,65.43,true);
-- Zaytun Kafe already exists (the seeded default branch).
select ok((select count(*)::integer from public.branches where active) >= 3,'three active branches exist: Zaytun Kafe, Fast Food A, Fast Food B');

-- Neutralize the pre-existing seeded fixture order so it can't be swept
-- up by this file's dispatch attempts.
update public.orders set status='CANCELLED' where id='20000000-0000-0000-0000-000000000001' and status='READY';

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,created_at,updated_at,raw_app_meta_data,raw_user_meta_data,is_super_admin,confirmation_token,recovery_token,email_change_token_new,email_change,phone_change_token,email_change_token_current,reauthentication_token) values
  ('00000000-0000-0000-0000-000000000000','70000000-0000-4000-8000-0000000000a1','authenticated','authenticated','pilot-sevara@zaytun.local',crypt('pilot','bf'),now(),now(),now(),'{}','{}',false,'','','','','','',''),
  ('00000000-0000-0000-0000-000000000000','70000000-0000-4000-8000-0000000000b1','authenticated','authenticated','pilot-driverb@zaytun.local',crypt('pilot','bf'),now(),now(),now(),'{}','{}',false,'','','','','','',''),
  ('00000000-0000-0000-0000-000000000000','70000000-0000-4000-8000-0000000000c1','authenticated','authenticated','pilot-driverc@zaytun.local',crypt('pilot','bf'),now(),now(),now(),'{}','{}',false,'','','','','','','');
insert into public.profiles(id,role,display_name,phone) values
  ('70000000-0000-4000-8000-0000000000a1','DRIVER','Sevara Akhmedova','+998900001001'),
  ('70000000-0000-4000-8000-0000000000b1','DRIVER','Driver B Pilot','+998900001002'),
  ('70000000-0000-4000-8000-0000000000c1','DRIVER','Driver C Pilot','+998900001003');
insert into public.drivers(id,phone,vehicle,availability,shift_status,dispatch_status,delivery_capacity) values
  ('70000000-0000-4000-8000-0000000000a1','+998900001001','Sevara vehicle','AVAILABLE','ON_SHIFT','ACTIVE',1),
  ('70000000-0000-4000-8000-0000000000b1','+998900001002','Driver B vehicle','AVAILABLE','ON_SHIFT','ACTIVE',1),
  ('70000000-0000-4000-8000-0000000000c1','+998900001003','Driver C vehicle','AVAILABLE','OFF_SHIFT','ACTIVE',1);
insert into public.driver_branches(driver_id,branch_id) values
  ('70000000-0000-4000-8000-0000000000a1',(select id from public.branches where slug='zaytun-kafe')),
  ('70000000-0000-4000-8000-0000000000a1','70000000-0000-4000-8000-00000000fa01'),
  ('70000000-0000-4000-8000-0000000000a1','70000000-0000-4000-8000-00000000fa02'),
  ('70000000-0000-4000-8000-0000000000b1','70000000-0000-4000-8000-00000000fa01'),
  ('70000000-0000-4000-8000-0000000000b1','70000000-0000-4000-8000-00000000fa02'),
  ('70000000-0000-4000-8000-0000000000c1',(select id from public.branches where slug='zaytun-kafe'));
-- Every OTHER seed/local driver must not interfere with this simulation's
-- exact-identity assertions -- paused globally, restored at the very end.
update public.drivers set dispatch_status='PAUSED' where id not in('70000000-0000-4000-8000-0000000000a1','70000000-0000-4000-8000-0000000000b1','70000000-0000-4000-8000-0000000000c1');

create or replace function pg_temp.new_ready_order(p_id text, p_branch uuid, p_payment public.payment_method default 'CASH') returns void language plpgsql as $$
begin
  perform public.create_public_order(jsonb_build_object(
    'id', p_id, 'customer', jsonb_build_object('name','Pilot Mijoz','primaryPhone','+998900002'||right(p_id,3)),
    'type','DELIVERY','paymentMethod',p_payment,
    'address', jsonb_build_object('district','Navoiy','street','Test','latitude',40.09,'longitude',65.40,'pinConfirmedAt','2026-08-13T08:00:00Z','locationProvider','mock'),
    'items', jsonb_build_array(jsonb_build_object('menuItemId','plov','quantity',3,'modifierIds','[]'::jsonb))
  ));
  update public.orders set branch_id=p_branch where id=p_id::uuid;
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
  perform public.review_delivery_request(p_id::uuid,true,null);
  perform public.transition_order(p_id::uuid,'CONFIRMED',null,null);
  perform public.transition_order(p_id::uuid,'PREPARING',null,null);
  perform public.transition_order(p_id::uuid,'READY',null,null);
  reset role;
end;
$$;
create or replace function pg_temp.kafe() returns uuid language sql as $$ select id from public.branches where slug='zaytun-kafe' $$;
create or replace function pg_temp.fast_a() returns uuid language sql as $$ select id from public.branches where slug='pilot-fast-food-a' $$;
create or replace function pg_temp.fast_b() returns uuid language sql as $$ select id from public.branches where slug='pilot-fast-food-b' $$;

-- ============================================================
-- P7.2 Scenario A: normal delivery, Zaytun Kafe. Sevara (the only
-- Kafe-eligible ON_SHIFT driver -- Driver C is OFF_SHIFT) receives it
-- automatically, completes the full lifecycle, credit lands correctly.
-- ============================================================
select pg_temp.new_ready_order('a1000000-0000-4000-8000-000000000001', pg_temp.kafe());
select is((select branch_id from public.orders where id='a1000000-0000-4000-8000-000000000001'),pg_temp.kafe(),'branch_id resolved and correctly attached (P7.2)');
select is((select assigned_driver_id::text from public.orders where id='a1000000-0000-4000-8000-000000000001'),'70000000-0000-4000-8000-0000000000a1','Sevara auto-assigned for the Kafe order (only eligible ON_SHIFT driver)');
set local role authenticated;
select set_config('request.jwt.claim.sub','70000000-0000-4000-8000-0000000000a1',true);
select public.accept_assignment('a1000000-0000-4000-8000-000000000001'::uuid);
select public.transition_order('a1000000-0000-4000-8000-000000000001'::uuid,'PICKED_UP',null,null);
select public.transition_order('a1000000-0000-4000-8000-000000000001'::uuid,'ON_THE_WAY',null,null);
select public.transition_order('a1000000-0000-4000-8000-000000000001'::uuid,'ARRIVED',null,null);
select public.transition_order('a1000000-0000-4000-8000-000000000001'::uuid,'DELIVERED',null,null);
reset role;
select is((select status::text from public.orders where id='a1000000-0000-4000-8000-000000000001'),'DELIVERED','full lifecycle reaches DELIVERED');
select is((select status::text from public.driver_assignments where order_id='a1000000-0000-4000-8000-000000000001'),'COMPLETED','assignment becomes COMPLETED');
select is((select public.driver_active_assignment_count('70000000-0000-4000-8000-0000000000a1'::uuid)),0,'Sevara''s capacity frees on completion');
select is((select payment_status::text from public.orders where id='a1000000-0000-4000-8000-000000000001'),'COLLECTED','CASH is collected on delivery');

-- ============================================================
-- P7.3 Scenario B: decline + reassign, Fast Food A. Sevara is the only
-- Fast-Food-A-eligible driver free at first (Driver B occupied below),
-- but here both are free -- dispatch picks one deterministically; force
-- Sevara specifically to prove the named decline/reassign story exactly
-- as specified.
-- ============================================================
select pg_temp.new_ready_order('b1000000-0000-4000-8000-000000000001', pg_temp.fast_a());
select is((select assigned_driver_id::text from public.orders where id='b1000000-0000-4000-8000-000000000001') in('70000000-0000-4000-8000-0000000000a1','70000000-0000-4000-8000-0000000000b1'),true,'one of the two Fast-Food-A-eligible drivers is auto-assigned');
-- The decline/reassign mechanism is driver-agnostic by design (P6.6): the
-- assertions below key off whichever driver was actually picked, rather
-- than assuming a specific one, so the scenario stays deterministic and
-- meaningful regardless of which of the two dispatch chose first.
select set_config('zaytun.pilot_b_declining_driver', (select assigned_driver_id::text from public.orders where id='b1000000-0000-4000-8000-000000000001'::uuid), false);
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('zaytun.pilot_b_declining_driver'),true);
select public.decline_assignment('b1000000-0000-4000-8000-000000000001'::uuid,'CANNOT_GO_NOW');
reset role;
select is((select status::text from public.driver_assignments where order_id='b1000000-0000-4000-8000-000000000001' and driver_id=current_setting('zaytun.pilot_b_declining_driver')::uuid),'DECLINED','the declining driver''s assignment -> DECLINED');
select is((select declined_at from public.driver_assignments where order_id='b1000000-0000-4000-8000-000000000001' and driver_id=current_setting('zaytun.pilot_b_declining_driver')::uuid) is not null,true,'declined_at set');
select is((select ended_at from public.driver_assignments where order_id='b1000000-0000-4000-8000-000000000001' and driver_id=current_setting('zaytun.pilot_b_declining_driver')::uuid) is not null,true,'ended_at set');
select is((select ready_at from public.orders where id='b1000000-0000-4000-8000-000000000001') is not null,true,'ready_at preserved (never reset)');
select is((select assigned_driver_id::text from public.orders where id='b1000000-0000-4000-8000-000000000001'),case when current_setting('zaytun.pilot_b_declining_driver')='70000000-0000-4000-8000-0000000000a1' then '70000000-0000-4000-8000-0000000000b1' else '70000000-0000-4000-8000-0000000000a1' end,'immediate redispatch assigns the OTHER eligible driver -- restaurant needed no manual action');
select is((select count(*)::integer from public.driver_assignments where order_id='b1000000-0000-4000-8000-000000000001' and ended_at is null),1,'exactly one active assignment after reassignment');
-- Capture the newly-assigned driver id here, still superuser -- doing
-- this same lookup AFTER switching to `authenticated` would run under
-- the DECLINING driver's still-active JWT claim, and RLS would silently
-- return no row (order_read requires is_staff() or assigned_driver_id =
-- auth.uid(), and the declining driver is neither staff nor still the
-- assigned driver), turning the JWT claim into NULL instead of erroring.
select set_config('zaytun.pilot_b_new_driver',(select assigned_driver_id::text from public.orders where id='b1000000-0000-4000-8000-000000000001'::uuid),false);
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('zaytun.pilot_b_new_driver'),true);
select public.accept_assignment('b1000000-0000-4000-8000-000000000001'::uuid);
select public.transition_order('b1000000-0000-4000-8000-000000000001'::uuid,'PICKED_UP',null,null);
select public.transition_order('b1000000-0000-4000-8000-000000000001'::uuid,'ON_THE_WAY',null,null);
select public.transition_order('b1000000-0000-4000-8000-000000000001'::uuid,'ARRIVED',null,null);
select public.transition_order('b1000000-0000-4000-8000-000000000001'::uuid,'DELIVERED',null,null);
reset role;
select is((select status::text from public.driver_assignments where order_id='b1000000-0000-4000-8000-000000000001' and driver_id=current_setting('zaytun.pilot_b_declining_driver')::uuid),'DECLINED','the declining driver''s row stays DECLINED (never rewritten as COMPLETED)');
select is((select status::text from public.driver_assignments where order_id='b1000000-0000-4000-8000-000000000001' and driver_id<>current_setting('zaytun.pilot_b_declining_driver')::uuid),'COMPLETED','the reassigned driver gets COMPLETED credit');

-- ============================================================
-- P7.4 Scenario C: no driver available, then one comes online.
-- Pause both Kafe-eligible drivers -- Sevara paused, Driver C already
-- OFF_SHIFT -- so a fresh Kafe order has zero eligible candidates.
-- ============================================================
update public.drivers set dispatch_status='PAUSED' where id='70000000-0000-4000-8000-0000000000a1';
select pg_temp.new_ready_order('c1000000-0000-4000-8000-000000000001', pg_temp.kafe());
select is((select status::text from public.orders where id='c1000000-0000-4000-8000-000000000001'),'READY','no eligible driver -- order remains READY, waiting');
select is((select assigned_driver_id from public.orders where id='c1000000-0000-4000-8000-000000000001'),null,'no assignment created');
select public.attempt_dispatch_sweep_internal();
select is((select count(*)::integer from public.driver_assignments where order_id='c1000000-0000-4000-8000-000000000001'),0,'a second sweep attempt with still nobody eligible creates no duplicate rows');
-- Driver C comes online.
update public.drivers set shift_status='ON_SHIFT' where id='70000000-0000-4000-8000-0000000000c1';
select public.attempt_dispatch_sweep_internal();
select is((select assigned_driver_id::text from public.orders where id='c1000000-0000-4000-8000-000000000001'),'70000000-0000-4000-8000-0000000000c1','backend automatically re-evaluates and assigns the waiting order once Driver C is eligible -- no restaurant action');
update public.orders set status='CANCELLED' where id='c1000000-0000-4000-8000-000000000001';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id='c1000000-0000-4000-8000-000000000001' and ended_at is null;
update public.drivers set shift_status='OFF_SHIFT' where id='70000000-0000-4000-8000-0000000000c1';
update public.drivers set dispatch_status='ACTIVE' where id='70000000-0000-4000-8000-0000000000a1';

-- ============================================================
-- P7.5 Scenario D: branch head-of-line. Order A (Kafe, older, no
-- eligible free Kafe courier) must not block Order B (Fast Food B,
-- newer, Driver B free).
-- ============================================================
update public.drivers set dispatch_status='PAUSED' where id='70000000-0000-4000-8000-0000000000a1'; -- Kafe's only ON_SHIFT driver, paused for this whole scenario
select pg_temp.new_ready_order('d1000000-0000-4000-8000-000000000001', pg_temp.kafe()); -- older, unserviceable
select pg_temp.new_ready_order('d1000000-0000-4000-8000-000000000002', pg_temp.fast_b()); -- newer, Driver B free
select is((select status::text from public.orders where id='d1000000-0000-4000-8000-000000000001'),'READY','order A (Kafe, unserviceable) remains waiting, does not block anything');
select is((select status::text from public.orders where id='d1000000-0000-4000-8000-000000000002'),'DRIVER_ASSIGNED','order B (Fast Food B, newer) is dispatched despite the older unserviceable Kafe order still waiting');
select is((select assigned_driver_id::text from public.orders where id='d1000000-0000-4000-8000-000000000002'),'70000000-0000-4000-8000-0000000000b1','Driver B specifically received it (the only Fast-Food-B-eligible free driver)');
update public.orders set status='CANCELLED' where id in('d1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002');
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id in('d1000000-0000-4000-8000-000000000001','d1000000-0000-4000-8000-000000000002') and ended_at is null;
update public.drivers set dispatch_status='ACTIVE' where id='70000000-0000-4000-8000-0000000000a1';

-- ============================================================
-- P7.6 Scenario E: one capacity slot, two orders READY nearly
-- simultaneously (single-connection proof of the idempotent-outcome
-- guarantee -- true multi-connection races are exercised separately via
-- a real two-process concurrency harness, documented in the release
-- report; FOR UPDATE SKIP LOCKED is what makes this safe under genuine
-- concurrency, and is not something a single pgTAP script can directly
-- simulate, same limitation already established in automatic_dispatch.test.sql).
-- ============================================================
update public.drivers set dispatch_status='PAUSED' where id='70000000-0000-4000-8000-0000000000b1'; -- only Sevara free for Fast Food A now
select pg_temp.new_ready_order('e1000000-0000-4000-8000-000000000001', pg_temp.fast_a());
select pg_temp.new_ready_order('e1000000-0000-4000-8000-000000000002', pg_temp.fast_a());
select is((select count(*)::integer from public.orders where id in('e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002') and status='DRIVER_ASSIGNED'),1,'exactly one of the two orders gets the single available courier');
select is((select count(*)::integer from public.orders where id in('e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002') and status='READY'),1,'the other stays READY, not lost, not duplicated');
select is((select count(*)::integer from public.driver_assignments where order_id in('e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002') and ended_at is null),1,'no duplicate active assignments');
update public.orders set status='CANCELLED' where id in('e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002');
update public.driver_assignments set ended_at=now(),status='CANCELLED' where order_id in('e1000000-0000-4000-8000-000000000001','e1000000-0000-4000-8000-000000000002') and ended_at is null;
update public.drivers set dispatch_status='ACTIVE' where id='70000000-0000-4000-8000-0000000000b1';

-- ============================================================
-- P7.7 Scenario F: manual supersede. Auto-assigned Fast Food A order,
-- staff replaces the active driver via the exception path.
-- ============================================================
select pg_temp.new_ready_order('f1000000-0000-4000-8000-000000000001', pg_temp.fast_a());
select set_config('zaytun.pilot_f_original_driver',(select assigned_driver_id::text from public.orders where id='f1000000-0000-4000-8000-000000000001'::uuid),false);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true); -- staff
select public.assign_driver('f1000000-0000-4000-8000-000000000001'::uuid, (select case when current_setting('zaytun.pilot_f_original_driver')='70000000-0000-4000-8000-0000000000a1' then '70000000-0000-4000-8000-0000000000b1' else '70000000-0000-4000-8000-0000000000a1' end)::uuid);
reset role;
select is((select status::text from public.driver_assignments where order_id='f1000000-0000-4000-8000-000000000001' and driver_id=current_setting('zaytun.pilot_f_original_driver')::uuid),'SUPERSEDED','old assignment -> SUPERSEDED');
select is((select ended_at from public.driver_assignments where order_id='f1000000-0000-4000-8000-000000000001' and driver_id=current_setting('zaytun.pilot_f_original_driver')::uuid) is not null,true,'old assignment ended_at set');
select is((select count(*)::integer from public.driver_assignments where order_id='f1000000-0000-4000-8000-000000000001' and ended_at is null),1,'exactly one active assignment after supersede');
select is((select count(*)::integer from public.driver_assignments where order_id='f1000000-0000-4000-8000-000000000001'),2,'old history row preserved, never deleted -- two rows total');
set local role authenticated;
select set_config('request.jwt.claim.sub',(select assigned_driver_id::text from public.orders where id='f1000000-0000-4000-8000-000000000001'::uuid),true);
select public.accept_assignment('f1000000-0000-4000-8000-000000000001'::uuid);
select public.transition_order('f1000000-0000-4000-8000-000000000001'::uuid,'PICKED_UP',null,null);
select public.transition_order('f1000000-0000-4000-8000-000000000001'::uuid,'ON_THE_WAY',null,null);
select public.transition_order('f1000000-0000-4000-8000-000000000001'::uuid,'ARRIVED',null,null);
select public.transition_order('f1000000-0000-4000-8000-000000000001'::uuid,'DELIVERED',null,null);
reset role;
select is((select status::text from public.driver_assignments where order_id='f1000000-0000-4000-8000-000000000001' and driver_id=current_setting('zaytun.pilot_f_original_driver')::uuid),'SUPERSEDED','SUPERSEDED row never rewritten to COMPLETED');
select is((select status::text from public.driver_assignments where order_id='f1000000-0000-4000-8000-000000000001' and driver_id<>current_setting('zaytun.pilot_f_original_driver')::uuid),'COMPLETED','the driver who actually delivered gets COMPLETED credit');

-- ============================================================
-- P7.12 Driver Ledger cross-check via the real, staff-only RPC, scoped to
-- this simulation's own three pilot drivers, over TODAY (every order
-- above was created within this same transaction/business day).
-- ============================================================
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true); -- staff
select is((select count(*)::integer from public.list_driver_ledger_summary('TODAY',null,null,null) s where s.driver_id in('70000000-0000-4000-8000-0000000000a1','70000000-0000-4000-8000-0000000000b1') and s.completed >= 1),2,'both Sevara and Driver B carry at least one COMPLETED credit across the simulation (real staff-only ledger RPC)');
select is((select count(*)::integer from public.list_driver_ledger_summary('TODAY',null,null,null) s where s.driver_id in('70000000-0000-4000-8000-0000000000a1','70000000-0000-4000-8000-0000000000b1') and (s.declined + s.superseded) >= 1),2,'both drivers also carry at least one non-completed (declined or superseded) row, never miscounted as completed');
reset role;

-- ============================================================
-- P7.16 forward-compatibility: capacity=2 for one driver can hold two
-- simultaneous active assignments without violating the schema (already
-- proven generally in automatic_dispatch.test.sql; reconfirmed here using
-- a named pilot driver for narrative completeness).
-- ============================================================
-- Sevara is also Kafe-eligible and, by now, back at zero active work --
-- she'd tie Driver C on workload and win ranking on a lower id, so both
-- orders would split one-each instead of proving capacity=2 for the SAME
-- driver. Pause her for just this scenario so Driver C is the only Kafe
-- candidate.
update public.drivers set dispatch_status='PAUSED' where id='70000000-0000-4000-8000-0000000000a1';
update public.drivers set delivery_capacity=2 where id='70000000-0000-4000-8000-0000000000c1';
update public.drivers set shift_status='ON_SHIFT' where id='70000000-0000-4000-8000-0000000000c1';
select pg_temp.new_ready_order('ca000000-0000-4000-8000-000000000001', pg_temp.kafe());
select pg_temp.new_ready_order('ca000000-0000-4000-8000-000000000002', pg_temp.kafe());
select is((select count(*)::integer from public.driver_assignments where driver_id='70000000-0000-4000-8000-0000000000c1' and ended_at is null),2,'capacity=2 correctly admits two simultaneous active assignments for one driver -- schema has no hidden one-active-per-driver constraint');
update public.orders set status='CANCELLED' where id in('ca000000-0000-4000-8000-000000000001','ca000000-0000-4000-8000-000000000002');
update public.drivers set dispatch_status='ACTIVE' where id='70000000-0000-4000-8000-0000000000a1';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where driver_id='70000000-0000-4000-8000-0000000000c1' and ended_at is null;
update public.drivers set delivery_capacity=1,shift_status='OFF_SHIFT' where id='70000000-0000-4000-8000-0000000000c1';

select * from finish();
rollback;
