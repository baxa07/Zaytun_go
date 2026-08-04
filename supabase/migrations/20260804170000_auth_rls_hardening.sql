-- Keep the existing profile/app_role model and narrow public execution to the
-- customer-safe RPC surface. RLS remains enabled on every operational table.
revoke create on schema public from public, anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.create_order(jsonb) to anon, authenticated;
grant execute on function public.create_public_order(jsonb) to anon, authenticated;
grant execute on function public.get_order_tracking(uuid, uuid) to anon, authenticated;
grant execute on function public.calculate_delivery_quote(double precision, double precision, integer, public.order_type) to anon, authenticated;

grant execute on function public.current_app_role() to authenticated;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.transition_order(uuid, public.order_status, text, text) to authenticated;
grant execute on function public.assign_driver(uuid, uuid) to authenticated;
grant execute on function public.accept_assignment(uuid) to authenticated;
grant execute on function public.report_delivery_issue(uuid, public.delivery_issue_type, text) to authenticated;
grant execute on function public.resolve_delivery_issue(uuid) to authenticated;
grant execute on function public.set_preparation_estimate(uuid, integer) to authenticated;

create or replace function public.transition_order(
  p_order_id uuid,
  p_new_status public.order_status,
  p_reason text default null,
  p_notes text default null
) returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.orders;
  old public.order_status;
  app_role public.app_role;
  actor public.actor_type;
begin
  app_role := public.current_app_role();
  if app_role is null then
    raise exception 'AUTHENTICATION_REQUIRED|Xodim hisobi bilan kiring' using errcode = '42501';
  end if;

  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi'; end if;
  old := o.status;

  if app_role = 'DRIVER' then
    if o.assigned_driver_id is distinct from auth.uid() then
      raise exception 'DRIVER_NOT_ASSIGNED|Bu buyurtma sizga biriktirilmagan' using errcode = '42501';
    end if;
    if p_new_status not in ('PICKED_UP','ON_THE_WAY','ARRIVED','DELIVERED','DELIVERY_FAILED','RETURNED') then
      raise exception 'DRIVER_TRANSITION_FORBIDDEN|Haydovchi bu holatni o‘zgartira olmaydi' using errcode = '42501';
    end if;
    if old = 'DRIVER_ASSIGNED' and p_new_status = 'PICKED_UP' and o.assignment_accepted_at is null then
      raise exception 'ASSIGNMENT_NOT_ACCEPTED|Avval topshiriqni qabul qiling' using errcode = '42501';
    end if;
    actor := 'DRIVER';
  elsif app_role = 'DISPATCHER' then
    actor := 'DISPATCHER';
  elsif app_role = 'RESTAURANT' then
    actor := 'RESTAURANT';
  else
    raise exception 'AUTHORIZATION_REQUIRED|Xodim roli talab qilinadi' using errcode = '42501';
  end if;

  perform public.assert_transition(old, p_new_status);
  if p_new_status in ('REJECTED','CANCELLED','DELIVERY_FAILED') and coalesce(trim(p_reason), '') = '' then
    raise exception 'REASON_REQUIRED|Sababni kiriting';
  end if;

  update public.orders
  set status = p_new_status,
      rejection_reason = case when p_new_status = 'REJECTED' then trim(p_reason) else rejection_reason end,
      cancellation_reason = case when p_new_status = 'CANCELLED' then trim(p_reason) else cancellation_reason end,
      payment_status = case when p_new_status = 'DELIVERED' and payment_method = 'CASH' then 'COLLECTED' else payment_status end
  where id = p_order_id
  returning * into o;

  insert into public.order_events(order_id, actor_type, actor_id, previous_status, new_status, reason, notes)
  values (p_order_id, actor, auth.uid()::text, old, p_new_status, nullif(trim(p_reason), ''), nullif(trim(p_notes), ''));

  if p_new_status in ('DELIVERED','DELIVERY_FAILED','RETURNED','CANCELLED') and o.assigned_driver_id is not null then
    update public.drivers set availability = 'AVAILABLE' where id = o.assigned_driver_id;
    update public.driver_assignments set ended_at = now() where order_id = p_order_id;
  end if;
  return o;
end
$$;

