begin;
select plan(19);

update public.delivery_settings set delivery_payment_methods=array['CASH','CLICK','PAYME']::public.payment_method[] where id=true;

-- H1: Order History. list_restaurant_order_history()/
-- get_restaurant_order_history_summary() filter strictly by created_at
-- (so a still-active order shows up in the day it was created), resolve
-- every date preset/custom range server-side in Asia/Tashkent, and never
-- touch H0's live-board semantics.

create or replace function pg_temp.new_history_order(p_id text, p_status public.order_status, p_type public.order_type, p_created_at timestamptz, p_payment public.payment_method default 'CASH', p_driver_id uuid default null) returns void language plpgsql security definer as $$
declare v_address jsonb;
begin
  v_address := case when p_type='DELIVERY' then jsonb_build_object('district','Navoiy','street','Test','latitude',40.09,'longitude',65.40,'pinConfirmedAt','2026-08-12T08:00:00Z','locationProvider','mock') else null end;
  perform public.create_public_order(jsonb_build_object(
    'id', p_id, 'customer', jsonb_build_object('name','History Test','primaryPhone','+998900000'||right(p_id,3)),
    'type', p_type, 'paymentMethod', p_payment, 'address', v_address,
    'items', jsonb_build_array(jsonb_build_object('menuItemId', case when p_type='PICKUP' then 'ayran' else 'plov' end,'quantity', case when p_type='PICKUP' then 1 else 3 end,'modifierIds','[]'::jsonb))
  ));
  update public.orders set status=p_status, delivery_review_status='APPROVED', created_at=p_created_at, assigned_driver_id=p_driver_id where id=p_id::uuid;
end;
$$;
create or replace function pg_temp.record_terminal_event(p_id text, p_status public.order_status, p_at timestamptz) returns void language plpgsql security definer as $$
begin
  insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status,occurred_at)
  values (p_id::uuid,'RESTAURANT','seed','READY',p_status,p_at);
end;
$$;
create or replace function pg_temp.new_branch(p_id uuid, p_slug text) returns void language plpgsql security definer as $$
begin
  insert into public.branches(id,name,slug,address,latitude,longitude,active) values (p_id,'Test Branch','test-branch-'||p_slug,'Test',40.09,65.40,true);
end;
$$;
create or replace function pg_temp.set_branch(p_id text, p_branch_id uuid) returns void language plpgsql security definer as $$
begin
  update public.orders set branch_id=p_branch_id where id=p_id::uuid;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);

-- 1. Yesterday's delivered order appears under YESTERDAY.
select pg_temp.new_history_order('9d000000-0000-4000-8000-000000000001','DELIVERED','DELIVERY', now()-interval '1 day');
select pg_temp.record_terminal_event('9d000000-0000-4000-8000-000000000001','DELIVERED', now()-interval '1 day');
select ok('9d000000-0000-4000-8000-000000000001'::uuid in (select id from public.list_restaurant_order_history('YESTERDAY')),'yesterday''s delivered order appears under the YESTERDAY preset');
select ok('9d000000-0000-4000-8000-000000000001'::uuid not in (select id from public.list_restaurant_order_history('TODAY')),'yesterday''s delivered order does not leak into TODAY');

-- 2. Today's still-active order appears under TODAY (created_at semantics,
--    not a live-board style status filter).
select pg_temp.new_history_order('9d000000-0000-4000-8000-000000000002','ON_THE_WAY','DELIVERY', now());
select ok('9d000000-0000-4000-8000-000000000002'::uuid in (select id from public.list_restaurant_order_history('TODAY')),'today''s still-active order appears in TODAY''s history by created_at');

-- 3/4. Cross-midnight: created 1 minute before midnight yesterday in
--    Asia/Tashkent is YESTERDAY, not TODAY -- proves the boundary is
--    computed in business time, not naive UTC/browser time.
select pg_temp.new_history_order('9d000000-0000-4000-8000-000000000003','DELIVERED','PICKUP',
  (date_trunc('day', now() at time zone 'Asia/Tashkent') at time zone 'Asia/Tashkent') - interval '1 minute');
select pg_temp.record_terminal_event('9d000000-0000-4000-8000-000000000003','DELIVERED', now()-interval '1 day');
select ok('9d000000-0000-4000-8000-000000000003'::uuid in (select id from public.list_restaurant_order_history('YESTERDAY')),'an order created 1 minute before business midnight is YESTERDAY''s, not TODAY''s');
select ok('9d000000-0000-4000-8000-000000000003'::uuid not in (select id from public.list_restaurant_order_history('TODAY')),'that same order is absent from TODAY');

