-- H0: Live Restaurant Board Cleanup.
--
-- Investigation finding (reported before implementing anything): no
-- canonical restaurant/business timezone configuration exists anywhere in
-- the schema (searched every migration and every frontend source file --
-- zero hits for "timezone"). Zaytun currently operates a single physical
-- city (Navoiy, Uzbekistan) in a single, unchanging IANA zone
-- (Asia/Tashkent, UTC+5, no daylight saving). Rather than inventing a new
-- configurable column for a value that has no current multi-value need
-- (all three branches share one city/timezone), this is a server-side
-- constant inside the RPC below -- explicit, not derived from whatever
-- timezone the restaurant laptop happens to use, per the requirement.
-- The moment branches genuinely operate in different timezones, THAT is
-- what would justify promoting this to a branches.timezone column; not
-- before.
--
-- Board inclusion rule:
--   1. every non-terminal order, regardless of created_at (an order
--      active at 00:10 that was created 23:50 the day before must never
--      disappear because of a date boundary)
--   2. terminal orders whose CANONICAL terminal transition (the
--      order_events row where new_status = the order's own current
--      status -- terminal statuses are sink states, so there is always
--      exactly one such row) occurred within today's Asia/Tashkent
--      business-day window
--
-- This is a read-model/query change only: no row is deleted, archived,
-- or mutated, and no Smart Dispatch logic (driver selection, eligibility,
-- capacity, sweep, redispatch, assignment history) is touched.
create or replace function public.list_live_restaurant_order_ids()
returns setof uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  business_tz constant text := 'Asia/Tashkent';
  day_start timestamptz;
  day_end timestamptz;
  terminal_statuses constant public.order_status[] := array['DELIVERED','COLLECTED','CANCELLED','REJECTED','DELIVERY_FAILED','RETURNED'];
begin
  if not public.is_staff() then
    raise exception 'STAFF_ROLE_REQUIRED|Xodim roli talab qilinadi' using errcode = '42501';
  end if;

  day_start := date_trunc('day', now() at time zone business_tz) at time zone business_tz;
  day_end := day_start + interval '1 day';

  return query
    select o.id from public.orders o where o.status <> all(terminal_statuses)
    union
    select o.id from public.orders o
    where o.status = any(terminal_statuses)
      and exists(
        select 1 from public.order_events e
        where e.order_id = o.id and e.new_status = o.status
          and e.occurred_at >= day_start and e.occurred_at < day_end
      );
end;
$$;
revoke execute on function public.list_live_restaurant_order_ids() from public, anon;
grant execute on function public.list_live_restaurant_order_ids() to authenticated;
