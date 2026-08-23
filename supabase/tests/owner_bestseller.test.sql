begin;
select plan(16);

select is((select bool_and(not is_bestseller) from public.menu_items),true,'existing products default to non-Bestseller');
select ok(not has_table_privilege('authenticated','public.menu_items','UPDATE'),'browser roles still have no direct menu update');
select ok(not has_function_privilege('anon','public.owner_update_menu_item(text,timestamptz,jsonb)','EXECUTE'),'anonymous cannot call Owner mutation RPC');

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select throws_ok($$select public.owner_update_menu_item('chicken',now(),' {"isBestseller":true}'::jsonb)$$,'42501','OWNER_ROLE_REQUIRED|Owner roli talab qilinadi','RESTAURANT cannot change Bestseller');
reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',true);
select throws_ok($$select public.owner_update_menu_item('chicken',now(),' {"isBestseller":true}'::jsonb)$$,'42501','OWNER_ROLE_REQUIRED|Owner roli talab qilinadi','DISPATCHER cannot change Bestseller');
reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select throws_ok($$select public.owner_update_menu_item('chicken',now(),' {"isBestseller":true}'::jsonb)$$,'42501','OWNER_ROLE_REQUIRED|Owner roli talab qilinadi','DRIVER cannot change Bestseller');
reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','90000000-0000-4000-8000-000000000099',true);
select throws_ok($$select public.owner_update_menu_item('chicken',now(),' {"isBestseller":true}'::jsonb)$$,'42501','OWNER_ROLE_REQUIRED|Owner roli talab qilinadi','customer cannot change Bestseller');

reset role;set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000005',true);
select lives_ok($$select public.owner_update_menu_item('chicken',(select updated_at from public.menu_items where id='chicken'),' {"isBestseller":true}'::jsonb)$$,'OWNER enables Bestseller');
select is((select is_bestseller from public.menu_items where id='chicken'),true,'Bestseller enabled authoritatively');
select is((select count(*)::integer from public.menu_audit_log where product_id='chicken' and action='BESTSELLER_CHANGED' and after_state->>'isBestseller'='true'),1,'enable creates audit entry');
select is((select actor_user_id from public.menu_audit_log where product_id='chicken' and action='BESTSELLER_CHANGED' limit 1),'10000000-0000-0000-0000-000000000005'::uuid,'audit actor derives from auth.uid');
select lives_ok($$select public.owner_update_menu_item('chicken',(select updated_at from public.menu_items where id='chicken'),' {"isBestseller":false}'::jsonb)$$,'OWNER disables Bestseller');
select is((select is_bestseller from public.menu_items where id='chicken'),false,'Bestseller disabled authoritatively');
select is((select count(*)::integer from public.menu_audit_log where product_id='chicken' and action='BESTSELLER_CHANGED' and after_state->>'isBestseller'='false'),1,'disable creates audit entry');
select lives_ok($$select public.owner_create_menu_item('{"name":"Curated","categoryId":"mains","price":33000,"available":true,"isBestseller":true,"packagingRequired":false}'::jsonb)$$,'new product may be explicitly curated by OWNER');
select is((select is_bestseller from public.menu_items where name='Curated'),true,'new product Bestseller value persists');
reset role;

select * from finish();
rollback;
