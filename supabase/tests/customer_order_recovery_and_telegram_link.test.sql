begin;
select plan(18);

insert into auth.users(instance_id,id,aud,role,phone,encrypted_password,phone_confirmed_at,raw_app_meta_data,raw_user_meta_data)
values
 ('00000000-0000-0000-0000-000000000000','91000000-0000-0000-0000-000000000001','authenticated','authenticated','998901230001',crypt('x',gen_salt('bf')),now(),'{"provider":"phone"}','{}'),
 ('00000000-0000-0000-0000-000000000000','91000000-0000-0000-0000-000000000002','authenticated','authenticated','998901230002',crypt('x',gen_salt('bf')),now(),'{"provider":"phone"}','{}');
insert into public.customers(id,auth_user_id,phone_e164)
values
 ('92000000-0000-0000-0000-000000000001','91000000-0000-0000-0000-000000000001','+998901230001'),
 ('92000000-0000-0000-0000-000000000002','91000000-0000-0000-0000-000000000002','+998901230002');

insert into public.orders(id,number,customer_name,primary_phone,order_type,payment_method,status,subtotal,customer_id,branch_id)
values
 ('93000000-0000-0000-0000-000000000001','ZG-R001','One','+998901230001','DELIVERY','CASH','NEW',100000,'92000000-0000-0000-0000-000000000001',(select id from public.branches order by created_at limit 1)),
 ('93000000-0000-0000-0000-000000000002','ZG-R002','Two','+998901230002','DELIVERY','CASH','NEW',100000,'92000000-0000-0000-0000-000000000002',(select id from public.branches order by created_at limit 1)),
 ('93000000-0000-0000-0000-000000000003','ZG-HIST','Guest','+998901230003','PICKUP','CASH','NEW',50000,null,(select id from public.branches order by created_at limit 1));

select set_config('request.jwt.claim.sub','91000000-0000-0000-0000-000000000001',true);
set local role authenticated;
select is((public.get_my_order_tracking('93000000-0000-0000-0000-000000000001')->>'number'),'ZG-R001','customer can recover their own tracking without a browser token');
select throws_ok($$select public.get_my_order_tracking('93000000-0000-0000-0000-000000000002')$$,'P0001','ORDER_NOT_FOUND|Buyurtma topilmadi','customer cannot recover another customer order');
select throws_ok($$select public.get_my_order_tracking('93000000-0000-0000-0000-000000000003')$$,'P0001','ORDER_NOT_FOUND|Buyurtma topilmadi','historical anonymous order is not claimed by login');
select ok(public.request_my_telegram_link('93000000-0000-0000-0000-000000000001') is not null,'owner can request Telegram link without local tracking token');
select throws_ok($$select public.request_my_telegram_link('93000000-0000-0000-0000-000000000002')$$,'P0001','ORDER_NOT_FOUND|Buyurtma topilmadi','another customer cannot issue a link token');
reset role;

select is((select customer_id from public.telegram_link_requests where order_id='93000000-0000-0000-0000-000000000001' order by created_at desc limit 1),'92000000-0000-0000-0000-000000000001'::uuid,'link token is scoped to the owning customer');
select ok(not public.consume_customer_telegram_link((select token from public.telegram_link_requests where order_id='93000000-0000-0000-0000-000000000001' limit 1),-100,123,'supergroup'),'group chat cannot consume customer link');
select is((select consumed_at from public.telegram_link_requests where order_id='93000000-0000-0000-0000-000000000001' limit 1),null,'rejected group attempt does not burn the token');
select ok(not public.consume_customer_telegram_link((select token from public.telegram_link_requests where order_id='93000000-0000-0000-0000-000000000001' limit 1),123,456,'private'),'mismatched private chat and Telegram user cannot consume link');
select ok(public.consume_customer_telegram_link((select token from public.telegram_link_requests where order_id='93000000-0000-0000-0000-000000000001' limit 1),123,123,'private'),'valid private Telegram identity consumes link');
select is((select telegram_user_id from public.customers where id='92000000-0000-0000-0000-000000000001'),123::bigint,'customer Telegram mapping is stored');
select is((select customer_telegram_chat_id from public.orders where id='93000000-0000-0000-0000-000000000001'),123::bigint,'order Telegram destination is stored');
select ok(not public.consume_customer_telegram_link((select token from public.telegram_link_requests where order_id='93000000-0000-0000-0000-000000000001' limit 1),123,123,'private'),'token is single-use');

update public.telegram_link_requests set expires_at=now()-interval '1 second',consumed_at=null where order_id='93000000-0000-0000-0000-000000000001';
select ok(not public.consume_customer_telegram_link((select token from public.telegram_link_requests where order_id='93000000-0000-0000-0000-000000000001' limit 1),123,123,'private'),'expired token is rejected');

insert into public.telegram_link_requests(order_id,customer_id) values('93000000-0000-0000-0000-000000000001','92000000-0000-0000-0000-000000000001');
select ok(not public.consume_customer_telegram_link((select token from public.telegram_link_requests where order_id='93000000-0000-0000-0000-000000000001' and consumed_at is null and expires_at>now() order by created_at desc limit 1),999,999,'private'),'existing mapping cannot be silently replaced');
select is((select telegram_user_id from public.customers where id='92000000-0000-0000-0000-000000000001'),123::bigint,'failed relink preserves existing Telegram identity');

insert into public.orders(id,number,customer_name,primary_phone,order_type,payment_method,status,subtotal,customer_id,branch_id)
values('93000000-0000-0000-0000-000000000004','ZG-R004','One','+998901230001','DELIVERY','CASH','NEW',100000,'92000000-0000-0000-0000-000000000001',(select id from public.branches order by created_at limit 1));
select is((select customer_telegram_chat_id from public.orders where id='93000000-0000-0000-0000-000000000004'),123::bigint,'new authenticated order inherits linked Telegram destination');
select is((select customer_id from public.orders where id='93000000-0000-0000-0000-000000000003'),null,'historical anonymous order remains anonymous and valid');

select * from finish();
rollback;
