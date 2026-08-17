begin;
select no_plan();

select lives_ok($$select public.create_public_order('{"id":"90000000-0000-4000-8000-000000000001","customer":{"name":"Click Delivery","primaryPhone":"+998900000010"},"type":"DELIVERY","paymentMethod":"CLICK","address":{"district":"Navoiy","street":"Test ko‘chasi","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-12T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb)$$,'delivery Click manual transfer can be selected');
select lives_ok($$select public.create_public_order('{"id":"90000000-0000-4000-8000-000000000002","customer":{"name":"Payme Delivery","primaryPhone":"+998900000011"},"type":"DELIVERY","paymentMethod":"PAYME","address":{"district":"Navoiy","street":"Test ko‘chasi","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-12T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb)$$,'delivery Payme manual transfer can be selected');
select is((select payment_status::text from public.orders where id='90000000-0000-4000-8000-000000000001'),'PENDING','Click starts pending');
select is((select payment_status::text from public.orders where id='90000000-0000-4000-8000-000000000002'),'PENDING','Payme starts pending');
select lives_ok($$select public.create_public_order('{"id":"90000000-0000-4000-8000-000000000003","customer":{"name":"Click Pickup","primaryPhone":"+998900000012"},"type":"PICKUP","paymentMethod":"CLICK","items":[{"menuItemId":"ayran","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'pickup Click manual transfer can be selected');
select lives_ok($$select public.create_public_order('{"id":"90000000-0000-4000-8000-000000000004","customer":{"name":"Payme Pickup","primaryPhone":"+998900000013"},"type":"PICKUP","paymentMethod":"PAYME","items":[{"menuItemId":"ayran","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'pickup Payme manual transfer can be selected');
select is((select payment_status::text from public.orders where id='90000000-0000-4000-8000-000000000003'),'PENDING','pickup Click starts pending');
select is((select payment_status::text from public.orders where id='90000000-0000-4000-8000-000000000004'),'PENDING','pickup Payme starts pending');

update public.orders set delivery_review_status='APPROVED' where id in('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.transition_order('90000000-0000-4000-8000-000000000001','CONFIRMED',null,null);
select public.transition_order('90000000-0000-4000-8000-000000000002','CONFIRMED',null,null);
select public.transition_order('90000000-0000-4000-8000-000000000003','CONFIRMED',null,null);
select throws_ok($$select public.transition_order('90000000-0000-4000-8000-000000000001','PREPARING',null,null)$$,'23514','PAYMENT_CONFIRMATION_REQUIRED|Avval Click/Payme to‘lovini tasdiqlang','Click cannot enter preparation while pending');
select throws_ok($$select public.transition_order('90000000-0000-4000-8000-000000000002','PREPARING',null,null)$$,'23514','PAYMENT_CONFIRMATION_REQUIRED|Avval Click/Payme to‘lovini tasdiqlang','Payme cannot enter preparation while pending');
select throws_ok($$select public.transition_order('90000000-0000-4000-8000-000000000003','PREPARING',null,null)$$,'23514','PAYMENT_CONFIRMATION_REQUIRED|Avval Click/Payme to‘lovini tasdiqlang','pickup Click cannot enter preparation while pending');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select throws_ok($$select public.confirm_manual_payment('90000000-0000-4000-8000-000000000001')$$,'42501','STAFF_ROLE_REQUIRED|Restaurant xodimi talab qilinadi','driver cannot confirm customer transfer');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.confirm_manual_payment('90000000-0000-4000-8000-000000000001')$$,'Restaurant confirms Click receipt');
select lives_ok($$select public.confirm_manual_payment('90000000-0000-4000-8000-000000000002')$$,'Restaurant confirms Payme receipt');
select lives_ok($$select public.confirm_manual_payment('90000000-0000-4000-8000-000000000003')$$,'Restaurant confirms pickup Click receipt');
select lives_ok($$select public.confirm_manual_payment('90000000-0000-4000-8000-000000000001')$$,'duplicate confirmation is idempotent');
select is((select payment_status::text from public.orders where id='90000000-0000-4000-8000-000000000001'),'CONFIRMED','Click becomes confirmed');
select is((select count(*)::integer from public.order_events where order_id='90000000-0000-4000-8000-000000000001' and notes='MANUAL_PAYMENT_CONFIRMED'),1,'manual confirmation creates exactly one immutable event');
select lives_ok($$select public.transition_order('90000000-0000-4000-8000-000000000001','PREPARING',null,null)$$,'preparation proceeds after Click confirmation');
select lives_ok($$select public.transition_order('90000000-0000-4000-8000-000000000002','PREPARING',null,null)$$,'preparation proceeds after Payme confirmation');
select lives_ok($$select public.transition_order('90000000-0000-4000-8000-000000000003','PREPARING',null,null)$$,'pickup preparation proceeds after Click confirmation');
reset role;

select ok(not has_function_privilege('anon','public.confirm_manual_payment(uuid)','EXECUTE'),'anonymous browser cannot confirm payment');
select * from finish();
rollback;