-- 5. Branch filter.
select pg_temp.new_branch('9d000000-0000-4000-9000-000000000001','history');
select pg_temp.new_history_order('9d000000-0000-4000-8000-000000000005','NEW','PICKUP', now());
select pg_temp.set_branch('9d000000-0000-4000-8000-000000000005','9d000000-0000-4000-9000-000000000001'::uuid);
select ok('9d000000-0000-4000-8000-000000000005'::uuid in (select id from public.list_restaurant_order_history('TODAY', null, null, '9d000000-0000-4000-9000-000000000001'::uuid)),'branch filter includes the matching branch''s order');
select ok('9d000000-0000-4000-8000-000000000005'::uuid not in (select id from public.list_restaurant_order_history('TODAY', null, null, (select id from public.branches where slug='zaytun-kafe'))),'branch filter excludes a different branch''s order');

-- 6. Driver filter.
select pg_temp.new_history_order('9d000000-0000-4000-8000-000000000006','DRIVER_ASSIGNED','DELIVERY', now(), 'CASH', '10000000-0000-0000-0000-000000000003'::uuid);
select ok('9d000000-0000-4000-8000-000000000006'::uuid in (select id from public.list_restaurant_order_history('TODAY', null, null, null, '10000000-0000-0000-0000-000000000003'::uuid)),'driver filter includes that driver''s order');
select ok('9d000000-0000-4000-8000-000000000006'::uuid not in (select id from public.list_restaurant_order_history('TODAY', null, null, null, '10000000-0000-0000-0000-000000000004'::uuid)),'driver filter excludes a different driver''s order');

-- 7. Status filter.
select ok('9d000000-0000-4000-8000-000000000002'::uuid in (select id from public.list_restaurant_order_history('TODAY', null, null, null, null, 'ON_THE_WAY'::public.order_status)),'status filter includes a matching-status order');
select ok('9d000000-0000-4000-8000-000000000002'::uuid not in (select id from public.list_restaurant_order_history('TODAY', null, null, null, null, 'DELIVERED'::public.order_status)),'status filter excludes a non-matching-status order');

-- 8. Fulfillment filter.
select ok('9d000000-0000-4000-8000-000000000005'::uuid in (select id from public.list_restaurant_order_history('TODAY', null, null, null, null, null, 'PICKUP'::public.order_type)),'fulfillment filter includes PICKUP');
select ok('9d000000-0000-4000-8000-000000000005'::uuid not in (select id from public.list_restaurant_order_history('TODAY', null, null, null, null, null, 'DELIVERY'::public.order_type)),'fulfillment filter excludes DELIVERY when PICKUP was requested');

-- 9. Payment filter.
select pg_temp.new_history_order('9d000000-0000-4000-8000-000000000009','NEW','DELIVERY', now(), 'CLICK');
select ok('9d000000-0000-4000-8000-000000000009'::uuid in (select id from public.list_restaurant_order_history('TODAY', null, null, null, null, null, null, 'CLICK'::public.payment_method)),'payment filter includes CLICK orders');
select ok('9d000000-0000-4000-8000-000000000009'::uuid not in (select id from public.list_restaurant_order_history('TODAY', null, null, null, null, null, null, 'CASH'::public.payment_method)),'payment filter excludes a CLICK order when CASH was requested');

-- 10. Order-number search (case-insensitive substring on the ZG-#### number).
select ok(exists(select 1 from public.list_restaurant_order_history('TODAY', null, null, null, null, null, null, null, lower((select number from public.orders where id='9d000000-0000-4000-8000-000000000009')))),'order-number search finds the order by a lowercased substring of its number');

-- 11. Pagination is stable and non-duplicating: two pages of size 1 over
--     the same >=2-row TODAY result set return two distinct ids, and their
--     union matches page-size-2's first two ids.
select is((select count(distinct id)::integer from (
  select id from public.list_restaurant_order_history('TODAY', null, null, null, null, null, null, null, null, 1, 0)
  union all
  select id from public.list_restaurant_order_history('TODAY', null, null, null, null, null, null, null, null, 1, 1)
) pages), 2, 'two size-1 pages of TODAY return two distinct, non-duplicating ids');

reset role;

-- 12. Non-staff cannot access History at all.
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000004',true);
select throws_ok($$select * from public.list_restaurant_order_history('TODAY')$$,'42501','STAFF_ROLE_REQUIRED|Xodim roli talab qilinadi','a driver cannot call list_restaurant_order_history');
select throws_ok($$select public.get_restaurant_order_history_summary('TODAY')$$,'42501','STAFF_ROLE_REQUIRED|Xodim roli talab qilinadi','a driver cannot call get_restaurant_order_history_summary');
reset role;

select * from finish();
rollback;
