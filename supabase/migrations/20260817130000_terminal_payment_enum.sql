-- Preserve legacy CARD_AT_PICKUP rows while introducing the explicit launch term.
alter type public.payment_method add value if not exists 'TERMINAL';
alter type public.payment_collection_status add value if not exists 'CONFIRMED';
