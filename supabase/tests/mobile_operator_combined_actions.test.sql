begin;
select plan(18);

-- Keep dispatch deterministic for this focused lifecycle test.
update public.drivers
set shift_status='ON_SHIFT', dispatch_status='ACTIVE', delivery_capacity=10
where id='10000000-0000-0000-0000-000000000003';
update public.drivers
set dispatch_status='PAUSED'
where id='10000000-0000-0000-0000-000000000004';
update public.orders
set status='CANCELLED'
where id='20000000-0000-0000-0000-000000000001' and status='READY';

select ok(not has_function_privilege('anon','public.restaurant_accept_and_start(uuid)','EXECUTE'),'anonymous cannot use the combined restaurant action');
select ok(not has_function_privilege('anon','public.driver_pickup_and_depart(uuid)','EXECUTE'),'anonymous cannot use the combined pickup action');
select ok(not has_function_privilege('anon','public.driver_complete_delivery(uuid)','EXECUTE'),'anonymous cannot use the combined delivery action');

-- A cash pickup order goes from NEW to PREPARING with one operator action,
-- while retaining both canonical audit events.
select public.create_public_order('{"id":"da000000-0000-4000-8000-000000000001","customer":{"name":"Mobile Pickup","primaryPhone":"+998900000501"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"ayran","quantity":1,"modifierIds":[]}]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.restaurant_accept_and_start('da000000-0000-4000-8000-000000000001')$$,'operator accepts and starts a cash order in one action');
reset role;
select is((select status::text from public.orders where id='da000000-0000-4000-8000-000000000001'),'PREPARING','cash order ends at PREPARING');
select is((select count(*)::integer from public.order_events where order_id='da000000-0000-4000-8000-000000000001' and new_status in('CONFIRMED','PREPARING')),2,'both canonical restaurant events remain recorded');

-- Remote payment remains safely gated after acceptance.
select public.create_public_order('{"id":"da000000-0000-4000-8000-000000000002","customer":{"name":"Mobile Payme","primaryPhone":"+998900000502"},"type":"PICKUP","paymentMethod":"PAYME","items":[{"menuItemId":"ayran","quantity":1,"modifierIds":[]}]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.restaurant_accept_and_start('da000000-0000-4000-8000-000000000002')$$,'operator can accept a remote-payment order');
reset role;
select is((select status::text from public.orders where id='da000000-0000-4000-8000-000000000002'),'CONFIRMED','remote-payment order waits at CONFIRMED until payment is verified');
select is((select count(*)::integer from public.order_events where order_id='da000000-0000-4000-8000-000000000002' and new_status='PREPARING'),0,'remote-payment gate does not create a false PREPARING event');

-- A delivery keeps every canonical state but needs only pickup/depart and
-- delivered actions from the driver.
select public.create_public_order('{"id":"da000000-0000-4000-8000-000000000003","customer":{"name":"Mobile Delivery","primaryPhone":"+998900000503"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-25T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.review_delivery_request('da000000-0000-4000-8000-000000000003',true,null);
select public.restaurant_accept_and_start('da000000-0000-4000-8000-000000000003');
select public.transition_order('da000000-0000-4000-8000-000000000003','READY',null,null);
reset role;
select is((select assigned_driver_id from public.orders where id='da000000-0000-4000-8000-000000000003'),'10000000-0000-0000-0000-000000000003'::uuid,'ready order is assigned to the available driver');

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.accept_assignment('da000000-0000-4000-8000-000000000003');
select lives_ok($$select public.driver_pickup_and_depart('da000000-0000-4000-8000-000000000003')$$,'driver picks up and departs in one action');
reset role;
select is((select status::text from public.orders where id='da000000-0000-4000-8000-000000000003'),'ON_THE_WAY','pickup/depart action ends at ON_THE_WAY');
select is((select count(*)::integer from public.order_events where order_id='da000000-0000-4000-8000-000000000003' and new_status in('PICKED_UP','ON_THE_WAY')),2,'pickup and departure remain separate audit events');

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select lives_ok($$select public.driver_complete_delivery('da000000-0000-4000-8000-000000000003')$$,'driver completes delivery in one action');
reset role;
select is((select status::text from public.orders where id='da000000-0000-4000-8000-000000000003'),'DELIVERED','final action closes the order as DELIVERED');
select is((select count(*)::integer from public.order_events where order_id='da000000-0000-4000-8000-000000000003' and new_status in('ARRIVED','DELIVERED')),2,'arrival and delivery remain separate audit events');
select is((select status::text from public.driver_assignments where order_id='da000000-0000-4000-8000-000000000003'),'COMPLETED','delivery closes the driver assignment');
select is((select payment_status::text from public.orders where id='da000000-0000-4000-8000-000000000003'),'COLLECTED','cash payment is marked collected at delivery');

select * from finish();
rollback;
