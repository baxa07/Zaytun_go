-- delivery_enabled is admission control for NEW delivery order creation; it
-- must not strand an already-existing delivery order's clarification loop.
begin;
select plan(22);

-- The internal admission-control-parameterized primitive is not exposed to
-- anon/authenticated: only trusted server-side callers may skip admission
-- control, and only after already proving order/token/state.
select has_function('public','calculate_delivery_quote_internal',array['double precision','double precision','integer','order_type','boolean'],'internal quote primitive exists');
select ok(not has_function_privilege('anon','public.calculate_delivery_quote_internal(double precision,double precision,integer,order_type,boolean)','EXECUTE'),'anon cannot call the internal primitive directly');
select ok(not has_function_privilege('authenticated','public.calculate_delivery_quote_internal(double precision,double precision,integer,order_type,boolean)','EXECUTE'),'authenticated cannot call the internal primitive directly');
select ok(has_function_privilege('anon','public.calculate_delivery_quote(double precision,double precision,integer,order_type)','EXECUTE'),'the public quote wrapper keeps its existing anon grant');
select ok(has_function_privilege('anon','public.revise_delivery_address(uuid,uuid,jsonb)','EXECUTE'),'revise_delivery_address keeps its existing anon grant');

-- ==========================================================================
-- A. NEW ORDER admission control is unaffected by this hotfix
-- ==========================================================================
update public.delivery_settings set delivery_enabled=false where id=true;

select throws_ok(
  $$select public.create_public_order('{"id":"70000000-0000-4000-8000-0000000000a1","customer":{"name":"Should Be Rejected","primaryPhone":"+998900000101"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","house":"1","landmark":"Kirish","deliveryNotes":"","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-08T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb)$$,
  'P0001','DELIVERY_DISABLED|Yetkazib berish vaqtincha o‘chirilgan','a brand-new DELIVERY order is still rejected while disabled');

select lives_ok(
  $$select public.create_public_order('{"id":"70000000-0000-4000-8000-0000000000a2","customer":{"name":"Pickup Still Fine","primaryPhone":"+998900000102"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]}'::jsonb)$$,
  'PICKUP order creation remains available while delivery is disabled');

-- ==========================================================================
-- B. EXISTING DELIVERY continuation is not stranded by the same switch
-- ==========================================================================
update public.delivery_settings set delivery_enabled=true where id=true;
select public.create_public_order('{"id":"70000000-0000-4000-8000-0000000000b1","customer":{"name":"Existing Order Continuation","primaryPhone":"+998900000103"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Original","house":"1","landmark":"Original mo‘ljal","deliveryNotes":"","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-08T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.request_delivery_clarification('70000000-0000-4000-8000-0000000000b1','Uy raqamini aniqlashtiring')$$,'restaurant requests clarification while delivery still enabled');
reset role;

update public.delivery_settings set delivery_enabled=false where id=true;

select is((select public.get_delivery_address_for_revision('70000000-0000-4000-8000-0000000000b1',(select tracking_token from public.orders where id='70000000-0000-4000-8000-0000000000b1'))->>'district'),'Navoiy','prefill read still works once delivery is disabled');
select is((select public.get_delivery_address_for_revision('70000000-0000-4000-8000-0000000000b1','00000000-0000-0000-0000-000000000099')),null,'wrong token still rejected while delivery is disabled');

select lives_ok(
  $$select public.revise_delivery_address('70000000-0000-4000-8000-0000000000b1',(select tracking_token from public.orders where id='70000000-0000-4000-8000-0000000000b1'),'{"district":"Navoiy","street":"Revised","house":"2","landmark":"Revised mo‘ljal","deliveryNotes":"","latitude":40.10,"longitude":65.41,"pinConfirmedAt":"2026-08-08T09:00:00Z","locationProvider":"mock"}'::jsonb)$$,
  'address revision succeeds for an existing order despite delivery_enabled=false');

select is((select delivery_review_status::text from public.orders where id='70000000-0000-4000-8000-0000000000b1'),'REVIEW_REQUIRED','review returns to REVIEW_REQUIRED');
select is((select status::text from public.orders where id='70000000-0000-4000-8000-0000000000b1'),'NEW','lifecycle remains NEW');
select is((select count(*)::int from public.customer_addresses where order_id='70000000-0000-4000-8000-0000000000b1'),1,'exactly one authoritative address row');
select is((select street from public.customer_addresses where order_id='70000000-0000-4000-8000-0000000000b1'),'Revised','the revision itself was actually applied');
select is((select subtotal from public.orders where id='70000000-0000-4000-8000-0000000000b1'),144000,'subtotal unchanged by the revision (3 x plov @ 48000)');
select is((select count(*)::int from public.order_items where order_id='70000000-0000-4000-8000-0000000000b1'),1,'item count unchanged');
select is((select payment_method::text from public.orders where id='70000000-0000-4000-8000-0000000000b1'),'CASH','payment method unchanged');
select is((select assigned_driver_id from public.orders where id='70000000-0000-4000-8000-0000000000b1'),null,'still no driver assigned');

-- staff may subsequently approve the revised address, still with delivery disabled
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.review_delivery_request('70000000-0000-4000-8000-0000000000b1',true,null)$$,'staff can approve the revised address while delivery remains disabled');
reset role;
select is((select delivery_review_status::text from public.orders where id='70000000-0000-4000-8000-0000000000b1'),'APPROVED','existing delivery workflow is not stranded — reaches APPROVED');

-- prove the hotfix did not quietly relax admission control for new orders
select throws_ok(
  $$select public.create_public_order('{"id":"70000000-0000-4000-8000-0000000000c1","customer":{"name":"Still Rejected After Fix","primaryPhone":"+998900000104"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","house":"1","landmark":"Kirish","deliveryNotes":"","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-08T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb)$$,
  'P0001','DELIVERY_DISABLED|Yetkazib berish vaqtincha o‘chirilgan','new DELIVERY order creation is still rejected after the fix, right after an existing-order revision succeeded');

select * from finish();
rollback;
