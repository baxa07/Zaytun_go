-- delivery_enabled is admission control for NEW delivery order creation
-- (create_public_order). It must not strand an already-existing delivery
-- order's clarification/revision workflow if delivery is later disabled.
-- Extracts the shared quote/location computation into an internal
-- primitive parameterized by whether admission control applies, so the
-- distance/zone/fee/minimum-order math is not duplicated.
--
-- The public calculate_delivery_quote(...) contract, signature, and
-- behavior are unchanged: it becomes a thin wrapper that always enforces
-- admission control, exactly as before. create_public_order's admission
-- control for new DELIVERY orders is therefore untouched by this migration.
--
-- revise_delivery_address is the only caller that invokes the internal
-- primitive with admission control off, and only after it has already
-- verified: correct order id + tracking token match, order_type=DELIVERY,
-- status=NEW, delivery_review_status=CLARIFICATION_REQUESTED. Every other
-- delivery rule (coordinates, required fields, zone/minimum-order/fee via
-- the same shared computation) remains fully enforced for the revision.
--
-- No new public/anon-callable bypass surface is introduced: the internal
-- primitive is not granted to anon or authenticated (Postgres grants
-- EXECUTE to PUBLIC by default on function creation, so this is revoked
-- explicitly below) — a browser can never itself choose to skip admission
-- control, only trusted server-side logic inside revise_delivery_address
-- can, after it has already proven the checks above.

create or replace function public.calculate_delivery_quote_internal(
  p_latitude double precision,
  p_longitude double precision,
  p_subtotal integer,
  p_order_type public.order_type,
  p_enforce_admission boolean
) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare s public.delivery_settings; d double precision; fee integer;
begin
  if p_order_type='PICKUP' then return jsonb_build_object('eligible',true,'distanceKm',null,'deliveryFee',0,'zoneResult','ELIGIBLE','minimumOrder',0,'reviewRequired',false); end if;
  if p_latitude is null or p_longitude is null or p_latitude not between -90 and 90 or p_longitude not between -180 and 180 or (p_latitude=0 and p_longitude=0) then
    raise exception 'INVALID_COORDINATES|Xaritadan to‘g‘ri yetkazish nuqtasini tanlang' using errcode='22023';
  end if;
  select * into s from public.delivery_settings where id=true;
  if not found then raise exception 'DELIVERY_SETTINGS_UNAVAILABLE|Yetkazish sozlamalari vaqtincha mavjud emas'; end if;
  if p_enforce_admission and not s.delivery_enabled then return jsonb_build_object('eligible',false,'distanceKm',null,'deliveryFee',0,'zoneResult','DELIVERY_DISABLED','minimumOrder',s.minimum_delivery_order,'reviewRequired',false,'message','Yetkazib berish vaqtincha o‘chirilgan'); end if;
  d:=public.geographic_distance_km(s.restaurant_latitude,s.restaurant_longitude,p_latitude,p_longitude);
  if p_subtotal<s.minimum_delivery_order then return jsonb_build_object('eligible',false,'distanceKm',round(d::numeric,3),'deliveryFee',0,'zoneResult','ELIGIBLE','minimumOrder',s.minimum_delivery_order,'reviewRequired',s.delivery_policy_mode='MANUAL_CITY_REVIEW','message',format('Yetkazish uchun eng kam buyurtma %s so‘m',s.minimum_delivery_order)); end if;
  if s.delivery_policy_mode='MANUAL_CITY_REVIEW' then
    return jsonb_build_object('eligible',true,'distanceKm',round(d::numeric,3),'deliveryFee',0,'zoneResult','ELIGIBLE','minimumOrder',s.minimum_delivery_order,'reviewRequired',true,'message','Manzil operator tomonidan tasdiqlanadi');
  end if;
  fee:=case when s.free_delivery_threshold is not null and p_subtotal>=s.free_delivery_threshold then 0 else s.base_delivery_fee end;
  return jsonb_build_object('eligible',d<=s.maximum_delivery_radius_km and p_subtotal>=s.minimum_delivery_order,'distanceKm',round(d::numeric,3),'deliveryFee',fee,'zoneResult',case when d<=s.maximum_delivery_radius_km then 'ELIGIBLE' else 'OUTSIDE_ZONE' end,'minimumOrder',s.minimum_delivery_order,'reviewRequired',false,'message',case when d>s.maximum_delivery_radius_km then 'Bu manzil yetkazish hududidan tashqarida' end);
end $$;

revoke all on function public.calculate_delivery_quote_internal(double precision,double precision,integer,public.order_type,boolean) from public;

create or replace function public.calculate_delivery_quote(p_latitude double precision,p_longitude double precision,p_subtotal integer,p_order_type public.order_type)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  return public.calculate_delivery_quote_internal(p_latitude,p_longitude,p_subtotal,p_order_type,true);
end $$;

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
  -- Admission control (delivery_enabled) intentionally not enforced here:
  -- this order already exists and was already validated as DELIVERY at
  -- creation time. The global new-order switch must not strand its
  -- clarification loop. Every other delivery rule (coordinates, zone,
  -- minimum order, fee) remains fully enforced via the shared computation.
  q:=public.calculate_delivery_quote_internal((p_address->>'latitude')::double precision,(p_address->>'longitude')::double precision,o.subtotal,o.order_type,false);
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
