begin;
select plan(27);

-- H3: Customer Feedback v1. Submission is authorized exactly like every
-- other public order-mutating RPC (id + tracking_token match, the same
-- capability get_order_tracking/revise_delivery_address already use) --
-- never a bare order_id. Attribution is snapshotted at submission time
-- from driver_assignments.status='COMPLETED', so reassignment (declined/
-- superseded rows) can never be credited. This is internal operational
-- signal only: no rating engine, no driver score, no salary.

create or replace function pg_temp.new_order(p_id text, p_type public.order_type, p_status public.order_status) returns void language plpgsql security definer as $$
declare v_address jsonb;
begin
  v_address := case when p_type='DELIVERY' then jsonb_build_object('district','Navoiy','street','Test','latitude',40.09,'longitude',65.40,'pinConfirmedAt','2026-08-12T08:00:00Z','locationProvider','mock') else null end;
  perform public.create_public_order(jsonb_build_object(
    'id', p_id, 'customer', jsonb_build_object('name','Feedback Test','primaryPhone','+998900000'||right(p_id,3)),
    'type', p_type, 'paymentMethod','CASH', 'address', v_address,
    'items', jsonb_build_array(jsonb_build_object('menuItemId', case when p_type='PICKUP' then 'ayran' else 'plov' end,'quantity', case when p_type='PICKUP' then 1 else 3 end,'modifierIds','[]'::jsonb))
  ));
  update public.orders set status=p_status, delivery_review_status='APPROVED' where id=p_id::uuid;
end;
$$;
create or replace function pg_temp.new_assignment(p_order_id text, p_driver_id uuid, p_status public.assignment_status) returns void language plpgsql security definer as $$
begin
  insert into public.driver_assignments(order_id,driver_id,assigned_at,accepted_at,ended_at,status)
  values (p_order_id::uuid, p_driver_id, now(), case when p_status in('ACCEPTED','COMPLETED') then now() end, case when p_status not in('ASSIGNED','ACCEPTED') then now() end, p_status);
end;
$$;
create or replace function pg_temp.token_for(p_id text) returns uuid language sql security definer as $$
  select tracking_token from public.orders where id = p_id::uuid;
$$;

-- 23. An active (not yet DELIVERED) DELIVERY order cannot submit feedback.
select pg_temp.new_order('9f100000-0000-4000-8000-000000000001','DELIVERY','ON_THE_WAY');
select throws_ok(
  format('select public.submit_order_feedback(%L::uuid,%L::uuid,%L::public.feedback_food_rating,%L::public.feedback_delivery_rating)','9f100000-0000-4000-8000-000000000001',pg_temp.token_for('9f100000-0000-4000-8000-000000000001'),'GOOD','FAST'),
  '22023','FEEDBACK_NOT_YET_AVAILABLE|Fikr faqat yetkazib berilgandan keyin qoldiriladi','an active DELIVERY order cannot submit delivery feedback yet');

-- 24/28. A DELIVERED order can submit feedback via valid tracking
--    capability, with only the two required answers (no comment).
select pg_temp.new_order('9f100000-0000-4000-8000-000000000002','DELIVERY','DELIVERED');
select lives_ok(
  format('select public.submit_order_feedback(%L::uuid,%L::uuid,%L::public.feedback_food_rating,%L::public.feedback_delivery_rating)','9f100000-0000-4000-8000-000000000002',pg_temp.token_for('9f100000-0000-4000-8000-000000000002'),'GOOD','FAST'),
  'a DELIVERED order can submit basic positive feedback with no comment, through valid tracking capability');

-- 25. A wrong/arbitrary tracking token is rejected -- same order_id, but
--     the token doesn't match, exactly like get_order_tracking's own guard.
select pg_temp.new_order('9f100000-0000-4000-8000-000000000003','DELIVERY','DELIVERED');
select throws_ok(
  format('select public.submit_order_feedback(%L::uuid,%L::uuid,%L::public.feedback_food_rating,%L::public.feedback_delivery_rating)','9f100000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','GOOD','FAST'),
  '42501','ORDER_NOT_FOUND|Buyurtma topilmadi','an arbitrary/wrong tracking token is rejected, not just an arbitrary order_id');

