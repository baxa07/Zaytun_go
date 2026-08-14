-- Multi-Order Dispatch: assign a driver at restaurant ACCEPT (NEW->CONFIRMED)
-- instead of at READY, so the same courier can be handed a second nearby
-- order while the first is still cooking and pick both up together.
--
-- Core decision: orders.status and assert_transition's legal-transition
-- graph do NOT change at all (still NEW->CONFIRMED->PREPARING->READY->
-- DRIVER_ASSIGNED->PICKED_UP->ON_THE_WAY->ARRIVED->DELIVERED, unchanged).
-- Instead, orders.assigned_driver_id and a driver_assignments row become
-- decoupled from orders.status -- they can now exist while status is
-- still CONFIRMED or PREPARING, before READY. When status naturally
-- reaches READY, if an assignment already exists, the system just flips
-- status READY->DRIVER_ASSIGNED reusing that assignment (the existing,
-- unchanged assert_transition edge) instead of searching for a driver. If
-- no assignment exists yet (driver-unavailable edge case), it falls back
-- to exactly today's search-and-assign sweep as a safety net -- READY
-- remains a valid, working assignment trigger, just no longer the normal
-- one.
--
-- This reuses the existing, already pgTAP-tested eligibility/capacity/
-- row-locking engine (select_best_driver_internal, assign_driver_internal's
-- locking pattern, driver_active_assignment_count, the partial-unique-
-- active-assignment index) almost entirely as-is -- no existing function
-- body is deleted, only extended or given a new sibling.

-- ============================================================
-- Schema
-- ============================================================

alter table public.orders add column accepted_at timestamptz; -- mirrors ready_at's exact pattern, written once on NEW->CONFIRMED

create type public.pickup_batch_status as enum ('OPEN','READY_TO_DEPART','IN_TRANSIT','COMPLETED','CANCELLED');
create table public.pickup_batches(
  id uuid primary key default gen_random_uuid(),
  driver_id uuid not null references public.drivers(id),
  branch_id uuid references public.branches(id),
  status public.pickup_batch_status not null default 'OPEN',
  max_members integer not null default 2 check(max_members > 0),
  created_at timestamptz not null default now(),
  first_member_ready_at timestamptz,
  departed_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz
);
create index pickup_batches_driver_open_idx on public.pickup_batches(driver_id) where status in ('OPEN','READY_TO_DEPART','IN_TRANSIT');
alter table public.pickup_batches enable row level security;
create policy pickup_batch_read on public.pickup_batches for select to authenticated using(public.is_staff() or driver_id=auth.uid());
revoke all on public.pickup_batches from public, anon, authenticated;
grant select on public.pickup_batches to authenticated;

alter table public.orders add column pickup_batch_id uuid references public.pickup_batches(id) on delete set null;
alter table public.orders add column stop_sequence integer;
create index orders_pickup_batch_idx on public.orders(pickup_batch_id) where pickup_batch_id is not null;

alter table public.delivery_settings add column max_batch_estimated_ready_gap_minutes integer not null default 5 check(max_batch_estimated_ready_gap_minutes > 0);
alter table public.delivery_settings add column max_batch_actual_wait_minutes integer not null default 5 check(max_batch_actual_wait_minutes > 0);

-- Driver capacity was already a real, already-enforced per-driver tunable
-- (driver_active_assignment_count(d) < d.delivery_capacity, used
-- identically everywhere already) -- only the default changes; the
-- architecture was never hardcoded around 1.
alter table public.drivers alter column delivery_capacity set default 2;
update public.drivers set delivery_capacity = 2 where delivery_capacity = 1;

