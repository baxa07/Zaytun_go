-- Smart Dispatch v1, Phase 3: Automatic Dispatch Engine.
--
-- Canonical eligibility, from this migration forward, for BOTH automatic
-- dispatch and manual assignment:
--   shift_status = 'ON_SHIFT'
--   AND dispatch_status = 'ACTIVE'
--   AND active_assignment_count < delivery_capacity
--   AND driver is in the order's branch pool (driver_branches)
--
-- `drivers.availability` is retired as a decision input as of this
-- migration -- it becomes a display-only compatibility projection, kept
-- for the still-unmodified restaurant/driver UI (Phases 4-5), still
-- written on assignment/terminal transitions so that UI doesn't show
-- stale values, but read by NOTHING in this migration. It is not dropped
-- yet (rollback safety / a later cleanup migration once Phases 4-5 stop
-- reading it), and it is explicitly documented as non-authoritative
-- everywhere it still appears.
--
-- Capacity is freed conceptually because driver_assignments.ended_at
-- becomes non-null (already true since Phase 2) -- never because
-- `availability` was reset. The dispatch sweep only ever reads the
-- derived active_assignment_count.

alter table public.orders add column ready_at timestamptz;
create index orders_dispatch_queue_idx on public.orders(ready_at, id)
  where order_type = 'DELIVERY' and status = 'READY' and assigned_driver_id is null;

-- Shared assignment primitive (Correction 3): the ONE place that mutates
-- assignment state, used identically by automatic dispatch and manual
-- staff assignment. The only difference between the two callers is WHO
-- picks the driver -- the algorithm (AUTO) or a human (MANUAL) -- never
-- what is allowed. Manual assignment does not bypass shift/dispatch/
-- capacity/branch eligibility: it may only bypass the fair-rotation
-- *ranking* (staff pick which eligible driver, instead of the algorithm
-- picking the best one). A true emergency override that bypasses
-- capacity/shift/branch would be a separate, deliberately-authorized
-- future decision -- not implicit here.
--
-- Never granted to anon/authenticated -- reachable only from other
-- security definer functions (assign_driver, dispatch_ready_order_internal).
create or replace function public.assign_driver_internal(
  p_order_id uuid,
  p_driver_id uuid,
  p_assignment_source text, -- 'AUTO' | 'MANUAL' -- audit-trail detail only, not a security boundary
  p_assigned_by uuid        -- staff profile id for MANUAL, null for AUTO
)
returns public.driver_assignments
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  o public.orders;
  d public.drivers;
  a public.driver_assignments;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi' using errcode = '22023'; end if;
  if o.order_type <> 'DELIVERY' then
    raise exception 'PICKUP_DRIVER_FORBIDDEN|Olib ketish buyurtmasiga haydovchi biriktirilmaydi' using errcode = '42501';
  end if;
  if o.delivery_review_status <> 'APPROVED' then
    raise exception 'DELIVERY_REVIEW_REQUIRED|Tasdiqlanmagan yetkazish haydovchiga berilmaydi' using errcode = '42501';
  end if;
  perform public.assert_transition(o.status, 'DRIVER_ASSIGNED');

  select * into d from public.drivers where id = p_driver_id for update;
  if not found then raise exception 'DRIVER_NOT_FOUND|Haydovchi topilmadi' using errcode = '22023'; end if;

  -- Canonical eligibility -- identical for AUTO and MANUAL.
  if d.shift_status <> 'ON_SHIFT' then
    raise exception 'DRIVER_OFF_SHIFT|Haydovchi ishda emas' using errcode = '42501';
  end if;
  if d.dispatch_status <> 'ACTIVE' then
    raise exception 'DRIVER_DISPATCH_PAUSED|Haydovchi vaqtincha topshiriq qabul qilmayapti' using errcode = '42501';
  end if;
  if public.driver_active_assignment_count(p_driver_id) >= d.delivery_capacity then
    raise exception 'DRIVER_AT_CAPACITY|Haydovchi band' using errcode = '42501';
  end if;
  if not exists(select 1 from public.driver_branches where driver_id = p_driver_id and branch_id = o.branch_id) then
    raise exception 'DRIVER_NOT_IN_BRANCH_POOL|Haydovchi bu filial uchun mavjud emas' using errcode = '42501';
  end if;

  insert into public.driver_assignments(order_id, driver_id, assigned_by, status)
  values (p_order_id, p_driver_id, p_assigned_by, 'ASSIGNED')
  returning * into a;

  -- Legacy display-only compatibility write -- NOT read by any eligibility
  -- or capacity decision from this migration forward.
  update public.drivers set availability = 'BUSY' where id = p_driver_id;
  update public.orders set assigned_driver_id = p_driver_id, status = 'DRIVER_ASSIGNED' where id = p_order_id;
  insert into public.order_events(order_id, actor_type, actor_id, previous_status, new_status)
  values (
    p_order_id,
    case when p_assignment_source = 'AUTO' then 'SYSTEM'::public.actor_type else 'DISPATCHER'::public.actor_type end,
    coalesce(p_assigned_by::text, 'system'),
    'READY', 'DRIVER_ASSIGNED'
  );

  return a;
