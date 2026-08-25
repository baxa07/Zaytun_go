-- A Telegram chat id is an operational delivery destination, not public
-- branch metadata. The column was added after the original table-level
-- SELECT grant, so narrow that grant to the customer-safe branch fields.
-- Service-role Edge Functions retain their server-side access.

revoke select on public.branches from anon, authenticated;

grant select (
  id,
  name,
  slug,
  address,
  latitude,
  longitude,
  active,
  created_at,
  updated_at
) on public.branches to anon, authenticated;
