-- Authenticated Customer Foundation, Phase 1, migration 1: customer identity
-- schema only. Does not enable customer auth, does not touch checkout
-- behavior, does not create real customers. customer_auth_required defaults
-- false and is the sole rollout switch for a later, separate release gate.
--
-- ACL WARNING (see docs/production-readiness.md ("Default-ACL exposure" section) for the full inspection
-- query/results this migration accounts for): this project's hosted
-- production database carries pre-existing, out-of-band default-ACL rules
-- (not set by any migration -- confirmed via full git history search) that
-- auto-grant broad privileges to anon/authenticated/service_role on every
-- new table/function/sequence created by the `postgres` role, including
-- full INSERT/SELECT/UPDATE/DELETE on tables. Every object below is
-- explicitly revoked before any selective grant -- do not rely on RLS
-- alone, and do not infer safety from local behavior, since local does not
-- reproduce this rule.

create type public.customer_status as enum ('ACTIVE');

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  phone_e164 text unique not null,
  display_name text,
  status public.customer_status not null default 'ACTIVE',
  telegram_user_id bigint unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.customers is 'Canonical Zaytun customer identity. id is independent of auth.users.id by design: Telegram-only customers have no auth.users row, so a customer must be able to exist with auth_user_id null.';

-- No serial/identity column exists on this table (id uses gen_random_uuid()
-- as a column DEFAULT, not a sequence-backed `serial`/`bigserial`/`identity`
-- column), so CREATE TABLE creates no new sequence here. Asserted, not
-- assumed: the DO block below queries pg_sequences for anything owned by
-- this table and raises if it finds one, so a future edit that
-- accidentally introduces a serial column fails the migration loudly
-- instead of silently shipping an unaudited sequence default-ACL exposure.
do $$
declare seq_count integer;
begin
  select count(*) into seq_count
  from pg_sequences
  where schemaname = 'public'
    and sequencename in (
      select s.relname
      from pg_depend d
      join pg_class s on s.oid = d.objid and s.relkind = 'S'
      join pg_class t on t.oid = d.refobjid and t.relkind = 'r'
      where t.relname = 'customers' and d.deptype = 'a'
    );
  if seq_count <> 0 then
    raise exception 'ASSERTION_FAILED|customers table unexpectedly owns % sequence(s); Phase 1 assumed gen_random_uuid() with no identity/serial column', seq_count;
  end if;
end $$;

-- Explicit ACL hardening -- do not rely on inherited/default privilege
-- state. Mirrors the pattern already used for every other table in this
-- schema (20260803180000_zaytun_go_core.sql line 44), now confirmed
-- mandatory rather than precautionary (see the "Hosted default-ACL
-- exposure" section of docs/production-readiness.md). service_role is
-- included explicitly: this project's pre-existing tables (created before
-- Phase 1) never revoked service_role from the same hosted default-ACL
-- rule and still carry an inherited, undocumented full-CRUD grant on
-- production -- see the Phase 1 server-enforcement gate report. There is
-- no concrete requirement for service_role to touch this new table
-- directly (all customer writes go through SECURITY DEFINER functions
-- that run as their owner, not as service_role), so Phase 1 does not
-- repeat that gap here.
revoke all on public.customers from public, anon, authenticated, service_role;
grant select on public.customers to authenticated;
-- No INSERT/UPDATE/DELETE grant to anyone: all writes go exclusively
-- through ensure_current_customer() (migration 2), matching every other
-- table in this schema.

alter table public.customers enable row level security;
create policy customer_self_read on public.customers for select to authenticated
  using (auth_user_id = auth.uid() or public.is_staff());

alter table public.orders add column customer_id uuid references public.customers(id);
alter table public.delivery_settings add column customer_auth_required boolean not null default false;
comment on column public.delivery_settings.customer_auth_required is 'Rollout switch for authenticated-customer checkout. Must stay false until a separate, explicit release gate turns it on; Phase 1 ships this column at false and does not flip it.';

-- Additive customer-own read policies. These are separate CREATE POLICY
-- statements alongside the existing staff/driver policies (order_read,
-- address_read from 20260803180000) -- Postgres ORs multiple permissive
-- policies for the same command together, so staff and driver access is
-- completely unaffected; this only adds a new way in, never removes the
-- existing ones. customers.id is an independent UUID (not auth.users.id),
-- so the predicate must join through customers.auth_user_id rather than
-- comparing customer_id directly to auth.uid().
create policy customer_own_order_read on public.orders for select to authenticated
  using (exists (
    select 1 from public.customers c
    where c.id = orders.customer_id and c.auth_user_id = auth.uid()
  ));

create policy customer_own_address_read on public.customer_addresses for select to authenticated
  using (exists (
    select 1 from public.orders o
    join public.customers c on c.id = o.customer_id
    where o.id = customer_addresses.order_id and c.auth_user_id = auth.uid()
  ));
