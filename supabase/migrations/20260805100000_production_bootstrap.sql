-- Production bootstrap contains only owner-verified facts. The existing zone
-- engine is radius-based; delivery stays disabled until an enforceable Navoiy
-- city boundary or an approved radius is configured.
alter table public.delivery_settings
  alter column maximum_delivery_radius_km drop not null,
  alter column estimated_preparation_minutes drop not null,
  alter column estimated_delivery_minutes drop not null,
  add column if not exists delivery_area_description text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'delivery_settings_enabled_zone_check'
      and conrelid = 'public.delivery_settings'::regclass
  ) then
    alter table public.delivery_settings
      add constraint delivery_settings_enabled_zone_check
      check (not delivery_enabled or maximum_delivery_radius_km is not null);
  end if;
end
$$;

insert into public.delivery_settings (
  id, restaurant_display_name, restaurant_address, restaurant_phone,
  restaurant_latitude, restaurant_longitude, default_map_zoom, operating_hours,
  delivery_enabled, maximum_delivery_radius_km, base_delivery_fee,
  free_delivery_threshold, minimum_delivery_order, maximum_item_quantity,
  supported_payment_methods, estimated_preparation_minutes,
  estimated_delivery_minutes, delivery_area_description, updated_at
) values (
  true, 'Zaytun Kafe', 'Guliston mavzesi 649, Navoiy shahri', '+998507440005',
  40.087274, 65.402551, 17, '{"everyday":"10:00–00:00"}'::jsonb,
  false, null, 0, null, 100000, 50,
  array['CASH']::public.payment_method[], null, null, 'Navoiy shahri', now()
)
on conflict (id) do update set
  restaurant_display_name = excluded.restaurant_display_name,
  restaurant_address = excluded.restaurant_address,
  restaurant_phone = excluded.restaurant_phone,
  restaurant_latitude = excluded.restaurant_latitude,
  restaurant_longitude = excluded.restaurant_longitude,
  default_map_zoom = excluded.default_map_zoom,
  operating_hours = excluded.operating_hours,
  delivery_enabled = excluded.delivery_enabled,
  maximum_delivery_radius_km = excluded.maximum_delivery_radius_km,
  base_delivery_fee = excluded.base_delivery_fee,
  free_delivery_threshold = excluded.free_delivery_threshold,
  minimum_delivery_order = excluded.minimum_delivery_order,
  maximum_item_quantity = excluded.maximum_item_quantity,
  supported_payment_methods = excluded.supported_payment_methods,
  estimated_preparation_minutes = excluded.estimated_preparation_minutes,
  estimated_delivery_minutes = excluded.estimated_delivery_minutes,
  delivery_area_description = excluded.delivery_area_description,
  updated_at = now();

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
  'deliveryAreaDescription', delivery_area_description,
  'minimumDeliverySubtotal', minimum_delivery_order,
  'baseDeliveryFee', base_delivery_fee,
  'freeDeliveryThreshold', free_delivery_threshold,
  'maximumItemQuantity', maximum_item_quantity,
  'supportedPaymentMethods', supported_payment_methods,
  'estimatedPreparationMinutes', estimated_preparation_minutes,
  'estimatedDeliveryMinutes', estimated_delivery_minutes,
  'defaultMapZoom', default_map_zoom
)
from public.delivery_settings where id = true
$$;

revoke execute on function public.get_public_restaurant_config() from public;
grant execute on function public.get_public_restaurant_config() to anon, authenticated;

comment on column public.delivery_settings.delivery_area_description is
  'Owner-facing description only. It is not sufficient for geographic eligibility validation.';
