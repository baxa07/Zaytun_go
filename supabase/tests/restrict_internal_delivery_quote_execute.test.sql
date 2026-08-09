-- calculate_delivery_quote_internal must be executable only by the
-- function owner (postgres) — never directly by anon, authenticated, or
-- service_role. This is privilege-only coverage for 20260809160000; the
-- underlying quote/revision behavior is covered in
-- delivery_revision_admission_control.test.sql and re-confirmed briefly
-- here to prove the privilege tightening did not break the trusted path.
begin;
select plan(8);

select ok(not has_function_privilege('anon','public.calculate_delivery_quote_internal(double precision,double precision,integer,order_type,boolean)','EXECUTE'),'anon has no EXECUTE on the internal primitive');
select ok(not has_function_privilege('authenticated','public.calculate_delivery_quote_internal(double precision,double precision,integer,order_type,boolean)','EXECUTE'),'authenticated has no EXECUTE on the internal primitive');
select ok(not has_function_privilege('service_role','public.calculate_delivery_quote_internal(double precision,double precision,integer,order_type,boolean)','EXECUTE'),'service_role has no EXECUTE on the internal primitive');
select ok(has_function_privilege('postgres','public.calculate_delivery_quote_internal(double precision,double precision,integer,order_type,boolean)','EXECUTE'),'postgres (owner) retains EXECUTE on the internal primitive');

-- the trusted server-side path must still work end to end
update public.delivery_settings set delivery_enabled=true where id=true;
select public.create_public_order('{"id":"70000000-0000-4000-8000-0000000000d1","customer":{"name":"Privilege Hotfix Check","primaryPhone":"+998900000105"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","house":"1","landmark":"Kirish","deliveryNotes":"","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-08T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select lives_ok($$select public.request_delivery_clarification('70000000-0000-4000-8000-0000000000d1','Uy raqamini aniqlashtiring')$$,'restaurant requests clarification');
reset role;
update public.delivery_settings set delivery_enabled=false where id=true;

select lives_ok(
  $$select public.revise_delivery_address('70000000-0000-4000-8000-0000000000d1',(select tracking_token from public.orders where id='70000000-0000-4000-8000-0000000000d1'),'{"district":"Navoiy","street":"Revised","house":"2","landmark":"Revised mo‘ljal","deliveryNotes":"","latitude":40.10,"longitude":65.41,"pinConfirmedAt":"2026-08-08T09:00:00Z","locationProvider":"mock"}'::jsonb)$$,
  'existing delivery revision still succeeds while disabled, after the internal primitive was locked down');
select is((select delivery_review_status::text from public.orders where id='70000000-0000-4000-8000-0000000000d1'),'REVIEW_REQUIRED','review returns to REVIEW_REQUIRED');

select throws_ok(
  $$select public.create_public_order('{"id":"70000000-0000-4000-8000-0000000000d2","customer":{"name":"Still Blocked","primaryPhone":"+998900000106"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","house":"1","landmark":"Kirish","deliveryNotes":"","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-08T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb)$$,
  'P0001','DELIVERY_DISABLED|Yetkazib berish vaqtincha o‘chirilgan','new DELIVERY order creation remains blocked after the privilege tightening');

select * from finish();
rollback;
