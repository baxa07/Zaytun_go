begin;
select plan(39);

create function pg_temp.pricing_payload(p_id uuid, p_items jsonb, p_type text default 'PICKUP', p_payment text default 'CASH')
returns jsonb language sql as $$
select jsonb_build_object(
  'id', p_id, 'idempotencyKey', p_id,
  'customer', jsonb_build_object('name','Pricing Test','primaryPhone','+998901234567'),
  'type', p_type, 'paymentMethod', p_payment,
  'address', jsonb_build_object(
    'district','Navoiy','street','Test','house','1','landmark','Maktab',
    'deliveryNotes','', 'latitude',40.104,'longitude',65.369,
    'pinConfirmedAt','2026-08-04T08:00:00Z','locationProvider','mock'
  ),
  'items', p_items
)
$$;

select lives_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000001','[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]'))$$,'normal order accepted');
select is((select subtotal from public.orders where id='40000000-0000-4000-8000-000000000001'),48000,'menu price determines subtotal');
select is((select delivery_fee from public.orders where id='40000000-0000-4000-8000-000000000001'),0,'pickup delivery fee is zero');
select is((select total from public.orders where id='40000000-0000-4000-8000-000000000001'),51000,'pickup grand total includes authoritative packaging');
select ok((select (public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000001','[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]'))->>'trackingToken') is not null),'successful idempotent response returns tracking token');

select lives_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000002','[{"menuItemId":"chicken","quantity":2,"modifierIds":["sauce"]}]'))$$,'modifier order accepted');
select is((select unit_price from public.order_items where order_id='40000000-0000-4000-8000-000000000002'),73000,'modifier price is added to unit snapshot');
select is((select subtotal from public.orders where id='40000000-0000-4000-8000-000000000002'),146000,'modifier line total determines subtotal');

select throws_ok($$select public.create_public_order(jsonb_set(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000003','[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]'),'{items,0,unitPrice}','1'))$$,'22023','CLIENT_PRICING_FIELDS_FORBIDDEN|Taom narxi server tomonidan hisoblanadi','client item price tampering rejected');
select throws_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000004','[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]')||'{"total":1}'::jsonb)$$,'22023','CLIENT_PRICING_FIELDS_FORBIDDEN|Narx va jami summa server tomonidan hisoblanadi','client total tampering rejected');

update public.menu_items set available=false where id='salad';
select throws_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000005','[{"menuItemId":"salad","quantity":1,"modifierIds":[]}]'))$$,'22023','MENU_ITEM_UNAVAILABLE|Tanlangan taom mavjud emas','unavailable item rejected');
update public.menu_items set available=true where id='salad';
select throws_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000006','[{"menuItemId":"missing","quantity":1,"modifierIds":[]}]'))$$,'22023','MENU_ITEM_UNAVAILABLE|Tanlangan taom mavjud emas','missing item rejected');
select throws_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000007','[{"menuItemId":"plov","quantity":1,"modifierIds":["missing"]}]'))$$,'22023','INVALID_MODIFIER|Tanlangan qo‘shimcha topilmadi','invalid modifier rejected');
select throws_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000008','[{"menuItemId":"plov","quantity":1,"modifierIds":["sauce"]}]'))$$,'22023','MODIFIER_ITEM_MISMATCH|Qo‘shimcha boshqa taomga tegishli','modifier from another item rejected');
update public.menu_modifiers set available=false where id='spicy';
select throws_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000009','[{"menuItemId":"chicken","quantity":1,"modifierIds":["spicy"]}]'))$$,'22023','MODIFIER_UNAVAILABLE|Tanlangan qo‘shimcha mavjud emas','unavailable modifier rejected');
update public.menu_modifiers set available=true where id='spicy';

select throws_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000010','[{"menuItemId":"plov","quantity":0,"modifierIds":[]}]'))$$,'22023','INVALID_QUANTITY|Taom miqdori 1–50 oralig‘ida bo‘lishi kerak','zero quantity rejected');
select throws_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000011','[{"menuItemId":"plov","quantity":-1,"modifierIds":[]}]'))$$,'22023','INVALID_QUANTITY|Taom miqdori butun son bo‘lishi kerak','negative quantity rejected');
select throws_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000012','[{"menuItemId":"plov","quantity":51,"modifierIds":[]}]'))$$,'22023','INVALID_QUANTITY|Taom miqdori 1–50 oralig‘ida bo‘lishi kerak','excessive quantity rejected');
select throws_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000013','[{"menuItemId":"chicken","quantity":1,"modifierIds":["sauce","sauce"]}]'))$$,'22023','DUPLICATE_MODIFIER|Bir qo‘shimcha takror tanlangan','duplicate modifier rejected');
select throws_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000014','[{"menuItemId":"plov","quantity":1,"modifierIds":[]},{"menuItemId":"plov","quantity":2,"modifierIds":[]}]'))$$,'22023','DUPLICATE_ITEM_SELECTION|Bir xil taom tanlovi takrorlangan','duplicate item selection rejected');
select throws_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000015','[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]','PICKUP','ONLINE_CARD'))$$,'22023','UNSUPPORTED_PAYMENT_METHOD|To‘lov usuli qo‘llab-quvvatlanmaydi','unsupported payment rejected');
select is((select count(*)::integer from public.orders where id between '40000000-0000-4000-8000-000000000003' and '40000000-0000-4000-8000-000000000015'),0,'invalid calls roll back without partial orders');

select lives_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000016','[{"menuItemId":"chicken","quantity":1,"modifierIds":[]}]'))$$,'snapshot order accepted');
update public.menu_items set price=99000 where id='chicken';
select is((select unit_price from public.order_items where order_id='40000000-0000-4000-8000-000000000016'),68000,'order-item price snapshot survives menu price change');
update public.menu_items set price=68000 where id='chicken';

select lives_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000017','[{"menuItemId":"chicken","quantity":2,"modifierIds":[]}]','DELIVERY'))$$,'delivery order accepted for manual review');
select is((select delivery_fee from public.orders where id='40000000-0000-4000-8000-000000000017'),10000,'subtotal below the free-delivery threshold is charged the base delivery fee');
select is((select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000017','[{"menuItemId":"chicken","quantity":2,"modifierIds":[]}]','DELIVERY'))->>'total'),'152000','response returns confirmed grand total including packaging and delivery fee');

select lives_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000018','[{"menuItemId":"chicken","quantity":3,"modifierIds":[]}]','DELIVERY'))$$,'delivery order at/above the free-delivery threshold accepted');
select is((select delivery_fee from public.orders where id='40000000-0000-4000-8000-000000000018'),0,'subtotal at or above the free-delivery threshold is not charged a delivery fee');
select is((select total from public.orders where id='40000000-0000-4000-8000-000000000018'),213000,'free-delivery total equals subtotal plus authoritative packaging');

-- Production hotfix: there is no delivery-order minimum -- only the
-- free-delivery-fee threshold. Exact mandated boundary values, tested
-- directly against calculate_delivery_quote (the one shared source of
-- truth every order-creation path reads) so they don't depend on menu
-- item prices lining up exactly.
select is((public.calculate_delivery_quote(40.0873,65.4026,1,'DELIVERY')->>'eligible')::boolean,true,'smallest technically valid positive basket (1 so‘m) is not rejected by any minimum');
select is((public.calculate_delivery_quote(40.0873,65.4026,1,'DELIVERY')->>'deliveryFee')::integer,10000,'1 so‘m subtotal is charged the base delivery fee');
select is((public.calculate_delivery_quote(40.0873,65.4026,99999,'DELIVERY')->>'deliveryFee')::integer,10000,'99,999 -> +10,000');
select is((public.calculate_delivery_quote(40.0873,65.4026,100000,'DELIVERY')->>'deliveryFee')::integer,10000,'100,000 (old minimum) -> +10,000, no longer rejected');
select is((public.calculate_delivery_quote(40.0873,65.4026,149999,'DELIVERY')->>'deliveryFee')::integer,10000,'149,999 -> +10,000');
select is((public.calculate_delivery_quote(40.0873,65.4026,150000,'DELIVERY')->>'deliveryFee')::integer,0,'150,000 -> free delivery (threshold is subtotal < 150,000, not <=)');
select is((public.calculate_delivery_quote(40.0873,65.4026,150001,'DELIVERY')->>'deliveryFee')::integer,0,'150,001 -> free delivery');

-- Security regression: a client cannot submit its own deliveryFee (or
-- subtotal/total) and have it trusted -- the whole payload is rejected
-- outright the instant any of these keys is present, never silently
-- recomputed-and-ignored. subtotal/total tampering is already proven
-- above; this proves deliveryFee specifically.
select throws_ok($$select public.create_public_order(pg_temp.pricing_payload('40000000-0000-4000-8000-000000000019','[{"menuItemId":"chicken","quantity":1,"modifierIds":[]}]','DELIVERY')||'{"deliveryFee":0}'::jsonb)$$,'22023','CLIENT_PRICING_FIELDS_FORBIDDEN|Narx va jami summa server tomonidan hisoblanadi','client deliveryFee tampering rejected');

set local role anon;
select throws_ok($$insert into public.orders(number,customer_name,primary_phone,order_type,payment_method,subtotal) values('ZG-HACK','X','+998901234567','PICKUP','CASH',1)$$,'42501',null,'anonymous direct order insert remains denied');
reset role;

select * from finish();
rollback;
