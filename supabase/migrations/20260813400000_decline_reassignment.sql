-- Smart Dispatch v1, Phase 6: Decline / Reassignment / Recovery.
--
-- Assignment history is already shaped for this (Phase 2): DECLINED and
-- SUPERSEDED are existing assignment_status values, `declined_at` already
-- exists on driver_assignments, and H2's ledger RPCs already derive credit
-- from driver_assignments.status alone -- never orders.assigned_driver_id
-- -- so decline/reassignment cannot misattribute completed work. This
-- migration implements the actual decline contract, teaches manual
-- assignment to supersede an existing active assignment instead of only
-- ever creating the first one, and adds an exclusion parameter so the
-- immediate redispatch after a decline cannot hand the same order straight
-- back to the driver who just declined it.

-- P6.2: small optional enum, canonical (untranslated) values -- labels are
-- a frontend concern, same convention as every other reason/issue enum in
-- this schema.
create type public.assignment_decline_reason as enum
  ('TOO_FAR','VEHICLE_ISSUE','CANNOT_GO_NOW','OTHER');

alter table public.driver_assignments
  add column decline_reason public.assignment_decline_reason;

-- Redispatch exclusion (P6.6): the smallest safe mechanism -- an optional
-- parameter threaded through the two internal dispatch functions, used
-- only by decline_assignment's own immediate redispatch call below. The
-- batch sweep (attempt_dispatch_sweep_internal) never passes it, so this
-- is never a persistent blacklist: the very next independent sweep (e.g.
-- triggered by a different order, or by the declining driver's own
-- shift/capacity changing) is free to consider that driver again.
--
-- Adding a parameter changes a function's identity in Postgres -- CREATE
-- OR REPLACE cannot widen an existing signature, it would silently create
-- a second overload instead (and every existing single-argument call site
-- would become ambiguous). The old single-argument versions are dropped
-- first so there is exactly one of each function, matching every prior
-- signature-widening migration's approach in this schema.
drop function if exists public.select_best_driver_internal(uuid);
drop function if exists public.dispatch_ready_order_internal(uuid);

create or replace function public.select_best_driver_internal(p_order_id uuid, p_excluded_driver_id uuid default null)
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
    and (p_excluded_driver_id is null or d.id <> p_excluded_driver_id)
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
revoke all on function public.select_best_driver_internal(uuid, uuid) from public, anon, authenticated, service_role;

create or replace function public.dispatch_ready_order_internal(p_order_id uuid, p_excluded_driver_id uuid default null)
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

  candidate_id := public.select_best_driver_internal(p_order_id, p_excluded_driver_id);
  if candidate_id is null then return false; end if;

  perform public.assign_driver_internal(p_order_id, candidate_id, 'AUTO', null);
  return true;
end;
$$;
revoke all on function public.dispatch_ready_order_internal(uuid, uuid) from public, anon, authenticated, service_role;

