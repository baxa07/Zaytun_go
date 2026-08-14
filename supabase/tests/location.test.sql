begin;
select plan(19);
select has_table('public','delivery_settings','delivery settings exists');
select is(round(public.geographic_distance_km(40.087274,65.402551,40.087274,65.402551)::numeric,3),0.000::numeric,'same point distance is zero');
select lives_ok($$select public.create_public_order('{"id":"30000000-0000-4000-8000-000000000001","idempotencyKey":"30000000-0000-4000-8000-000000000001","customer":{"name":"Test","primaryPhone":"+998900000000"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","house":"1","landmark":"Maktab","deliveryNotes":"Kirish oldi","latitude":40.0873,"longitude":65.4026,"confidence":"COMPLETE","pinConfirmedAt":"2026-08-04T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[],"instructions":""}]}'::jsonb)$$,'delivery request accepted for review');
select is((select delivery_fee from orders where id='30000000-0000-4000-8000-000000000001'),10000,'subtotal below the free-delivery threshold is charged the base delivery fee');
select is((select total from orders where id='30000000-0000-4000-8000-000000000001'),154000,'server calculates authoritative total');
select ok((select delivery_distance_km<0.1 from customer_addresses where order_id='30000000-0000-4000-8000-000000000001'),'server stores distance');
select is((select delivery_review_status::text from orders where id='30000000-0000-4000-8000-000000000001'),'REVIEW_REQUIRED','manual policy requires review');
select is((public.calculate_delivery_quote(41,67,144000,'DELIVERY')->>'reviewRequired')::boolean,true,'arbitrary valid coordinate is reviewed rather than falsely accepted by a boundary');
select throws_ok($$select public.calculate_delivery_quote(91,65,150000,'DELIVERY')$$,'22023','INVALID_COORDINATES|Xaritadan to‘g‘ri yetkazish nuqtasini tanlang','invalid coordinates rejected');
-- Production hotfix: there is no delivery-order minimum -- a small
-- delivery basket (ayran alone, 12000 so'm) must succeed, well below the
-- old 100000 gate and well below the free-delivery threshold, so it's
-- charged the standard base delivery fee, not rejected outright.
select lives_ok($$select public.create_public_order('{"id":"30000000-0000-4000-8000-000000000005","customer":{"name":"Test","primaryPhone":"+998900000000"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","house":"1","landmark":"X","latitude":40.0873,"longitude":65.4026,"pinConfirmedAt":"2026-08-04T08:00:00Z"},"items":[{"menuItemId":"ayran","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'no delivery-order minimum -- a small basket is accepted');
select is((select subtotal from orders where id='30000000-0000-4000-8000-000000000005'),12000,'small basket subtotal stored as-is');
select is((select delivery_fee from orders where id='30000000-0000-4000-8000-000000000005'),10000,'subtotal below the free-delivery threshold is still charged the base delivery fee');
select lives_ok($$select public.create_public_order('{"id":"30000000-0000-4000-8000-000000000003","customer":{"name":"Pickup","primaryPhone":"+998900000000"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"ayran","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'pickup bypasses coordinates and delivery minimum');
select is((select delivery_review_status::text from orders where id='30000000-0000-4000-8000-000000000003'),'NOT_REQUIRED','pickup does not require review');
select throws_ok($$select public.create_public_order('{"id":"30000000-0000-4000-8000-000000000006","customer":{"name":"Test","primaryPhone":"+998900000000"},"type":"DELIVERY","paymentMethod":"CARD_ON_DELIVERY","address":{"district":"Navoiy","street":"Test","house":"1","landmark":"X","latitude":40.0873,"longitude":65.4026,"pinConfirmedAt":"2026-08-04T08:00:00Z"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb)$$,'22023','UNSUPPORTED_PAYMENT_METHOD|Tanlangan to‘lov usuli bu buyurtma turi uchun mavjud emas','unsupported payment rejected');
-- Minimum delivery-address contract (Delivery Address + Pin Workflow
-- Refinement): the confirmed pin is the primary geographic source --
-- district + street + confirmed pin must be sufficient on their own, with
-- house/entrance/floor/apartment/landmark/deliveryNotes entirely absent.
select lives_ok($$select public.create_public_order('{"id":"30000000-0000-4000-8000-000000000007","idempotencyKey":"30000000-0000-4000-8000-000000000007","customer":{"name":"Minimal","primaryPhone":"+998900000000"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test ko‘chasi","latitude":40.0873,"longitude":65.4026,"pinConfirmedAt":"2026-08-04T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[],"instructions":""}]}'::jsonb)$$,'minimum contract succeeds: district + street + confirmed pin only, no house/landmark/notes');
update delivery_settings set delivery_enabled=false;
select is((public.calculate_delivery_quote(40.0873,65.4026,150000,'DELIVERY')->>'zoneResult'),'DELIVERY_DISABLED','delivery disabled rejected in quote');
select throws_ok($$select public.create_public_order('{"id":"30000000-0000-4000-8000-000000000004","customer":{"name":"Test","primaryPhone":"+998900000000"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","house":"1","landmark":"X","latitude":40.0873,"longitude":65.4026,"pinConfirmedAt":"2026-08-04T08:00:00Z"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb)$$,'P0001','DELIVERY_DISABLED|Yetkazib berish vaqtincha o‘chirilgan','delivery-disabled order rejected');
select is((public.create_public_order('{"id":"30000000-0000-4000-8000-000000000099","idempotencyKey":"30000000-0000-4000-8000-000000000001","customer":{"name":"Changed","primaryPhone":"x"},"type":"PICKUP","paymentMethod":"CASH","items":[{"unitPrice":1,"quantity":1}]}'::jsonb)->>'id'),'30000000-0000-4000-8000-000000000001','idempotency returns original order');
select * from finish();
rollback;
