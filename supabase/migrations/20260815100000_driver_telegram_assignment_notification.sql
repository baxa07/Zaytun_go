-- Phase D, Part D/E: Telegram fallback for a new driver assignment,
-- exactly the same durable outbox pattern already proven by the
-- restaurant new-order notification (20260812190000) -- an assignment
-- INSERT enqueues a row in the SAME transaction (fast, local, no
-- network), a trigger attempts an async pg_net dispatch (decoupled,
-- outside this transaction), and the existing zaytun-telegram-notify
-- function marks it SENT/FAILED. Telegram failure can never block or
-- slow down assignment -- the enqueue step is exception-safe, same as
-- the existing new-order trigger.
--
-- Driver -> Telegram chat mapping: a simple, nullable, server-managed
-- column (matches branches.notification_chat_id's own precedent) --
-- never a frontend value, never invented. Unconfigured is a normal,
-- expected state at rollout: the driver's own in-app sound/UI already
-- works regardless, and the notify function safely no-ops (logs
-- "nothing_to_send", never an error) when it finds no chat id.
alter table public.drivers add column telegram_chat_id text;

-- Per-assignment idempotency without a schema change to
-- notification_outbox: the assignment's own id is embedded directly in
-- the channel string, so the existing unique(order_id, channel)
-- constraint scopes naturally to "this specific assignment," not just
-- "this order" -- a later reassignment of the same order (decline,
-- supersede) is a NEW driver_assignments row with a NEW id, and
-- correctly gets its own notification to the newly assigned driver,
-- while a genuine retry of the exact same INSERT event (same id) is
-- deduplicated by the same constraint the new-order trigger already
-- relies on.
create or replace function public.enqueue_new_assignment_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  begin
    insert into public.notification_outbox(order_id, channel)
    values (new.order_id, 'TELEGRAM_DRIVER_NEW_ASSIGNMENT:' || new.id)
    on conflict (order_id, channel) do nothing;
  exception when others then
    raise warning 'failed to enqueue assignment notification for assignment %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;
create trigger driver_assignments_enqueue_notification after insert on public.driver_assignments
  for each row execute function public.enqueue_new_assignment_notification();
