-- Authenticated Customer Foundation, Phase 2: expose customer_auth_required
-- (added in 20260810100000, still false, never flipped) through the public
-- restaurant config RPC so the frontend can read it. Read-only exposure
-- only -- no admission logic changes, no grant changes (CREATE OR REPLACE
-- preserves existing ACLs; the grant below simply restates the
-- already-current anon/authenticated EXECUTE grant explicitly, matching
-- this project's established pattern of never relying on that fact alone).
create or replace function public.get_public_restaurant_config()
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
select jsonb_build_object('restaurantName',restaurant_display_name,'restaurantAddress',restaurant_address,'restaurantPhone',restaurant_phone,'restaurantLatitude',restaurant_latitude,'restaurantLongitude',restaurant_longitude,'operatingHours',operating_hours,'deliveryEnabled',delivery_enabled,'deliveryPolicyMode',delivery_policy_mode,'deliveryReviewMessage',case when delivery_policy_mode='MANUAL_CITY_REVIEW' then 'Navoiy shahri bo‘ylab yetkazib berish bepul. Manzil operator tomonidan tasdiqlanadi.' else null end,'deliveryRadiusKm',maximum_delivery_radius_km,'deliveryAreaDescription',delivery_area_description,'minimumDeliverySubtotal',minimum_delivery_order,'baseDeliveryFee',base_delivery_fee,'freeDeliveryThreshold',free_delivery_threshold,'maximumItemQuantity',maximum_item_quantity,'supportedPaymentMethods',supported_payment_methods,'pickupPaymentMethods',pickup_payment_methods,'deliveryPaymentMethods',delivery_payment_methods,'estimatedPreparationMinutes',estimated_preparation_minutes,'estimatedDeliveryMinutes',estimated_delivery_minutes,'defaultMapZoom',default_map_zoom,'customerAuthRequired',customer_auth_required)from public.delivery_settings where id=true
$$;

revoke execute on function public.get_public_restaurant_config() from public;
grant execute on function public.get_public_restaurant_config() to anon, authenticated;
