-- Smart Dispatch v1, Phase 2: Assignment History Foundation.
--
-- Today driver_assignments.order_id is a plain UNIQUE constraint, so an
-- order can receive at most one assignment row for its entire lifetime --
-- structurally incompatible with decline/reassignment (Phase 6), which
-- needs a second row after the first ends. Replaces it with a partial
-- unique index (at most one *active* assignment per order), and adds an
-- explicit `status` classification so history stays unambiguous instead
-- of being inferred from `ended_at` alone.
--
-- Every lifecycle ending sets `status` to a distinct terminal value and
-- `ended_at`; no row is ever overwritten to mean something different than
-- what actually happened:
--   decline (pre-accept only)          -> DECLINED, declined_at, ended_at
--   staff supersedes an active one     -> SUPERSEDED, ended_at (new row inserted)
--   DELIVERED                          -> COMPLETED, ended_at
--   DELIVERY_FAILED                    -> FAILED, ended_at
--   RETURNED                           -> RETURNED, ended_at
--   CANCELLED (had an active courier)  -> CANCELLED, ended_at
-- ASSIGNED/ACCEPTED are the two active, non-terminal states.

create type public.assignment_status as enum
  ('ASSIGNED','ACCEPTED','DECLINED','SUPERSEDED','COMPLETED','FAILED','RETURNED','CANCELLED');

alter table public.driver_assignments
  add column status public.assignment_status not null default 'ASSIGNED',
  add column declined_at timestamptz;

