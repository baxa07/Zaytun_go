begin;
select plan(69);

select has_column('public','orders','delivery_review_status','orders record delivery review');
select has_function('public','review_delivery_request',array['uuid','boolean','text'],'review RPC exists');
select ok(not has_function_privilege('anon','public.review_delivery_request(uuid,boolean,text)','EXECUTE'),'anonymous cannot review delivery');

select public.create_public_order('{"id":"70000000-0000-4000-8000-000000000001","customer":{"name":"Review Test","primaryPhone":"+998900000000"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","house":"1","landmark":"Kirish","deliveryNotes":"Darvoza","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-05T10:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
select is((select delivery_review_status::text from public.orders where id='70000000-0000-4000-8000-000000000001'),'REVIEW_REQUIRED','new delivery awaits review');

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select throws_ok($$select public.review_delivery_request('70000000-0000-4000-8000-000000000001',true,null)$$,'42501','DELIVERY_REVIEW_FORBIDDEN|Yetkazishni faqat restoran yoki dispatcher ko‘rib chiqadi','driver cannot approve');
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',true);
select lives_ok($$select public.review_delivery_request('70000000-0000-4000-8000-000000000001',true,null)$$,'dispatcher approves delivery');
select is((select delivery_review_status::text from public.orders where id='70000000-0000-4000-8000-000000000001'),'APPROVED','approval is persisted');
select ok((select exists(select 1 from public.order_events where order_id='70000000-0000-4000-8000-000000000001' and notes='DELIVERY_REVIEW_APPROVED')),'approval creates immutable event');
reset role;

select public.create_public_order('{"id":"70000000-0000-4000-8000-000000000002","customer":{"name":"Reject Test","primaryPhone":"+998900000000"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","house":"2","landmark":"Kirish","deliveryNotes":"Darvoza","latitude":40.10,"longitude":65.41,"pinConfirmedAt":"2026-08-05T10:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.review_delivery_request('70000000-0000-4000-8000-000000000002',false,'Hududni aniqlashtirish kerak')$$,'restaurant rejects with reason');
select is((select status::text from public.orders where id='70000000-0000-4000-8000-000000000002'),'REJECTED','rejected review terminates order');
reset role;

select public.create_public_order('{"id":"70000000-0000-4000-8000-000000000003","customer":{"name":"Assignment Test","primaryPhone":"+998900000000"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","house":"3","landmark":"Kirish","deliveryNotes":"Darvoza","latitude":40.10,"longitude":65.41,"pinConfirmedAt":"2026-08-05T10:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select throws_ok($$select public.transition_order('70000000-0000-4000-8000-000000000003','CONFIRMED',null,null)$$,'42501','DELIVERY_REVIEW_REQUIRED|Avval yetkazish manzilini tasdiqlang','unapproved delivery cannot enter preparation lifecycle');
reset role;
update public.orders set status='READY' where id='70000000-0000-4000-8000-000000000003';
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',true);
select throws_ok($$select public.assign_driver('70000000-0000-4000-8000-000000000003','10000000-0000-0000-0000-000000000003')$$,'42501','DELIVERY_REVIEW_REQUIRED|Tasdiqlanmagan yetkazish haydovchiga berilmaydi','unapproved delivery cannot be assigned');
select public.review_delivery_request('70000000-0000-4000-8000-000000000003',true,null);
select lives_ok($$select public.assign_driver('70000000-0000-4000-8000-000000000003','10000000-0000-0000-0000-000000000003')$$,'approved delivery can be assigned');
reset role;

-- ==========================================================================
-- Delivery address clarification: REVIEW_REQUIRED -> CLARIFICATION_REQUESTED
-- -> (customer revises) -> REVIEW_REQUIRED -> APPROVED|REJECTED
-- ==========================================================================

select public.create_public_order('{"id":"70000000-0000-4000-8000-000000000004","customer":{"name":"Clarify Test","primaryPhone":"+998900000004"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test ko‘chasi","house":"noma’lum","landmark":"","deliveryNotes":"Uy raqami keyin aniqlashtiriladi","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-08T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
select is((select delivery_review_status::text from public.orders where id='70000000-0000-4000-8000-000000000004'),'REVIEW_REQUIRED','clarification: new delivery awaits review');

select public.create_public_order('{"id":"70000000-0000-4000-8000-000000000005","customer":{"name":"Untouched Test","primaryPhone":"+998900000005"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test ko‘chasi","house":"2","landmark":"Kirish","deliveryNotes":"","latitude":40.10,"longitude":65.41,"pinConfirmedAt":"2026-08-08T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);

-- authorization negatives: requesting clarification
set local role anon;
select throws_ok($$select public.request_delivery_clarification('70000000-0000-4000-8000-000000000004','Uy raqami tushunarsiz')$$,'42501',null,'anonymous cannot request clarification');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select throws_ok($$select public.request_delivery_clarification('70000000-0000-4000-8000-000000000004','Uy raqami tushunarsiz')$$,'42501',null,'driver cannot request clarification');
reset role;

-- reason required
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',true);
select throws_ok($$select public.request_delivery_clarification('70000000-0000-4000-8000-000000000005','   ')$$,'22023','CLARIFICATION_REASON_REQUIRED|Aniqlashtirish sababini kiriting','blank clarification reason rejected');

-- staff requests clarification (dispatcher)
select lives_ok($$select public.request_delivery_clarification('70000000-0000-4000-8000-000000000004','Uy raqami tushunarsiz')$$,'dispatcher requests clarification');
reset role;
select is((select delivery_review_status::text from public.orders where id='70000000-0000-4000-8000-000000000004'),'CLARIFICATION_REQUESTED','clarification recorded');
select is((select status::text from public.orders where id='70000000-0000-4000-8000-000000000004'),'NEW','order status stays NEW during clarification');
select is((select delivery_review_reason from public.orders where id='70000000-0000-4000-8000-000000000004'),'Uy raqami tushunarsiz','clarification reason stored on existing review-reason field');
select ok((select exists(select 1 from public.order_events where order_id='70000000-0000-4000-8000-000000000004' and notes='DELIVERY_CLARIFICATION_REQUESTED' and reason='Uy raqami tushunarsiz')),'clarification request creates an audit event');

-- customer revision authorization negatives
select throws_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000099','{}'::jsonb)$$,'P0001','ORDER_NOT_FOUND|Buyurtma yoki kuzatuv kodi noto‘g‘ri','wrong tracking token rejected');
select throws_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000004',null,'{}'::jsonb)$$,'P0001','ORDER_NOT_FOUND|Buyurtma yoki kuzatuv kodi noto‘g‘ri','missing tracking token rejected');
select throws_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000005',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000004'),'{}'::jsonb)$$,'P0001','ORDER_NOT_FOUND|Buyurtma yoki kuzatuv kodi noto‘g‘ri','revising a different order with another order''s token is rejected');

-- customer revision state negatives
select throws_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000005',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000005'),'{}'::jsonb)$$,'22023','ADDRESS_REVISION_NOT_ALLOWED|Bu manzilni hozir tahrirlab bo‘lmaydi','revision rejected while review is still REVIEW_REQUIRED');