-- ============================================================
-- Estimated-ready helper: never stored (stays correct if staff updates
-- estimated_minutes later), computed inline wherever compatibility is
-- evaluated. Uses the existing delivery_settings.estimated_preparation_minutes
-- as the default (already the app's one config-storage convention), with a
-- final hardcoded fallback for defensive safety if that's ever null too.
-- ============================================================
create or replace function public.order_estimated_ready_at(p_order_id uuid)
returns timestamptz language sql stable security definer set search_path = pg_catalog, public as $$
  select o.accepted_at + (coalesce(o.estimated_minutes, s.estimated_preparation_minutes, 25) || ' minutes')::interval
  from public.orders o left join public.delivery_settings s on s.id = true
  where o.id = p_order_id and o.accepted_at is not null
$$;
revoke all on function public.order_estimated_ready_at(uuid) from public, anon, authenticated, service_role;

-- ============================================================
-- assign_driver_early_internal: sibling to assign_driver_internal that
-- does NOT touch orders.status at all (order stays CONFIRMED/PREPARING).
-- Reuses the identical canonical eligibility checks (shift/dispatch/
-- capacity/branch), row-locking the driver exactly like assign_driver_internal
-- already does, plus two new conservative checks: the driver must not
-- already have departed with another order (PICKED_UP/ON_THE_WAY/ARRIVED),
-- and if they already hold exactly one other active non-departed order, it
-- must be compatible (same branch, ready-time gap within the configured
-- threshold). Creates-or-joins a pickup_batches row.
-- ============================================================
create or replace function public.assign_driver_early_internal(
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
  partner_order public.orders;
  gap_minutes numeric;
  max_gap integer;
  batch public.pickup_batches;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi' using errcode = '22023'; end if;
  if o.order_type <> 'DELIVERY' then
    raise exception 'PICKUP_DRIVER_FORBIDDEN|Olib ketish buyurtmasiga haydovchi biriktirilmaydi' using errcode = '42501';
  end if;
  if o.delivery_review_status <> 'APPROVED' then
    raise exception 'DELIVERY_REVIEW_REQUIRED|Tasdiqlanmagan yetkazish haydovchiga berilmaydi' using errcode = '42501';
  end if;
  if o.status not in ('CONFIRMED','PREPARING') then
    raise exception 'EARLY_ASSIGNMENT_NOT_APPLICABLE|Bu buyurtma endi erta biriktirish uchun mos emas' using errcode = '42501';
  end if;

  select * into existing from public.driver_assignments where order_id = p_order_id and ended_at is null for update;
  if existing.id is not null then
    raise exception 'ASSIGNMENT_ALREADY_ACTIVE|Bu buyurtmaga allaqachon haydovchi biriktirilgan' using errcode = '42501';
  end if;

  select * into d from public.drivers where id = p_driver_id for update;
  if not found then raise exception 'DRIVER_NOT_FOUND|Haydovchi topilmadi' using errcode = '22023'; end if;

  -- Test-only fault injection (mirrors zaytun.test_force_dispatch_failure's
  -- existing pattern) -- lets pgTAP deterministically force ONE specific
  -- driver's assignment attempt to fail for any reason, to prove
  -- attempt_early_dispatch_internal's retry loop actually moves on to a
  -- different, genuinely eligible candidate rather than giving up. Never
  -- set outside a test transaction.
  if current_setting('zaytun.test_force_assign_failure_for_driver', true) = p_driver_id::text then
    raise exception 'TEST_FORCED_ASSIGN_FAILURE';
  end if;

  -- Canonical eligibility -- identical to assign_driver_internal.
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

  -- Conservative "hasn't departed" rule (spec: a driver already en route
  -- with another order should not normally receive a fresh restaurant
  -- pickup): forbid if the driver holds any other active order already
  -- past READY (PICKED_UP/ON_THE_WAY/ARRIVED).
  if exists(
    select 1 from public.driver_assignments da join public.orders o2 on o2.id = da.order_id
    where da.driver_id = p_driver_id and da.ended_at is null and o2.id <> p_order_id
      and o2.status in ('PICKED_UP','ON_THE_WAY','ARRIVED')
  ) then
    raise exception 'DRIVER_ALREADY_DEPARTED|Haydovchi allaqachon yo‘lda' using errcode = '42501';
  end if;

  -- If the driver already has exactly one other active non-departed
  -- order, it must be compatible (same branch, close ready-time) --
  -- otherwise this call is only valid for a driver with zero active
  -- orders (a fresh pick).
  select o2.* into partner_order
  from public.driver_assignments da join public.orders o2 on o2.id = da.order_id
  where da.driver_id = p_driver_id and da.ended_at is null and o2.id <> p_order_id;

  if partner_order.id is not null then
    if partner_order.branch_id is distinct from o.branch_id then
      raise exception 'BATCH_INCOMPATIBLE_BRANCH|Boshqa filial buyurtmasi bilan birlashtirib bo‘lmaydi' using errcode = '42501';
    end if;
    select max_batch_estimated_ready_gap_minutes into max_gap from public.delivery_settings where id = true;
    gap_minutes := abs(extract(epoch from (public.order_estimated_ready_at(p_order_id) - public.order_estimated_ready_at(partner_order.id))) / 60);
    if gap_minutes is null or gap_minutes > coalesce(max_gap, 5) then
      raise exception 'BATCH_INCOMPATIBLE_READY_GAP|Tayyorlanish vaqtlari farqi juda katta' using errcode = '42501';
    end if;
  end if;

  insert into public.driver_assignments(order_id, driver_id, assigned_by, status)
  values (p_order_id, p_driver_id, p_assigned_by, 'ASSIGNED')
  returning * into a;

  update public.drivers set availability = 'BUSY' where id = p_driver_id;
  update public.orders set assigned_driver_id = p_driver_id, assignment_accepted_at = null where id = p_order_id;
  insert into public.order_events(order_id, actor_type, actor_id, previous_status, new_status, notes)
  values (
    p_order_id,
    case when p_assignment_source = 'AUTO' then 'SYSTEM'::public.actor_type else 'DISPATCHER'::public.actor_type end,
    coalesce(p_assigned_by::text, 'system'),
    o.status, o.status,
    'EARLY_DRIVER_ASSIGNED'
  );

  -- Batch membership: join the partner's batch if one exists, is under
  -- capacity, and the driver hasn't departed with it yet (OPEN or
  -- READY_TO_DEPART -- not IN_TRANSIT/COMPLETED/CANCELLED), else open a
  -- new batch for this driver. Joining a READY_TO_DEPART batch reopens it
  -- to OPEN: that batch had nothing left to wait for until this new,
  -- not-yet-ready member just joined.
  if partner_order.id is not null and partner_order.pickup_batch_id is not null then
    select * into batch from public.pickup_batches where id = partner_order.pickup_batch_id and status in ('OPEN','READY_TO_DEPART') for update;
  end if;
  if batch.id is null or (select count(*) from public.orders where pickup_batch_id = batch.id) >= batch.max_members then
    insert into public.pickup_batches(driver_id, branch_id) values (p_driver_id, o.branch_id) returning * into batch;
  end if;
  if batch.status = 'READY_TO_DEPART' then
    update public.pickup_batches set status = 'OPEN' where id = batch.id;
  end if;
  update public.orders set pickup_batch_id = batch.id where id = p_order_id;
  if partner_order.id is not null and partner_order.pickup_batch_id is distinct from batch.id then
    update public.orders set pickup_batch_id = batch.id where id = partner_order.id;
  end if;

  return a;
end;
$$;
revoke all on function public.assign_driver_early_internal(uuid, uuid, text, uuid) from public, anon, authenticated, service_role;

-- select_compatible_batch_partner_internal: phase-1 lookup, tried FIRST
-- (to encourage batching) -- an eligible driver who already has exactly
-- one active non-departed order in the same branch, within the
-- ready-gap threshold, and remaining capacity. Takes an exclusion ARRAY
-- (not a single id) so attempt_early_dispatch_internal's retry loop can
-- keep ruling out every candidate already tried this attempt, not just
-- the most recent one -- required so an incompatible-but-capacity-
-- available candidate can never terminate the search (see
-- attempt_early_dispatch_internal's own comment).
drop function if exists public.select_compatible_batch_partner_internal(uuid, uuid);
create or replace function public.select_compatible_batch_partner_internal(p_order_id uuid, p_excluded_driver_ids uuid[] default '{}'::uuid[])
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  target_branch uuid;
  max_gap integer;
  candidate_id uuid;
begin
  select branch_id into target_branch from public.orders where id = p_order_id;
  if target_branch is null then return null; end if;
  select max_batch_estimated_ready_gap_minutes into max_gap from public.delivery_settings where id = true;

  select d.id into candidate_id
  from public.drivers d
  where d.shift_status = 'ON_SHIFT'
    and d.dispatch_status = 'ACTIVE'
    and not (d.id = any(coalesce(p_excluded_driver_ids, '{}'::uuid[])))
    and public.driver_active_assignment_count(d.id) < d.delivery_capacity
    and public.driver_active_assignment_count(d.id) = 1
    and exists(select 1 from public.driver_branches db where db.driver_id = d.id and db.branch_id = target_branch)
    and not exists(
      select 1 from public.driver_assignments da join public.orders o2 on o2.id = da.order_id
      where da.driver_id = d.id and da.ended_at is null and o2.status in ('PICKED_UP','ON_THE_WAY','ARRIVED')
    )
    and exists(
      select 1 from public.driver_assignments da join public.orders o2 on o2.id = da.order_id
      where da.driver_id = d.id and da.ended_at is null and o2.branch_id = target_branch
        and abs(extract(epoch from (public.order_estimated_ready_at(p_order_id) - public.order_estimated_ready_at(o2.id))) / 60) <= coalesce(max_gap, 5)
    )
  order by d.id asc
  for update of d skip locked
  limit 1;

  return candidate_id;
end;
$$;
revoke all on function public.select_compatible_batch_partner_internal(uuid, uuid[]) from public, anon, authenticated, service_role;

-- select_best_driver_internal (array-exclusion overload): new sibling of
-- the existing scalar-exclusion select_best_driver_internal(uuid,uuid)
-- from 20260813400000 (untouched, still used by dispatch_ready_order_internal
-- and decline_assignment's classic path) -- an additive overload, not a
-- replacement, so attempt_early_dispatch_internal's retry loop can exclude
-- every candidate already tried this attempt, not just the most recent.
-- Body is otherwise byte-identical to the scalar version's own logic.
create or replace function public.select_best_driver_internal(p_order_id uuid, p_excluded_driver_ids uuid[])
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
    and not (d.id = any(coalesce(p_excluded_driver_ids, '{}'::uuid[])))
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
revoke all on function public.select_best_driver_internal(uuid, uuid[]) from public, anon, authenticated, service_role;

-- attempt_early_dispatch_internal: single-order attempt, used by both the
-- CONFIRMED-time call site in transition_order and the sweep's new first
-- pass below. Checks the SAME test-fault-injection GUC
-- attempt_dispatch_sweep_internal already checks, so neither dispatch
-- path bypasses the existing fault-injection test infrastructure.
--
-- Retries with a growing exclusion set (bounded) rather than giving up
-- after one candidate: the phase-2 fallback (select_best_driver_internal)
-- does not itself know about batch compatibility, so it can select a
-- driver who is generically eligible (under capacity, right branch, on
-- shift) but whom assign_driver_early_internal's own stricter
-- compatibility re-check then correctly rejects (e.g. their existing
-- order's ready-time is too far off). That candidate being incompatible
-- must never terminate the search when a DIFFERENT, genuinely compatible
-- driver exists -- e.g. Driver A already 1/2 but incompatible, Driver B
-- 0/2 and eligible: B must still receive the order. Bounded by
-- max_attempts (driver headcount is always small) purely as a defensive
-- circuit-breaker, not because more legitimate candidates are expected.
create or replace function public.attempt_early_dispatch_internal(p_order_id uuid, p_excluded_driver_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  o public.orders;
  candidate_id uuid;
  tried_ids uuid[] := '{}'::uuid[];
  max_attempts constant integer := 20;
  attempt integer := 0;
begin
  if current_setting('zaytun.test_force_dispatch_failure', true) = 'true' then
    raise exception 'TEST_FORCED_DISPATCH_FAILURE';
  end if;

  select * into o from public.orders where id = p_order_id;
  if not found or o.order_type <> 'DELIVERY' or o.status not in ('CONFIRMED','PREPARING') or o.assigned_driver_id is not null then
    return false;
  end if;

  if p_excluded_driver_id is not null then
    tried_ids := array[p_excluded_driver_id];
  end if;

  loop
    attempt := attempt + 1;
    exit when attempt > max_attempts;

    candidate_id := public.select_compatible_batch_partner_internal(p_order_id, tried_ids);
    if candidate_id is null then
      candidate_id := public.select_best_driver_internal(p_order_id, tried_ids);
    end if;
    if candidate_id is null then
      return false; -- exhausted every eligible candidate
    end if;

    -- A candidate failing assign_driver_early_internal's own re-check
    -- (batch-incompatible, or a genuine race) is an expected, routine
    -- "this candidate didn't work out" outcome, not a fatal error --
    -- caught here so it can neither abort the sweep's loop over the rest
    -- of the batch, nor stop THIS order's own search for another
    -- candidate (same "one unserviceable order must never block another"
    -- principle attempt_dispatch_sweep_internal's own READY pass already
    -- relies on, now applied within a single order's candidate search too).
    begin
      perform public.assign_driver_early_internal(p_order_id, candidate_id, 'AUTO', null);
      return true;
    exception when others then
      tried_ids := tried_ids || candidate_id;
    end;
  end loop;

  return false;
end;
$$;
revoke all on function public.attempt_early_dispatch_internal(uuid, uuid) from public, anon, authenticated, service_role;

-- attempt_dispatch_sweep_internal: extended (not replaced) with a first
-- pass over CONFIRMED/PREPARING unassigned orders, before its existing,
-- unchanged READY-only pass. Same call sites as today (start_shift,
-- resume_dispatch, decline_assignment's redispatch, terminal-transition
-- redispatch) -- no new triggers, this is the retry mechanism for "no
-- eligible driver was available at ACCEPT time."
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
  if current_setting('zaytun.test_force_dispatch_failure', true) = 'true' then
    raise exception 'TEST_FORCED_DISPATCH_FAILURE';
  end if;

  for candidate_order in
    select id from public.orders
    where order_type = 'DELIVERY' and status in ('CONFIRMED','PREPARING') and assigned_driver_id is null
    order by accepted_at asc, id asc
    limit batch_limit
    for update skip locked
  loop
    perform public.attempt_early_dispatch_internal(candidate_order.id);
  end loop;

  for candidate_order in
    select id from public.orders
    where order_type = 'DELIVERY' and status = 'READY' and assigned_driver_id is null
    order by ready_at asc, id asc
    limit batch_limit
    for update skip locked
  loop
    perform public.dispatch_ready_order_internal(candidate_order.id);
  end loop;
end;
$$;
revoke all on function public.attempt_dispatch_sweep_internal() from public, anon, authenticated, service_role;

-- confirm_existing_assignment_on_ready_internal: reuses an already-early-
-- assigned driver once the order naturally reaches READY -- just flips
-- orders.status READY->DRIVER_ASSIGNED (the existing, unchanged
-- assert_transition edge), no new search.
create or replace function public.confirm_existing_assignment_on_ready_internal(p_order_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare o public.orders;
begin
  select * into o from public.orders where id = p_order_id for update;
  if not found or o.assigned_driver_id is null then return; end if;
  perform public.assert_transition(o.status, 'DRIVER_ASSIGNED');
  update public.orders set status = 'DRIVER_ASSIGNED' where id = p_order_id;
  insert into public.order_events(order_id, actor_type, actor_id, previous_status, new_status)
  values (p_order_id, 'SYSTEM', 'system', o.status, 'DRIVER_ASSIGNED');
end;
$$;
revoke all on function public.confirm_existing_assignment_on_ready_internal(uuid) from public, anon, authenticated, service_role;

-- maybe_advance_batch_ready_to_depart_internal: a batch still OPEN moves
-- to READY_TO_DEPART the moment there is nothing left to wait for --
-- either every currently-attached member has reached READY/DRIVER_ASSIGNED
-- on its own, or evaluate_batch_actual_wait_internal has just detached
-- every member that wasn't ready in time. Idempotent (only acts on
-- status='OPEN'), so it's safe to call from multiple sites.
create or replace function public.maybe_advance_batch_ready_to_depart_internal(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.pickup_batches set status = 'READY_TO_DEPART'
  where id = p_batch_id
    and status = 'OPEN'
    and exists(select 1 from public.orders where pickup_batch_id = p_batch_id)
    and not exists(
      -- Positive form deliberately, not "not in (READY,DRIVER_ASSIGNED)":
      -- a member already PICKED_UP/ON_THE_WAY/ARRIVED (the driver has
      -- already departed with it) must never be treated as "blocking"
      -- readiness -- only a member still genuinely cooking is.
      select 1 from public.orders
      where pickup_batch_id = p_batch_id and status in ('CONFIRMED','PREPARING')
    );
end;
$$;
revoke all on function public.maybe_advance_batch_ready_to_depart_internal(uuid) from public, anon, authenticated, service_role;

-- evaluate_batch_actual_wait_internal: lazy, no cron -- run whenever a
-- driver marks any batched order PICKED_UP. Once the actual-wait
-- threshold (since the batch's first member became READY) has elapsed,
-- any OTHER batch member that still isn't READY is fully released, not
-- just unbatched: its assignment to the now-departing driver is closed
-- (driver_assignments ended as SUPERSEDED, capacity freed) and it is
-- immediately put back through the same server-authoritative early-
-- dispatch search every other order uses -- a driver who has already left
-- with another delivery must never keep silent ownership of an order they
-- cannot actually service. Falls back to a standby notice if redispatch
-- also finds nobody eligible right now (mirrors the CONFIRMED-time
-- call site's own fallback), and the whole redispatch attempt is
-- exception-safe so one stuck order can never block the driver's own
-- PICKED_UP transition that triggered this.
create or replace function public.evaluate_batch_actual_wait_internal(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  b public.pickup_batches;
  max_wait integer;
  stale_order record;
  departing_driver uuid;
begin
  select * into b from public.pickup_batches where id = p_batch_id for update;
  if not found or b.first_member_ready_at is null then return; end if;
  select max_batch_actual_wait_minutes into max_wait from public.delivery_settings where id = true;
  if now() - b.first_member_ready_at <= (coalesce(max_wait, 5) || ' minutes')::interval then return; end if;

  departing_driver := b.driver_id;

  for stale_order in
    -- Positive form deliberately: CONFIRMED/PREPARING means "still
    -- genuinely cooking, not yet ready" -- the one and only condition
    -- that makes a member "stale/delayed". A negative "not in
    -- (READY,DRIVER_ASSIGNED)" form would also match PICKED_UP/
    -- ON_THE_WAY/ARRIVED, incorrectly catching the very order that
    -- triggered this evaluation (already PICKED_UP by the time this
    -- runs) and releasing the departing driver's OWN order out from
    -- under them.
    select id from public.orders where pickup_batch_id = p_batch_id and status in ('CONFIRMED','PREPARING')
  loop
    update public.driver_assignments set ended_at = now(), status = 'SUPERSEDED'
    where order_id = stale_order.id and driver_id = departing_driver and ended_at is null;
    if public.driver_active_assignment_count(departing_driver) <= 1 then
      update public.drivers set availability = 'AVAILABLE' where id = departing_driver;
    end if;
    update public.orders set assigned_driver_id = null, assignment_accepted_at = null, pickup_batch_id = null, stop_sequence = null
    where id = stale_order.id;
    insert into public.order_events(order_id, actor_type, actor_id, previous_status, new_status, notes)
    select id, 'SYSTEM', 'system', status, status, 'BATCH_ACTUAL_WAIT_EXCEEDED_DRIVER_DEPARTED'
    from public.orders where id = stale_order.id;
    begin
      if not public.attempt_early_dispatch_internal(stale_order.id, departing_driver) then
        perform public.attempt_driver_standby_notice_internal(stale_order.id);
      end if;
    exception when others then
      raise warning 'redispatch after actual-wait release failed for order %: %', stale_order.id, sqlerrm;
    end;
  end loop;

  perform public.maybe_advance_batch_ready_to_depart_internal(p_batch_id);
end;
$$;
revoke all on function public.evaluate_batch_actual_wait_internal(uuid) from public, anon, authenticated, service_role;

-- compute_batch_stop_sequence_internal: computed once, the moment the
-- first member of a batch is marked PICKED_UP, ordering all still-
-- attached members by delivery_distance_km ascending (nearest-to-
-- restaurant-first). No real routing/travel-time provider exists
-- anywhere in this codebase (verified) -- this is the honest phase-1
-- heuristic, not a silent substitute for real routing.
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
    order by ca.delivery_distance_km asc nulls last, o.id asc
  loop
    update public.orders set stop_sequence = seq where id = member.id;
    seq := seq + 1;
  end loop;
end;
$$;
revoke all on function public.compute_batch_stop_sequence_internal(uuid) from public, anon, authenticated, service_role;

-- ============================================================
-- transition_order: reproduced from 20260814500000, with the targeted
-- additions described above. Every unrelated line is byte-identical.
-- ============================================================
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
    -- Availability fix: only mark AVAILABLE once this driver genuinely
    -- holds zero active assignments -- unconditional before this
    -- migration, harmless only because capacity was always 1.
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

-- ============================================================
-- decline_assignment: reproduced from 20260813400000 with a new early-
-- decline branch (order.status still CONFIRMED/PREPARING, never reached
-- READY) alongside the byte-identical classic path (order.status=
-- DRIVER_ASSIGNED).
-- ============================================================
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
  if o.status not in ('DRIVER_ASSIGNED','CONFIRMED','PREPARING') then
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

  if public.driver_active_assignment_count(a.driver_id) = 0 then
    update public.drivers set availability = 'AVAILABLE' where id = a.driver_id;
  end if;

  if o.status = 'DRIVER_ASSIGNED' then
    -- Classic path -- byte-identical to the pre-batching behavior.
    update public.orders set assigned_driver_id = null, assignment_accepted_at = null, pickup_batch_id = null, status = 'READY' where id = p_order_id;
    insert into public.order_events(order_id, actor_type, actor_id, previous_status, new_status)
    values (p_order_id, 'DRIVER', auth.uid()::text, 'DRIVER_ASSIGNED', 'READY');
    begin
      perform public.dispatch_ready_order_internal(p_order_id, a.driver_id);
    exception when others then
      raise warning 'redispatch after decline failed for order %: %', p_order_id, sqlerrm;
    end;
  else
    -- Early-decline path: the order never reached READY, so status is
    -- left untouched -- only the (early) assignment/batch membership is
    -- cleared, and the retry sweep is asked to find a replacement now.
    update public.orders set assigned_driver_id = null, assignment_accepted_at = null, pickup_batch_id = null where id = p_order_id;
    insert into public.order_events(order_id, actor_type, actor_id, previous_status, new_status, notes)
    values (p_order_id, 'DRIVER', auth.uid()::text, o.status, o.status, 'EARLY_ASSIGNMENT_DECLINED');
    begin
      if not public.attempt_early_dispatch_internal(p_order_id, a.driver_id) then
        perform public.attempt_driver_standby_notice_internal(p_order_id);
      end if;
    exception when others then
      raise warning 'redispatch after early decline failed for order %: %', p_order_id, sqlerrm;
    end;
  end if;

  return a;
end;
$$;
revoke all on function public.decline_assignment(uuid, public.assignment_decline_reason) from public, anon, authenticated, service_role;
grant execute on function public.decline_assignment(uuid, public.assignment_decline_reason) to authenticated;

-- list_my_standby_notices: widen the read-side filter to match the new,
-- earlier firing point. 20260814600000 (Driver UI Phase) wrote this
-- function when a standby notice could only ever exist while an order was
-- PREPARING (the old model's only "no eligible driver" moment). Multi-Order
-- Dispatch now fires the notice as early as CONFIRMED (assign-at-ACCEPT
-- failing to find an eligible driver), so a driver genuinely waiting on a
-- CONFIRMED order was invisible to their own standby list even though the
-- notice row existed. `create or replace` on the existing function,
-- consistent with this project's additive-only migration convention.
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
    where o.status in ('CONFIRMED', 'PREPARING')
      and n.branch_id in (select db.branch_id from public.driver_branches db where db.driver_id = auth.uid())
    order by n.created_at asc;
end $$;
revoke all on function public.list_my_standby_notices() from public, anon, authenticated, service_role;
grant execute on function public.list_my_standby_notices() to authenticated;

-- attempt_driver_standby_notice_internal: widen the broadcast condition to
-- match the new audience. 20260814500000 only ever broadcast when
-- eligible_count > 0 ("nobody eligible -> nobody to usefully signal") --
-- correct under the old PREPARING-only model, where a standby notice's
-- only real audience was a driver who could immediately pick the order up.
-- Multi-Order Dispatch now also fires this notice as early as CONFIRMED,
-- specifically for the case where assign-at-ACCEPT found nobody eligible
-- -- and a driver who is genuinely ON_SHIFT but currently PAUSED (not
-- counted in eligible_count, which requires dispatch_status='ACTIVE') is
-- exactly the kind of driver who should still see that demand is waiting,
-- so they can decide to resume. The stored eligible_driver_count column
-- (staff analytics: "how often did we have nobody available") is
-- unchanged -- only the broadcast trigger widens to "is anyone at all
-- on shift in this branch pool who could see it."
create or replace function public.attempt_driver_standby_notice_internal(p_order_id uuid)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare target_branch uuid; eligible_count integer; on_shift_count integer;
begin
  select branch_id into target_branch from public.orders where id=p_order_id;
  select count(*) into eligible_count
  from public.drivers d
  where d.shift_status='ON_SHIFT'
    and d.dispatch_status='ACTIVE'
    and public.driver_active_assignment_count(d.id) < d.delivery_capacity
    and (target_branch is null or exists(select 1 from public.driver_branches db where db.driver_id=d.id and db.branch_id=target_branch));
  select count(*) into on_shift_count
  from public.drivers d
  where d.shift_status='ON_SHIFT'
    and (target_branch is null or exists(select 1 from public.driver_branches db where db.driver_id=d.id and db.branch_id=target_branch));
  insert into public.driver_standby_notices(order_id, branch_id, eligible_driver_count)
  values(p_order_id, target_branch, eligible_count)
  on conflict(order_id) do nothing;
  if on_shift_count > 0 then
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
