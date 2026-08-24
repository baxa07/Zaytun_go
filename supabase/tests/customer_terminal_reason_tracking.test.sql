begin;
select plan(4);

insert into public.orders(id,number,branch_id,customer_name,primary_phone,order_type,payment_method,status,subtotal,delivery_fee,cancellation_reason,rejection_reason)
values
('8c240000-0000-4000-8000-000000000001','ZG-CR01',(select id from public.branches order by created_at limit 1),'Customer','+998900000001','PICKUP','CASH','CANCELLED',0,0,'Restoran izohi: mahsulot qolmadi',null),
('8c240000-0000-4000-8000-000000000002','ZG-CR02',(select id from public.branches order by created_at limit 1),'Customer','+998900000002','PICKUP','CASH','REJECTED',0,0,null,'Yetkazish hududidan tashqarida');

select is(public.get_order_tracking('8c240000-0000-4000-8000-000000000001',(select tracking_token from public.orders where id='8c240000-0000-4000-8000-000000000001'))->>'cancellation_reason','Restoran izohi: mahsulot qolmadi','customer tracking exposes the exact cancellation comment');
select is(public.get_order_tracking('8c240000-0000-4000-8000-000000000002',(select tracking_token from public.orders where id='8c240000-0000-4000-8000-000000000002'))->>'rejection_reason','Yetkazish hududidan tashqarida','customer tracking exposes the exact rejection reason');
select is(public.get_order_tracking('8c240000-0000-4000-8000-000000000001','ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid),null,'wrong tracking token cannot read the cancellation comment');
select is(public.get_order_tracking('8c240000-0000-4000-8000-000000000001',(select tracking_token from public.orders where id='8c240000-0000-4000-8000-000000000001'))->>'primary_phone','','tracking response still redacts the customer phone');

select * from finish();
rollback;
