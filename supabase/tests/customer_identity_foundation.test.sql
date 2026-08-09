-- Authenticated Customer Foundation, Phase 1: privilege, RLS, identity
-- resolution, and order-creation coverage. Local default ACLs are NOT
-- production-equivalent (see docs/production-readiness.md ("Default-ACL exposure" section)) -- these
-- assertions exercise actual privileges (has_*_privilege / real attempted
-- writes expecting 42501), not information_schema alone, so this suite is
-- meaningful evidence on any environment, but only recovery/production
-- confirm the real hosted default-ACL exposure is closed.
begin;
select plan(84);

-- ============================================================
-- Section 1: customers table ACL -- explicit privilege assertions
-- ============================================================
select ok(not has_table_privilege('anon','public.customers','INSERT'),'anon has no INSERT on customers');
select ok(not has_table_privilege('anon','public.customers','UPDATE'),'anon has no UPDATE on customers');
select ok(not has_table_privilege('anon','public.customers','DELETE'),'anon has no DELETE on customers');
select ok(not has_table_privilege('anon','public.customers','SELECT'),'anon has no SELECT on customers');
select ok(not has_table_privilege('authenticated','public.customers','INSERT'),'authenticated has no INSERT on customers');
select ok(not has_table_privilege('authenticated','public.customers','UPDATE'),'authenticated has no UPDATE on customers');
select ok(not has_table_privilege('authenticated','public.customers','DELETE'),'authenticated has no DELETE on customers');
select ok(has_table_privilege('authenticated','public.customers','SELECT'),'authenticated has table-level SELECT on customers (narrowed further by RLS)');
-- service_role: this project's pre-existing tables never revoked
-- service_role from the hosted default-ACL rule and still carry an
-- inherited full-CRUD grant on production (documented, not fixed here --
-- see the Phase 1 server-enforcement gate report). customers is new, so
-- Phase 1 does not repeat that gap: no concrete requirement exists for
-- service_role to touch this table directly.
select ok(not has_table_privilege('service_role','public.customers','INSERT'),'service_role has no INSERT on customers');
select ok(not has_table_privilege('service_role','public.customers','UPDATE'),'service_role has no UPDATE on customers');
select ok(not has_table_privilege('service_role','public.customers','DELETE'),'service_role has no DELETE on customers');
select ok(not has_table_privilege('service_role','public.customers','SELECT'),'service_role has no SELECT on customers (RLS-bypass role, but no table grant either)');

-- Real attempted writes, not just metadata -- must fail closed at the GRANT
-- layer regardless of RLS.
set local role anon;
select throws_ok($$insert into public.customers(phone_e164) values ('+998900000900')$$, '42501', null, 'anon cannot actually INSERT into customers');
reset role;
set local role authenticated;
select throws_ok($$insert into public.customers(phone_e164) values ('+998900000901')$$, '42501', null, 'authenticated cannot actually INSERT into customers');
reset role;
set local role service_role;
select throws_ok($$insert into public.customers(phone_e164) values ('+998900000902')$$, '42501', null, 'service_role cannot actually INSERT into customers');
reset role;

-- ============================================================
-- Section 2: ensure_current_customer -- fail-closed identity resolution
-- ============================================================

-- unauthenticated -> fail
select throws_ok($$select public.ensure_current_customer()$$, '28000', 'AUTHENTICATION_REQUIRED|Kirish talab qilinadi', 'no auth.uid() is rejected');

-- auth user with no verified phone -> fail
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-0000000000c1','authenticated','authenticated','nophone-test@zaytun.local',crypt('x',gen_salt('bf')),now(),'{}','{}');
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000c1',true);
set local role authenticated;
select throws_ok($$select public.ensure_current_customer()$$, '22023', 'PHONE_NOT_VERIFIED|Telefon raqami tasdiqlanmagan', 'auth user with no verified phone is rejected');
reset role;

