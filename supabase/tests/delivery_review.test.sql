begin;
select plan(13);

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

select * from finish();
rollback;
