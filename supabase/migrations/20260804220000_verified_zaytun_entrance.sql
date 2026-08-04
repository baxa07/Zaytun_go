-- Owner-verified Zaytun Kafe customer entrance. Delivery eligibility continues
-- to use this database record; Vite map defaults are not authoritative.
update public.delivery_settings
set restaurant_latitude = 40.087274,
    restaurant_longitude = 65.402551,
    default_map_zoom = 17,
    updated_at = now()
where id = true;

comment on table public.delivery_settings is
  'Single ZAYTUN GO settings record. Entrance coordinates 40.087274, 65.402551 and default zoom 17 were owner-verified for the Zaytun pilot on 2026-08-04; delivery radius and pricing require separate owner approval.';
