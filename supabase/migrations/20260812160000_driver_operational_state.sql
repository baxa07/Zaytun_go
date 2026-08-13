-- Smart Dispatch v1, Phase 1: Driver Operational State.
--
-- Splits today's single, conflated drivers.availability (AVAILABLE|BUSY|
-- OFFLINE) into three orthogonal, purpose-built concepts:
--   shift_status    -- driver-controlled: am I working right now at all?
--   dispatch_status -- driver-controlled: should I receive NEW assignments
--                      right now (break/vehicle issue/operational pause)?
--   delivery_capacity + derived active_assignment_count -- workload.
--
-- This migration is purely additive: it does not touch assign_driver or
-- transition_order, and nothing yet reads these new columns for any
-- assignment decision -- that wiring happens in Phase 3, at which point
-- assign_driver/transition_order stop writing to `availability` too, so
-- there is never a moment where two columns simultaneously claim to be
-- authoritative for the same decision. `availability` is left in place,
-- untouched and still fully authoritative for manual assignment through
-- Phase 2, and is only dropped in a later cleanup migration once the new
-- model has run cleanly in production for a verification window.

create type public.driver_shift_status as enum ('OFF_SHIFT','ON_SHIFT');
create type public.driver_dispatch_status as enum ('ACTIVE','PAUSED');

alter table public.drivers
  add column shift_status public.driver_shift_status not null default 'OFF_SHIFT',
  add column dispatch_status public.driver_dispatch_status not null default 'ACTIVE',
  add column delivery_capacity integer not null default 1 check(delivery_capacity > 0);

-- One-time backfill from the existing `availability` value, run once as
-- every existing driver gets the new columns. From this point on nothing
-- writes to `availability` based on shift_status/dispatch_status, and
-- nothing derives shift_status/dispatch_status from `availability` --
-- the two are independent from here forward.
--
-- Production-safety principle: this migration creates the *capability*
-- for automatic dispatch -- it must never itself grant *operational*
-- eligibility to a driver nobody has explicitly reviewed for this new
-- system. shift_status still mirrors each driver's own pre-migration
-- availability (a purely informational carry-over, not an eligibility
-- grant), but dispatch_status -- the field assign_driver_internal and
-- select_best_driver_internal both actually gate on, for AUTO and MANUAL
-- assignment alike -- is backfilled PAUSED for every pre-existing driver,
-- unconditionally, regardless of their prior availability. A driver only
-- becomes dispatch-active again via a deliberate, explicit owner action
-- after migration (`update drivers set dispatch_status='ACTIVE' where
-- id=...`), never merely because this migration ran. New drivers created
-- after this migration (real provisioning, or `supabase/seed.sql` for
-- local/test environments that need an already-active fixture) are
-- unaffected by this backfill and set dispatch_status explicitly at
-- INSERT time, as they already do.
update public.drivers set
  shift_status = case when availability = 'OFFLINE' then 'OFF_SHIFT'::public.driver_shift_status else 'ON_SHIFT'::public.driver_shift_status end,
  dispatch_status = 'PAUSED'::public.driver_dispatch_status;

-- Never stored: active workload is always counted live from
-- driver_assignments, so it can never drift out of sync with reality.
create or replace function public.driver_active_assignment_count(p_driver_id uuid)
returns integer
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select count(*)::integer from public.driver_assignments
  where driver_id = p_driver_id and ended_at is null
$$;
revoke all on function public.driver_active_assignment_count(uuid) from public, anon, authenticated;

-- All four RPCs are strictly self-service: no order/driver id parameter --
-- a driver can only ever modify their own row (auth.uid()), never another
-- driver's.
create or replace function public.start_shift()
returns public.drivers
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare d public.drivers;
begin
  if public.current_app_role() is distinct from 'DRIVER' then
    raise exception 'DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi' using errcode = '42501';
  end if;
  update public.drivers set shift_status = 'ON_SHIFT', dispatch_status = 'ACTIVE'
  where id = auth.uid()
  returning * into d;
  if not found then
    raise exception 'DRIVER_NOT_FOUND|Haydovchi topilmadi' using errcode = '22023';
  end if;
  return d;
end;
$$;

create or replace function public.end_shift()
returns public.drivers
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare d public.drivers;
begin
  if public.current_app_role() is distinct from 'DRIVER' then
    raise exception 'DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi' using errcode = '42501';
  end if;
  if public.driver_active_assignment_count(auth.uid()) > 0 then
    raise exception 'ACTIVE_ASSIGNMENTS_EXIST|Faol yetkazishlar tugagach ishni tugating' using errcode = '42501';
  end if;
  update public.drivers set shift_status = 'OFF_SHIFT'
  where id = auth.uid()
  returning * into d;
  if not found then
    raise exception 'DRIVER_NOT_FOUND|Haydovchi topilmadi' using errcode = '22023';
  end if;
  return d;
end;
$$;

create or replace function public.pause_dispatch()
returns public.drivers
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare d public.drivers;
begin
  if public.current_app_role() is distinct from 'DRIVER' then
    raise exception 'DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi' using errcode = '42501';
  end if;
  update public.drivers set dispatch_status = 'PAUSED'
  where id = auth.uid() and shift_status = 'ON_SHIFT'
  returning * into d;
  if not found then
    raise exception 'NOT_ON_SHIFT|Avval ishni boshlang' using errcode = '42501';
  end if;
  return d;
end;
$$;

create or replace function public.resume_dispatch()
returns public.drivers
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare d public.drivers;
begin
  if public.current_app_role() is distinct from 'DRIVER' then
    raise exception 'DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi' using errcode = '42501';
  end if;
  update public.drivers set dispatch_status = 'ACTIVE'
  where id = auth.uid() and shift_status = 'ON_SHIFT'
  returning * into d;
  if not found then
    raise exception 'NOT_ON_SHIFT|Avval ishni boshlang' using errcode = '42501';
  end if;
  return d;
end;
$$;

revoke execute on function public.start_shift(), public.end_shift(), public.pause_dispatch(), public.resume_dispatch()
  from public, anon;
grant execute on function public.start_shift(), public.end_shift(), public.pause_dispatch(), public.resume_dispatch()
  to authenticated;
