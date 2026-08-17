begin;
select plan(21);

select enum_has_labels('public','payment_method',array['CASH','CARD_ON_DELIVERY','CARD_AT_PICKUP','CLICK','PAYME','TERMINAL'],'explicit terminal added without removing historical payment values');
select enum_has_labels('public','order_status',array['NEW','CONFIRMED','PREPARING','READY','DRIVER_ASSIGNED','PICKED_UP','ON_THE_WAY','ARRIVED','DELIVERED','REJECTED','CANCELLED','DELIVERY_FAILED','RETURNED','COLLECTED'],'collected terminal status added');
select is((public.get_public_restaurant_config()->'pickupPaymentMethods')::text,'["CASH", "TERMINAL", "CLICK", "PAYME"]','pickup exposes cash, terminal, and manual Click/Payme transfers');
select is((public.get_public_restaurant_config()->'deliveryPaymentMethods')::text,'["CASH", "CLICK", "PAYME"]','delivery exposes cash and manual Click/Payme transfers');

select lives_ok($$select public.create_public_order('{"id":"80000000-0000-4000-8000-000000000001","customer":{"name":"Cash Pickup","primaryPhone":"+998900000001"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"ayran","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'pickup cash accepted');
select lives_ok($$select public.create_public_order('{"id":"80000000-0000-4000-8000-000000000002","customer":{"name":"Terminal Pickup","primaryPhone":"+998900000002"},"type":"PICKUP","paymentMethod":"TERMINAL","cardNumber":"never-store","items":[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'pickup terminal accepted');
select is((select payment_method::text from public.orders where id='80000000-0000-4000-8000-000000000002'),'TERMINAL','terminal selection stored authoritatively');
select is((select payment_status::text from public.orders where id='80000000-0000-4000-8000-000000000002'),'PENDING','selecting terminal alone does not mark payment collected');
select ok(not exists(select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name in('card_number','cvv','expiry','pin','cardholder')),'no card-sensitive columns exist');

select lives_ok($$select public.create_public_order('{"id":"80000000-0000-4000-8000-000000000003","customer":{"name":"Cash Delivery","primaryPhone":"+998900000003"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","house":"1","landmark":"Kirish","deliveryNotes":"Darvoza","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-06T10:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb)$$,'delivery cash remains accepted');
select throws_ok($$select public.create_public_order('{"id":"80000000-0000-4000-8000-000000000004","customer":{"name":"Bad Delivery","primaryPhone":"+998900000004"},"type":"DELIVERY","paymentMethod":"CARD_AT_PICKUP","address":{"district":"Navoiy","street":"Test","house":"1","landmark":"Kirish","deliveryNotes":"Darvoza","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-06T10:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb)$$,'22023','UNSUPPORTED_PAYMENT_METHOD|Tanlangan to‘lov usuli bu buyurtma turi uchun mavjud emas','pickup card rejected for delivery');
select throws_ok($$select public.create_public_order('{"id":"80000000-0000-4000-8000-000000000005","customer":{"name":"Bad Payment","primaryPhone":"+998900000005"},"type":"PICKUP","paymentMethod":"ONLINE_CARD","items":[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'22023','UNSUPPORTED_PAYMENT_METHOD|To‘lov usuli qo‘llab-quvvatlanmaydi','unsupported manipulated payment rejected');

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.transition_order('80000000-0000-4000-8000-000000000002','CONFIRMED',null,null);select public.transition_order('80000000-0000-4000-8000-000000000002','PREPARING',null,null);select public.transition_order('80000000-0000-4000-8000-000000000002','READY',null,null)$$,'restaurant advances pickup to ready');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select throws_ok($$select public.transition_order('80000000-0000-4000-8000-000000000002','COLLECTED',null,null)$$,'42501','PICKUP_DRIVER_FORBIDDEN|Haydovchi olib ketish buyurtmasini boshqarmaydi','driver cannot mark pickup collected');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',true);
select throws_ok($$select public.assign_driver('80000000-0000-4000-8000-000000000002','10000000-0000-0000-0000-000000000003')$$,'42501','PICKUP_DRIVER_FORBIDDEN|Olib ketish buyurtmasiga haydovchi biriktirilmaydi','pickup cannot be assigned');
reset role;

insert into public.driver_assignments(id,order_id,driver_id,assigned_by) values('81000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001','10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000001');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select throws_ok($$select public.accept_assignment('80000000-0000-4000-8000-000000000001')$$,'42501','PICKUP_DRIVER_FORBIDDEN|Haydovchi olib ketish buyurtmasini qabul qilmaydi','driver cannot accept pickup assignment');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.transition_order('80000000-0000-4000-8000-000000000002','COLLECTED',null,null)$$,'restaurant marks pickup collected');
select is((select status::text from public.orders where id='80000000-0000-4000-8000-000000000002'),'COLLECTED','pickup ends as collected, not delivered');
select is((select payment_status::text from public.orders where id='80000000-0000-4000-8000-000000000002'),'COLLECTED','physical payment records collection at handoff');
select is((select count(*)::integer from public.order_events where order_id='80000000-0000-4000-8000-000000000002'),5,'every pickup lifecycle transition has immutable event');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select throws_ok($$select public.transition_order('80000000-0000-4000-8000-000000000001','DRIVER_ASSIGNED',null,null)$$,'42501','PICKUP_TRANSITION_FORBIDDEN|Olib ketish buyurtmasi haydovchi bosqichiga o‘tmaydi','pickup cannot enter driver state');
reset role;
select * from finish();
rollback;
