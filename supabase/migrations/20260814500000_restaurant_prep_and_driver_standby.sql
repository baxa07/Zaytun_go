-- Restaurant UI Phase 1: Live Incoming Orders + Loud Alerts + Telegram
-- Notification + Preparing Workflow. The address-review / accept / start-
-- preparing / mark-ready sequence, the loud-alert board, and the
-- restaurant new-order Telegram notification all already existed in full
-- from earlier phases -- this migration adds exactly one new backend
-- primitive: an early, non-binding "driver standby" heads-up broadcast
-- fired when an order enters PREPARING, so drivers can become aware
-- before the food is actually READY. This is deliberately NOT a hard
-- assignment and does not touch driver_assignments, assigned_driver_id,
-- availability, or capacity accounting at all -- the existing automatic
-- dispatch sweep (attempt_dispatch_sweep_internal, still fired on READY)
-- remains the sole authority for actual assignment. This is designed to
-- evolve into real dispatch-adjacent logic in the Driver UI phase without
-- requiring a schema change: driver_standby_notices already records which
-- order, which branch, and how many drivers were eligible at that moment.

create table public.driver_standby_notices(
  order_id uuid primary key references public.orders(id) on delete cascade,
  branch_id uuid references public.branches(id),
  eligible_driver_count integer not null,
  created_at timestamptz not null default now()
);
create index driver_standby_notices_branch_idx on public.driver_standby_notices(branch_id, created_at);
alter table public.driver_standby_notices enable row level security;
create policy driver_standby_notices_read on public.driver_standby_notices for select to authenticated
  using(public.is_staff());
revoke all on public.driver_standby_notices from public, anon, authenticated;
grant select on public.driver_standby_notices to authenticated;

-- "Available" reuses the exact eligibility predicate select_best_driver_internal
-- already uses for real dispatch (ON_SHIFT + ACTIVE + under capacity + in
-- this order's branch pool) -- a driver who wouldn't be a real dispatch
-- candidate shouldn't be told to stand by for one either. Idempotent via
-- driver_standby_notices' own primary key (order_id): PREPARING is only
-- ever entered once per order (assert_transition has no CONFIRMED<-PREPARING
-- or PREPARING<-PREPARING edge), so on conflict do nothing is defense in
-- depth, not the primary guarantee. Zero eligible drivers is handled
-- safely: the row is still recorded (for staff visibility / later
-- analysis of "how often we had nobody available"), just with no
-- broadcast, since there is nobody to usefully signal.
create or replace function public.attempt_driver_standby_notice_internal(p_order_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare target_branch uuid; eligible_count integer;
begin
  select branch_id into target_branch from public.orders where id=p_order_id;
  select count(*) into eligible_count
  from public.drivers d
  where d.shift_status='ON_SHIFT'
    and d.dispatch_status='ACTIVE'
    and public.driver_active_assignment_count(d.id) < d.delivery_capacity
    and (target_branch is null or exists(select 1 from public.driver_branches db where db.driver_id=d.id and db.branch_id=target_branch));
  insert into public.driver_standby_notices(order_id, branch_id, eligible_driver_count)
  values(p_order_id, target_branch, eligible_count)
  on conflict(order_id) do nothing;
  if eligible_count > 0 then
    -- Open broadcast (private:=false), same reasoning as the customer
    -- tracking signal: the payload carries no customer PII, only an
    -- order id and branch-scoped topic -- a future Driver UI always
    -- refetches driver_standby_notices (or the order itself) as the
    -- authoritative state, this is only ever a "go check" signal.
    perform realtime.send(
      jsonb_build_object('type','driver_standby','orderId',p_order_id),
      'driver_standby',
      'driver-standby:'||coalesce(target_branch::text,'none'),
      false
    );
  end if;
end $$;
revoke all on function public.attempt_driver_standby_notice_internal(uuid) from public, anon, authenticated, service_role;

-- transition_order: every line reproduced byte-identical from the current
-- body (20260814300000) except the new PREPARING block, placed between
-- the terminal-state driver-freeing block and the READY dispatch-sweep
-- block to mirror the lifecycle's own chronological order.
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
  update public.orders set status=p_new_status,ready_at=case when p_new_status='READY' and order_type='DELIVERY' then coalesce(ready_at,now()) else ready_at end,rejection_reason=case when p_new_status='REJECTED' then trim(p_reason) else rejection_reason end,cancellation_reason=case when p_new_status='CANCELLED' then trim(p_reason) else cancellation_reason end,payment_status=case when p_new_status in('DELIVERED','COLLECTED') and o.payment_method not in('CLICK','PAYME') then 'COLLECTED' else payment_status end where id=p_order_id returning * into o;
  insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status,reason,notes) values(p_order_id,actor,auth.uid()::text,old,p_new_status,nullif(trim(p_reason),''),nullif(trim(p_notes),''));
  if p_new_status in('DELIVERED','DELIVERY_FAILED','RETURNED','CANCELLED') and o.assigned_driver_id is not null then
    update public.drivers set availability='AVAILABLE' where id=o.assigned_driver_id;
    update public.driver_assignments set ended_at=now(),status=(case p_new_status when 'DELIVERED' then 'COMPLETED' when 'DELIVERY_FAILED' then 'FAILED' when 'RETURNED' then 'RETURNED' when 'CANCELLED' then 'CANCELLED' end)::public.assignment_status where order_id=p_order_id and ended_at is null;
  end if;
  if p_new_status='PREPARING' and o.order_type='DELIVERY' then
    begin
      perform public.attempt_driver_standby_notice_internal(p_order_id);
    exception when others then
      raise warning 'failed to send driver standby notice for order %: %', p_order_id, sqlerrm;
    end;
  end if;
  if p_new_status='READY' and o.order_type='DELIVERY' then
    begin
      perform public.attempt_dispatch_sweep_internal();
    exception when others then
      raise warning 'dispatch sweep failed after order % became READY: %', p_order_id, sqlerrm;
    end;
  end if;
  if p_new_status in('DELIVERED','DELIVERY_FAILED','RETURNED','CANCELLED') and o.assigned_driver_id is not null then
    begin
      perform public.attempt_dispatch_sweep_internal();
    exception when others then
      raise warning 'redispatch sweep failed after order % reached %: %', p_order_id, p_new_status, sqlerrm;
    end;
  end if;
  if p_new_status='ARRIVED' and o.customer_telegram_chat_id is not null then
    begin
      insert into public.notification_outbox(order_id, channel) values(p_order_id, 'TELEGRAM_CUSTOMER_ARRIVED') on conflict(order_id, channel) do nothing;
    exception when others then
      raise warning 'failed to enqueue arrival notification for order %: %', p_order_id, sqlerrm;
    end;
  end if;
  return o;
end $$;
