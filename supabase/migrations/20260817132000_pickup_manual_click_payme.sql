-- Click and Payme are staff-confirmed manual transfers for both fulfillment
-- types. Terminal remains an offline pickup-only method.
update public.delivery_settings
set pickup_payment_methods=array['CASH','TERMINAL','CLICK','PAYME']::public.payment_method[],
    delivery_payment_methods=array['CASH','CLICK','PAYME']::public.payment_method[],
    updated_at=now()
where id=true;
