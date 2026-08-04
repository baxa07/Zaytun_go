alter table public.delivery_settings
  add column restaurant_address text not null default '',
  add column restaurant_phone text not null default '',
  add column operating_hours jsonb not null default '{}'::jsonb check(jsonb_typeof(operating_hours)='object'),
  add column maximum_item_quantity integer not null default 50 check(maximum_item_quantity between 1 and 50),
  add column supported_payment_methods public.payment_method[] not null default array['CASH','CARD_ON_DELIVERY']::public.payment_method[] check(cardinality(supported_payment_methods)>0),
  add column estimated_preparation_minutes integer not null default 35 check(estimated_preparation_minutes between 5 and 180),
  add column estimated_delivery_minutes integer not null default 45 check(estimated_delivery_minutes between 5 and 240);

create or replace function public.get_public_restaurant_config()
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
select jsonb_build_object(
  'restaurantName', restaurant_display_name,
  'restaurantAddress', restaurant_address,
  'restaurantPhone', restaurant_phone,
  'restaurantLatitude', restaurant_latitude,
  'restaurantLongitude', restaurant_longitude,
  'operatingHours', operating_hours,
  'deliveryEnabled', delivery_enabled,
  'deliveryRadiusKm', maximum_delivery_radius_km,
  'minimumDeliverySubtotal', minimum_delivery_order,
  'baseDeliveryFee', base_delivery_fee,
  'freeDeliveryThreshold', free_delivery_threshold,
  'maximumItemQuantity', maximum_item_quantity,
  'supportedPaymentMethods', supported_payment_methods,
  'estimatedPreparationMinutes', estimated_preparation_minutes,
  'estimatedDeliveryMinutes', estimated_delivery_minutes,
  'defaultMapZoom', default_map_zoom
)
from public.delivery_settings where id=true
$$;

create or replace function public.enforce_order_configuration()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare settings public.delivery_settings;
begin
  select * into settings from public.delivery_settings where id=true;
  if not found then raise exception 'DELIVERY_SETTINGS_UNAVAILABLE|Restoran sozlamalari mavjud emas'; end if;
  if not (new.payment_method = any(settings.supported_payment_methods)) then
    raise exception 'UNSUPPORTED_PAYMENT_METHOD|To‘lov usuli hozir qabul qilinmaydi' using errcode='22023';
  end if;
  return new;
end $$;

create or replace function public.enforce_item_quantity_configuration()
returns trigger language plpgsql set search_path = pg_catalog, public as $$
declare maximum_quantity integer;
begin
  select maximum_item_quantity into maximum_quantity from public.delivery_settings where id=true;
  if maximum_quantity is null then raise exception 'DELIVERY_SETTINGS_UNAVAILABLE|Restoran sozlamalari mavjud emas'; end if;
  if new.quantity > maximum_quantity then
    raise exception 'MAXIMUM_ITEM_QUANTITY|Bir taomdan ko‘pi bilan % ta buyurtma qilish mumkin',maximum_quantity using errcode='22023';
  end if;
  return new;
end $$;

create trigger orders_configuration_guard before insert or update of payment_method on public.orders for each row execute function public.enforce_order_configuration();
create trigger order_items_quantity_guard before insert or update of quantity on public.order_items for each row execute function public.enforce_item_quantity_configuration();

revoke execute on function public.get_public_restaurant_config() from public;
grant execute on function public.get_public_restaurant_config() to anon, authenticated;
revoke execute on function public.enforce_order_configuration(),public.enforce_item_quantity_configuration() from public,anon,authenticated;