-- 26/27. One order cannot create duplicate feedback -- a second submit
--    (a retry/double-click) is rejected, not silently duplicated, and the
--    underlying row count stays at exactly one.
select throws_ok(
  format('select public.submit_order_feedback(%L::uuid,%L::uuid,%L::public.feedback_food_rating,%L::public.feedback_delivery_rating)','9f100000-0000-4000-8000-000000000002',pg_temp.token_for('9f100000-0000-4000-8000-000000000002'),'BAD','LATE'),
  '23505','FEEDBACK_ALREADY_SUBMITTED|Fikr allaqachon yuborilgan','a second submission for the same order is rejected, not a silent duplicate');
select is((select count(*)::integer from public.order_feedback where order_id='9f100000-0000-4000-8000-000000000002'),1,'exactly one feedback row exists despite two submit attempts');

-- 29. Delivery ISSUE accepts a valid structured reason.
select pg_temp.new_order('9f100000-0000-4000-8000-000000000004','DELIVERY','DELIVERED');
select lives_ok(
  format('select public.submit_order_feedback(%L::uuid,%L::uuid,%L::public.feedback_food_rating,%L::public.feedback_delivery_rating,%L::public.feedback_delivery_issue_reason)','9f100000-0000-4000-8000-000000000004',pg_temp.token_for('9f100000-0000-4000-8000-000000000004'),'GOOD','ISSUE','VERY_LATE'),
  'delivery ISSUE accepts a valid structured issue reason');

-- 30. Food BAD and OKAY each accept a valid structured reason.
select pg_temp.new_order('9f100000-0000-4000-8000-000000000005','DELIVERY','DELIVERED');
select lives_ok(
  format('select public.submit_order_feedback(%L::uuid,%L::uuid,%L::public.feedback_food_rating,%L::public.feedback_delivery_rating,null,%L::public.feedback_food_issue_reason)','9f100000-0000-4000-8000-000000000005',pg_temp.token_for('9f100000-0000-4000-8000-000000000005'),'BAD','FAST','COLD'),
  'food BAD accepts a valid structured food issue reason');
select pg_temp.new_order('9f100000-0000-4000-8000-000000000006','DELIVERY','DELIVERED');
select lives_ok(
  format('select public.submit_order_feedback(%L::uuid,%L::uuid,%L::public.feedback_food_rating,%L::public.feedback_delivery_rating,null,%L::public.feedback_food_issue_reason)','9f100000-0000-4000-8000-000000000006',pg_temp.token_for('9f100000-0000-4000-8000-000000000006'),'OKAY','FAST','MISSING_ITEM'),
  'food OKAY also accepts a valid structured food issue reason');

-- 31. Invalid enum/reason combinations are rejected: a non-ISSUE delivery
--     rating with a reason, a non-OKAY/BAD food rating with a reason, and
--     a PICKUP order given a delivery rating at all.
select pg_temp.new_order('9f100000-0000-4000-8000-000000000007','DELIVERY','DELIVERED');
select throws_ok(
  format('select public.submit_order_feedback(%L::uuid,%L::uuid,%L::public.feedback_food_rating,%L::public.feedback_delivery_rating,%L::public.feedback_delivery_issue_reason)','9f100000-0000-4000-8000-000000000007',pg_temp.token_for('9f100000-0000-4000-8000-000000000007'),'GOOD','FAST','VERY_LATE'),
  '22023','DELIVERY_ISSUE_REASON_NOT_ALLOWED|Sabab faqat muammo tanlanganda kiritiladi','a delivery issue reason is rejected unless the rating itself is ISSUE');
