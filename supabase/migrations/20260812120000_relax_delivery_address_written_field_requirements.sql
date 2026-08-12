-- Zaytun Go Phase: Delivery Address + Pin Workflow Refinement.
--
-- The confirmed map pin is the primary geographic delivery-location
-- source; written address fields only need to give the courier enough
-- human-readable context, not duplicate what the pin already proves.
-- Narrows the INCOMPLETE_ADDRESS check in create_order_internal (called by
-- both create_public_order and create_customer_order) and in
-- revise_delivery_address so the backend never disagrees with the
-- frontend's new minimum contract (src/domain.ts validateDeliveryLocation):
-- district + street + a confirmed pin are required; house, landmark and
-- delivery notes become fully optional and independent of each other.
--
-- PIN_CONFIRMATION_REQUIRED, delivery-zone/minimum-order/fee admission
-- control, and every other check in both functions are byte-identical to
-- their previous versions (20260810100100_customer_order_creation.sql,
-- 20260809150000_delivery_revision_admission_control.sql) -- only the
-- address-completeness condition changes.
--
-- customer_addresses.house stays `text not null` at the schema level
-- (unchanged): the frontend already always sends house as a string, so an
-- empty '' satisfies NOT NULL without a schema/default change.

create or replace function public.create_order_internal(
  p_order jsonb,
  p_customer_id uuid,
  p_actor_type public.actor_type,
  p_actor_id text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  oid uuid;
  ikey uuid;
  oid_text text := nullif(p_order->>'id', '');
  ikey_text text := nullif(p_order->>'idempotencyKey', '');
  num text;
  subtotal_value bigint := 0;
  typ public.order_type;
  payment public.payment_method;
  address_data jsonb := p_order->'address';
  line jsonb;
  quote jsonb;
  existing public.orders;
  confidence public.address_confidence;
  menu_row public.menu_items;
  modifier_ids text[];
  modifier_names text[];
  modifier_total integer;
  modifier_count integer;
  quantity_value integer;
  unit_price_value integer;
  line_signature text;
  seen_signatures text[] := array[]::text[];
begin
  if p_order is null or jsonb_typeof(p_order) <> 'object' then
    raise exception 'INVALID_ORDER_PAYLOAD|Buyurtma ma’lumoti noto‘g‘ri' using errcode = '22023';
  end if;

  if oid_text is not null and oid_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'INVALID_ORDER_ID|Buyurtma identifikatori noto‘g‘ri' using errcode = '22023';
  end if;
  if ikey_text is not null and ikey_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'INVALID_IDEMPOTENCY_KEY|Takroriy so‘rov kaliti noto‘g‘ri' using errcode = '22023';
  end if;
  oid := coalesce(oid_text::uuid, extensions.gen_random_uuid());
  ikey := coalesce(ikey_text::uuid, oid);

  select * into existing from public.orders where idempotency_key = ikey;
  if found then
    return jsonb_build_object(
      'id', existing.id,
      'number', existing.number,
      'trackingToken', existing.tracking_token,
      'subtotal', existing.subtotal,
      'deliveryFee', existing.delivery_fee,
      'total', existing.total,
      'items', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', item.id, 'menuItemId', item.menu_item_id, 'name', item.name,
        'unitPrice', item.unit_price, 'quantity', item.quantity,
        'modifierIds', item.modifier_ids, 'modifierNames', item.modifier_names,
        'instructions', item.instructions, 'total', item.total
      ) order by item.id), '[]'::jsonb) from public.order_items item where item.order_id = existing.id)
    );
  end if;

  if p_order ?| array['subtotal','deliveryFee','total'] then
    raise exception 'CLIENT_PRICING_FIELDS_FORBIDDEN|Narx va jami summa server tomonidan hisoblanadi' using errcode = '22023';
  end if;
  if jsonb_typeof(p_order->'items') <> 'array' or jsonb_array_length(p_order->'items') not between 1 and 50 then
    raise exception 'INVALID_ITEMS|Buyurtmada 1–50 ta turdagi taom bo‘lishi kerak' using errcode = '22023';
  end if;
  if coalesce(trim(p_order#>>'{customer,name}'), '') = '' or length(trim(p_order#>>'{customer,name}')) > 120 then
    raise exception 'INVALID_CUSTOMER_NAME|Mijoz ismini to‘g‘ri kiriting' using errcode = '22023';
  end if;
  if coalesce(trim(p_order#>>'{customer,primaryPhone}'), '') !~ '^\+?[0-9 ()-]{9,24}$' then
    raise exception 'INVALID_CUSTOMER_PHONE|Telefon raqamini to‘g‘ri kiriting' using errcode = '22023';
  end if;
  if p_order->>'type' not in ('DELIVERY','PICKUP') then
    raise exception 'UNSUPPORTED_ORDER_TYPE|Buyurtma turini tanlang' using errcode = '22023';
  end if;
  typ := (p_order->>'type')::public.order_type;
  if p_order->>'paymentMethod' not in ('CASH','CARD_ON_DELIVERY','CARD_AT_PICKUP') then
    raise exception 'UNSUPPORTED_PAYMENT_METHOD|To‘lov usuli qo‘llab-quvvatlanmaydi' using errcode = '22023';
  end if;
  payment := (p_order->>'paymentMethod')::public.payment_method;

  for line in select value from jsonb_array_elements(p_order->'items') loop
    if jsonb_typeof(line) <> 'object' then
      raise exception 'MALFORMED_ITEM|Taom tanlovi noto‘g‘ri' using errcode = '22023';
    end if;
    if line ?| array['unitPrice','total','name','modifierNames'] then
      raise exception 'CLIENT_PRICING_FIELDS_FORBIDDEN|Taom narxi server tomonidan hisoblanadi' using errcode = '22023';
    end if;
    if coalesce(line->>'menuItemId', '') = '' then
      raise exception 'MENU_ITEM_REQUIRED|Taom identifikatori kerak' using errcode = '22023';
    end if;
    if coalesce(line->>'quantity', '') !~ '^[0-9]+$' then
      raise exception 'INVALID_QUANTITY|Taom miqdori butun son bo‘lishi kerak' using errcode = '22023';
    end if;
    quantity_value := (line->>'quantity')::integer;
    if quantity_value not between 1 and 50 then
      raise exception 'INVALID_QUANTITY|Taom miqdori 1–50 oralig‘ida bo‘lishi kerak' using errcode = '22023';
    end if;
    if line ? 'modifierIds' and jsonb_typeof(line->'modifierIds') <> 'array' then
      raise exception 'MALFORMED_MODIFIERS|Qo‘shimchalar ro‘yxati noto‘g‘ri' using errcode = '22023';
    end if;
    if exists(select 1 from jsonb_array_elements(coalesce(line->'modifierIds', '[]'::jsonb)) value where jsonb_typeof(value) <> 'string') then
      raise exception 'MALFORMED_MODIFIERS|Qo‘shimcha identifikatori noto‘g‘ri' using errcode = '22023';
    end if;
    modifier_ids := array(select jsonb_array_elements_text(coalesce(line->'modifierIds', '[]'::jsonb)));
    if cardinality(modifier_ids) <> (select count(distinct value) from unnest(modifier_ids) value) then
      raise exception 'DUPLICATE_MODIFIER|Bir qo‘shimcha takror tanlangan' using errcode = '22023';
    end if;

    select * into menu_row
    from public.menu_items item
    where item.id = line->>'menuItemId' and item.available
      and exists(select 1 from public.menu_categories category where category.id = item.category_id and category.active)
    for share;
    if not found then
      raise exception 'MENU_ITEM_UNAVAILABLE|Tanlangan taom mavjud emas' using errcode = '22023';
    end if;

    if exists(select 1 from unnest(modifier_ids) selected join public.menu_modifiers modifier on modifier.id = selected where modifier.menu_item_id <> menu_row.id) then
      raise exception 'MODIFIER_ITEM_MISMATCH|Qo‘shimcha boshqa taomga tegishli' using errcode = '22023';
    end if;
    if exists(select 1 from unnest(modifier_ids) selected join public.menu_modifiers modifier on modifier.id = selected where not modifier.available) then
      raise exception 'MODIFIER_UNAVAILABLE|Tanlangan qo‘shimcha mavjud emas' using errcode = '22023';
    end if;
    select count(*), coalesce(sum(modifier.price), 0), coalesce(array_agg(modifier.name order by modifier.id), '{}')
      into modifier_count, modifier_total, modifier_names
    from public.menu_modifiers modifier
    where modifier.id = any(modifier_ids) and modifier.menu_item_id = menu_row.id and modifier.available;
    if modifier_count <> cardinality(modifier_ids) then
      raise exception 'INVALID_MODIFIER|Tanlangan qo‘shimcha topilmadi' using errcode = '22023';
    end if;

    line_signature := menu_row.id || ':' || coalesce((select string_agg(value, ',' order by value) from unnest(modifier_ids) value), '');
    if line_signature = any(seen_signatures) then
      raise exception 'DUPLICATE_ITEM_SELECTION|Bir xil taom tanlovi takrorlangan' using errcode = '22023';
    end if;
    seen_signatures := array_append(seen_signatures, line_signature);
    unit_price_value := menu_row.price + modifier_total;
    subtotal_value := subtotal_value + unit_price_value::bigint * quantity_value;
    if subtotal_value > 2000000000 then
      raise exception 'ORDER_TOTAL_TOO_LARGE|Buyurtma summasi juda katta' using errcode = '22023';
    end if;
  end loop;

  -- Minimum written-address contract: district + street only. The
  -- confirmed pin (checked separately below) is the primary geographic
  -- source; house/landmark/deliveryNotes are optional courier context.
  if typ = 'DELIVERY' and (
    jsonb_typeof(address_data) <> 'object' or
    coalesce(trim(address_data->>'district'), '') = '' or
    coalesce(trim(address_data->>'street'), '') = ''
  ) then
    raise exception 'INCOMPLETE_ADDRESS|Mahalla/tuman va ko‘cha/joylashuvni kiriting' using errcode = '22023';
  end if;
  if typ = 'DELIVERY' and address_data->>'pinConfirmedAt' is null then
    raise exception 'PIN_CONFIRMATION_REQUIRED|Yetkazish pinini tasdiqlang' using errcode = '22023';
  end if;

  quote := public.calculate_delivery_quote(
    case when typ = 'DELIVERY' then (address_data->>'latitude')::double precision end,
    case when typ = 'DELIVERY' then (address_data->>'longitude')::double precision end,
    subtotal_value::integer,
    typ
  );
  if not (quote->>'eligible')::boolean then
    if quote->>'zoneResult' = 'DELIVERY_DISABLED' then
      raise exception 'DELIVERY_DISABLED|Yetkazib berish vaqtincha o‘chirilgan';
    elsif subtotal_value < (quote->>'minimumOrder')::integer then
      raise exception 'MINIMUM_ORDER_NOT_MET|%', quote->>'message';
    else
      raise exception 'DELIVERY_OUTSIDE_ZONE|Bu manzil yetkazish hududidan tashqarida';
    end if;
  end if;
  confidence := case
    when typ = 'DELIVERY' and address_data->>'confidence' = 'NEEDS_CLARIFICATION' then 'NEEDS_CLARIFICATION'::public.address_confidence
    when typ = 'DELIVERY' then 'COMPLETE'::public.address_confidence
    else null
  end;

  num := 'ZG-' || lpad(nextval('public.order_number_seq')::text, 4, '0');
  insert into public.orders(
    id, idempotency_key, number, customer_name, primary_phone, secondary_phone,
    order_type, payment_method, special_instructions, subtotal, delivery_fee,
    customer_id
  ) values (
    oid, ikey, num, trim(p_order#>>'{customer,name}'), trim(p_order#>>'{customer,primaryPhone}'),
    nullif(trim(p_order#>>'{customer,secondaryPhone}'), ''), typ, payment,
    left(coalesce(p_order->>'specialInstructions', ''), 1000), subtotal_value::integer,
    (quote->>'deliveryFee')::integer,
    p_customer_id
  );

  if typ = 'DELIVERY' then
    insert into public.customer_addresses(
      order_id, district, street, house, entrance, floor, apartment, landmark,
      delivery_notes, latitude, longitude, confidence, pin_confirmed_at,
      location_provider, provider_place_id, provider_formatted_address,
      delivery_distance_km, delivery_zone_result
    ) values (
      oid, trim(address_data->>'district'), trim(address_data->>'street'),
      coalesce(trim(address_data->>'house'), ''),
      nullif(trim(address_data->>'entrance'), ''), nullif(trim(address_data->>'floor'), ''),
      nullif(trim(address_data->>'apartment'), ''), coalesce(trim(address_data->>'landmark'), ''),
      coalesce(trim(address_data->>'deliveryNotes'), ''), (address_data->>'latitude')::double precision,
      (address_data->>'longitude')::double precision, confidence, (address_data->>'pinConfirmedAt')::timestamptz,
      case when address_data->>'locationProvider' in ('mock','yandex') then address_data->>'locationProvider' else null end,
      nullif(address_data->>'providerPlaceId', ''), nullif(address_data->>'providerFormattedAddress', ''),
      (quote->>'distanceKm')::numeric, (quote->>'zoneResult')::public.delivery_zone_result
    );
  end if;

  for line in select value from jsonb_array_elements(p_order->'items') loop
    quantity_value := (line->>'quantity')::integer;
    modifier_ids := array(select jsonb_array_elements_text(coalesce(line->'modifierIds', '[]'::jsonb)));
    select * into strict menu_row from public.menu_items item where item.id = line->>'menuItemId' for share;
    select coalesce(sum(modifier.price), 0), coalesce(array_agg(modifier.name order by modifier.id), '{}')
      into modifier_total, modifier_names
    from public.menu_modifiers modifier where modifier.id = any(modifier_ids);
    unit_price_value := menu_row.price + modifier_total;
    insert into public.order_items(
      order_id, menu_item_id, name, unit_price, quantity, modifier_ids,
      modifier_names, instructions
    ) values (
      oid, menu_row.id, menu_row.name, unit_price_value, quantity_value,
      modifier_ids, modifier_names, left(coalesce(line->>'instructions', ''), 500)
    );
  end loop;

  insert into public.order_events(order_id, actor_type, actor_id, new_status, notes)
  values (oid, p_actor_type, p_actor_id, 'NEW', format('Pin confirmed via %s', coalesce(address_data->>'locationProvider', 'pickup')));

  return jsonb_build_object(
    'id', oid,
    'number', num,
    'trackingToken', (select tracking_token from public.orders where id = oid),
    'subtotal', subtotal_value,
    'deliveryFee', (quote->>'deliveryFee')::integer,
    'total', subtotal_value + (quote->>'deliveryFee')::integer,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', item.id, 'menuItemId', item.menu_item_id, 'name', item.name,
      'unitPrice', item.unit_price, 'quantity', item.quantity,
      'modifierIds', item.modifier_ids, 'modifierNames', item.modifier_names,
      'instructions', item.instructions, 'total', item.total
    ) order by item.id), '[]'::jsonb) from public.order_items item where item.order_id = oid)
  );
exception
  when unique_violation then
    select * into existing from public.orders where idempotency_key = ikey;
    if found then
      return jsonb_build_object(
        'id', existing.id, 'number', existing.number, 'trackingToken', existing.tracking_token,
        'subtotal', existing.subtotal, 'deliveryFee', existing.delivery_fee, 'total', existing.total,
        'items', (select coalesce(jsonb_agg(jsonb_build_object(
          'id', item.id, 'menuItemId', item.menu_item_id, 'name', item.name,
          'unitPrice', item.unit_price, 'quantity', item.quantity,
          'modifierIds', item.modifier_ids, 'modifierNames', item.modifier_names,
          'instructions', item.instructions, 'total', item.total
        ) order by item.id), '[]'::jsonb) from public.order_items item where item.order_id = existing.id)
      );
    end if;
    raise;
end
$$;

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
  -- Minimum written-address contract: district + street only, matching
  -- create_order_internal exactly (see 20260812120000).
  if coalesce(p_address->>'district','')='' or coalesce(p_address->>'street','')='' then
    raise exception 'INCOMPLETE_ADDRESS|Mahalla/tuman va ko‘cha/joylashuvni kiriting' using errcode='22023';
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
    house=coalesce(p_address->>'house',''),
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
