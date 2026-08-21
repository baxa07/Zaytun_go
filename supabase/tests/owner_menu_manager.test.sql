begin;
select no_plan();

select ok(has_function_privilege('authenticated','public.owner_update_menu_item(text,timestamptz,jsonb)','EXECUTE'),'authenticated may call guarded owner update RPC');
select ok(not has_function_privilege('anon','public.owner_update_menu_item(text,timestamptz,jsonb)','EXECUTE'),'anonymous cannot call owner update RPC');
select ok(not has_table_privilege('authenticated','public.menu_items','UPDATE'),'browser roles have no direct menu update privilege');
select ok(not has_table_privilege('authenticated','public.menu_items','INSERT'),'browser roles have no direct menu insert privilege');
select ok(not has_table_privilege('authenticated','public.menu_audit_log','INSERT'),'browser cannot forge audit rows');
select ok(not has_table_privilege('authenticated','public.menu_audit_log','TRUNCATE'),'browser cannot truncate immutable audit rows');
select ok(not has_table_privilege('anon','public.menu_audit_log','SELECT'),'anonymous cannot read menu audit rows');
select ok(has_table_privilege('authenticated','public.menu_audit_log','SELECT'),'authenticated OWNER may read audit rows through RLS');

-- A pre-change order proves snapshots are not rewritten by later menu edits.
select public.create_public_order('{"id":"8b100000-0000-4000-8000-000000000001","customer":{"name":"Snapshot","primaryPhone":"+998900000099"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"chicken","quantity":1,"modifierIds":[]}]}'::jsonb);
select is((select unit_price from public.order_items where order_id='8b100000-0000-4000-8000-000000000001'),68000,'historical price snapshot starts at 68000');
select is((select packaging_total from public.order_items where order_id='8b100000-0000-4000-8000-000000000001'),3000,'historical packaging snapshot starts at 3000');

-- Every non-owner role is rejected by the server function itself.
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select throws_ok($$select public.owner_update_menu_item('chicken',(select updated_at from public.menu_items where id='chicken'),' {"price":70000}'::jsonb)$$,'42501','OWNER_ROLE_REQUIRED|Owner roli talab qilinadi','RESTAURANT cannot edit menu');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select throws_ok($$select public.owner_update_menu_item('chicken',now(),'{"price":70000}'::jsonb)$$,'42501','OWNER_ROLE_REQUIRED|Owner roli talab qilinadi','DRIVER cannot edit menu');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000099',true);
select throws_ok($$select public.owner_create_menu_item('{"name":"Attack","categoryId":"grill","price":1}'::jsonb)$$,'42501','OWNER_ROLE_REQUIRED|Owner roli talab qilinadi','profile-less customer cannot create menu product');
reset role;

-- OWNER mutations, concurrency and audit.
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000005',true);
select ok(public.is_owner(),'seeded local OWNER is authoritative owner');
create temp table old_versions as select id,updated_at from public.menu_items where id='chicken';
select lives_ok($$select public.owner_update_menu_item('chicken',(select updated_at from old_versions),'{"price":70000}'::jsonb)$$,'OWNER changes price');
select is((select price from public.menu_items where id='chicken'),70000,'authoritative customer menu price changed');
select throws_ok($$select public.owner_update_menu_item('chicken',(select updated_at from old_versions),'{"price":71000}'::jsonb)$$,'40001','MENU_ITEM_STALE|Mahsulot boshqa oynada o‘zgartirilgan. Yangilang.','stale edit is rejected');
select throws_ok($$select public.owner_update_menu_item('chicken',(select updated_at from public.menu_items where id='chicken'),'{"price":0}'::jsonb)$$,'22023','INVALID_PRODUCT_PRICE|Narx noldan katta bo‘lishi kerak','invalid price rejected');
select is((select unit_price from public.order_items where order_id='8b100000-0000-4000-8000-000000000001'),68000,'historical price snapshot remains unchanged');
select is((select count(*)::integer from public.menu_audit_log where product_id='chicken' and action='PRICE_CHANGED'),1,'price change is audited once');
select is((select actor_user_id from public.menu_audit_log where product_id='chicken' and action='PRICE_CHANGED'),'10000000-0000-0000-0000-000000000005'::uuid,'audit actor comes from auth.uid');

