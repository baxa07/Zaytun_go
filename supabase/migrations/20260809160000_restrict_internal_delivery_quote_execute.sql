-- Privilege-only emergency hotfix. calculate_delivery_quote_internal(...)
-- (introduced in 20260809150000) was found to be directly EXECUTE-able by
-- anon and authenticated on hosted Supabase, contradicting its trusted-
-- internal-only design intent. This project has two pre-existing default-
-- ACL rules on the public schema (one owned by supabase_admin, one by
-- postgres — both predate this hotfix, e.g. the postgres-owned one from
-- 20260805191000_manual_delivery_review.sql's
-- "ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon/authenticated/
-- service_role") that automatically grant EXECUTE to anon/authenticated/
-- service_role on every new function created by postgres or supabase_admin
-- in schema public. "REVOKE ... FROM PUBLIC" does not undo these: it only
-- revokes the implicit PUBLIC-pseudo-role privilege, not privileges
-- explicitly granted to a named role via a default-ACL rule.
--
-- This migration performs explicit named-role revocations only. It does
-- not redefine the function body, does not touch revise_delivery_address,
-- does not touch tables/RLS/config, and does not alter the project's
-- default-ACL rules themselves — that broader question (should the
-- project-wide ALTER DEFAULT PRIVILEGES rule exist at all, and why local
-- doesn't reproduce it) is deliberately deferred to a separate security-
-- hardening audit of all public RPC grants, not folded into this narrow
-- emergency fix.
--
-- service_role is also revoked here: nothing in this codebase legitimately
-- calls this internal primitive directly via a service-role context either
-- (it is only ever invoked from inside other SECURITY DEFINER functions,
-- which execute as their owner, not as service_role) — a direct
-- service-role call path is equally an unintended bypass surface.
revoke execute on function public.calculate_delivery_quote_internal(double precision,double precision,integer,public.order_type,boolean) from public;
revoke execute on function public.calculate_delivery_quote_internal(double precision,double precision,integer,public.order_type,boolean) from anon;
revoke execute on function public.calculate_delivery_quote_internal(double precision,double precision,integer,public.order_type,boolean) from authenticated;
revoke execute on function public.calculate_delivery_quote_internal(double precision,double precision,integer,public.order_type,boolean) from service_role;
