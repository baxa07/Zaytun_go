-- Production fix (Phase C, multi-order pickup UX): compute_batch_stop_
-- sequence_internal previously sequenced EVERY member of a batch the
-- moment the first one was marked PICKED_UP, with no readiness filter --
-- so a sibling still genuinely cooking (CONFIRMED/PREPARING) could be
-- given a stop_sequence and start rendering as a "next delivery stop" in
-- the driver's post-pickup route view before it had ever actually been
-- collected from the restaurant. Route mode must only ever reflect
-- orders the driver genuinely holds -- a still-cooking sibling is not a
-- stop yet, it's still a pending pickup.
create or replace function public.compute_batch_stop_sequence_internal(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare member record; seq integer := 1;
begin
  for member in
    select o.id from public.orders o
    join public.customer_addresses ca on ca.order_id = o.id
    where o.pickup_batch_id = p_batch_id
      -- Only members already ready-for-pickup or genuinely departed --
      -- a still-cooking sibling must not be sequenced until it is (see
      -- append_batch_stop_sequence_internal below, which handles it
      -- becoming ready after the route was already computed).
      and o.status not in ('CONFIRMED','PREPARING')
    order by ca.delivery_distance_km asc nulls last, o.id asc
  loop
    update public.orders set stop_sequence = seq where id = member.id;
    seq := seq + 1;
  end loop;
end;
$$;
revoke all on function public.compute_batch_stop_sequence_internal(uuid) from public, anon, authenticated, service_role;

-- append_batch_stop_sequence_internal: a batch member that was still
-- cooking when the rest of the route was already computed (the driver
-- already departed with a sibling) needs a stop_sequence of its own the
-- moment it finally becomes ready -- otherwise it would sit permanently
-- un-sequenced and never show up in the route view at all. Appended
-- after the existing route (max(stop_sequence)+1): the driver already
-- left, so this member can only realistically be picked up on the way,
-- never reordered ahead of a stop already in progress. A safe no-op if
-- the batch has no route yet (compute_batch_stop_sequence_internal will
-- size it in correctly at the first real pickup) or if this order
-- already has a stop_sequence.
create or replace function public.append_batch_stop_sequence_internal(p_batch_id uuid, p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare next_seq integer;
begin
  if exists(select 1 from public.orders where id = p_order_id and stop_sequence is not null) then return; end if;
  select max(stop_sequence) + 1 into next_seq from public.orders where pickup_batch_id = p_batch_id and stop_sequence is not null;
  if next_seq is null then return; end if;
  update public.orders set stop_sequence = next_seq where id = p_order_id;
end;
$$;
revoke all on function public.append_batch_stop_sequence_internal(uuid, uuid) from public, anon, authenticated, service_role;

-- transition_order: reproduced from 20260814700000 with one targeted
-- addition in the READY block (append a late-ready batch member to an
-- already-departed route, via the function above). Every other line is
-- byte-identical.
create or replace function public.transition_order(p_order_id uuid,p_new_status public.order_status,p_reason text default null,p_notes text default null)
returns public.orders language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders; old public.order_status; app_role public.app_role; actor public.actor_type; existing_batch_id uuid; all_terminal boolean;
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
  update public.orders set status=p_new_status,
    accepted_at=case when p_new_status='CONFIRMED' then coalesce(accepted_at,now()) else accepted_at end,
    ready_at=case when p_new_status='READY' and order_type='DELIVERY' then coalesce(ready_at,now()) else ready_at end,
    rejection_reason=case when p_new_status='REJECTED' then trim(p_reason) else rejection_reason end,
    cancellation_reason=case when p_new_status='CANCELLED' then trim(p_reason) else cancellation_reason end,
    payment_status=case when p_new_status in('DELIVERED','COLLECTED') and o.payment_method not in('CLICK','PAYME') then 'COLLECTED' else payment_status end
    where id=p_order_id returning * into o;
  insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status,reason,notes) values(p_order_id,actor,auth.uid()::text,old,p_new_status,nullif(trim(p_reason),''),nullif(trim(p_notes),''));
  if p_new_status in('DELIVERED','DELIVERY_FAILED','RETURNED','CANCELLED') and o.assigned_driver_id is not null then
    if public.driver_active_assignment_count(o.assigned_driver_id) <= 1 then
      update public.drivers set availability='AVAILABLE' where id=o.assigned_driver_id;
    end if;
    update public.driver_assignments set ended_at=now(),status=(case p_new_status when 'DELIVERED' then 'COMPLETED' when 'DELIVERY_FAILED' then 'FAILED' when 'RETURNED' then 'RETURNED' when 'CANCELLED' then 'CANCELLED' end)::public.assignment_status where order_id=p_order_id and ended_at is null;
    if o.pickup_batch_id is not null then
      select not exists(
        select 1 from public.orders where pickup_batch_id=o.pickup_batch_id and status not in('DELIVERED','CANCELLED','RETURNED','DELIVERY_FAILED')
      ) into all_terminal;
      if all_terminal then
        update public.pickup_batches set status='COMPLETED', completed_at=now() where id=o.pickup_batch_id and status<>'COMPLETED';
      end if;
    end if;
  end if;
  if p_new_status='CONFIRMED' and o.order_type='DELIVERY' then
    begin
      if not public.attempt_early_dispatch_internal(p_order_id) then
        perform public.attempt_driver_standby_notice_internal(p_order_id);
      end if;
    exception when others then
      raise warning 'early dispatch attempt failed for order %: %', p_order_id, sqlerrm;
      begin
        perform public.attempt_driver_standby_notice_internal(p_order_id);
      exception when others then
        raise warning 'failed to send driver standby notice for order %: %', p_order_id, sqlerrm;
      end;
    end;
  end if;
  if p_new_status='PREPARING' and o.order_type='DELIVERY' and o.assigned_driver_id is null then
    begin
      perform public.attempt_driver_standby_notice_internal(p_order_id);
    exception when others then
      raise warning 'failed to send driver standby notice for order %: %', p_order_id, sqlerrm;
    end;
  end if;
  if p_new_status='READY' and o.order_type='DELIVERY' then
    begin
      if o.assigned_driver_id is not null then
        perform public.confirm_existing_assignment_on_ready_internal(p_order_id);
        if o.pickup_batch_id is not null then
          update public.pickup_batches set first_member_ready_at=coalesce(first_member_ready_at,now()) where id=o.pickup_batch_id;
          perform public.maybe_advance_batch_ready_to_depart_internal(o.pickup_batch_id);
          -- Production fix: this order may have still been cooking when
          -- a sibling was already picked up and routed -- append it to
          -- the existing route now that it's finally ready. A no-op if
          -- there is no route yet or this order already has a stop.
          perform public.append_batch_stop_sequence_internal(o.pickup_batch_id, p_order_id);
        end if;
      else
        perform public.attempt_dispatch_sweep_internal();
      end if;
    exception when others then
      raise warning 'dispatch confirmation/sweep failed after order % became READY: %', p_order_id, sqlerrm;
    end;
  end if;
  if p_new_status='PICKED_UP' and o.pickup_batch_id is not null then
    begin
      if not exists(select 1 from public.orders where pickup_batch_id=o.pickup_batch_id and stop_sequence is not null) then
        perform public.compute_batch_stop_sequence_internal(o.pickup_batch_id);
      end if;
      -- The driver is now genuinely departing with at least one member of
      -- this batch -- IN_TRANSIT regardless of which lifecycle stage the
      -- batch was previously in (OPEN or READY_TO_DEPART), since actually
      -- picking up is the one unambiguous "en route" signal.
      update public.pickup_batches set status='IN_TRANSIT', departed_at=coalesce(departed_at,now())
      where id=o.pickup_batch_id and status in ('OPEN','READY_TO_DEPART');
      perform public.evaluate_batch_actual_wait_internal(o.pickup_batch_id);
    exception when others then
      raise warning 'batch pickup bookkeeping failed for order %: %', p_order_id, sqlerrm;
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
