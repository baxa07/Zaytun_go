-- PostgreSQL requires newly added enum values to commit before they are used.
-- This migration only extends delivery_review_status; it adds no columns,
-- functions, or behavior changes. See 20260808120100_delivery_address_clarification.sql.
alter type public.delivery_review_status add value if not exists 'CLARIFICATION_REQUESTED';