create or replace function public.accept_assignment(p_order_id uuid)
returns public.driver_assignments
language plpgsql
security definer
set search_path = public
as $$
declare a public.driver_assignments;
begin
  if public.current_app_role() is distinct from 'DRIVER' then
    raise exception 'DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi' using errcode = '42501';
  end if;
  update public.driver_assignments
  set accepted_at = now()
  where order_id = p_order_id and driver_id = auth.uid() and accepted_at is null and ended_at is null
  returning * into a;
  if not found then raise exception 'ASSIGNMENT_NOT_FOUND|Faol topshiriq topilmadi'; end if;
  update public.orders set assignment_accepted_at = a.accepted_at where id = p_order_id;
  return a;
end
$$;

create or replace function public.report_delivery_issue(
  p_order_id uuid,
  p_type public.delivery_issue_type,
  p_description text
) returns public.delivery_issues
language plpgsql
security definer
set search_path = public
as $$
declare i public.delivery_issues;
begin
  if coalesce(length(trim(p_description)), 0) < 3 then
    raise exception 'ISSUE_DESCRIPTION_REQUIRED|Muammo izohini kiriting' using errcode = '22023';
  end if;
  if not public.is_staff() and not (
    public.current_app_role() = 'DRIVER' and
    exists(select 1 from public.orders where id = p_order_id and assigned_driver_id = auth.uid())
  ) then
    raise exception 'NOT_AUTHORIZED|Bu buyurtma uchun ruxsat yo‘q' using errcode = '42501';
  end if;
  insert into public.delivery_issues(order_id, issue_type, description, reported_by)
  values (p_order_id, p_type, trim(p_description), auth.uid()) returning * into i;
  return i;
end
$$;

-- A tracking token is a bearer capability, but the response is still limited
-- to customer-safe status, totals, items, and public lifecycle timestamps.
create or replace function public.get_order_tracking(p_order_id uuid, p_tracking_token uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
select jsonb_build_object(
  'id', o.id,
  'number', o.number,
  'customer_name', '',
  'primary_phone', '',
  'order_type', o.order_type,
  'payment_method', o.payment_method,
  'payment_status', o.payment_status,
  'special_instructions', '',
  'status', o.status,
  'subtotal', o.subtotal,
  'delivery_fee', o.delivery_fee,
  'total', o.total,
  'estimated_minutes', o.estimated_minutes,
  'assigned_driver_id', null,
  'assignment_accepted_at', null,
  'created_at', o.created_at,
  'customer_addresses', '[]'::jsonb,
  'order_items', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'order_id', i.order_id, 'menu_item_id', i.menu_item_id,
      'name', i.name, 'unit_price', i.unit_price, 'quantity', i.quantity,
      'modifier_ids', i.modifier_ids, 'modifier_names', i.modifier_names,
      'instructions', i.instructions, 'total', i.total
    )), '[]'::jsonb) from public.order_items i where i.order_id = o.id
  ),
  'order_events', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'order_id', e.order_id, 'actor_type', 'SYSTEM',
      'actor_id', 'public', 'previous_status', e.previous_status,
      'new_status', e.new_status, 'occurred_at', e.occurred_at
    ) order by e.occurred_at), '[]'::jsonb)
    from public.order_events e where e.order_id = o.id
  ),
  'delivery_issues', '[]'::jsonb
)
from public.orders o
where o.id = p_order_id and o.tracking_token = p_tracking_token
$$;

-- CREATE OR REPLACE resets neither ownership nor ACLs; re-assert the exact ACLs.
revoke execute on function public.transition_order(uuid, public.order_status, text, text) from public, anon;
revoke execute on function public.accept_assignment(uuid) from public, anon;
revoke execute on function public.report_delivery_issue(uuid, public.delivery_issue_type, text) from public, anon;
revoke execute on function public.get_order_tracking(uuid, uuid) from public;
grant execute on function public.transition_order(uuid, public.order_status, text, text) to authenticated;
grant execute on function public.accept_assignment(uuid) to authenticated;
grant execute on function public.report_delivery_issue(uuid, public.delivery_issue_type, text) to authenticated;
grant execute on function public.get_order_tracking(uuid, uuid) to anon, authenticated;
