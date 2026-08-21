begin;
select plan(18);
select has_table('public','orders','orders exists');
select has_table('public','order_events','events exist');
select has_function('public','transition_order',array['uuid','order_status','text','text'],'transition RPC exists');
select lives_ok($$select public.assert_transition('NEW','CONFIRMED')$$,'legal transition accepted');
select throws_ok($$select public.assert_transition('NEW','DELIVERED')$$,'23514',null,'illegal transition rejected');
select throws_ok($$select public.create_order('{"customer":{"name":"A","primaryPhone":"+998901234567"},"type":"DELIVERY","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'22023',null,'incomplete delivery rejected');
select lives_ok($$select public.create_order('{"customer":{"name":"A","primaryPhone":"+998901234567"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":2,"modifierIds":[]}]}'::jsonb)$$,'pickup without address accepted');
select is((select total from orders order by created_at desc limit 1),102000,'total and packaging calculated from menu in database');
select is((select count(*)::integer from order_events where order_id=(select id from orders order by created_at desc limit 1)),1,'creation event added');
select is((select count(*)::integer from pg_policies where schemaname='public' and tablename='orders' and policyname='order_read'),1,'staff/driver orders RLS policy exists');
select is((select count(*)::integer from pg_policies where schemaname='public' and tablename='orders' and policyname='customer_own_order_read'),1,'additive customer-own orders RLS policy exists');
select is((select relrowsecurity from pg_class where oid='public.orders'::regclass),true,'orders RLS enabled');
select is((select count(*)::integer from pg_publication_tables where pubname='supabase_realtime' and tablename='orders'),1,'orders realtime enabled');
set local role anon;
select throws_ok($$select count(*) from public.orders$$,'42501',null,'anonymous cannot list orders');
select is((select count(*)::integer from public.menu_items)>0,true,'anonymous can read menu');
reset role;
-- Two DRIVER-role identities are seeded (the original email driver and the
-- phone-login LOCAL TEST fixture) -- verify both specific identities exist
-- with the correct role rather than an opaque count.
select ok((select role='DRIVER' from profiles where id='10000000-0000-0000-0000-000000000003'),'the seeded email driver identity holds the DRIVER role');
select ok((select role='DRIVER' from profiles where id='10000000-0000-0000-0000-000000000004'),'the seeded phone-login driver identity holds the DRIVER role');
select is((select count(*)::integer from profiles where role='DRIVER'),2,'exactly the two known driver identities are seeded, no more');
select * from finish();
rollback;