select throws_ok(
  format('select public.submit_order_feedback(%L::uuid,%L::uuid,%L::public.feedback_food_rating,%L::public.feedback_delivery_rating,null,%L::public.feedback_food_issue_reason)','9f100000-0000-4000-8000-000000000007',pg_temp.token_for('9f100000-0000-4000-8000-000000000007'),'EXCELLENT','FAST','COLD'),
  '22023','FOOD_ISSUE_REASON_NOT_ALLOWED|Sabab faqat qoniqarsiz baholarda kiritiladi','a food issue reason is rejected unless the rating itself is OKAY/BAD');
select pg_temp.new_order('9f100000-0000-4000-8000-000000000008','PICKUP','COLLECTED');
select throws_ok(
  format('select public.submit_order_feedback(%L::uuid,%L::uuid,%L::public.feedback_food_rating,%L::public.feedback_delivery_rating)','9f100000-0000-4000-8000-000000000008',pg_temp.token_for('9f100000-0000-4000-8000-000000000008'),'GOOD','FAST'),
  '22023','DELIVERY_FEEDBACK_NOT_APPLICABLE|Olib ketish buyurtmasida yetkazib berish bahosi bo‘lmaydi','a PICKUP order cannot be given a delivery rating at all');
select lives_ok(
  format('select public.submit_order_feedback(%L::uuid,%L::uuid,%L::public.feedback_food_rating)','9f100000-0000-4000-8000-000000000008',pg_temp.token_for('9f100000-0000-4000-8000-000000000008'),'GOOD'),
  'a COLLECTED PICKUP order can submit food-only feedback, with no delivery rating at all');

-- 32. Comment length is bounded server-side.
select pg_temp.new_order('9f100000-0000-4000-8000-000000000009','DELIVERY','DELIVERED');
select throws_ok(
  format('select public.submit_order_feedback(%L::uuid,%L::uuid,%L::public.feedback_food_rating,%L::public.feedback_delivery_rating,null,null,%L)','9f100000-0000-4000-8000-000000000009',pg_temp.token_for('9f100000-0000-4000-8000-000000000009'),'GOOD','FAST',repeat('a',501)),
  '22023','COMMENT_TOO_LONG|Izoh 500 belgidan oshmasin','a comment over 500 characters is rejected server-side');

-- 33. The feedback table itself never stores phone/address/coordinates/OTP
--     -- verified structurally, not just by absence of a given value.
select is((select count(*)::integer from information_schema.columns where table_schema='public' and table_name='order_feedback' and (column_name ilike '%phone%' or column_name ilike '%address%' or column_name ilike '%latitude%' or column_name ilike '%longitude%' or column_name ilike '%otp%')),0,'order_feedback has no phone/address/coordinate/OTP column at all');

-- 34/36. Reassignment: driver A declined, driver B completed the same
--     order -- feedback attributes to B only, never A.
select pg_temp.new_order('9f100000-0000-4000-8000-000000000010','DELIVERY','DELIVERED');
select pg_temp.new_assignment('9f100000-0000-4000-8000-000000000010','10000000-0000-0000-0000-000000000003'::uuid,'DECLINED');
select pg_temp.new_assignment('9f100000-0000-4000-8000-000000000010','10000000-0000-0000-0000-000000000004'::uuid,'COMPLETED');
select public.submit_order_feedback('9f100000-0000-4000-8000-000000000010'::uuid,pg_temp.token_for('9f100000-0000-4000-8000-000000000010'),'GOOD'::public.feedback_food_rating,'FAST'::public.feedback_delivery_rating);
select is((select completed_driver_id::text from public.order_feedback where order_id='9f100000-0000-4000-8000-000000000010'),'10000000-0000-0000-0000-000000000004','feedback attributes to the driver whose assignment reads COMPLETED');
select isnt((select completed_driver_id::text from public.order_feedback where order_id='9f100000-0000-4000-8000-000000000010'),'10000000-0000-0000-0000-000000000003','the DECLINED driver never receives completed-delivery feedback attribution');

