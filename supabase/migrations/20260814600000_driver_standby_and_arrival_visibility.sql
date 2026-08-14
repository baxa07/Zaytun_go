-- Driver UI Phase: driver-facing standby awareness + purely-informational
-- "arrived at restaurant" marker. Two independent, additive primitives --
-- neither touches driver_assignments' terminal-state logic, orders.status,
-- assigned_driver_id, availability, or capacity accounting. No existing
-- RPC body (accept_assignment, decline_assignment, transition_order,
-- start_shift/end_shift/pause_dispatch/resume_dispatch, the dispatch
-- sweep family) is modified, and no RLS policy is added or altered
-- anywhere in this migration.

-- ------------------------------------------------------------------
-- 1) list_my_standby_notices(): exposes driver_standby_notices (staff-only
-- RLS, unchanged -- see 20260814500000) to the calling driver via a
-- narrow, minimal-field RPC instead of widening that table's RLS or
-- orders' RLS (a driver still can't read a PREPARING order they aren't
-- assigned to; that has to be bypassed inside this SECURITY DEFINER
-- function, not via a policy). Naturally clears once an order leaves
-- PREPARING -- no separate cleanup needed -- and is scoped to the
-- caller's own driver_branches pool (already driver-readable with zero
-- RLS change: driver_branch_read allows driver_id = auth.uid()).
create or replace function public.list_my_standby_notices()
returns table(order_id uuid, order_number text, branch_id uuid, branch_name text, created_at timestamptz)
language plpgsql stable security definer set search_path = pg_catalog, public as $$
begin
  if public.current_app_role() is distinct from 'DRIVER' then
    raise exception 'DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi' using errcode = '42501';
  end if;
  return query
    select n.order_id, o.number, n.branch_id, b.name, n.created_at
    from public.driver_standby_notices n
    join public.orders o on o.id = n.order_id
    left join public.branches b on b.id = n.branch_id
    where o.status = 'PREPARING'
      and n.branch_id in (select db.branch_id from public.driver_branches db where db.driver_id = auth.uid())
    order by n.created_at asc;
end $$;
revoke all on function public.list_my_standby_notices() from public, anon, authenticated, service_role;
grant execute on function public.list_my_standby_notices() to authenticated;

-- ------------------------------------------------------------------
-- 2) "At restaurant" marker: purely informational timestamp on the
-- driver's own currently-accepted-but-not-yet-picked-up assignment.
-- Never gates PICKED_UP or any other transition -- a driver who never
-- taps this can still proceed normally. driver_assignments already has
-- the exact RLS this needs (is_staff() OR driver_id = auth.uid()), so no
-- RLS change at all; the SECURITY DEFINER function itself re-derives
-- auth.uid() and never trusts a caller-supplied driver id.
alter table public.driver_assignments add column arrived_at_restaurant_at timestamptz;

create or replace function public.mark_driver_at_restaurant(p_order_id uuid)
returns public.driver_assignments
language plpgsql security definer set search_path = pg_catalog, public as $$
declare a public.driver_assignments;
begin
  if public.current_app_role() is distinct from 'DRIVER' then
    raise exception 'DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi' using errcode = '42501';
  end if;
  -- Idempotent: coalesce keeps the FIRST timestamp on repeated taps.
  update public.driver_assignments da
  set arrived_at_restaurant_at = coalesce(da.arrived_at_restaurant_at, now())
  from public.orders o
  where da.order_id = o.id
    and da.order_id = p_order_id
    and da.driver_id = auth.uid()
    and da.accepted_at is not null
    and da.ended_at is null
    and o.status = 'DRIVER_ASSIGNED'
  returning da.* into a;
  if not found then
    raise exception 'ASSIGNMENT_NOT_FOUND|Faol topshiriq topilmadi' using errcode = '22023';
  end if;
  return a;
end $$;
revoke all on function public.mark_driver_at_restaurant(uuid) from public, anon, authenticated, service_role;
grant execute on function public.mark_driver_at_restaurant(uuid) to authenticated;
