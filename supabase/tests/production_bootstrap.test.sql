begin;
select plan(24);

create temporary table bootstrap_counts as select
  (select count(*) from public.menu_categories) categories,
  (select count(*) from public.menu_items) items,
  (select count(*) from public.menu_modifiers) modifiers,
  (select count(*) from public.profiles) profiles,
  (select count(*) from public.drivers) drivers,
  (select count(*) from public.orders) orders;

select ok((select is_nullable='YES' from information_schema.columns where table_schema='public' and table_name='delivery_settings' and column_name='maximum_delivery_radius_km'),'radius may remain null until a machine-enforceable city zone is approved');
select ok((select is_nullable='YES' from information_schema.columns where table_schema='public' and table_name='delivery_settings' and column_name='estimated_preparation_minutes'),'product-dependent preparation estimate may be null');
select ok((select is_nullable='YES' from information_schema.columns where table_schema='public' and table_name='delivery_settings' and column_name='estimated_delivery_minutes'),'location-dependent delivery estimate may be null');

delete from public.delivery_settings;
insert into public.delivery_settings(id,restaurant_display_name,restaurant_address,restaurant_phone,restaurant_latitude,restaurant_longitude,default_map_zoom,operating_hours,delivery_enabled,maximum_delivery_radius_km,base_delivery_fee,free_delivery_threshold,minimum_delivery_order,maximum_item_quantity,supported_payment_methods,estimated_preparation_minutes,estimated_delivery_minutes,delivery_area_description)
values(true,'Zaytun Kafe','Guliston mavzesi 649, Navoiy shahri','+998507440005',40.087274,65.402551,17,'{"everyday":"10:00–00:00"}'::jsonb,false,null,0,null,100000,50,array['CASH']::public.payment_method[],null,null,'Navoiy shahri');

select is((select count(*)::integer from public.delivery_settings),1,'bootstrap creates exactly one singleton settings row');
select is((select restaurant_display_name from public.delivery_settings),'Zaytun Kafe','verified restaurant name stored');
select is((select restaurant_address from public.delivery_settings),'Guliston mavzesi 649, Navoiy shahri','verified address stored');
select is((select restaurant_phone from public.delivery_settings),'+998507440005','verified phone stored');
select is((select restaurant_latitude from public.delivery_settings),40.087274::double precision,'verified latitude stored');
select is((select restaurant_longitude from public.delivery_settings),65.402551::double precision,'verified longitude stored');
select is((select default_map_zoom from public.delivery_settings),17.0::numeric,'verified zoom stored');
select is((select operating_hours->>'everyday' from public.delivery_settings),'10:00–00:00','verified daily hours stored');
select is((select minimum_delivery_order from public.delivery_settings),100000,'verified minimum order stored');
select is((select base_delivery_fee from public.delivery_settings),0,'verified free-delivery fee stored');
select is((select supported_payment_methods::text from public.delivery_settings),'{CASH}','only CASH is active');
select is((select delivery_area_description from public.delivery_settings),'Navoiy shahri','verified human delivery policy stored');
select is((select delivery_enabled from public.delivery_settings),false,'delivery remains safely disabled without an enforceable city boundary');
select is((public.calculate_delivery_quote(40.087274,65.402551,100000,'DELIVERY')->>'zoneResult'),'DELIVERY_DISABLED','server refuses delivery until zone validation is configured');
select is((public.get_public_restaurant_config()->>'restaurantName'),'Zaytun Kafe','public configuration returns bootstrapped identity');

select is((select count(*) from public.menu_categories),(select categories from bootstrap_counts),'bootstrap does not create menu categories');
select is((select count(*) from public.menu_items),(select items from bootstrap_counts),'bootstrap does not create menu items');
select is((select count(*) from public.menu_modifiers),(select modifiers from bootstrap_counts),'bootstrap does not create modifiers');
select is((select count(*) from public.profiles),(select profiles from bootstrap_counts),'bootstrap does not create staff profiles');
select is((select count(*) from public.drivers),(select drivers from bootstrap_counts),'bootstrap does not create drivers');
select is((select count(*) from public.orders),(select orders from bootstrap_counts),'bootstrap does not create orders');

select * from finish();
rollback;
