begin;
select plan(7);

-- Phase D, Part D/E: a driver_assignments INSERT enqueues exactly one
-- durable notification_outbox row, keyed to that SPECIFIC assignment (its
-- own id embedded in the channel string), never just "this order" --
-- proven below by a reassignment producing a second, distinct row rather
-- than being silently swallowed by the (order_id, channel) uniqueness
-- constraint. Dispatch itself is untested here (telegram_notify_url/
-- secret are unset in every local/test environment, same inert-by-default
-- reasoning as notification_outbox.test.sql).

select has_column('public','drivers','telegram_chat_id','drivers carry a nullable, server-managed Telegram chat mapping');

insert into public.branches(id,name,slug,address,latitude,longitude,active)
values ('9e000000-0000-4000-8000-0000000000e1','Zaytun Telegram Test Branch','telegram-notify-phase','Test',40.12,65.43,true);
delete from public.driver_branches where driver_id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
insert into public.driver_branches(driver_id,branch_id) values
  ('10000000-0000-0000-0000-000000000003','9e000000-0000-4000-8000-0000000000e1'),
  ('10000000-0000-0000-0000-000000000004','9e000000-0000-4000-8000-0000000000e1');
update public.drivers set shift_status='ON_SHIFT',dispatch_status='ACTIVE',availability='AVAILABLE'
  where id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');
-- Only ...003 eligible at first -- deterministic first pick.
update public.drivers set dispatch_status='PAUSED' where id='10000000-0000-0000-0000-000000000004';

select public.create_public_order(jsonb_build_object(
  'id','9e000000-0000-4000-8000-0000000000e2','customer',jsonb_build_object('name','Telegram Notify Test','primaryPhone','+998900000070'),
  'type','DELIVERY','paymentMethod','CASH',
  'items',jsonb_build_array(jsonb_build_object('menuItemId','plov','quantity',1,'modifierIds','[]'::jsonb)),
  'address',jsonb_build_object('district','Navoiy','street','Test','latitude',40.09,'longitude',65.40,'pinConfirmedAt','2026-08-15T08:00:00Z','locationProvider','mock')
));
update public.orders set branch_id='9e000000-0000-4000-8000-0000000000e1' where id='9e000000-0000-4000-8000-0000000000e2';
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select public.review_delivery_request('9e000000-0000-4000-8000-0000000000e2'::uuid,true,null);
select public.transition_order('9e000000-0000-4000-8000-0000000000e2'::uuid,'CONFIRMED',null,null); -- real assignment happens here, at ACCEPT
reset role;

select is(
  (select count(*)::integer from public.notification_outbox where order_id='9e000000-0000-4000-8000-0000000000e2' and channel like 'TELEGRAM_DRIVER_NEW_ASSIGNMENT:%'),
  1,
  'exactly one driver-assignment notification is enqueued for the new assignment'
);
select is(
  (select channel from public.notification_outbox where order_id='9e000000-0000-4000-8000-0000000000e2' and channel like 'TELEGRAM_DRIVER_NEW_ASSIGNMENT:%'),
  'TELEGRAM_DRIVER_NEW_ASSIGNMENT:' || (select id::text from public.driver_assignments where order_id='9e000000-0000-4000-8000-0000000000e2' and ended_at is null),
  'the channel identity is this SPECIFIC assignment, not just the order'
);

-- A duplicate enqueue attempt for the exact same assignment is a safe
-- no-op (same second, independent duplicate-protection layer as the
-- existing new-order trigger).
select lives_ok(
  $$insert into public.notification_outbox(order_id,channel) values(
    '9e000000-0000-4000-8000-0000000000e2',
    'TELEGRAM_DRIVER_NEW_ASSIGNMENT:' || (select id::text from public.driver_assignments where order_id='9e000000-0000-4000-8000-0000000000e2' and ended_at is null)
  ) on conflict (order_id,channel) do nothing$$,
  'a duplicate enqueue attempt for the same assignment is a safe no-op, not an error'
);

-- Now bring the second driver online and decline the first assignment
-- (early-decline path) -- redispatch immediately reassigns to the other
-- eligible driver, a genuinely NEW driver_assignments row with its own
-- id. This must enqueue a SECOND, DISTINCT notification -- proving the
-- (order_id, channel) uniqueness scopes to the assignment, not the order,
-- so the newly assigned driver is never silently left unnotified because
-- "this order already has a notification."
update public.drivers set dispatch_status='ACTIVE' where id='10000000-0000-0000-0000-000000000004';
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select public.decline_assignment('9e000000-0000-4000-8000-0000000000e2'::uuid,'TOO_FAR');
reset role;

select is(
  (select assigned_driver_id from public.orders where id='9e000000-0000-4000-8000-0000000000e2'),
  '10000000-0000-0000-0000-000000000004'::uuid,
  'redispatch reassigned to the other eligible driver'
);
select is(
  (select count(*)::integer from public.notification_outbox where order_id='9e000000-0000-4000-8000-0000000000e2' and channel like 'TELEGRAM_DRIVER_NEW_ASSIGNMENT:%'),
  2,
  'the reassignment enqueues a SECOND, distinct notification -- one per assignment, not capped at one per order'
);

-- Assignment creation itself must never depend on notification plumbing
-- succeeding -- confirmed structurally: the assignment/redispatch above
-- already completed normally with no telegram_notify_url/secret
-- configured in this test environment at all.
select ok(
  (select assigned_driver_id from public.orders where id='9e000000-0000-4000-8000-0000000000e2') is not null,
  'the order genuinely has a real, active assignment regardless of notification delivery'
);

update public.orders set status='CANCELLED' where id='9e000000-0000-4000-8000-0000000000e2';
update public.driver_assignments set ended_at=now(),status='CANCELLED' where driver_id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004') and ended_at is null;
update public.drivers set availability='AVAILABLE' where id in('10000000-0000-0000-0000-000000000003','10000000-0000-0000-0000-000000000004');

select * from finish();
rollback;