select lives_ok($$select public.owner_update_menu_item('chicken',(select updated_at from public.menu_items where id='chicken'),'{"available":false}'::jsonb)$$,'OWNER disables product');
select is((select available from public.menu_items where id='chicken'),false,'product is unavailable');
select throws_ok($$select public.create_public_order('{"id":"8b100000-0000-4000-8000-000000000002","customer":{"name":"Blocked","primaryPhone":"+998900000099"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"chicken","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'22023','MENU_ITEM_UNAVAILABLE|Tanlangan taom mavjud emas','unavailable product cannot be newly ordered');
select lives_ok($$select public.owner_update_menu_item('chicken',(select updated_at from public.menu_items where id='chicken'),'{"available":true}'::jsonb)$$,'OWNER re-enables product');
select is((select count(*)::integer from public.menu_audit_log where product_id='chicken' and action='AVAILABILITY_CHANGED'),2,'both availability changes are audited');

select lives_ok($$select public.owner_update_menu_item('chicken',(select updated_at from public.menu_items where id='chicken'),'{"packagingUnitPrice":4000,"packagingCapacity":2}'::jsonb)$$,'OWNER changes packaging price and capacity');
select is((select row(packaging_unit_price,packaging_capacity) from public.menu_items where id='chicken'),row(4000,2),'new packaging configuration persisted');
select throws_ok($$select public.owner_update_menu_item('chicken',(select updated_at from public.menu_items where id='chicken'),'{"packagingCapacity":0}'::jsonb)$$,'22023','INVALID_PACKAGING_CONFIG|Quti narxi va sig‘imi noldan katta bo‘lishi kerak','invalid packaging rejected');
select public.create_public_order('{"id":"8b100000-0000-4000-8000-000000000003","customer":{"name":"Future","primaryPhone":"+998900000099"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"chicken","quantity":3,"modifierIds":[]}]}'::jsonb);
select is((select packaging_total from public.order_items where order_id='8b100000-0000-4000-8000-000000000003'),8000,'future order uses changed packaging config');
select is((select packaging_total from public.order_items where order_id='8b100000-0000-4000-8000-000000000001'),3000,'historical packaging snapshot remains unchanged');
select lives_ok($$select public.owner_update_menu_item('chicken',(select updated_at from public.menu_items where id='chicken'),'{"packagingRequired":false}'::jsonb)$$,'OWNER disables packaging');
select is((select row(packaging_required,packaging_unit_price,packaging_capacity) from public.menu_items where id='chicken'),row(false,0,null::integer),'disabled packaging normalizes to zero/null');
select is((select count(*)::integer from public.menu_audit_log where product_id='chicken' and action='PACKAGING_CHANGED'),2,'packaging changes are audited');

select lives_ok($$select public.owner_create_menu_item('{"name":"Owner yangi taom","categoryId":"mains","price":33000,"description":"Sinov","image":"","available":true,"packagingRequired":true,"packagingUnitPrice":3000,"packagingCapacity":1}'::jsonb)$$,'OWNER creates product');
select is((select count(*)::integer from public.menu_items where name='Owner yangi taom'),1,'new product exists once');
select matches((select id from public.menu_items where name='Owner yangi taom'),'^mains-[0-9a-f]{12}$','stable generated id uses category prefix');
select lives_ok($$select public.owner_create_menu_item('{"name":"Owner yangi taom","categoryId":"mains","price":33000,"available":false,"packagingRequired":false}'::jsonb)$$,'same display name safely creates a different stable id');
select is((select count(distinct id)::integer from public.menu_items where name='Owner yangi taom'),2,'generated ids do not collide');
select is((select count(*)::integer from public.menu_audit_log where action='PRODUCT_CREATED' and after_state->>'name'='Owner yangi taom'),2,'each creation is audited');
select throws_ok($$insert into public.menu_audit_log(product_id,actor_user_id,action,after_state) values('fake','10000000-0000-0000-0000-000000000003','PRODUCT_CREATED','{}')$$,'42501',null,'even OWNER browser cannot forge audit actor');
reset role;

select * from finish();
rollback;
