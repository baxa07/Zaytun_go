-- PostgreSQL requires newly added enum values to commit before they are used.
alter type public.payment_method add value if not exists 'CARD_AT_PICKUP';
alter type public.order_status add value if not exists 'COLLECTED';
