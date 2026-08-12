-- H2: Driver Delivery Ledger.
--
-- A defensible record of actual driver work, sourced strictly from
-- driver_assignments.status -- never from orders.assigned_driver_id, which
-- only ever reflects the CURRENT/last driver on an order and would
-- misattribute completed work the moment reassignment (Smart Dispatch
-- Phase 6, not yet built) exists. Because at most one assignment per order
-- is ever ACCEPTED/COMPLETED, and a DECLINED/SUPERSEDED row's status never
-- changes afterward, summing by driver_id + status is unambiguous and
-- correct even after reassignment: the driver who declined or was
-- superseded is never credited, only the one whose row reads COMPLETED.
--
-- This is a reporting layer only -- no payroll math, no salary, no
-- driver_settlements table. Dates reuse H1's resolve_history_window() (same
-- Asia/Tashkent business day), anchored on driver_assignments.assigned_at
-- (when the work was handed to that driver), not the order's created_at.

create index driver_assignments_driver_assigned_idx on public.driver_assignments(driver_id, assigned_at desc);

create or replace function public.list_driver_ledger_summary(
  p_preset text,
  p_custom_from date default null,
  p_custom_to date default null,
  p_branch_id uuid default null
)
returns table(
  driver_id uuid,
  driver_name text,
  total_assignments integer,
  accepted integer,
  completed integer,
  failed integer,
  returned integer,
  declined integer,
  superseded integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from timestamptz;
  v_to timestamptz;
begin
  if not public.is_staff() then
    raise exception 'STAFF_ROLE_REQUIRED|Xodim roli talab qilinadi' using errcode = '42501';
  end if;
  select w.window_start, w.window_end into v_from, v_to from public.resolve_history_window(p_preset, p_custom_from, p_custom_to) w;

  return query
  select
    a.driver_id,
    p.display_name,
    count(*)::integer,
    count(*) filter (where a.accepted_at is not null)::integer,
    count(*) filter (where a.status = 'COMPLETED')::integer,
    count(*) filter (where a.status = 'FAILED')::integer,
    count(*) filter (where a.status = 'RETURNED')::integer,
    count(*) filter (where a.status = 'DECLINED')::integer,
    count(*) filter (where a.status = 'SUPERSEDED')::integer
  from public.driver_assignments a
  join public.orders o on o.id = a.order_id
  join public.profiles p on p.id = a.driver_id
  where a.assigned_at >= v_from and a.assigned_at < v_to
    and (p_branch_id is null or o.branch_id = p_branch_id)
  group by a.driver_id, p.display_name
  order by count(*) filter (where a.status = 'COMPLETED') desc, p.display_name;
end;
$$;
revoke all on function public.list_driver_ledger_summary(text, date, date, uuid) from public, anon;
grant execute on function public.list_driver_ledger_summary(text, date, date, uuid) to authenticated;

create or replace function public.list_driver_assignment_ledger(
  p_driver_id uuid,
  p_preset text,
  p_custom_from date default null,
  p_custom_to date default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table(
  id uuid,
  order_id uuid,
  order_number text,
  branch_id uuid,
  branch_name text,
  district text,
  order_type public.order_type,
  assigned_at timestamptz,
  accepted_at timestamptz,
  ended_at timestamptz,
  status public.assignment_status,
  total integer,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from timestamptz;
  v_to timestamptz;
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
  if not public.is_staff() then
    raise exception 'STAFF_ROLE_REQUIRED|Xodim roli talab qilinadi' using errcode = '42501';
  end if;
  select w.window_start, w.window_end into v_from, v_to from public.resolve_history_window(p_preset, p_custom_from, p_custom_to) w;

  return query
  select
    a.id, a.order_id, o.number, o.branch_id, b.name, ca.district, o.order_type,
    a.assigned_at, a.accepted_at, a.ended_at, a.status, o.total,
    count(*) over()
  from public.driver_assignments a
  join public.orders o on o.id = a.order_id
  left join public.branches b on b.id = o.branch_id
  left join public.customer_addresses ca on ca.order_id = o.id
  where a.driver_id = p_driver_id
    and a.assigned_at >= v_from and a.assigned_at < v_to
  order by a.assigned_at desc, a.id
  limit v_limit offset v_offset;
end;
$$;
revoke all on function public.list_driver_assignment_ledger(uuid, text, date, date, integer, integer) from public, anon;
grant execute on function public.list_driver_assignment_ledger(uuid, text, date, date, integer, integer) to authenticated;
