begin;
select plan(24);

update public.delivery_settings set customer_auth_required=false,delivery_enabled=true,base_delivery_fee=10000,free_delivery_threshold=150000 where id=true;

select is((select packaging_required from public.menu_items where id='nacional-somsa-obychnyy-i-ostryy'),false,'normal somsa explicitly requires no packaging');
select is((select row(packaging_required,packaging_unit_price,packaging_capacity) from public.menu_items where id='nacional-olot-somsa'),row(true,3000,15),'Olot somsa has the approved 3000/15 packaging configuration');

create function pg_temp.place(p_id uuid,p_type text,p_items jsonb) returns jsonb language sql as $$
  select public.create_public_order(jsonb_build_object(
    'id',p_id,'customer',jsonb_build_object('name','Packaging Test','primaryPhone','+998900000099'),
    'type',p_type,'paymentMethod','CASH','items',p_items,
    'address',case when p_type='DELIVERY' then jsonb_build_object('district','Navoiy','street','Test','latitude',40.0873,'longitude',65.4026,'pinConfirmedAt','2026-08-21T08:00:00Z','locationProvider','mock') else null end
  ));
$$;

select pg_temp.place('8a100000-0000-4000-8000-000000000001','PICKUP','[{"menuItemId":"nacional-somsa-obychnyy-i-ostryy","quantity":1,"modifierIds":[]}]');
select is((select packaging_total from public.orders where id='8a100000-0000-4000-8000-000000000001'),0,'normal somsa x1 -> zero packaging');
select is((select packaging_box_count from public.order_items where order_id='8a100000-0000-4000-8000-000000000001'),0,'normal somsa x1 -> zero boxes');

select pg_temp.place('8a100000-0000-4000-8000-000000000002','PICKUP','[{"menuItemId":"nacional-somsa-obychnyy-i-ostryy","quantity":20,"modifierIds":[]}]');
select is((select packaging_total from public.orders where id='8a100000-0000-4000-8000-000000000002'),0,'normal somsa x20 -> zero packaging');

select pg_temp.place('8a100000-0000-4000-8000-000000000003','PICKUP','[{"menuItemId":"nacional-olot-somsa","quantity":1,"modifierIds":[]}]');
select is((select row(packaging_box_count,packaging_total) from public.order_items where order_id='8a100000-0000-4000-8000-000000000003'),row(1,3000),'Olot x1 -> one box / 3000');

select pg_temp.place('8a100000-0000-4000-8000-000000000004','PICKUP','[{"menuItemId":"nacional-olot-somsa","quantity":15,"modifierIds":[]}]');
select is((select row(packaging_box_count,packaging_total) from public.order_items where order_id='8a100000-0000-4000-8000-000000000004'),row(1,3000),'Olot x15 -> one box / 3000');

select pg_temp.place('8a100000-0000-4000-8000-000000000005','PICKUP','[{"menuItemId":"nacional-olot-somsa","quantity":16,"modifierIds":[]}]');
select is((select row(packaging_box_count,packaging_total) from public.order_items where order_id='8a100000-0000-4000-8000-000000000005'),row(2,6000),'Olot x16 -> two boxes / 6000');
select is((select total from public.orders where id='8a100000-0000-4000-8000-000000000005'),166000,'pickup total includes food plus mandatory packaging and no delivery fee');

select pg_temp.place('8a100000-0000-4000-8000-000000000006','PICKUP','[{"menuItemId":"nacional-olot-somsa","quantity":30,"modifierIds":[]}]');
select is((select row(packaging_box_count,packaging_total) from public.order_items where order_id='8a100000-0000-4000-8000-000000000006'),row(2,6000),'Olot x30 -> two boxes / 6000');

select pg_temp.place('8a100000-0000-4000-8000-000000000007','PICKUP','[{"menuItemId":"nacional-olot-somsa","quantity":31,"modifierIds":[]}]');
select is((select row(packaging_box_count,packaging_total) from public.order_items where order_id='8a100000-0000-4000-8000-000000000007'),row(3,9000),'Olot x31 -> three boxes / 9000');

select pg_temp.place('8a100000-0000-4000-8000-000000000008','PICKUP','[{"menuItemId":"nacional-olot-somsa","quantity":16,"modifierIds":[]},{"menuItemId":"nacional-somsa-obychnyy-i-ostryy","quantity":20,"modifierIds":[]}]');
select is((select subtotal from public.orders where id='8a100000-0000-4000-8000-000000000008'),400000,'mixed-cart food subtotal remains separate and authoritative');
select is((select packaging_total from public.orders where id='8a100000-0000-4000-8000-000000000008'),6000,'mixed cart charges packaging only for Olot');
select is((select total from public.orders where id='8a100000-0000-4000-8000-000000000008'),406000,'mixed pickup final total includes separate packaging');

select pg_temp.place('8a100000-0000-4000-8000-000000000009','DELIVERY','[{"menuItemId":"nacional-olot-somsa","quantity":1,"modifierIds":[]}]');
select is((select packaging_total from public.orders where id='8a100000-0000-4000-8000-000000000009'),3000,'delivery also includes mandatory product packaging');
select is((select delivery_fee from public.orders where id='8a100000-0000-4000-8000-000000000009'),10000,'existing delivery fee remains based on the food subtotal');
select is((select total from public.orders where id='8a100000-0000-4000-8000-000000000009'),23000,'delivery final total is food + packaging + delivery fee');

select throws_ok($$select public.create_public_order('{"id":"8a100000-0000-4000-8000-000000000010","customer":{"name":"Tamper","primaryPhone":"+998900000099"},"type":"PICKUP","paymentMethod":"CASH","packagingTotal":0,"items":[{"menuItemId":"nacional-olot-somsa","quantity":16,"modifierIds":[]}]}'::jsonb)$$,'22023','CLIENT_PRICING_FIELDS_FORBIDDEN|Qadoqlash narxi server tomonidan hisoblanadi','client cannot submit an order packaging total');
select throws_ok($$select public.create_public_order('{"id":"8a100000-0000-4000-8000-000000000011","customer":{"name":"Tamper","primaryPhone":"+998900000099"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"nacional-olot-somsa","quantity":16,"modifierIds":[],"packagingUnitPrice":1}]}'::jsonb)$$,'22023','CLIENT_PRICING_FIELDS_FORBIDDEN|Qadoqlash narxi server tomonidan hisoblanadi','client cannot submit a packaging unit price');
select is((select count(*)::integer from public.orders where id in('8a100000-0000-4000-8000-000000000010','8a100000-0000-4000-8000-000000000011')),0,'tampered requests create no orders');

select is(((public.order_creation_result('8a100000-0000-4000-8000-000000000005')->>'packagingTotal')::integer),6000,'creation response exposes the server-confirmed packaging subtotal');
select is(((public.get_order_tracking('8a100000-0000-4000-8000-000000000005',(select tracking_token from public.orders where id='8a100000-0000-4000-8000-000000000005'))#>>'{order_items,0,packaging_box_count}')::integer),2,'customer tracking preserves the two-box snapshot');

update public.menu_items set packaging_unit_price=4000 where id='nacional-olot-somsa';
select is((select packaging_unit_price from public.order_items where order_id='8a100000-0000-4000-8000-000000000005'),3000,'historical item keeps the packaging unit-price snapshot after menu changes');
select is((select packaging_total from public.orders where id='8a100000-0000-4000-8000-000000000005'),6000,'historical order packaging total remains financially unchanged');

select * from finish();
rollback;
