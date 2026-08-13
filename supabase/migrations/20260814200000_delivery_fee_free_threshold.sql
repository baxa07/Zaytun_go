-- Delivery fee becomes conditional on order size, in the policy mode
-- actually in use. calculate_delivery_quote_internal (20260809150000)
-- already computed `fee` from base_delivery_fee/free_delivery_threshold,
-- but only used it in the RADIUS branch -- the MANUAL_CITY_REVIEW branch
-- (the only mode ever seeded/active, see delivery_policy_mode in
-- seed.sql/production_bootstrap.sql) hardcoded deliveryFee=0 instead.
-- This migration moves the existing fee computation above both branches
-- and uses it in both, then sets Navoiy's actual configured amounts:
-- free delivery at/above 150,000 so‘m, otherwise a flat 10,000 so‘m fee.
-- orders.total (a generated subtotal+delivery_fee column, see
-- 20260803180000_zaytun_go_core.sql) and every UI that reads it pick this
-- up automatically -- no other backend logic changes.

update public.delivery_settings set base_delivery_fee=10000, free_delivery_threshold=150000, updated_at=now() where id=true;

create or replace function public.calculate_delivery_quote_internal(
  p_latitude double precision,
  p_longitude double precision,
  p_subtotal integer,
  p_order_type public.order_type,
  p_enforce_admission boolean
) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare s public.delivery_settings; d double precision; fee integer;
begin
  if p_order_type='PICKUP' then return jsonb_build_object('eligible',true,'distanceKm',null,'deliveryFee',0,'zoneResult','ELIGIBLE','minimumOrder',0,'reviewRequired',false); end if;
  if p_latitude is null or p_longitude is null or p_latitude not between -90 and 90 or p_longitude not between -180 and 180 or (p_latitude=0 and p_longitude=0) then
    raise exception 'INVALID_COORDINATES|Xaritadan to‘g‘ri yetkazish nuqtasini tanlang' using errcode='22023';
  end if;
  select * into s from public.delivery_settings where id=true;
  if not found then raise exception 'DELIVERY_SETTINGS_UNAVAILABLE|Yetkazish sozlamalari vaqtincha mavjud emas'; end if;
  if p_enforce_admission and not s.delivery_enabled then return jsonb_build_object('eligible',false,'distanceKm',null,'deliveryFee',0,'zoneResult','DELIVERY_DISABLED','minimumOrder',s.minimum_delivery_order,'reviewRequired',false,'message','Yetkazib berish vaqtincha o‘chirilgan'); end if;
  d:=public.geographic_distance_km(s.restaurant_latitude,s.restaurant_longitude,p_latitude,p_longitude);
  if p_subtotal<s.minimum_delivery_order then return jsonb_build_object('eligible',false,'distanceKm',round(d::numeric,3),'deliveryFee',0,'zoneResult','ELIGIBLE','minimumOrder',s.minimum_delivery_order,'reviewRequired',s.delivery_policy_mode='MANUAL_CITY_REVIEW','message',format('Yetkazish uchun eng kam buyurtma %s so‘m',s.minimum_delivery_order)); end if;
  fee:=case when s.free_delivery_threshold is not null and p_subtotal>=s.free_delivery_threshold then 0 else s.base_delivery_fee end;
  if s.delivery_policy_mode='MANUAL_CITY_REVIEW' then
    return jsonb_build_object('eligible',true,'distanceKm',round(d::numeric,3),'deliveryFee',fee,'zoneResult','ELIGIBLE','minimumOrder',s.minimum_delivery_order,'reviewRequired',true,'message','Manzil operator tomonidan tasdiqlanadi');
  end if;
  return jsonb_build_object('eligible',d<=s.maximum_delivery_radius_km and p_subtotal>=s.minimum_delivery_order,'distanceKm',round(d::numeric,3),'deliveryFee',fee,'zoneResult',case when d<=s.maximum_delivery_radius_km then 'ELIGIBLE' else 'OUTSIDE_ZONE' end,'minimumOrder',s.minimum_delivery_order,'reviewRequired',false,'message',case when d>s.maximum_delivery_radius_km then 'Bu manzil yetkazish hududidan tashqarida' end);
end $$;

-- CREATE OR REPLACE on an already-existing function preserves its current
-- ACL rather than reapplying the project's ALTER DEFAULT PRIVILEGES rule
-- (that rule only fires for genuinely new objects) -- these are
-- unnecessary in theory, but repeated here anyway, matching this
-- project's established defense-in-depth pattern for this exact function
-- (see 20260809160000_restrict_internal_delivery_quote_execute.sql).
revoke execute on function public.calculate_delivery_quote_internal(double precision,double precision,integer,public.order_type,boolean) from public;
revoke execute on function public.calculate_delivery_quote_internal(double precision,double precision,integer,public.order_type,boolean) from anon;
revoke execute on function public.calculate_delivery_quote_internal(double precision,double precision,integer,public.order_type,boolean) from authenticated;
revoke execute on function public.calculate_delivery_quote_internal(double precision,double precision,integer,public.order_type,boolean) from service_role;

create or replace function public.get_public_restaurant_config()
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
select jsonb_build_object('restaurantName',restaurant_display_name,'restaurantAddress',restaurant_address,'restaurantPhone',restaurant_phone,'restaurantLatitude',restaurant_latitude,'restaurantLongitude',restaurant_longitude,'operatingHours',operating_hours,'deliveryEnabled',delivery_enabled,'deliveryPolicyMode',delivery_policy_mode,'deliveryReviewMessage',case when delivery_policy_mode='MANUAL_CITY_REVIEW' then 'Navoiy shahri bo‘ylab yetkazib berish 150.000 so‘mdan oshiq xaridlarda bepul. Undan kam buyurtmalarga 10.000 so‘m yetkazib berish narxi qo‘shiladi. Manzil operator tomonidan tasdiqlanadi.' else null end,'deliveryRadiusKm',maximum_delivery_radius_km,'deliveryAreaDescription',delivery_area_description,'minimumDeliverySubtotal',minimum_delivery_order,'baseDeliveryFee',base_delivery_fee,'freeDeliveryThreshold',free_delivery_threshold,'maximumItemQuantity',maximum_item_quantity,'supportedPaymentMethods',supported_payment_methods,'pickupPaymentMethods',pickup_payment_methods,'deliveryPaymentMethods',delivery_payment_methods,'estimatedPreparationMinutes',estimated_preparation_minutes,'estimatedDeliveryMinutes',estimated_delivery_minutes,'defaultMapZoom',default_map_zoom,'customerAuthRequired',customer_auth_required)from public.delivery_settings where id=true
$$;

revoke execute on function public.get_public_restaurant_config() from public;
grant execute on function public.get_public_restaurant_config() to anon, authenticated;