select public.create_order('{"id":"70000000-0000-4000-8000-000000000008","customer":{"name":"Pickup Test","primaryPhone":"+998900000008"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]}'::jsonb);
select throws_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000008',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000008'),'{}'::jsonb)$$,'22023','PICKUP_ADDRESS_FORBIDDEN|Olib ketish buyurtmasida manzil yo‘q','pickup order revision rejected');

-- customer revises using the correct token
select lives_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000004',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000004'),'{"district":"Navoiy","street":"Test ko‘chasi","house":"14-uy","landmark":"Ko‘k darvoza","deliveryNotes":"","latitude":40.095,"longitude":65.405,"pinConfirmedAt":"2026-08-08T09:00:00Z","locationProvider":"mock","confidence":"COMPLETE"}'::jsonb)$$,'customer revises address with correct token');
select is((select delivery_review_status::text from public.orders where id='70000000-0000-4000-8000-000000000004'),'REVIEW_REQUIRED','revision returns order to REVIEW_REQUIRED');
select is((select delivery_review_reason from public.orders where id='70000000-0000-4000-8000-000000000004'),null,'prior clarification reason cleared on revision');
select is((select house from public.customer_addresses where order_id='70000000-0000-4000-8000-000000000004'),'14-uy','address fields updated in place');
select is((select count(*)::integer from public.customer_addresses where order_id='70000000-0000-4000-8000-000000000004'),1,'exactly one address row remains for the order');

-- integrity: items, pricing, payment, driver untouched by address revision
select is((select subtotal from public.orders where id='70000000-0000-4000-8000-000000000004'),144000,'subtotal unchanged by address revision');
select is((select total from public.orders where id='70000000-0000-4000-8000-000000000004'),144000,'total reflects only the recalculated (still zero) delivery fee');
select is((select count(*)::integer from public.order_items where order_id='70000000-0000-4000-8000-000000000004'),1,'item count unchanged by address revision');
select is((select payment_method::text from public.orders where id='70000000-0000-4000-8000-000000000004'),'CASH','payment method unchanged by address revision');
select is((select assigned_driver_id from public.orders where id='70000000-0000-4000-8000-000000000004'),null,'no driver assigned by address revision');