-- assign_driver_internal gains manual supersede (P6.13/P6.14): when the
-- order already has an active assignment (status = DRIVER_ASSIGNED), a
-- MANUAL caller may replace it -- the old row ends as SUPERSEDED, a new
-- row is inserted, exactly one active assignment remains. AUTO can never
-- hit this branch (dispatch_ready_order_internal only ever calls this for
-- a READY order with assigned_driver_id null). Every eligibility check
-- below (shift/dispatch/capacity/branch) still applies unchanged to the
-- new driver -- manual selection may bypass fairness ranking, never
-- eligibility.
create or replace function public.assign_driver_internal(
  p_order_id uuid,
  p_driver_id uuid,
  p_assignment_source text,
  p_assigned_by uuid
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
  existing public.driver_assignments;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi' using errcode = '22023'; end if;
  if o.order_type <> 'DELIVERY' then
    raise exception 'PICKUP_DRIVER_FORBIDDEN|Olib ketish buyurtmasiga haydovchi biriktirilmaydi' using errcode = '42501';
  end if;
  if o.delivery_review_status <> 'APPROVED' then
    raise exception 'DELIVERY_REVIEW_REQUIRED|Tasdiqlanmagan yetkazish haydovchiga berilmaydi' using errcode = '42501';
  end if;

  select * into existing from public.driver_assignments where order_id = p_order_id and ended_at is null for update;

  if existing.id is not null then
    -- Supersede path: only a staff-initiated manual reassignment may
    -- replace an already-active assignment. AUTO never reaches here.
    if p_assignment_source <> 'MANUAL' then
      raise exception 'ASSIGNMENT_ALREADY_ACTIVE|Bu buyurtmaga allaqachon haydovchi biriktirilgan' using errcode = '42501';
    end if;
    if existing.driver_id = p_driver_id then
      raise exception 'DRIVER_ALREADY_ASSIGNED|Bu haydovchi allaqachon biriktirilgan' using errcode = '42501';
    end if;
  else
    perform public.assert_transition(o.status, 'DRIVER_ASSIGNED');
  end if;

  select * into d from public.drivers where id = p_driver_id for update;
  if not found then raise exception 'DRIVER_NOT_FOUND|Haydovchi topilmadi' using errcode = '22023'; end if;

  -- Canonical eligibility -- identical for AUTO and MANUAL, and identical
  -- for a first assignment or a supersede.
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

  if existing.id is not null then
    update public.driver_assignments set status = 'SUPERSEDED', ended_at = now() where id = existing.id;
  end if;

  insert into public.driver_assignments(order_id, driver_id, assigned_by, status)
  values (p_order_id, p_driver_id, p_assigned_by, 'ASSIGNED')
  returning * into a;

  -- Legacy display-only compatibility write -- NOT read by any eligibility
  -- or capacity decision from this migration forward.
  update public.drivers set availability = 'BUSY' where id = p_driver_id;
  update public.orders set assigned_driver_id = p_driver_id, assignment_accepted_at = null, status = 'DRIVER_ASSIGNED' where id = p_order_id;
  insert into public.order_events(order_id, actor_type, actor_id, previous_status, new_status)
  values (
    p_order_id,
    case when p_assignment_source = 'AUTO' then 'SYSTEM'::public.actor_type else 'DISPATCHER'::public.actor_type end,
    coalesce(p_assigned_by::text, 'system'),
    case when existing.id is not null then 'DRIVER_ASSIGNED' else 'READY' end::public.order_status,
    'DRIVER_ASSIGNED'
  );

  return a;
end;
$$;
revoke all on function public.assign_driver_internal(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;

-- decline_assignment (P6.1/P6.3): the assigned driver, before accepting,
-- may hand the order back. Server-authoritative end to end -- caller must
-- be the currently assigned driver, the assignment must still be ASSIGNED
-- (never ACCEPTED), row-locked so an accept racing a decline resolves to
-- exactly one terminal outcome (P6.15): whichever UPDATE's WHERE clause
-- still matches wins; the other finds zero rows and raises cleanly.
--
-- shift_status/dispatch_status are deliberately left untouched (P6.9): a
-- driver declining one order is not the same as ending their shift or
-- pausing dispatch, and this function never writes either column.
--
-- orders.ready_at is deliberately never written here (P6.4): the order
-- keeps its original queue age, exactly as when it first became READY.
create or replace function public.decline_assignment(p_order_id uuid, p_reason public.assignment_decline_reason default null)
returns public.driver_assignments
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  o public.orders;
  a public.driver_assignments;
begin
  if public.current_app_role() is distinct from 'DRIVER' then
    raise exception 'DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi' using errcode = '42501';
  end if;

  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi' using errcode = '22023'; end if;
  if o.order_type <> 'DELIVERY' then
    raise exception 'PICKUP_DRIVER_FORBIDDEN|Olib ketish buyurtmasini rad etib bo‘lmaydi' using errcode = '42501';
  end if;
  if o.status <> 'DRIVER_ASSIGNED' then
    raise exception 'ASSIGNMENT_NOT_DECLINABLE|Bu buyurtmani hozir rad etib bo‘lmaydi' using errcode = '42501';
  end if;
  if o.assigned_driver_id is distinct from auth.uid() then
    raise exception 'DRIVER_NOT_ASSIGNED|Bu buyurtma sizga biriktirilmagan' using errcode = '42501';
  end if;

  update public.driver_assignments
  set status = 'DECLINED', declined_at = now(), ended_at = now(), decline_reason = p_reason
  where order_id = p_order_id and driver_id = auth.uid() and status = 'ASSIGNED' and accepted_at is null and ended_at is null
  returning * into a;
  if not found then
    raise exception 'ASSIGNMENT_NOT_DECLINABLE|Topshiriq allaqachon qabul qilingan yoki topilmadi' using errcode = '42501';
  end if;

  update public.drivers set availability = 'AVAILABLE' where id = a.driver_id;
  update public.orders set assigned_driver_id = null, assignment_accepted_at = null, status = 'READY' where id = p_order_id;
  -- No `notes` written here: get_order_tracking returns order_events.notes
  -- unredacted to anonymous customers holding a tracking token (P6.12/
  -- P6.17) -- the previous/new status pair alone (DRIVER_ASSIGNED ->
  -- READY) is customer-invisible anyway, since both collapse into the
  -- same "Tayyorlanmoqda" stage in customerDeliveryStageIndex.
  insert into public.order_events(order_id, actor_type, actor_id, previous_status, new_status)
  values (p_order_id, 'DRIVER', auth.uid()::text, 'DRIVER_ASSIGNED', 'READY');

  -- Immediate, excluded redispatch (P6.5/P6.6) -- never rolls back the
  -- decline itself if it fails for any reason; the order simply remains
  -- READY, exactly like any other order for which the general sweep found
  -- no eligible driver.
  begin
    perform public.dispatch_ready_order_internal(p_order_id, a.driver_id);
  exception when others then
    raise warning 'redispatch after decline failed for order %: %', p_order_id, sqlerrm;
  end;

  return a;
end;
$$;
revoke all on function public.decline_assignment(uuid, public.assignment_decline_reason) from public, anon, authenticated, service_role;
grant execute on function public.decline_assignment(uuid, public.assignment_decline_reason) to authenticated;
