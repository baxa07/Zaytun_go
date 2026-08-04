begin;
select plan(14);

select ok(has_function_privilege('anon', 'public.get_public_restaurant_config()', 'EXECUTE'), 'anonymous may read safe public restaurant configuration');
select ok(not has_function_privilege('anon', 'public.enforce_order_configuration()', 'EXECUTE'), 'anonymous cannot execute the payment guard directly');
select ok(not has_function_privilege('authenticated', 'public.enforce_item_quantity_configuration()', 'EXECUTE'), 'browser users cannot execute the quantity guard directly');

set local role anon;
select throws_ok($$select count(*) from public.delivery_settings$$, '42501', null, 'anonymous cannot read the authoritative settings table');
select ok((public.get_public_restaurant_config() ?& array['restaurantName','restaurantAddress','deliveryEnabled','maximumItemQuantity','supportedPaymentMethods']), 'public configuration includes intended non-secret fields');
select ok(not (public.get_public_restaurant_config() ?| array['updatedAt','serviceRoleKey','databaseUrl']), 'public configuration excludes internal metadata and secrets');
reset role;

select set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true);
set local role authenticated;
select throws_ok($$update public.delivery_settings set base_delivery_fee=0 where id=true$$, '42501', null, 'ordinary authenticated user cannot alter pricing settings');
select throws_ok($$insert into public.profiles(id,role,display_name) values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','RESTAURANT','attacker')$$, '42501', null, 'ordinary browser user cannot create a staff role');
reset role;

select is((public.get_public_restaurant_config()->>'maximumItemQuantity')::integer, (select maximum_item_quantity from public.delivery_settings where id=true), 'public quantity guidance matches the authoritative setting');
select is((select restaurant_latitude from public.delivery_settings), 40.087274::double precision, 'authoritative restaurant latitude is the owner-verified entrance');
select is((select restaurant_longitude from public.delivery_settings), 65.402551::double precision, 'authoritative restaurant longitude is the owner-verified entrance');
select is((select default_map_zoom from public.delivery_settings), 17.0::numeric, 'authoritative default map zoom is owner-verified');

update public.delivery_settings set maximum_item_quantity=2 where id=true;
select throws_ok($$select public.create_public_order('{"id":"60000000-0000-4000-8000-000000000001","customer":{"name":"Limit Test","primaryPhone":"+998900000000"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb)$$, '22023', 'MAXIMUM_ITEM_QUANTITY|Bir taomdan ko‘pi bilan 2 ta buyurtma qilish mumkin', 'configured item maximum is database-authoritative');
select is((select count(*)::integer from public.orders where id='60000000-0000-4000-8000-000000000001'),0,'quantity rejection leaves no partial order');

select * from finish();
rollback;