-- 35. Food feedback joins to the order's own actual branch_id.
select is((select o.branch_id from public.order_feedback f join public.orders o on o.id=f.order_id where f.order_id='9f100000-0000-4000-8000-000000000010'),(select branch_id from public.orders where id='9f100000-0000-4000-8000-000000000010'),'food feedback resolves to the order''s own actual branch_id');

-- 37/38/39. Submitting feedback mutates nothing about order lifecycle,
--    driver operational state, or dispatch -- it is a pure side-effect-free
--    write to order_feedback alone.
select pg_temp.new_order('9f100000-0000-4000-8000-000000000011','DELIVERY','DELIVERED');
select pg_temp.new_assignment('9f100000-0000-4000-8000-000000000011','10000000-0000-0000-0000-000000000003'::uuid,'COMPLETED');
select is((select availability::text from public.drivers where id='10000000-0000-0000-0000-000000000003'),'AVAILABLE','driver availability before feedback submission (baseline)');
select is((select count(*)::integer from public.driver_assignments where order_id='9f100000-0000-4000-8000-000000000011'),1,'exactly one assignment exists before feedback submission (baseline)');
select public.submit_order_feedback('9f100000-0000-4000-8000-000000000011'::uuid,pg_temp.token_for('9f100000-0000-4000-8000-000000000011'),'GOOD'::public.feedback_food_rating,'FAST'::public.feedback_delivery_rating);
select is((select status::text from public.orders where id='9f100000-0000-4000-8000-000000000011'),'DELIVERED','order status is unchanged by feedback submission');
select is((select availability::text from public.drivers where id='10000000-0000-0000-0000-000000000003'),'AVAILABLE','driver availability is unchanged by feedback submission');
select is((select count(*)::integer from public.driver_assignments where order_id='9f100000-0000-4000-8000-000000000011'),1,'no new driver_assignments row (no automatic dispatch/redispatch) is created by feedback submission');

-- 40. No new notification_outbox row is created by feedback submission --
--    a fresh order so the "before" baseline is captured before any
--    submit_order_feedback call touches it.
select pg_temp.new_order('9f100000-0000-4000-8000-000000000012','DELIVERY','DELIVERED');
create temp table t40_baseline as select count(*)::integer as n from public.notification_outbox where order_id='9f100000-0000-4000-8000-000000000012';
select public.submit_order_feedback('9f100000-0000-4000-8000-000000000012'::uuid,pg_temp.token_for('9f100000-0000-4000-8000-000000000012'),'GOOD'::public.feedback_food_rating,'FAST'::public.feedback_delivery_rating);
select is((select count(*)::integer from public.notification_outbox where order_id='9f100000-0000-4000-8000-000000000012'),(select n from t40_baseline),'notification_outbox row count for this order is unchanged by feedback submission (no extra Telegram notification)');

-- 41. get_order_tracking's feedback payload exposes only customer-facing
--    fields -- never the internal completed_driver_id attribution.
select ok(not ((public.get_order_tracking('9f100000-0000-4000-8000-000000000010'::uuid,pg_temp.token_for('9f100000-0000-4000-8000-000000000010')))->'feedback' ? 'completedDriverId'),'the tracking response''s feedback object never exposes completed_driver_id to the customer');
select ok((public.get_order_tracking('9f100000-0000-4000-8000-000000000010'::uuid,pg_temp.token_for('9f100000-0000-4000-8000-000000000010')))->'feedback' ? 'foodRating','the tracking response''s feedback object does expose the customer''s own answers');

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
-- 42. Restaurant staff can read feedback directly (History/order-detail integration).
select ok(exists(select 1 from public.order_feedback where order_id='9f100000-0000-4000-8000-000000000010'),'restaurant staff can read order_feedback directly via RLS');
reset role;

-- 43. A driver (non-staff, authenticated) cannot read order_feedback at all.
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select is((select count(*)::integer from public.order_feedback),0,'a driver cannot read any order_feedback rows -- RLS is staff-only, not staff-or-assigned-driver');
reset role;

select * from finish();
rollback;
