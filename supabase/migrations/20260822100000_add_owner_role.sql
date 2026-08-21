-- OWNER is a distinct authoritative role. Kept separate because PostgreSQL
-- requires a newly-added enum value to commit before later migrations use it.
alter type public.app_role add value if not exists 'OWNER';
