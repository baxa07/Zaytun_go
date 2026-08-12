-- H1: Buyurtmalar tarixi / Order History.
--
-- The live restaurant board (H0) stays exactly as it is: every active
-- order, plus only today's terminal orders. History is a separate,
-- staff-only, server-side-filtered, paginated report over orders.created_at
-- -- it does not change what the live board shows and does not delete,
-- archive, or mutate anything.
--
-- Date semantics: every preset/custom range is resolved server-side in the
-- canonical Asia/Tashkent business timezone (matching H0), never from the
-- browser. resolve_history_window() is the single shared boundary
-- calculation both RPCs below use, so the list and its summary can never
-- disagree about what "today" means.
--
-- Filtering is strictly by orders.created_at -- an order created inside the
-- selected window appears in that window's History regardless of its
-- current status (including still-active orders), because History answers
-- "what was created in this period", not "what is currently pending".
-- finished_at (H1.6) is a display-only column, never part of the filter.

create index orders_branch_created_idx on public.orders(branch_id, created_at desc);

create or replace function public.resolve_history_window(
  p_preset text,
  p_custom_from date,
  p_custom_to date,
  out window_start timestamptz,
  out window_end timestamptz
)
language plpgsql
stable
as $$
declare
  business_tz constant text := 'Asia/Tashkent';
  today date := (now() at time zone business_tz)::date;
begin
  case p_preset
    when 'TODAY' then
      window_start := today::timestamp at time zone business_tz;
      window_end := (today + 1)::timestamp at time zone business_tz;
    when 'YESTERDAY' then
      window_start := (today - 1)::timestamp at time zone business_tz;
      window_end := today::timestamp at time zone business_tz;
    when 'LAST_7_DAYS' then
      window_start := (today - 6)::timestamp at time zone business_tz;
      window_end := (today + 1)::timestamp at time zone business_tz;
    when 'THIS_MONTH' then
      window_start := date_trunc('month', today)::timestamp at time zone business_tz;
      window_end := (today + 1)::timestamp at time zone business_tz;
    when 'CUSTOM' then
      if p_custom_from is null or p_custom_to is null or p_custom_from > p_custom_to then
        raise exception 'INVALID_DATE_RANGE|Sana oralig‘i noto‘g‘ri' using errcode = '22023';
      end if;
      window_start := p_custom_from::timestamp at time zone business_tz;
      window_end := (p_custom_to + 1)::timestamp at time zone business_tz;
    else
      raise exception 'INVALID_DATE_PRESET|Sana oralig‘i noto‘g‘ri' using errcode = '22023';
  end case;
end;
$$;
revoke all on function public.resolve_history_window(text, date, date) from public, anon, authenticated, service_role;

create or replace function public.list_restaurant_order_history(
  p_preset text,
  p_custom_from date default null,
  p_custom_to date default null,
  p_branch_id uuid default null,
  p_driver_id uuid default null,
  p_status public.order_status default null,
  p_fulfillment public.order_type default null,
  p_payment_method public.payment_method default null,
  p_search text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table(
  id uuid,
  number text,
  created_at timestamptz,
  finished_at timestamptz,
  branch_id uuid,
  branch_name text,
  customer_name text,
  order_type public.order_type,
  status public.order_status,
  assigned_driver_id uuid,
  driver_name text,
  payment_method public.payment_method,
  total integer,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  terminal_statuses constant public.order_status[] := array['DELIVERED','COLLECTED','CANCELLED','REJECTED','DELIVERY_FAILED','RETURNED'];
  v_from timestamptz;
  v_to timestamptz;
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not public.is_staff() then
    raise exception 'STAFF_ROLE_REQUIRED|Xodim roli talab qilinadi' using errcode = '42501';
  end if;
  select w.window_start, w.window_end into v_from, v_to from public.resolve_history_window(p_preset, p_custom_from, p_custom_to) w;

  return query
  with filtered as (
    select o.*
    from public.orders o
    where o.created_at >= v_from and o.created_at < v_to
      and (p_branch_id is null or o.branch_id = p_branch_id)
      and (p_driver_id is null or o.assigned_driver_id = p_driver_id)
      and (p_status is null or o.status = p_status)
      and (p_fulfillment is null or o.order_type = p_fulfillment)
      and (p_payment_method is null or o.payment_method = p_payment_method)
      and (v_search is null or o.number ilike '%' || v_search || '%')
  )
  select
    f.id, f.number, f.created_at,
    (select e.occurred_at from public.order_events e
     where e.order_id = f.id and e.new_status = f.status and f.status = any(terminal_statuses)
     order by e.occurred_at desc limit 1) as finished_at,
    f.branch_id, b.name as branch_name, f.customer_name, f.order_type, f.status,
    f.assigned_driver_id, p.display_name as driver_name, f.payment_method, f.total,
    count(*) over() as total_count
  from filtered f
  left join public.branches b on b.id = f.branch_id
  left join public.profiles p on p.id = f.assigned_driver_id
  order by f.created_at desc, f.id
  limit v_limit offset v_offset;
end;
$$;
revoke all on function public.list_restaurant_order_history(text, date, date, uuid, uuid, public.order_status, public.order_type, public.payment_method, text, integer, integer) from public, anon;
grant execute on function public.list_restaurant_order_history(text, date, date, uuid, uuid, public.order_status, public.order_type, public.payment_method, text, integer, integer) to authenticated;

create or replace function public.get_restaurant_order_history_summary(
  p_preset text,
  p_custom_from date default null,
  p_custom_to date default null,
  p_branch_id uuid default null,
  p_driver_id uuid default null,
  p_status public.order_status default null,
  p_fulfillment public.order_type default null,
  p_payment_method public.payment_method default null,
  p_search text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from timestamptz;
  v_to timestamptz;
  v_search text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not public.is_staff() then
    raise exception 'STAFF_ROLE_REQUIRED|Xodim roli talab qilinadi' using errcode = '42501';
  end if;
  select w.window_start, w.window_end into v_from, v_to from public.resolve_history_window(p_preset, p_custom_from, p_custom_to) w;

  return (
    select jsonb_build_object(
      'totalOrders', count(*),
      'delivered', count(*) filter (where o.status in ('DELIVERED', 'COLLECTED')),
      'cancelled', count(*) filter (where o.status in ('CANCELLED', 'REJECTED')),
      'failed', count(*) filter (where o.status in ('DELIVERY_FAILED', 'RETURNED')),
      'totalValue', coalesce(sum(o.total), 0)
    )
    from public.orders o
    where o.created_at >= v_from and o.created_at < v_to
      and (p_branch_id is null or o.branch_id = p_branch_id)
      and (p_driver_id is null or o.assigned_driver_id = p_driver_id)
      and (p_status is null or o.status = p_status)
      and (p_fulfillment is null or o.order_type = p_fulfillment)
      and (p_payment_method is null or o.payment_method = p_payment_method)
      and (v_search is null or o.number ilike '%' || v_search || '%')
  );
end;
$$;
revoke all on function public.get_restaurant_order_history_summary(text, date, date, uuid, uuid, public.order_status, public.order_type, public.payment_method, text) from public, anon;
grant execute on function public.get_restaurant_order_history_summary(text, date, date, uuid, uuid, public.order_status, public.order_type, public.payment_method, text) to authenticated;
