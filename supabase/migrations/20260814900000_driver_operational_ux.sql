-- Driver UI Final Operational UX: this phase is UI-first (see the App.tsx
-- rewrite in the same commit). Only two backend additions are made, both
-- narrowly scoped to real defects the new UX exposes -- neither touches
-- assignment, capacity, batching, redispatch, or route-stop logic at all.

-- 1) mark_driver_at_restaurant: widen the status guard. The prior version
-- (20260814600000) only allowed check-in once order.status='DRIVER_ASSIGNED'
-- (i.e. only once the food is already READY) -- but Multi-Order Dispatch
-- assigns a driver as early as CONFIRMED, and the whole point of an early
-- assignment is that the driver can head to the restaurant and check in
-- WHILE the food is still cooking. The prior guard made that operationally
-- impossible, contradicting the very feature it was supposed to support --
-- a genuine correctness defect the new Driver UX surfaces, not a redesign
-- of dispatch itself. Everything else about this RPC (idempotent
-- first-timestamp-wins, driver-owns-the-active-assignment check) is
-- unchanged.
create or replace function public.mark_driver_at_restaurant(p_order_id uuid)
returns public.driver_assignments
language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.driver_assignments;
begin
  if public.current_app_role() is distinct from 'DRIVER' then
    raise exception 'DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi' using errcode = '42501';
  end if;
  update public.driver_assignments da
  set arrived_at_restaurant_at = coalesce(da.arrived_at_restaurant_at, now())
  from public.orders o
  where da.order_id = o.id
    and da.order_id = p_order_id
    and da.driver_id = auth.uid()
    and da.accepted_at is not null
    and da.ended_at is null
    and o.status in ('CONFIRMED','PREPARING','READY','DRIVER_ASSIGNED')
  returning da.* into a;
  if not found then
    raise exception 'ASSIGNMENT_NOT_FOUND|Faol topshiriq topilmadi' using errcode = '22023';
  end if;
  return a;
end;
$$;
revoke all on function public.mark_driver_at_restaurant(uuid) from public, anon, authenticated, service_role;
grant execute on function public.mark_driver_at_restaurant(uuid) to authenticated;

-- 2) list_my_pickup_batch_context(): a narrow, PII-free read the Driver UI
-- needs to show the batch-level "wait briefly for the second order" state
-- (spec: "the platform -- not the courier -- decides and communicates the
-- brief wait based on authoritative batch state/configuration"). Exposes
-- only what's needed to compute that: the batch's own status, member cap,
-- when the first member became ready, and the actual-wait deadline
-- (computed server-side from delivery_settings.max_batch_actual_wait_minutes,
-- which stays staff-only -- this avoids exposing that raw config row to
-- drivers at all). Scoped to the caller's own non-terminal batches only,
-- mirroring pickup_batches' existing RLS (driver_id=auth.uid()) even
-- though this is SECURITY DEFINER.
create or replace function public.list_my_pickup_batch_context()
returns table(batch_id uuid, status public.pickup_batch_status, max_members integer, first_member_ready_at timestamptz, wait_deadline_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if public.current_app_role() is distinct from 'DRIVER' then
    raise exception 'DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi' using errcode = '42501';
  end if;
  return query
    select
      b.id,
      b.status,
      b.max_members,
      b.first_member_ready_at,
      case when b.first_member_ready_at is not null
        then b.first_member_ready_at + (coalesce(s.max_batch_actual_wait_minutes, 5) || ' minutes')::interval
        else null
      end
    from public.pickup_batches b
    left join public.delivery_settings s on s.id = true
    where b.driver_id = auth.uid()
      and b.status in ('OPEN','READY_TO_DEPART','IN_TRANSIT');
end $$;
revoke all on function public.list_my_pickup_batch_context() from public, anon, authenticated, service_role;
grant execute on function public.list_my_pickup_batch_context() to authenticated;

-- 3) The frontend's shared realtime channel (supabase.ts's subscribe())
-- now also watches pickup_batches, but the original publication
-- (20260803180000_zaytun_go_core.sql) only ever listed the five tables
-- that existed at the time. A postgres_changes filter for a table that
-- isn't in the publication doesn't just silently no-op -- it fails the
-- WHOLE shared channel (CHANNEL_ERROR), which broke live updates for
-- every other watched table too (orders/drivers/etc), not just batches.
-- Additive, matching the original statement's own pattern exactly.
alter publication supabase_realtime add table public.pickup_batches;