-- a second revision attempt without a new clarification request is rejected
select throws_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000004',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000004'),'{}'::jsonb)$$,'22023','ADDRESS_REVISION_NOT_ALLOWED|Bu manzilni hozir tahrirlab bo‘lmaydi','second revision without new clarification request is rejected');

-- happy path: staff approves and kitchen progression unblocks
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.review_delivery_request('70000000-0000-4000-8000-000000000004',true,null)$$,'restaurant approves the revised address');
select is((select delivery_review_status::text from public.orders where id='70000000-0000-4000-8000-000000000004'),'APPROVED','review approved after revision');
select throws_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000004',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000004'),'{}'::jsonb)$$,'22023','ADDRESS_REVISION_NOT_ALLOWED|Bu manzilni hozir tahrirlab bo‘lmaydi','revision rejected once review is APPROVED');
select lives_ok($$select public.transition_order('70000000-0000-4000-8000-000000000004','CONFIRMED',null,null)$$,'approved delivery order may progress to CONFIRMED');
select is((select status::text from public.orders where id='70000000-0000-4000-8000-000000000004'),'CONFIRMED','order reaches CONFIRMED after approval');
reset role;

-- clarify then reject: clarification does not prevent a later terminal rejection
select public.create_public_order('{"id":"70000000-0000-4000-8000-000000000006","customer":{"name":"Clarify Reject Test","primaryPhone":"+998900000006"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","house":"noma’lum","landmark":"","deliveryNotes":"Aniqlashtirish kerak","latitude":40.11,"longitude":65.42,"pinConfirmedAt":"2026-08-08T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
select is((select delivery_review_status::text from public.orders where id='70000000-0000-4000-8000-000000000006'),'REVIEW_REQUIRED','clarify-then-reject: starts REVIEW_REQUIRED');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.request_delivery_clarification('70000000-0000-4000-8000-000000000006','Hudud noaniq')$$,'restaurant requests clarification');
reset role;
select is((select delivery_review_status::text from public.orders where id='70000000-0000-4000-8000-000000000006'),'CLARIFICATION_REQUESTED','clarify-then-reject: moves to CLARIFICATION_REQUESTED');
select lives_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000006',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000006'),'{"district":"Navoiy","street":"Test","house":"9-uy","landmark":"Do‘kon yonida","deliveryNotes":"","latitude":40.30,"longitude":65.60,"pinConfirmedAt":"2026-08-08T09:00:00Z","locationProvider":"mock"}'::jsonb)$$,'customer revises after clarification request');
select is((select delivery_review_status::text from public.orders where id='70000000-0000-4000-8000-000000000006'),'REVIEW_REQUIRED','clarify-then-reject: back to REVIEW_REQUIRED after revision');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.review_delivery_request('70000000-0000-4000-8000-000000000006',false,'Yetkazib bo‘lmaydi - hudud xizmat doirasidan tashqarida')$$,'restaurant terminally rejects after clarification');
reset role;
select is((select delivery_review_status::text from public.orders where id='70000000-0000-4000-8000-000000000006'),'REJECTED','clarify-then-reject: review status REJECTED');
select is((select status::text from public.orders where id='70000000-0000-4000-8000-000000000006'),'REJECTED','clarify-then-reject: order status REJECTED (terminal)');
select throws_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000006',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000006'),'{}'::jsonb)$$,'22023','ADDRESS_REVISION_NOT_ALLOWED|Bu manzilni hozir tahrirlab bo‘lmaydi','revision rejected once review is REJECTED and order is terminal');

