-- Smart Dispatch v1: driver-eligibility redispatch sweep.
--
-- Bug found via production investigation: attempt_dispatch_sweep_internal()
-- (20260812180000) is only ever invoked from transition_order(), on an
-- ORDER becoming READY or reaching a terminal state. Nothing calls it when
-- a DRIVER transitions into eligibility. So a DELIVERY order that reached
-- READY while no driver was eligible stays stuck, unassigned, until some
-- unrelated order elsewhere happens to transition and incidentally
-- triggers a sweep that scans the whole waiting queue -- never because the
-- driver who just became available made it dispatchable. This violates the
-- intended invariant: a driver moving into (ON_SHIFT, ACTIVE) must attempt
-- to clear the waiting queue for branches it belongs to, with no
-- restaurant action required.
--
-- Fix: start_shift and resume_dispatch are the only two RPCs that can move
-- a driver INTO eligibility (shift_status='ON_SHIFT' AND
-- dispatch_status='ACTIVE') -- end_shift and pause_dispatch only ever move
-- a driver OUT of eligibility, which can never make a waiting order newly
-- dispatchable, so they are deliberately left untouched. Both fixed RPCs
-- gain the exact same exception-safe sweep call transition_order already
-- uses: wrapped in its own nested block so a sweep failure can never roll
-- back the driver-state UPDATE that already committed earlier in the same
-- function. Every other line is reproduced byte-identical from
-- 20260812160000.
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
  begin
    perform public.attempt_dispatch_sweep_internal();
  exception when others then
    raise warning 'dispatch sweep failed after driver % started shift: %', d.id, sqlerrm;
  end;
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
  begin
    perform public.attempt_dispatch_sweep_internal();
  exception when others then
    raise warning 'dispatch sweep failed after driver % resumed dispatch: %', d.id, sqlerrm;
  end;
  return d;
end;
$$;

revoke execute on function public.start_shift(), public.resume_dispatch() from public, anon;
grant execute on function public.start_shift(), public.resume_dispatch() to authenticated;