end;
$$;
revoke all on function public.assign_driver_internal(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;

-- Branch-aware candidate selection: lowest active workload, then longest
-- since previous assignment (fair rotation, derived from the existing
-- assigned_at column -- no new state), then a deterministic id tie-break.
-- FOR UPDATE SKIP LOCKED means a concurrent sweep/dispatch attempt racing
-- for the same driver is never blocked -- it simply falls through to the
-- next-best candidate instead.
create or replace function public.select_best_driver_internal(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_branch uuid;
  candidate_id uuid;
begin
  select branch_id into target_branch from public.orders where id = p_order_id;
  if target_branch is null then return null; end if;

  select d.id into candidate_id
  from public.drivers d
  where d.shift_status = 'ON_SHIFT'
    and d.dispatch_status = 'ACTIVE'
    and public.driver_active_assignment_count(d.id) < d.delivery_capacity
    and exists(select 1 from public.driver_branches db where db.driver_id = d.id and db.branch_id = target_branch)
  order by
    public.driver_active_assignment_count(d.id) asc,
    (select max(a.assigned_at) from public.driver_assignments a where a.driver_id = d.id) asc nulls first,
    d.id asc
  for update of d skip locked
  limit 1;

  return candidate_id;
end;
$$;
revoke all on function public.select_best_driver_internal(uuid) from public, anon, authenticated, service_role;

-- Attempts exactly one order. Returns true if it dispatched, false
-- otherwise (already handled by someone else, or genuinely no candidate).
-- Never raises for "no candidate" -- only for a genuine internal error,
-- which callers (the sweep) handle via their own exception-safe wrapper.
create or replace function public.dispatch_ready_order_internal(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  o public.orders;
  candidate_id uuid;
begin
  select * into o from public.orders where id = p_order_id;
  if not found or o.order_type <> 'DELIVERY' or o.status <> 'READY' or o.assigned_driver_id is not null then
    return false;
  end if;

  candidate_id := public.select_best_driver_internal(p_order_id);
  if candidate_id is null then return false; end if;

  perform public.assign_driver_internal(p_order_id, candidate_id, 'AUTO', null);
  return true;
end;
$$;
revoke all on function public.dispatch_ready_order_internal(uuid) from public, anon, authenticated, service_role;

-- Bounded sweep (Correction 1): an unserviceable oldest order must never
-- head-of-line-block a newer, differently-branched order that DOES have
-- capacity. Reads a single bounded batch of the oldest waiting orders via
-- the indexed queue, and for EACH one independently attempts dispatch,
-- continuing past ones with no eligible candidate rather than stopping.
-- batch_limit is the one centralized knob (not scattered): 20 is far
-- larger than any realistic near-term queue depth across three branches,
-- while keeping worst-case cost small and bounded -- no full-table scan,
-- no re-scanning of the same queue within one call.
create or replace function public.attempt_dispatch_sweep_internal()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  batch_limit constant integer := 20;
  candidate_order record;
begin
  -- Test-only fault injection (inert unless a pgTAP test explicitly sets
  -- this session-local GUC): proves a genuine internal dispatch failure
  -- cannot roll back a caller's already-performed READY write, without
  -- weakening any real production code path.
  if current_setting('zaytun.test_force_dispatch_failure', true) = 'true' then
    raise exception 'TEST_FORCED_DISPATCH_FAILURE';
  end if;

  for candidate_order in
    select id from public.orders
    where order_type = 'DELIVERY' and status = 'READY' and assigned_driver_id is null
    order by ready_at asc, id asc
    limit batch_limit
    for update skip locked
  loop
    -- Whether or not THIS order finds a driver, continue to the next one
    -- in the batch -- an unserviceable branch must never block a
    -- different, serviceable branch.
    perform public.dispatch_ready_order_internal(candidate_order.id);
  end loop;
end;
$$;
revoke all on function public.attempt_dispatch_sweep_internal() from public, anon, authenticated, service_role;

-- assign_driver: public, staff-only entry point, now a thin wrapper over
-- the shared primitive with source='MANUAL'. Enforces the exact same
-- canonical eligibility as automatic dispatch -- manual assignment can
-- pick WHICH eligible driver, never bypass whether a driver is eligible.
create or replace function public.assign_driver(p_order_id uuid, p_driver_id uuid)
returns public.driver_assignments
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.is_staff() then
    raise exception 'STAFF_ROLE_REQUIRED|Xodim roli talab qilinadi' using errcode = '42501';
  end if;
  return public.assign_driver_internal(p_order_id, p_driver_id, 'MANUAL', auth.uid());
end;
$$;
revoke execute on function public.assign_driver(uuid, uuid) from public, anon;
grant execute on function public.assign_driver(uuid, uuid) to authenticated;

-- transition_order (current body: 20260812170000): READY now records
-- ready_at (once, guarded by IS NULL so it can never be overwritten) and
-- triggers a dispatch sweep; the terminal branch (which already frees the
-- driver -- legacy availability write kept, non-authoritative -- and ends
-- the assignment row) also triggers a sweep afterward, since a DIFFERENT
-- waiting order may now be dispatchable. Both sweep calls are wrapped in
-- a nested exception block (an implicit savepoint in plpgsql): a dispatch
-- failure or "no candidate" can NEVER roll back the READY/terminal write
-- that already committed earlier in the same function. Failures are
-- surfaced via RAISE WARNING (Postgres server log only) -- never written
-- to order_events, since get_order_tracking returns every event's `notes`
-- unredacted to anonymous customers holding a tracking token; nothing
-- sensitive is ever given a path to that table in the first place. Every
-- other line reproduced byte-identical from source.
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
  return o;
end $$;
