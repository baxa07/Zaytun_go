-- Narrow customer-safe read of the current delivery address, for
-- pre-populating the clarification address editor. Additive, on top of
-- Phase A (20260808120000/20260808120100); those files are not edited.
-- Normal public tracking (get_order_tracking) intentionally keeps returning
-- customer_addresses:'[]' — this function does not change that contract,
-- it only opens a narrow, state-gated read for the customer's own order.
create or replace function public.get_delivery_address_for_revision(p_order_id uuid, p_tracking_token uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
select jsonb_build_object(
  'district',a.district,
  'street',a.street,
  'house',a.house,
  'entrance',a.entrance,
  'floor',a.floor,
  'apartment',a.apartment,
  'landmark',a.landmark,
  'deliveryNotes',a.delivery_notes,
  'latitude',a.latitude,
  'longitude',a.longitude,
  'confidence',a.confidence,
  'locationProvider',a.location_provider,
  'providerPlaceId',a.provider_place_id,
  'providerFormattedAddress',a.provider_formatted_address
)
from public.orders o
join public.customer_addresses a on a.order_id=o.id
where o.id=p_order_id
  and o.tracking_token=p_tracking_token
  and o.order_type='DELIVERY'
  and o.status='NEW'
  and o.delivery_review_status='CLARIFICATION_REQUESTED'
$$;

revoke execute on function public.get_delivery_address_for_revision(uuid,uuid) from public;
grant execute on function public.get_delivery_address_for_revision(uuid,uuid) to anon,authenticated;
