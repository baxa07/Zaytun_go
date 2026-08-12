begin;
select plan(14);

-- Payment Preference v1: CLICK/PAYME record only that the customer intends
-- to pay by that method -- never that payment was received. Enum/config
-- exposure assertions live in pickup_fulfillment.test.sql alongside the
-- other payment-method enum checks; this file covers order creation,
-- rejection, and the payment_status auto-collection behavior specifically.

select lives_ok($$select public.create_public_order('{"id":"90000000-0000-4000-8000-000000000001","customer":{"name":"Click Delivery","primaryPhone":"+998900000010"},"type":"DELIVERY","paymentMethod":"CLICK","address":{"district":"Navoiy","street":"Test ko‘chasi","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-12T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb)$$,'delivery CLICK order can be created when supported');
select lives_ok($$select public.create_public_order('{"id":"90000000-0000-4000-8000-000000000002","customer":{"name":"Payme Delivery","primaryPhone":"+998900000011"},"type":"DELIVERY","paymentMethod":"PAYME","address":{"district":"Navoiy","street":"Test ko‘chasi","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-12T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb)$$,'delivery PAYME order can be created when supported');
select is((select payment_method::text from public.orders where id='90000000-0000-4000-8000-000000000001'),'CLICK','CLICK preference stored authoritatively');
select is((select payment_method::text from public.orders where id='90000000-0000-4000-8000-000000000002'),'PAYME','PAYME preference stored authoritatively');

-- CLICK/PAYME means "customer intends to pay this way" only -- a brand new
-- order must never start out looking paid.
select is((select payment_status::text from public.orders where id='90000000-0000-4000-8000-000000000001'),'PENDING','a new CLICK order is not paid merely by selecting it');
select is((select payment_status::text from public.orders where id='90000000-0000-4000-8000-000000000002'),'PENDING','a new PAYME order is not paid merely by selecting it');

-- CLICK/PAYME is not offered for pickup in this pass (CARD_AT_PICKUP
-- already covers in-person restaurant payment; see task decision) --
-- attempting it must be rejected exactly like any other unsupported method.
select throws_ok($$select public.create_public_order('{"id":"90000000-0000-4000-8000-000000000003","customer":{"name":"Bad Pickup","primaryPhone":"+998900000012"},"type":"PICKUP","paymentMethod":"CLICK","items":[{"menuItemId":"ayran","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'22023','UNSUPPORTED_PAYMENT_METHOD|Tanlangan to‘lov usuli bu buyurtma turi uchun mavjud emas','CLICK rejected for pickup (not configured, avoids CARD_AT_PICKUP ambiguity)');

-- Sanity: CASH delivery still works unchanged alongside the new methods.
select lives_ok($$select public.create_public_order('{"id":"90000000-0000-4000-8000-000000000004","customer":{"name":"Cash Still Works","primaryPhone":"+998900000013"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test ko‘chasi","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-12T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb)$$,'CASH delivery order still works');

-- Fast-forward all three orders straight to ARRIVED with an assigned
-- driver (bypassing the full lifecycle walk, which is already covered
-- end to end elsewhere) so transition_order's DELIVERED handling -- the
-- part this migration actually changed -- can be exercised directly.
update public.orders set delivery_review_status='APPROVED',status='ARRIVED',assigned_driver_id='10000000-0000-0000-0000-000000000003'
  where id in('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000004');

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select lives_ok($$select public.transition_order('90000000-0000-4000-8000-000000000001','DELIVERED',null,null)$$,'CLICK order can still be marked delivered');
select lives_ok($$select public.transition_order('90000000-0000-4000-8000-000000000002','DELIVERED',null,null)$$,'PAYME order can still be marked delivered');
select lives_ok($$select public.transition_order('90000000-0000-4000-8000-000000000004','DELIVERED',null,null)$$,'CASH order can still be marked delivered');
reset role;

-- The actual behavior this task requires: reaching DELIVERED must not
-- silently mark a CLICK/PAYME order as paid -- it stays PENDING until
-- restaurant staff verify receipt some other way. CASH, which completes
-- physically at the moment of delivery, keeps auto-collecting exactly as
-- before -- proving the narrowing didn't regress the existing method.
select is((select payment_status::text from public.orders where id='90000000-0000-4000-8000-000000000001'),'PENDING','delivered CLICK order is still only PENDING, never auto-collected');
select is((select payment_status::text from public.orders where id='90000000-0000-4000-8000-000000000002'),'PENDING','delivered PAYME order is still only PENDING, never auto-collected');
select is((select payment_status::text from public.orders where id='90000000-0000-4000-8000-000000000004'),'COLLECTED','CASH still auto-collects on delivery (unchanged regression)');

select * from finish();
rollback;