-- Backfill existing rows from what we can actually infer: an
-- already-ended assignment's outcome mirrors its order's own terminal
-- status (the only status that could have caused `ended_at` to be set,
-- per transition_order's existing logic); a still-active assignment is
-- ACCEPTED if accepted_at is set, else ASSIGNED.
update public.driver_assignments a
set status = case
  when a.ended_at is null then
    case when a.accepted_at is not null then 'ACCEPTED'::public.assignment_status else 'ASSIGNED'::public.assignment_status end
  else
    coalesce(
      (select case o.status
        when 'DELIVERED' then 'COMPLETED'
        when 'DELIVERY_FAILED' then 'FAILED'
        when 'RETURNED' then 'RETURNED'
        when 'CANCELLED' then 'CANCELLED'
        else null
       end::public.assignment_status
       from public.orders o where o.id = a.order_id),
      'COMPLETED'::public.assignment_status
    )
end;

alter table public.driver_assignments drop constraint driver_assignments_order_id_key;
create unique index driver_assignments_active_order_idx
  on public.driver_assignments(order_id) where ended_at is null;

-- accept_assignment (current body: 20260806100000) gains exactly one
-- thing: status='ACCEPTED' alongside the existing accepted_at write.
-- Every other line reproduced byte-identical from source.
create or replace function public.accept_assignment(p_order_id uuid)
returns public.driver_assignments
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare a public.driver_assignments;
begin
  if public.current_app_role() is distinct from 'DRIVER' then
    raise exception 'DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi' using errcode = '42501';
  end if;
  if exists(select 1 from public.orders where id = p_order_id and order_type = 'PICKUP') then
    raise exception 'PICKUP_DRIVER_FORBIDDEN|Haydovchi olib ketish buyurtmasini qabul qilmaydi' using errcode = '42501';
  end if;
  if exists(select 1 from public.orders where id = p_order_id and order_type = 'DELIVERY' and delivery_review_status <> 'APPROVED') then
    raise exception 'DELIVERY_REVIEW_REQUIRED|Tasdiqlanmagan yetkazish qabul qilinmaydi' using errcode = '42501';
  end if;
  update public.driver_assignments
  set accepted_at = now(), status = 'ACCEPTED'
  where order_id = p_order_id and driver_id = auth.uid() and accepted_at is null and ended_at is null
  returning * into a;
  if not found then raise exception 'ASSIGNMENT_NOT_FOUND|Faol topshiriq topilmadi'; end if;
  update public.orders set assignment_accepted_at = a.accepted_at where id = p_order_id;
  return a;
end $$;

-- transition_order (current body: 20260806100000) gains exactly one
-- thing: the terminal-status branch that already resets driver
-- availability and ended_at now also classifies *why* the assignment
-- ended via `status`. Every other line reproduced byte-identical.
create or replace function public.transition_order(p_order_id uuid,p_new_status public.order_status,p_reason text default null,p_notes text default null)
returns public.orders language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders; old public.order_status; app_role public.app_role; actor public.actor_type;
begin
  app_role:=public.current_app_role(); if app_role is null then raise exception 'AUTHENTICATION_REQUIRED|Xodim hisobi bilan kiring' using errcode='42501'; end if;
  select * into o from public.orders where id=p_order_id for update; if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi'; end if; old:=o.status;
  if o.order_type='DELIVERY' and o.delivery_review_status<>'APPROVED' and p_new_status not in('REJECTED','CANCELLED') then raise exception 'DELIVERY_REVIEW_REQUIRED|Avval yetkazish manzilini tasdiqlang' using errcode='42501'; end if;
  if o.order_type='PICKUP' and p_new_status in('DRIVER_ASSIGNED','PICKED_UP','ON_THE_WAY','ARRIVED','DELIVERED','DELIVERY_FAILED','RETURNED') then raise exception 'PICKUP_TRANSITION_FORBIDDEN|Olib ketish buyurtmasi haydovchi bosqichiga o‘tmaydi' using errcode='42501'; end if;
  if o.order_type='DELIVERY' and p_new_status='COLLECTED' then raise exception 'DELIVERY_TRANSITION_FORBIDDEN|Yetkazish buyurtmasi olib ketildi deb belgilanmaydi' using errcode='42501'; end if;
  if app_role='DRIVER' then
    if o.order_type='PICKUP' then raise exception 'PICKUP_DRIVER_FORBIDDEN|Haydovchi olib ketish buyurtmasini boshqarmaydi' using errcode='42501'; end if;
    if o.assigned_driver_id is distinct from auth.uid() then raise exception 'DRIVER_NOT_ASSIGNED|Bu buyurtma sizga biriktirilmagan' using errcode='42501'; end if;
    if p_new_status not in('PICKED_UP','ON_THE_WAY','ARRIVED','DELIVERED','DELIVERY_FAILED','RETURNED') then raise exception 'DRIVER_TRANSITION_FORBIDDEN|Haydovchi bu holatni o‘zgartira olmaydi' using errcode='42501'; end if;
    if old='DRIVER_ASSIGNED' and p_new_status='PICKED_UP' and o.assignment_accepted_at is null then raise exception 'ASSIGNMENT_NOT_ACCEPTED|Avval topshiriqni qabul qiling' using errcode='42501'; end if; actor:='DRIVER';
  elsif app_role='DISPATCHER' then actor:='DISPATCHER'; elsif app_role='RESTAURANT' then actor:='RESTAURANT'; else raise exception 'AUTHORIZATION_REQUIRED|Xodim roli talab qilinadi' using errcode='42501'; end if;
  perform public.assert_transition(old,p_new_status);
  if p_new_status in('REJECTED','CANCELLED','DELIVERY_FAILED') and coalesce(trim(p_reason),'')='' then raise exception 'REASON_REQUIRED|Sababni kiriting'; end if;
  update public.orders set status=p_new_status,rejection_reason=case when p_new_status='REJECTED' then trim(p_reason) else rejection_reason end,cancellation_reason=case when p_new_status='CANCELLED' then trim(p_reason) else cancellation_reason end,payment_status=case when p_new_status in('DELIVERED','COLLECTED') and o.payment_method not in('CLICK','PAYME') then 'COLLECTED' else payment_status end where id=p_order_id returning * into o;
  insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status,reason,notes) values(p_order_id,actor,auth.uid()::text,old,p_new_status,nullif(trim(p_reason),''),nullif(trim(p_notes),''));
  if p_new_status in('DELIVERED','DELIVERY_FAILED','RETURNED','CANCELLED') and o.assigned_driver_id is not null then
    update public.drivers set availability='AVAILABLE' where id=o.assigned_driver_id;
    update public.driver_assignments set ended_at=now(),status=(case p_new_status when 'DELIVERED' then 'COMPLETED' when 'DELIVERY_FAILED' then 'FAILED' when 'RETURNED' then 'RETURNED' when 'CANCELLED' then 'CANCELLED' end)::public.assignment_status where order_id=p_order_id and ended_at is null;
  end if;
  return o;
end $$;