-- state negatives: order.status guard independent of review status
select public.create_public_order('{"id":"70000000-0000-4000-8000-000000000007","customer":{"name":"Lifecycle Guard Test","primaryPhone":"+998900000007"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","house":"3","landmark":"Kirish","deliveryNotes":"","latitude":40.10,"longitude":65.41,"pinConfirmedAt":"2026-08-08T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
update public.orders set delivery_review_status='CLARIFICATION_REQUESTED' where id='70000000-0000-4000-8000-000000000007';
update public.orders set status='CONFIRMED' where id='70000000-0000-4000-8000-000000000007';
select throws_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000007',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000007'),'{}'::jsonb)$$,'22023','ADDRESS_REVISION_NOT_ALLOWED|Bu manzilni hozir tahrirlab bo‘lmaydi','revision rejected while order is CONFIRMED');
update public.orders set status='PREPARING' where id='70000000-0000-4000-8000-000000000007';
select throws_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000007',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000007'),'{}'::jsonb)$$,'22023','ADDRESS_REVISION_NOT_ALLOWED|Bu manzilni hozir tahrirlab bo‘lmaydi','revision rejected while order is PREPARING');
update public.orders set status='READY' where id='70000000-0000-4000-8000-000000000007';
select throws_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000007',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000007'),'{}'::jsonb)$$,'22023','ADDRESS_REVISION_NOT_ALLOWED|Bu manzilni hozir tahrirlab bo‘lmaydi','revision rejected while order is READY');
update public.orders set status='DRIVER_ASSIGNED' where id='70000000-0000-4000-8000-000000000007';
select throws_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000007',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000007'),'{}'::jsonb)$$,'22023','ADDRESS_REVISION_NOT_ALLOWED|Bu manzilni hozir tahrirlab bo‘lmaydi','revision rejected while order is in driver lifecycle');
update public.orders set status='DELIVERED' where id='70000000-0000-4000-8000-000000000007';
select throws_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000007',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000007'),'{}'::jsonb)$$,'22023','ADDRESS_REVISION_NOT_ALLOWED|Bu manzilni hozir tahrirlab bo‘lmaydi','revision rejected while order is terminal (DELIVERED)');
update public.orders set status='CANCELLED' where id='70000000-0000-4000-8000-000000000007';
select throws_ok($$select public.revise_delivery_address('70000000-0000-4000-8000-000000000007',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000007'),'{}'::jsonb)$$,'22023','ADDRESS_REVISION_NOT_ALLOWED|Bu manzilni hozir tahrirlab bo‘lmaydi','revision rejected while order is terminal (CANCELLED)');

-- events remain append-only even for the new clarification event kind
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select throws_ok($$update public.order_events set notes='tampered' where order_id='70000000-0000-4000-8000-000000000004' and notes='DELIVERY_CLARIFICATION_REQUESTED'$$,'42501',null,'staff cannot mutate order_events directly');
reset role;

-- ==========================================================================
-- get_delivery_address_for_revision: narrow customer-safe address read
-- ==========================================================================

select public.create_public_order('{"id":"70000000-0000-4000-8000-000000000009","customer":{"name":"Revision Read Test","primaryPhone":"+998900000009"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test ko‘chasi","house":"noma’lum","landmark":"","deliveryNotes":"Uy raqamini aniqlashtirish kerak","latitude":40.12,"longitude":65.43,"pinConfirmedAt":"2026-08-08T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',true);
select lives_ok($$select public.request_delivery_clarification('70000000-0000-4000-8000-000000000009','Uy raqamini tasdiqlang')$$,'clarification requested for revision-read fixture');
reset role;

select is((select public.get_delivery_address_for_revision('70000000-0000-4000-8000-000000000009',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000009'))->>'house'),'noma’lum','correct token returns the current address');
select is((select array(select jsonb_object_keys(public.get_delivery_address_for_revision('70000000-0000-4000-8000-000000000009',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000009'))) order by 1)),array['apartment','confidence','deliveryNotes','district','entrance','floor','house','landmark','latitude','locationProvider','longitude','providerFormattedAddress','providerPlaceId','street']::text[],'response exposes only the intended address fields');
select is((select public.get_delivery_address_for_revision('70000000-0000-4000-8000-000000000009','00000000-0000-0000-0000-000000000099')),null,'wrong token returns nothing');
select is((select public.get_delivery_address_for_revision('70000000-0000-4000-8000-000000000009',null)),null,'missing token returns nothing');
select is((select public.get_delivery_address_for_revision('70000000-0000-4000-8000-000000000005',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000009'))),null,'a different order''s token returns nothing');
select is((select public.get_delivery_address_for_revision('70000000-0000-4000-8000-000000000008',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000008'))),null,'pickup order returns nothing');
select is((select public.get_delivery_address_for_revision('70000000-0000-4000-8000-000000000005',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000005'))),null,'REVIEW_REQUIRED order returns nothing');
select is((select public.get_delivery_address_for_revision('70000000-0000-4000-8000-000000000004',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000004'))),null,'approved/later-lifecycle order returns nothing');
select is((select public.get_delivery_address_for_revision('70000000-0000-4000-8000-000000000006',(select tracking_token from public.orders where id='70000000-0000-4000-8000-000000000006'))),null,'rejected order returns nothing');

select * from finish();
rollback;
