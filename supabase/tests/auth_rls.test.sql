begin;
select plan(21);

select ok(not has_function_privilege('anon', 'public.transition_order(uuid,public.order_status,text,text)', 'EXECUTE'), 'anonymous cannot execute operational transitions');
select ok(has_function_privilege('anon', 'public.create_public_order(jsonb)', 'EXECUTE'), 'anonymous can execute controlled order creation');
select ok(has_function_privilege('anon', 'public.get_order_tracking(uuid,uuid)', 'EXECUTE'), 'anonymous can execute token tracking');

set local role anon;
select throws_ok($$select count(*) from public.orders$$, '42501', null, 'anonymous cannot enumerate orders');
select throws_ok($$select count(*) from public.drivers$$, '42501', null, 'anonymous cannot enumerate drivers');
reset role;

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);
set local role authenticated;
select ok((select count(*) > 0 from public.orders), 'restaurant can read operational orders');
-- Two drivers are seeded (the original email driver and the phone-login
-- LOCAL TEST fixture) -- assert staff visibility semantically (both known
-- identities are readable, both hold DRIVER role) rather than an opaque
-- count, so this test documents and verifies the actual roster shape.
select ok((select exists(select 1 from public.drivers where id = '10000000-0000-0000-0000-000000000003')), 'restaurant roster includes the seeded email driver');
select ok((select exists(select 1 from public.drivers where id = '10000000-0000-0000-0000-000000000004')), 'restaurant roster includes the seeded phone-login driver');
select ok((select bool_and(role = 'DRIVER') from public.profiles where id in ('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004')), 'both roster entries hold the DRIVER role');
select is((select count(*)::integer from public.drivers), 2, 'restaurant sees the full driver roster, no more and no fewer');
reset role;

update public.orders
set status = 'DRIVER_ASSIGNED', assigned_driver_id = '10000000-0000-0000-0000-000000000003', assignment_accepted_at = null
where id = '20000000-0000-0000-0000-000000000001';
insert into public.driver_assignments(order_id, driver_id, assigned_by)
values ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000002')
on conflict (order_id) do update set driver_id = excluded.driver_id, accepted_at = null, ended_at = null;

select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000003', true);
set local role authenticated;
select is((select count(*)::integer from public.drivers), 1, 'driver sees only own roster row');
select is((select count(*)::integer from public.orders where assigned_driver_id is distinct from auth.uid()), 0, 'driver sees no unrelated orders');
select is((select count(*)::integer from public.driver_assignments where driver_id is distinct from auth.uid()), 0, 'driver sees no unrelated assignments');
select throws_ok($$select public.transition_order('20000000-0000-0000-0000-000000000001','CANCELLED','driver cancellation','test')$$, '42501', null, 'driver cannot cancel an order');
select throws_ok($$select public.transition_order('20000000-0000-0000-0000-000000000001','PICKED_UP',null,'test')$$, '42501', null, 'driver must accept before pickup');
select lives_ok($$select public.accept_assignment('20000000-0000-0000-0000-000000000001')$$, 'assigned driver can accept');
select lives_ok($$select public.transition_order('20000000-0000-0000-0000-000000000001','PICKED_UP',null,'test')$$, 'assigned driver can perform allowed transition');
reset role;

select ok((select public.get_order_tracking(id, tracking_token) is not null from public.orders where id = '20000000-0000-0000-0000-000000000001'), 'valid tracking token succeeds');
select is(public.get_order_tracking('20000000-0000-0000-0000-000000000001', 'ffffffff-ffff-ffff-ffff-ffffffffffff'), null, 'invalid tracking token is rejected');
select is((select jsonb_array_length(public.get_order_tracking(id, tracking_token)->'customer_addresses') from public.orders where id = '20000000-0000-0000-0000-000000000001'), 0, 'public tracking excludes private address');
select is((select public.get_order_tracking(id, tracking_token)->'assigned_driver_id' from public.orders where id = '20000000-0000-0000-0000-000000000001'), 'null'::jsonb, 'public tracking excludes driver identity');

select * from finish();
rollback;
