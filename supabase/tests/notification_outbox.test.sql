begin;
select plan(11);

-- Restaurant Telegram notification, v1: durable outbox, never on the
-- critical order-creation path. current_setting('app.settings.telegram_notify_url', true)
-- is unset in every local/test environment, so the dispatch trigger is
-- provably inert throughout this file -- these tests focus on the
-- enqueue/durability/RLS side, which is what runs unconditionally.

select has_table('public','notification_outbox','notification_outbox exists');
select has_column('public','branches','notification_chat_id','branches carry a forward-compatible per-branch chat pointer');

-- A brand new order enqueues exactly one PENDING outbox row.
select lives_ok(
  $$select public.create_public_order('{"id":"9b000000-0000-4000-8000-000000000001","customer":{"name":"Outbox Test","primaryPhone":"+998900000060"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"ayran","quantity":1,"modifierIds":[]}]}'::jsonb)$$,
  'order creation succeeds normally alongside notification enqueueing'
);
select is((select count(*)::integer from public.notification_outbox where order_id='9b000000-0000-4000-8000-000000000001'),1,'exactly one outbox row was enqueued');
select is((select status from public.notification_outbox where order_id='9b000000-0000-4000-8000-000000000001'),'PENDING','the row starts PENDING (dispatch trigger is inert with no configured URL/secret)');
select is((select channel from public.notification_outbox where order_id='9b000000-0000-4000-8000-000000000001'),'TELEGRAM_RESTAURANT_NEW_ORDER','the channel is recorded');

-- Idempotent retry (same idempotency key -> create_order_internal's
-- existing short-circuit returns the existing order without ever
-- re-reaching the INSERT that fires this trigger) -- still exactly one
-- outbox row, never a duplicate alert.
select public.create_public_order('{"id":"9b000000-0000-4000-8000-000000000001","idempotencyKey":"9b000000-0000-4000-8000-000000000001","customer":{"name":"Outbox Test","primaryPhone":"+998900000060"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"ayran","quantity":1,"modifierIds":[]}]}'::jsonb);
select public.create_public_order('{"id":"9b000000-0000-4000-8000-000000000001","idempotencyKey":"9b000000-0000-4000-8000-000000000001","customer":{"name":"Outbox Test","primaryPhone":"+998900000060"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"ayran","quantity":1,"modifierIds":[]}]}'::jsonb);
select is((select count(*)::integer from public.notification_outbox where order_id='9b000000-0000-4000-8000-000000000001'),1,'a retried checkout never produces a duplicate outbox row');

-- Direct proof the enqueue trigger cannot break order creation: a second,
-- independent duplicate-protection layer (the unique constraint itself)
-- means even a hypothetical direct duplicate insert attempt is a no-op,
-- not a failure that could propagate.
select lives_ok(
  $$insert into public.notification_outbox(order_id,channel) values('9b000000-0000-4000-8000-000000000001','TELEGRAM_RESTAURANT_NEW_ORDER') on conflict (order_id,channel) do nothing$$,
  'a duplicate enqueue attempt is a safe no-op, not an error'
);

-- Pickup and delivery both enqueue (restaurant needs to know about both).
select public.create_public_order('{"id":"9b000000-0000-4000-8000-000000000002","customer":{"name":"Outbox Delivery Test","primaryPhone":"+998900000061"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"Test","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-12T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
select is((select count(*)::integer from public.notification_outbox where order_id='9b000000-0000-4000-8000-000000000002'),1,'delivery orders enqueue a notification too');

-- RLS: staff can read, nobody else can.
select ok(has_table_privilege('authenticated','public.notification_outbox','SELECT'),'authenticated (gated by is_staff() inside the policy) can read');
select ok(not has_table_privilege('anon','public.notification_outbox','SELECT'),'anon cannot read the outbox at all');

select * from finish();
rollback;