-- phone present but NOT confirmed (phone_confirmed_at IS NULL) -> fail
insert into auth.users(instance_id,id,aud,role,phone,encrypted_password,raw_app_meta_data,raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-0000000000c2','authenticated','authenticated','998901111122',crypt('x',gen_salt('bf')),'{"provider":"phone"}','{}');
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000c2',true);
set local role authenticated;
select throws_ok($$select public.ensure_current_customer()$$, '22023', 'PHONE_NOT_VERIFIED|Telefon raqami tasdiqlanmagan', 'a present but unconfirmed phone (phone_confirmed_at IS NULL) is rejected');
reset role;
select is((select count(*)::integer from public.customers where phone_e164='+998901111122'),0,'an unconfirmed phone never reaches customers.phone_e164');

-- malformed digits (wrong length) -> fail
insert into auth.users(instance_id,id,aud,role,phone,encrypted_password,phone_confirmed_at,raw_app_meta_data,raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-0000000000c3','authenticated','authenticated','99890111112',crypt('x',gen_salt('bf')),now(),'{"provider":"phone"}','{}');
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000c3',true);
set local role authenticated;
select throws_ok($$select public.ensure_current_customer()$$, '22023', 'PHONE_NOT_VERIFIED|Telefon raqami tasdiqlanmagan', 'a malformed (wrong-length) confirmed phone is rejected');
reset role;
select is((select count(*)::integer from public.customers where phone_e164 like '%99890111112%'),0,'a malformed phone never reaches customers.phone_e164');

-- non-998 (non-Uzbek) confirmed number -> fail
insert into auth.users(instance_id,id,aud,role,phone,encrypted_password,phone_confirmed_at,raw_app_meta_data,raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-0000000000c4','authenticated','authenticated','15551234567',crypt('x',gen_salt('bf')),now(),'{"provider":"phone"}','{}');
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000c4',true);
set local role authenticated;
select throws_ok($$select public.ensure_current_customer()$$, '22023', 'PHONE_NOT_VERIFIED|Telefon raqami tasdiqlanmagan', 'a confirmed but non-998 (non-Uzbek) number is rejected');
reset role;
select is((select count(*)::integer from public.customers where phone_e164 like '%15551234567%'),0,'a non-Uzbek phone never reaches customers.phone_e164');

-- valid, confirmed Uzbek phone -> succeeds (positive case; Case D below
-- exercises this exact path with a full assertion on the resulting
-- canonical phone_e164, so not duplicated here).

-- new customer (Case D)
insert into auth.users(instance_id,id,aud,role,phone,encrypted_password,phone_confirmed_at,raw_app_meta_data,raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-0000000000a1','authenticated','authenticated','998901111111',crypt('x',gen_salt('bf')),now(),'{"provider":"phone"}','{}');
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000a1',true);
set local role authenticated;
select is((select phone_e164 from public.ensure_current_customer()),'+998901111111','new customer is created with canonicalized +998... phone');
select is((select count(*)::integer from public.customers where auth_user_id='90000000-0000-0000-0000-0000000000a1'),1,'exactly one customers row exists for the new auth user');
reset role;

-- repeat call idempotency (still Case A1) -- no duplicate row
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000a1',true);
set local role authenticated;
select is((select id from public.ensure_current_customer()),(select id from public.customers where auth_user_id='90000000-0000-0000-0000-0000000000a1'),'repeat call returns the same customer id');
reset role;
select is((select count(*)::integer from public.customers where auth_user_id='90000000-0000-0000-0000-0000000000a1'),1,'repeat call created no duplicate row');

-- existing same auth + same phone (Case A1 again, explicit distinct assertion)
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000a1',true);
set local role authenticated;
select is((select phone_e164 from public.ensure_current_customer()),'+998901111111','same auth + same verified phone returns the row unchanged');
reset role;

-- same auth, phone change to a free number (Case A2, clean)
update auth.users set phone='998901111199' where id='90000000-0000-0000-0000-0000000000a1';
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000a1',true);
set local role authenticated;
select is((select phone_e164 from public.ensure_current_customer()),'+998901111199','phone change to a free number updates the same customer row');
select is((select id from public.ensure_current_customer()),(select id from public.customers where phone_e164='+998901111199'),'the customer identity (id) is preserved across the phone change');
reset role;
select is((select count(*)::integer from public.customers where auth_user_id='90000000-0000-0000-0000-0000000000a1'),1,'phone change did not create a second row');

-- second identity Z, to become the stale-owner of a phone customer A will try to steal
insert into auth.users(instance_id,id,aud,role,phone,encrypted_password,phone_confirmed_at,raw_app_meta_data,raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-0000000000ee','authenticated','authenticated','998909999999',crypt('x',gen_salt('bf')),now(),'{"provider":"phone"}','{}');
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000ee',true);
set local role authenticated;
select public.ensure_current_customer();
reset role;
-- Z's phone changes away at the Auth layer without Z logging back in --
-- customers.phone_e164 for Z is now stale, exactly the real-world condition
-- that makes the phone number available for reassignment by the telecom.
update auth.users set phone='998908888888' where id='90000000-0000-0000-0000-0000000000ee';

-- same auth (A), phone change INTO Z's still-stale customer phone -> fail
update auth.users set phone='998909999999' where id='90000000-0000-0000-0000-0000000000a1';
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000a1',true);
set local role authenticated;
select throws_ok($$select public.ensure_current_customer()$$, '23505', 'CUSTOMER_PHONE_ALREADY_IN_USE|Bu telefon raqami boshqa hisobga tegishli', 'phone change into a number already owned by a different customer fails closed');
reset role;
-- restore A to a clean, uncontested phone for later order-creation tests
update auth.users set phone='998901111111' where id='90000000-0000-0000-0000-0000000000a1';

-- phone-matched row with auth_user_id IS NULL -> may be linked (Case B).
-- The pre-existing row has an explicit, known id: until ensure_current_customer
-- links it, customer_self_read RLS hides it from DD entirely (auth_user_id is
-- null, not DD's uid, and DD isn't staff), so a same-statement lookup of "the
-- row by phone" alongside the linking call itself is not reliable -- verify
-- the link with separate, later statements instead, run as postgres (after
-- reset role) to observe the committed post-link state unambiguously.
insert into public.customers(id, phone_e164, display_name) values ('90000000-1111-4000-8000-000000000001','+998905555555','Pre-existing (e.g. Telegram) customer');
insert into auth.users(instance_id,id,aud,role,phone,encrypted_password,phone_confirmed_at,raw_app_meta_data,raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-0000000000dd','authenticated','authenticated','998905555555',crypt('x',gen_salt('bf')),now(),'{"provider":"phone"}','{}');
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000dd',true);
set local role authenticated;
select is((select id from public.ensure_current_customer()),'90000000-1111-4000-8000-000000000001'::uuid,'first login links to the pre-existing phone-matched row rather than creating a new one');
reset role;
select is((select auth_user_id from public.customers where id='90000000-1111-4000-8000-000000000001'),'90000000-0000-0000-0000-0000000000dd'::uuid,'the pre-existing row is now linked to the logging-in auth user');
select is((select count(*)::integer from public.customers where phone_e164='+998905555555'),1,'linking did not create a duplicate row');

-- phone-matched row with a DIFFERENT non-null auth_user_id -> fail closed
-- (Case C). This requires a genuinely fresh auth user (FF) who has never
-- called ensure_current_customer before -- reusing an identity that already
-- owns a customers row (like EE) would always hit Case A instead, since
-- Case C is specifically the "no row for me yet, but this phone belongs to
-- someone else" path. EE's own row is still stale at +998909999999 (EE's
-- own auth.users.phone moved away from it earlier and was never refreshed),
-- and A's earlier attempt to claim +998909999999 failed and left it free in
-- auth.users, so it's available for FF here.
insert into auth.users(instance_id,id,aud,role,phone,encrypted_password,phone_confirmed_at,raw_app_meta_data,raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-0000000000ff','authenticated','authenticated','998909999999',crypt('x',gen_salt('bf')),now(),'{"provider":"phone"}','{}');
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000ff',true);
set local role authenticated;
select throws_ok($$select public.ensure_current_customer()$$, '23505', 'CUSTOMER_PHONE_CONFLICT|Bu telefon raqami allaqachon boshqa hisobga bog‘langan', 'a phone already linked to a different auth user is rejected, never silently reassigned');
reset role;

-- ============================================================
-- Section 3: orders/customer_addresses RLS -- cross-customer isolation
-- ============================================================
insert into auth.users(instance_id,id,aud,role,phone,encrypted_password,phone_confirmed_at,raw_app_meta_data,raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-0000000000b1','authenticated','authenticated','998902222222',crypt('x',gen_salt('bf')),now(),'{"provider":"phone"}','{}');

update public.delivery_settings set delivery_enabled=true where id=true;

select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000a1',true);
set local role authenticated;
select public.create_customer_order('{"id":"90000000-0000-4000-8000-00000000e001","customer":{"name":"Customer A","primaryPhone":"+998900000000"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"A Street","house":"1","landmark":"A","deliveryNotes":"","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-10T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
reset role;

select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000b1',true);
set local role authenticated;
select public.create_customer_order('{"id":"90000000-0000-4000-8000-00000000e002","customer":{"name":"Customer B","primaryPhone":"+998900000000"},"type":"DELIVERY","paymentMethod":"CASH","address":{"district":"Navoiy","street":"B Street","house":"2","landmark":"B","deliveryNotes":"","latitude":40.09,"longitude":65.40,"pinConfirmedAt":"2026-08-10T08:00:00Z","locationProvider":"mock"},"items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
reset role;
update public.delivery_settings set delivery_enabled=false where id=true;

select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000a1',true);
set local role authenticated;
select ok((select count(*)::integer from public.orders where id='90000000-0000-4000-8000-00000000e001')=1,'customer A sees own order');
select ok((select count(*)::integer from public.orders where id='90000000-0000-4000-8000-00000000e002')=0,'customer A cannot see customer B''s order');
select ok((select count(*)::integer from public.customer_addresses where order_id='90000000-0000-4000-8000-00000000e002')=0,'customer A cannot see customer B''s address');
select ok((select count(*)::integer from public.customer_addresses where order_id='90000000-0000-4000-8000-00000000e001')=1,'customer A sees own address');
reset role;

-- staff access unchanged
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
set local role authenticated;
select ok((select count(*)::integer from public.orders where id in ('90000000-0000-4000-8000-00000000e001','90000000-0000-4000-8000-00000000e002'))=2,'staff still sees both customers'' orders (unaffected by the new additive policy)');
reset role;

-- assigned driver access unchanged: confirm the existing driver_read/order_read
-- policies still exclude an unrelated, unassigned driver from these new orders.
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
set local role authenticated;
select ok((select count(*)::integer from public.orders where id in ('90000000-0000-4000-8000-00000000e001','90000000-0000-4000-8000-00000000e002'))=0,'an unassigned driver still sees neither order (existing policy unaffected)');
reset role;

-- ============================================================
-- Section 4: order creation -- anonymous regression + authenticated linkage
-- ============================================================

-- anonymous create_public_order regression: still works, unauthenticated
select lives_ok($$select public.create_public_order('{"id":"90000000-0000-4000-8000-00000000f001","customer":{"name":"Guest Pickup","primaryPhone":"+998900000111"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":2,"modifierIds":[]}]}'::jsonb)$$,'anonymous create_public_order still succeeds (pickup regression)');
select is((select customer_id from public.orders where id='90000000-0000-4000-8000-00000000f001'),null,'anonymous order has customer_id IS NULL');
select is((select actor_type::text from public.order_events where order_id='90000000-0000-4000-8000-00000000f001' and new_status='NEW'),'CUSTOMER','anonymous initial actor_type remains CUSTOMER');
select is((select actor_id from public.order_events where order_id='90000000-0000-4000-8000-00000000f001' and new_status='NEW'),'guest','anonymous initial actor_id remains guest');

-- authenticated create_customer_order requires a session. set_config's
-- is_local=true scopes request.jwt.claim.sub to the whole transaction, not
-- the statement -- it must be explicitly cleared here, or this test would
-- silently inherit whatever identity a prior test last set.
select set_config('request.jwt.claim.sub','',true);
select throws_ok($$select public.create_customer_order('{"customer":{"name":"No Session","primaryPhone":"+998900000000"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'28000','AUTHENTICATION_REQUIRED|Buyurtma berish uchun tizimga kiring','create_customer_order rejects an unauthenticated call');

-- authenticated create_customer_order creates/links customer + correct linkage
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000a1',true);
set local role authenticated;
select public.create_customer_order('{"id":"90000000-0000-4000-8000-00000000f002","customer":{"name":"Customer A Pickup","primaryPhone":"+998900000999"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]}'::jsonb);
reset role;
select is((select customer_id from public.orders where id='90000000-0000-4000-8000-00000000f002'),(select id from public.customers where auth_user_id='90000000-0000-0000-0000-0000000000a1'),'authenticated order stores the correct server-resolved customer_id');
select is((select primary_phone from public.orders where id='90000000-0000-4000-8000-00000000f002'),'+998901111111','the canonical verified phone overrides the client-supplied phone in the payload');
select is((select actor_type::text from public.order_events where order_id='90000000-0000-4000-8000-00000000f002' and new_status='NEW'),'CUSTOMER','authenticated initial actor_type is CUSTOMER');
select is((select actor_id from public.order_events where order_id='90000000-0000-4000-8000-00000000f002' and new_status='NEW'),'90000000-0000-0000-0000-0000000000a1','authenticated initial actor_id is the real auth uid, not a placeholder');

-- a browser-supplied fake customer id/uuid embedded in the payload must be inert
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000a1',true);
set local role authenticated;
select public.create_customer_order('{"id":"90000000-0000-4000-8000-00000000f003","customer":{"id":"ffffffff-ffff-ffff-ffff-ffffffffffff","name":"Spoofed Id","primaryPhone":"+998900000999"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]}'::jsonb);
reset role;
select is((select customer_id from public.orders where id='90000000-0000-4000-8000-00000000f003'),(select id from public.customers where auth_user_id='90000000-0000-0000-0000-0000000000a1'),'a spoofed customer.id in the payload is ignored; linkage is always server-resolved');
select ok((select customer_id from public.orders where id='90000000-0000-4000-8000-00000000f003')<>'ffffffff-ffff-ffff-ffff-ffffffffffff','the spoofed uuid never becomes the actual customer_id');

-- pricing/totals identical between equivalent public and authenticated payloads
select public.create_public_order('{"id":"90000000-0000-4000-8000-00000000f004","customer":{"name":"Guest Compare","primaryPhone":"+998900000222"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000a1',true);
set local role authenticated;
select public.create_customer_order('{"id":"90000000-0000-4000-8000-00000000f005","customer":{"name":"Customer Compare","primaryPhone":"+998900000000"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":3,"modifierIds":[]}]}'::jsonb);
reset role;
select is(
  (select row(subtotal,delivery_fee,total) from public.orders where id='90000000-0000-4000-8000-00000000f005'),
  (select row(subtotal,delivery_fee,total) from public.orders where id='90000000-0000-4000-8000-00000000f004'),
  'pricing/order totals are identical between equivalent public and authenticated payloads'
);

-- ============================================================
-- Section 5: create_order_internal -- owner-only, proven by real execution
-- ============================================================
select ok(not has_function_privilege('anon','public.create_order_internal(jsonb,uuid,public.actor_type,text)','EXECUTE'),'anon has no EXECUTE on create_order_internal');
select ok(not has_function_privilege('authenticated','public.create_order_internal(jsonb,uuid,public.actor_type,text)','EXECUTE'),'authenticated has no EXECUTE on create_order_internal');
select ok(not has_function_privilege('service_role','public.create_order_internal(jsonb,uuid,public.actor_type,text)','EXECUTE'),'service_role has no EXECUTE on create_order_internal');
select ok(has_function_privilege('postgres','public.create_order_internal(jsonb,uuid,public.actor_type,text)','EXECUTE'),'postgres (owner) retains EXECUTE on create_order_internal');

set local role anon;
select throws_ok($$select public.create_order_internal('{}'::jsonb, null, 'CUSTOMER'::public.actor_type, 'guest')$$, '42501', null, 'anon cannot actually execute create_order_internal directly');
reset role;
set local role authenticated;
select throws_ok($$select public.create_order_internal('{}'::jsonb, null, 'CUSTOMER'::public.actor_type, 'guest')$$, '42501', null, 'authenticated cannot actually execute create_order_internal directly');
reset role;
set local role service_role;
select throws_ok($$select public.create_order_internal('{}'::jsonb, null, 'CUSTOMER'::public.actor_type, 'guest')$$, '42501', null, 'service_role cannot actually execute create_order_internal directly');
reset role;

-- ensure_current_customer / create_customer_order grants match intent
select ok(not has_function_privilege('anon','public.ensure_current_customer()','EXECUTE'),'anon has no EXECUTE on ensure_current_customer');
select ok(has_function_privilege('authenticated','public.ensure_current_customer()','EXECUTE'),'authenticated has EXECUTE on ensure_current_customer');
select ok(not has_function_privilege('anon','public.create_customer_order(jsonb)','EXECUTE'),'anon has no EXECUTE on create_customer_order');
select ok(has_function_privilege('authenticated','public.create_customer_order(jsonb)','EXECUTE'),'authenticated has EXECUTE on create_customer_order');

-- create_public_order retains its exact existing public signature/grants
select ok(has_function_privilege('anon','public.create_public_order(jsonb)','EXECUTE'),'anon retains EXECUTE on create_public_order (unchanged)');
select ok(has_function_privilege('authenticated','public.create_public_order(jsonb)','EXECUTE'),'authenticated retains EXECUTE on create_public_order (unchanged)');

-- ============================================================
-- Section 6: customer_auth_required rollout flag -- server-side enforcement
-- ============================================================
update public.delivery_settings set customer_auth_required=false where id=true;
select is((select customer_auth_required from public.delivery_settings where id=true),false,'customer_auth_required defaults to false');

-- --- flag=false: existing behavior fully preserved ---
set local role anon;
select lives_ok($$select public.create_public_order('{"id":"90000000-0000-4000-8000-00000000fa01","customer":{"name":"Flag Off Anon","primaryPhone":"+998900000501"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'flag=false: anon create_public_order succeeds');
reset role;
select is((select customer_id from public.orders where id='90000000-0000-4000-8000-00000000fa01'),null,'flag=false: anonymous order has customer_id IS NULL');
select is((select actor_type::text from public.order_events where order_id='90000000-0000-4000-8000-00000000fa01' and new_status='NEW'),'CUSTOMER','flag=false: anonymous initial actor remains CUSTOMER');
select is((select actor_id from public.order_events where order_id='90000000-0000-4000-8000-00000000fa01' and new_status='NEW'),'guest','flag=false: anonymous initial actor remains guest');

select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
set local role authenticated;
select lives_ok($$select public.create_public_order('{"id":"90000000-0000-4000-8000-00000000fa02","customer":{"name":"Flag Off Authenticated","primaryPhone":"+998900000502"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'flag=false: an authenticated caller invoking create_public_order directly retains backward compatibility');
reset role;

-- --- flag=true: legacy/anonymous creation is rejected server-side, at the
-- RPC layer, independent of which Postgres role is calling ---
update public.delivery_settings set customer_auth_required=true where id=true;

set local role anon;
select throws_ok($$select public.create_public_order('{"id":"90000000-0000-4000-8000-00000000fa03","customer":{"name":"Flag On Anon","primaryPhone":"+998900000503"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'42501','CUSTOMER_AUTH_REQUIRED|Buyurtma berish uchun telefon raqamingizni tasdiqlang','flag=true: anon create_public_order is rejected server-side');
reset role;
select is((select count(*)::integer from public.orders where id='90000000-0000-4000-8000-00000000fa03'),0,'flag=true: the rejected anon attempt created no order');

select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
set local role authenticated;
select throws_ok($$select public.create_public_order('{"id":"90000000-0000-4000-8000-00000000fa04","customer":{"name":"Flag On Authenticated","primaryPhone":"+998900000504"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'42501','CUSTOMER_AUTH_REQUIRED|Buyurtma berish uchun telefon raqamingizni tasdiqlang','flag=true: an ordinary authenticated caller invoking create_public_order directly is also rejected');
select throws_ok($$select public.create_order('{"id":"90000000-0000-4000-8000-00000000fa05","customer":{"name":"Flag On Legacy","primaryPhone":"+998900000505"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'42501','CUSTOMER_AUTH_REQUIRED|Buyurtma berish uchun telefon raqamingizni tasdiqlang','flag=true: legacy create_order cannot bypass the flag (it delegates to the same guarded wrapper)');
reset role;

set local role anon;
select throws_ok($$select public.create_order('{"id":"90000000-0000-4000-8000-00000000fa06","customer":{"name":"Flag On Legacy Anon","primaryPhone":"+998900000506"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'42501','CUSTOMER_AUTH_REQUIRED|Buyurtma berish uchun telefon raqamingizni tasdiqlang','flag=true: legacy create_order also rejects an anonymous caller');
reset role;

-- --- flag=true: the authenticated customer path still works ---
insert into auth.users(instance_id,id,aud,role,phone,encrypted_password,phone_confirmed_at,raw_app_meta_data,raw_user_meta_data)
values ('00000000-0000-0000-0000-000000000000','90000000-0000-0000-0000-0000000000fa','authenticated','authenticated','998907700000',crypt('x',gen_salt('bf')),now(),'{"provider":"phone"}','{}');
select set_config('request.jwt.claim.sub','90000000-0000-0000-0000-0000000000fa',true);
set local role authenticated;
select lives_ok($$select public.create_customer_order('{"id":"90000000-0000-4000-8000-00000000fa07","customer":{"name":"Flag On Real Customer","primaryPhone":"+998900000000"},"type":"PICKUP","paymentMethod":"CASH","items":[{"menuItemId":"plov","quantity":1,"modifierIds":[]}]}'::jsonb)$$,'flag=true: authenticated create_customer_order still succeeds');
reset role;
select is((select customer_id from public.orders where id='90000000-0000-4000-8000-00000000fa07'),(select id from public.customers where auth_user_id='90000000-0000-0000-0000-0000000000fa'),'flag=true: resulting order has the real, server-resolved customer_id');
select is((select primary_phone from public.orders where id='90000000-0000-4000-8000-00000000fa07'),'+998907700000','flag=true: canonical verified phone is used, not the client-supplied one');
select is((select actor_type::text from public.order_events where order_id='90000000-0000-4000-8000-00000000fa07' and new_status='NEW'),'CUSTOMER','flag=true: initial actor_type is CUSTOMER');
select is((select actor_id from public.order_events where order_id='90000000-0000-4000-8000-00000000fa07' and new_status='NEW'),'90000000-0000-0000-0000-0000000000fa','flag=true: initial actor_id is the authenticated customer''s real auth uid');

-- Explicit reset, belt-and-braces alongside the transaction rollback below.
update public.delivery_settings set customer_auth_required=false where id=true;
select is((select customer_auth_required from public.delivery_settings where id=true),false,'customer_auth_required is reset to false at the end of this test');

select * from finish();
rollback;
