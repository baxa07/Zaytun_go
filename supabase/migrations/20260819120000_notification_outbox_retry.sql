-- Durable retry for outbound Telegram notifications. Assignment creation
-- and lifecycle transitions remain independent of Telegram: failures stay
-- in the outbox and are retried server-side without any browser/realtime
-- client being present.

alter table public.notification_outbox
  add column last_attempt_at timestamptz,
  add column next_attempt_at timestamptz;

create index notification_outbox_retry_idx
  on public.notification_outbox(next_attempt_at)
  where status = 'FAILED';

create or replace function public.mark_notification_delivery_failed(
  p_outbox_id uuid,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.notification_outbox
  set status = 'FAILED',
      attempts = attempts + 1,
      last_error = left(coalesce(p_error, 'delivery_error'), 500),
      last_attempt_at = now(),
      next_attempt_at = case
        when attempts + 1 >= 5 then null
        else now() + make_interval(secs => least(300, 15 * (2 ^ attempts))::integer)
      end
  where id = p_outbox_id and status <> 'SENT';
end;
$$;

revoke all on function public.mark_notification_delivery_failed(uuid,text) from public, anon, authenticated;
grant execute on function public.mark_notification_delivery_failed(uuid,text) to service_role;

-- Updating a due FAILED row back to PENDING is the retry signal. The same
-- pg_net dispatcher used for the initial insert handles it; the outbox's
-- unique(order_id, channel) key remains the exactly-once intent boundary.
drop trigger if exists notification_outbox_retry_dispatch on public.notification_outbox;
create trigger notification_outbox_retry_dispatch
  after update of status on public.notification_outbox
  for each row
  when (old.status = 'FAILED' and new.status = 'PENDING')
  execute function public.dispatch_notification_via_pg_net();

create or replace function public.retry_due_notification_outbox()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  retried integer;
begin
  with due as (
    select id
    from public.notification_outbox
    where status = 'FAILED'
      and attempts < 5
      and next_attempt_at <= now()
    order by next_attempt_at
    limit 50
    for update skip locked
  )
  update public.notification_outbox o
  set status = 'PENDING', next_attempt_at = null
  from due
  where o.id = due.id;
  get diagnostics retried = row_count;
  return retried;
end;
$$;

revoke all on function public.retry_due_notification_outbox() from public, anon, authenticated;
grant execute on function public.retry_due_notification_outbox() to service_role;

create extension if not exists pg_cron;
do $$
begin
  if exists(select 1 from cron.job where jobname = 'zaytun-notification-outbox-retry') then
    perform cron.unschedule('zaytun-notification-outbox-retry');
  end if;
  perform cron.schedule(
    'zaytun-notification-outbox-retry',
    '* * * * *',
    'select public.retry_due_notification_outbox()'
  );
end;
$$;
