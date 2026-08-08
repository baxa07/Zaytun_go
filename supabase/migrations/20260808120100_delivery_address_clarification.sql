-- Non-terminal delivery address clarification loop. Extends the existing
-- binary review_delivery_request(approve|reject) model with a middle path:
-- REVIEW_REQUIRED -> CLARIFICATION_REQUESTED -> (customer revises) -> REVIEW_REQUIRED.
-- Terminal approve/reject behavior in review_delivery_request is unchanged.
-- Does not enable delivery, does not touch pickup, does not change delivery_enabled.

-- Staff: request clarification instead of rejecting a fixable address.
-- Mirrors review_delivery_request's authorization/locking/error-code conventions.
create or replace function public.request_delivery_clarification(p_order_id uuid, p_reason text)
returns public.orders language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders; role public.app_role; actor public.actor_type;
begin
  role:=public.current_app_role();
  if role is null or role not in ('RESTAURANT','DISPATCHER') then
    raise exception 'DELIVERY_CLARIFICATION_FORBIDDEN|Yetkazishni faqat restoran yoki dispatcher ko‘rib chiqadi' using errcode='42501';
  end if;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi'; end if;
  if o.order_type<>'DELIVERY' or o.delivery_review_status<>'REVIEW_REQUIRED' then
    raise exception 'DELIVERY_REVIEW_NOT_REQUIRED|Bu buyurtma ko‘rib chiqishni kutmayapti' using errcode='22023';
  end if;
  if o.status<>'NEW' then
    raise exception 'ORDER_NOT_AWAITING_REVIEW|Bu buyurtma endi kutish holatida emas' using errcode='22023';
  end if;
  if coalesce(trim(p_reason),'')='' then
    raise exception 'CLARIFICATION_REASON_REQUIRED|Aniqlashtirish sababini kiriting' using errcode='22023';
  end if;
  actor:=case when role='DISPATCHER' then 'DISPATCHER'::public.actor_type else 'RESTAURANT'::public.actor_type end;
  update public.orders set
    delivery_review_status='CLARIFICATION_REQUESTED',
    delivery_review_reason=trim(p_reason),
    delivery_reviewed_at=now(),
    delivery_reviewed_by=auth.uid()
  where id=p_order_id returning * into o;
  insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status,reason,notes)
  values(p_order_id,actor,auth.uid()::text,o.status,o.status,trim(p_reason),'DELIVERY_CLARIFICATION_REQUESTED');
  return o;
end $$;

-- Customer: revise the delivery-location fields of an order awaiting
-- clarification. Bearer-token authorized (order id + tracking token), same
-- trust model as get_order_tracking; no Auth signup required. Reuses
-- calculate_delivery_quote rather than duplicating eligibility/pricing logic.
-- Touches only customer_addresses and orders.delivery_review_*/delivery_fee;
-- never items, prices, subtotal, payment, customer identity, driver, or issues.
create or replace function public.revise_delivery_address(p_order_id uuid, p_tracking_token uuid, p_address jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders; q jsonb; next_confidence public.address_confidence;
begin
  select * into o from public.orders where id=p_order_id and tracking_token=p_tracking_token for update;
  if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma yoki kuzatuv kodi noto‘g‘ri'; end if;
  if o.order_type<>'DELIVERY' then
    raise exception 'PICKUP_ADDRESS_FORBIDDEN|Olib ketish buyurtmasida manzil yo‘q' using errcode='22023';
  end if;
  if o.delivery_review_status<>'CLARIFICATION_REQUESTED' or o.status<>'NEW' then
    raise exception 'ADDRESS_REVISION_NOT_ALLOWED|Bu manzilni hozir tahrirlab bo‘lmaydi' using errcode='22023';
  end if;
  if coalesce(p_address->>'district','')=''or coalesce(p_address->>'street','')=''or coalesce(p_address->>'house','')=''
     or(coalesce(p_address->>'landmark','')=''and coalesce(p_address->>'deliveryNotes','')='')then
    raise exception 'INCOMPLETE_ADDRESS|Yozma yetkazish manzilini to‘liq kiriting' using errcode='22023';
  end if;
  if p_address->>'pinConfirmedAt' is null then
    raise exception 'PIN_CONFIRMATION_REQUIRED|Yetkazish pinini tasdiqlang' using errcode='22023';
  end if;
  q:=public.calculate_delivery_quote((p_address->>'latitude')::double precision,(p_address->>'longitude')::double precision,o.subtotal,o.order_type);
  if not(q->>'eligible')::boolean then
    if q->>'zoneResult'='DELIVERY_DISABLED' then raise exception 'DELIVERY_DISABLED|Yetkazib berish vaqtincha o‘chirilgan' using errcode='22023';
    elsif o.subtotal<(q->>'minimumOrder')::integer then raise exception 'MINIMUM_ORDER_NOT_MET|%',q->>'message';
    else raise exception 'DELIVERY_OUTSIDE_ZONE|Bu manzil yetkazish hududidan tashqarida' using errcode='22023';
    end if;
  end if;
  next_confidence:=case when p_address->>'confidence'='NEEDS_CLARIFICATION' then 'NEEDS_CLARIFICATION'::public.address_confidence else 'COMPLETE'::public.address_confidence end;
  update public.customer_addresses set
    district=p_address->>'district',
    street=p_address->>'street',
    house=p_address->>'house',
    entrance=nullif(p_address->>'entrance',''),
    floor=nullif(p_address->>'floor',''),
    apartment=nullif(p_address->>'apartment',''),
    landmark=coalesce(p_address->>'landmark',''),
    delivery_notes=coalesce(p_address->>'deliveryNotes',''),
    latitude=(p_address->>'latitude')::double precision,
    longitude=(p_address->>'longitude')::double precision,
    confidence=next_confidence,
    pin_confirmed_at=(p_address->>'pinConfirmedAt')::timestamptz,
    location_provider=coalesce(p_address->>'locationProvider','yandex'),
    provider_place_id=nullif(p_address->>'providerPlaceId',''),
    provider_formatted_address=nullif(p_address->>'providerFormattedAddress',''),
    delivery_distance_km=(q->>'distanceKm')::numeric,
    delivery_zone_result=(q->>'zoneResult')::public.delivery_zone_result
  where order_id=p_order_id;
  update public.orders set
    delivery_review_status='REVIEW_REQUIRED',
    delivery_review_reason=null,
    delivery_reviewed_at=null,
    delivery_reviewed_by=null,
    delivery_fee=(q->>'deliveryFee')::integer
  where id=p_order_id;
  insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status,notes)
  values(p_order_id,'CUSTOMER','guest','NEW','NEW','DELIVERY_ADDRESS_REVISED');
  return public.get_order_tracking(p_order_id,p_tracking_token);
end $$;

revoke execute on function public.request_delivery_clarification(uuid,text) from public,anon;
grant execute on function public.request_delivery_clarification(uuid,text) to authenticated;
revoke execute on function public.revise_delivery_address(uuid,uuid,jsonb) from public;
grant execute on function public.revise_delivery_address(uuid,uuid,jsonb) to anon,authenticated;
