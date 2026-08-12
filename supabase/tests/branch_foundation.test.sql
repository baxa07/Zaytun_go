begin;
select plan(14);

-- Smart Dispatch v1, Phase 0: Branch Foundation. The existing Zaytun Kafe
-- becomes the initial/default branch; every existing order/driver backfills
-- onto it; new orders resolve branch_id entirely server-side.

select has_table('public','branches','branches table exists');
select has_table('public','driver_branches','driver_branches pool table exists');
select has_column('public','orders','branch_id','orders record their pickup branch');
select has_column('public','delivery_settings','branch_id','delivery_settings points at the active branch');

select is((select count(*)::integer from public.branches),1,'exactly one branch exists after backfill');
-- Compared against production_bootstrap's baseline name, not the CURRENT
-- delivery_settings row: seed.sql (local-dev only) cosmetically renames the
-- restaurant to "... -- LOCAL PILOT" *after* migrations (and this branch
-- seed) already ran, so the two are expected to diverge locally by design.
select ok((select name from public.branches where slug='zaytun-kafe') like 'Zaytun Kafe%','seeded branch name is derived from the existing restaurant config, not hardcoded');
select is((select active from public.branches where slug='zaytun-kafe'),true,'the initial branch is active');
select is((select branch_id from public.delivery_settings where id=true),(select id from public.branches where slug='zaytun-kafe'),'delivery_settings points at the seeded branch');

select ok(not exists(select 1 from public.orders where branch_id is null),'every existing order backfilled onto the seeded branch');
select ok(not exists(
  select 1 from public.drivers d where not exists(
    select 1 from public.driver_branches db where db.driver_id=d.id and db.branch_id=(select id from public.branches where slug='zaytun-kafe')
  )
),'every existing driver is backfilled into the seeded branch''s pool');

-- New orders resolve branch_id entirely server-side, from
-- delivery_settings' own pointer -- never from client input. Also proves
-- the browser cannot inject an arbitrary branch_id: this payload includes
-- a bogus "branchId" the RPC never even looks at.
select lives_ok($$select public.create_public_order('{"id":"95000000-0000-4000-8000-000000000001","branchId":"ffffffff-ffff-ffff-ffff-ffffffffffff","customer":{"name":"Branch Test","primaryPhone":"+998900000020"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"ayran","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'order creation still succeeds with an extraneous client-supplied branchId field');
select is((select branch_id from public.orders where id='95000000-0000-4000-8000-000000000001'),(select id from public.branches where slug='zaytun-kafe'),'the server-resolved branch is used, not the client-supplied one');

-- RLS: readable by anon/authenticated (menu-adjacent, customer-safe), not
-- writable by anyone through the client roles.
select ok(has_table_privilege('anon','public.branches','SELECT'),'anon can read branches');
select ok(not has_table_privilege('authenticated','public.branches','INSERT'),'authenticated cannot write branches');

select * from finish();
rollback;
