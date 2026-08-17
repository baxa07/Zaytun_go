-- Run only after final launch approval and after verifying the external backup.
-- Required invocation: psql ... -v cleanup_approved=YES -f scripts/production-test-history-cleanup.sql
\set ON_ERROR_STOP on
\if :{?cleanup_approved}
\else
  \echo 'Missing cleanup_approved. No changes made.'
  \quit
\endif
select :'cleanup_approved' = 'YES' as approved \gset
\if :approved
\else
  \echo 'cleanup_approved must be YES. No changes made.'
  \quit
\endif

begin;
lock table public.orders in share row exclusive mode;

create temp table cleanup_orders on commit drop as
select id,number,pickup_batch_id
from public.orders
where created_at <= timestamptz '2026-08-17 14:24:46.971088+00';

do $$ begin
  if (select count(*) from cleanup_orders) <> 44 then
    raise exception 'Cleanup scope changed: expected exactly 44 orders, found %',(select count(*) from cleanup_orders);
  end if;
  if exists(select 1 from cleanup_orders where number not between 'ZG-1043' and 'ZG-1087') then
    raise exception 'Cleanup scope contains an unexpected order number';
  end if;
end $$;

create temp table cleanup_batches on commit drop as
select distinct pickup_batch_id id from cleanup_orders where pickup_batch_id is not null;

-- All other order-domain children are ON DELETE CASCADE. Assignment history
-- deliberately uses NO ACTION, so it is removed explicitly first.
delete from public.driver_assignments where order_id in(select id from cleanup_orders);
delete from public.orders where id in(select id from cleanup_orders);
delete from public.pickup_batches where id in(select id from cleanup_batches)
  and not exists(select 1 from public.orders where pickup_batch_id=pickup_batches.id);

do $$ begin
  if exists(select 1 from public.orders where id in(select id from cleanup_orders)) then
    raise exception 'Cleanup verification failed: target orders remain';
  end if;
  if exists(select 1 from public.driver_assignments a left join public.orders o on o.id=a.order_id where o.id is null) then
    raise exception 'Cleanup verification failed: dangling driver assignment';
  end if;
end $$;

-- Intentionally do not reset order_number_seq here. Launch numbering is a
-- product decision: continuing at the next value is safest; restarting at
-- ZG-1043 requires explicit approval and a separate reviewed setval.
commit;
