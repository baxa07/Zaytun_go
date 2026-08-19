begin;
select plan(10);

insert into public.branches(id,name,slug,address,latitude,longitude,active)
values ('9e100000-0000-4000-8000-000000000001','Retry Test Branch','retry-test','Test',40.12,65.43,true);
insert into public.orders(id,number,branch_id,customer_id,customer_name,primary_phone,order_type,payment_method,payment_status,subtotal,delivery_fee,status,tracking_token,idempotency_key)
values ('9e100000-0000-4000-8000-000000000002','ZG-RETRY','9e100000-0000-4000-8000-000000000001',null,'Retry','+998900000099','DELIVERY','CASH','PENDING',10000,0,'CONFIRMED',gen_random_uuid(),'9e100000-0000-4000-8000-000000000005');
insert into public.notification_outbox(id,order_id,channel)
values ('9e100000-0000-4000-8000-000000000003','9e100000-0000-4000-8000-000000000002','TELEGRAM_DRIVER_NEW_ASSIGNMENT:9e100000-0000-4000-8000-000000000004');

select lives_ok($$select public.mark_notification_delivery_failed('9e100000-0000-4000-8000-000000000003','telegram_api_error')$$,'a Telegram failure is durably recorded without affecting the order');
select is((select status from public.notification_outbox where id='9e100000-0000-4000-8000-000000000003'),'FAILED','failed delivery remains in the durable outbox');
select is((select attempts from public.notification_outbox where id='9e100000-0000-4000-8000-000000000003'),1,'first failure increments attempts');
select ok((select next_attempt_at is not null from public.notification_outbox where id='9e100000-0000-4000-8000-000000000003'),'a retry is scheduled');
select is((select status::text from public.orders where id='9e100000-0000-4000-8000-000000000002'),'CONFIRMED','notification failure never rolls back or changes lifecycle');

update public.notification_outbox set next_attempt_at=now()-interval '1 second' where id='9e100000-0000-4000-8000-000000000003';
select is(public.retry_due_notification_outbox(),1,'the server-side sweep requeues one due notification');
select is((select status from public.notification_outbox where id='9e100000-0000-4000-8000-000000000003'),'PENDING','due notification is pending for pg_net dispatch again');
select is(public.retry_due_notification_outbox(),0,'the same pending intent is not requeued twice');

update public.notification_outbox set status='FAILED',attempts=5,next_attempt_at=now()-interval '1 second' where id='9e100000-0000-4000-8000-000000000003';
select is(public.retry_due_notification_outbox(),0,'bounded retry does not requeue an exhausted intent');
select is((select count(*)::integer from public.notification_outbox where order_id='9e100000-0000-4000-8000-000000000002' and channel like 'TELEGRAM_DRIVER_NEW_ASSIGNMENT:%'),1,'retry preserves the single idempotent assignment intent');

select * from finish();
rollback;
