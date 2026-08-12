-- Restaurant Telegram notification, v1: durable outbox pattern, so a
-- Telegram/Edge-Function outage can never block or slow down order
-- creation. order creation succeeds -> a durable notification_outbox row
-- is written in the SAME transaction (fast, local, no network) -> a
-- trigger attempts an async dispatch (net.http_post, decoupled, outside
-- this transaction) -> the zaytun-telegram-notify function marks the row
-- SENT/FAILED. The enqueue step itself is exception-safe, so even a bug
-- there can never break order creation.
--
-- Branch-aware from day one: branches.notification_chat_id lets a future
-- branch have its own staff chat; unset (the only state today) falls back
-- to the single TELEGRAM_RESTAURANT_CHAT_ID secret, resolved inside the
-- Edge Function, not here.

alter table public.branches add column notification_chat_id text;

create table public.notification_outbox(
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  channel text not null,
  status text not null default 'PENDING' check(status in ('PENDING','SENT','FAILED')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique(order_id, channel)
);
create index notification_outbox_pending_idx on public.notification_outbox(created_at) where status = 'PENDING';

alter table public.notification_outbox enable row level security;
create policy notification_outbox_read on public.notification_outbox for select to authenticated
  using(public.is_staff());
revoke all on public.notification_outbox from public, anon, authenticated;
grant select on public.notification_outbox to authenticated;

-- pg_net: Supabase's own async-HTTP extension, the standard mechanism for
-- exactly this "DB trigger fires an outbound webhook without blocking the
-- calling transaction" pattern. Enabling it changes no existing behavior
-- by itself -- it only adds functions. pg_net's control file fixes its
-- own schema (net) -- unlike most extensions, it cannot be relocated via
-- `with schema`, so it's created with its default placement here.
create extension if not exists pg_net;

-- Enqueue: fires on every new order (delivery or pickup -- restaurant
-- staff need to know about both). Never blocks/fails order creation --
-- the whole body is wrapped in a nested exception block (an implicit
-- savepoint), so even a bug here can't roll back the INSERT that already
-- committed. `on conflict do nothing` on (order_id, channel) makes this
-- naturally idempotent: a checkout retry never reaches this trigger twice
-- for the same order anyway (create_order_internal's own idempotency-key
-- short-circuit returns early before a second INSERT), but the
-- constraint is a second, independent layer of duplicate protection.
create or replace function public.enqueue_new_order_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  begin
    insert into public.notification_outbox(order_id, channel)
    values (new.id, 'TELEGRAM_RESTAURANT_NEW_ORDER')
    on conflict (order_id, channel) do nothing;
  exception when others then
    raise warning 'failed to enqueue notification for order %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;
create trigger orders_enqueue_notification after insert on public.orders
  for each row execute function public.enqueue_new_order_notification();

-- Dispatch: attempts an async HTTP call to zaytun-telegram-notify via
-- pg_net (which queues the request and returns immediately -- the actual
-- network call happens in pg_net's own background worker, fully outside
-- this transaction). Inert by default: current_setting(..., true) returns
-- null when the two custom GUCs below are unset, which they are in every
-- environment until a human explicitly configures them (see the final
-- report for exactly what that requires) -- so this trigger safely no-ops
-- everywhere until deliberately activated, never partially/silently wired.
create or replace function public.dispatch_notification_via_pg_net()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, net
as $$
declare
  function_url text := current_setting('app.settings.telegram_notify_url', true);
  shared_secret text := current_setting('app.settings.telegram_notify_secret', true);
begin
  if new.status <> 'PENDING' or coalesce(function_url, '') = '' or coalesce(shared_secret, '') = '' then
    return new;
  end if;
  begin
    perform net.http_post(
      url := function_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || shared_secret),
      body := jsonb_build_object('outboxId', new.id)
    );
  exception when others then
    raise warning 'failed to dispatch notification % via pg_net: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;
create trigger notification_outbox_dispatch after insert on public.notification_outbox
  for each row execute function public.dispatch_notification_via_pg_net();
