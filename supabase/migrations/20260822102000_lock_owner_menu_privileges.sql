-- Default table grants include non-DML privileges that browser roles do not
-- need. Keep menu writes RPC-only and the audit log strictly read-only.
revoke all privileges on table public.menu_items from public,anon,authenticated;
grant select on table public.menu_items to anon,authenticated;

revoke all privileges on table public.menu_audit_log from public,anon,authenticated;
grant select on table public.menu_audit_log to authenticated;
