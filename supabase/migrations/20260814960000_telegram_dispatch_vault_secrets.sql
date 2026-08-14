-- Production hotfix: the restaurant-new-order AND customer-ARRIVED
-- Telegram paths share this ONE dispatch trigger (fires on every
-- notification_outbox insert regardless of channel), which was designed
-- to read its target URL/shared-secret from two custom GUCs
-- (app.settings.telegram_notify_url/telegram_notify_secret) via
-- `ALTER DATABASE ... SET ...`. On a hosted Supabase project that
-- statement requires a superuser-level connection this project's normal
-- operational access does not have (confirmed: attempting it here returns
-- "permission denied to set parameter"), and the dedicated
-- `postgres-config` management API only accepts a fixed allowlist of
-- standard postgresql.conf parameters, not arbitrary custom app.settings.*
-- keys -- so those two GUCs were never actually set on production. The
-- trigger's own "inert until configured" no-op guard has been silently
-- protecting against a missing configuration, not a deliberate off
-- switch: every notification_outbox row ever inserted (both channels)
-- has sat PENDING forever, confirmed by inspecting the live table
-- directly before this migration.
--
-- Fix: read the same two values from Supabase Vault instead of a custom
-- GUC. Vault is writable through the exact same connection this project's
-- normal migration/management access already has (verified), keeps the
-- actual secret out of git entirely (never embedded in a migration file),
-- and preserves the identical "inert by default" safety property in
-- every environment including local dev/CI -- a fresh `supabase db
-- reset` has an empty vault, so this trigger stays a safe no-op locally
-- exactly as before, with zero risk of a local test firing a real HTTP
-- request at production infrastructure. Only the secret-retrieval
-- mechanism changes; the dispatch logic, the trigger, and every other
-- function are untouched.
--
-- The two vault secrets themselves (telegram_notify_url,
-- telegram_notify_secret) are set out-of-band via `vault.create_secret`,
-- the same way TELEGRAM_BOT_TOKEN etc. are set via `supabase secrets set`
-- -- operational configuration, never committed to this repository.
create or replace function public.dispatch_notification_via_pg_net()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, net, vault
as $$
declare
  function_url text;
  shared_secret text;
begin
  if new.status <> 'PENDING' then
    return new;
  end if;
  select decrypted_secret into function_url from vault.decrypted_secrets where name = 'telegram_notify_url';
  select decrypted_secret into shared_secret from vault.decrypted_secrets where name = 'telegram_notify_secret';
  if coalesce(function_url, '') = '' or coalesce(shared_secret, '') = '' then
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
