-- Payment Preference v1: add CLICK and PAYME as new payment_method enum
-- values. This migration only extends the enum -- it does not change any
-- validation, trigger, or config-driven allowlist, so it is inert on its
-- own (no order can select CLICK/PAYME until a later migration both
-- accepts them in create_order_internal's parser AND a restaurant's
-- delivery_payment_methods array includes them).
--
-- PostgreSQL requires newly added enum values to commit before they are
-- used in a cast/comparison -- same reasoning as the existing
-- 20260806095900_pickup_enum_values.sql precedent -- so this stays its own
-- migration, separate from the one that references these values as literals.
alter type public.payment_method add value if not exists 'CLICK';
alter type public.payment_method add value if not exists 'PAYME';
