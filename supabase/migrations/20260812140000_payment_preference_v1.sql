-- Payment Preference v1 (deliberately simple -- NOT online payment
-- integration; see task spec). CLICK/PAYME record only that the customer
-- *intends* to pay by that method; the restaurant confirms the order and
-- verifies receipt operationally afterwards. Two narrow changes, both
-- `create or replace function` reproducing the current byte-identical body
-- from source (not from memory) with exactly one line changed each:
--
-- 1. create_order_internal (current body: 20260810100100) -- the
--    paymentMethod parser whitelist now also accepts CLICK/PAYME. This
--    alone does not make CLICK/PAYME selectable: the
--    enforce_order_configuration() trigger (current body: 20260806100000)
--    separately gates every insert against
--    delivery_settings.delivery_payment_methods/pickup_payment_methods,
--    which is unchanged here -- production's delivery_payment_methods stays
--    ['CASH'] until a separate, later config change explicitly opts in.
--    Local/dev config (supabase/seed.sql, src/data.ts) is updated
--    separately to include CLICK/PAYME so this can be exercised end to end
--    locally and in tests.
--
-- 2. transition_order (current body: 20260806100000) -- today, reaching
--    DELIVERED or COLLECTED unconditionally flips payment_status to
--    'COLLECTED' regardless of payment_method. That is correct for CASH,
--    CARD_ON_DELIVERY and CARD_AT_PICKUP (payment completes physically at
--    that exact moment), but would be wrong for CLICK/PAYME (a remote
--    transfer the restaurant must separately verify) -- it would silently
--    mark a merely-*intended* payment as received. Narrowed to exclude
--    CLICK/PAYME, which stay at their existing payment_status (PENDING by
--    the orders table's own default) until staff verify receipt through
--    some other, already-existing mechanism (order_events/notes) -- this
--    migration does not add a new payment_status value or a "mark verified"
--    action, since PENDING already models "not yet collected" and no
--    stricter state machine is required for this pass.

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
  if p_order->>'paymentMethod' not in ('CASH','CARD_ON_DELIVERY','CARD_AT_PICKUP','CLICK','PAYME') then
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
      oid, trim(address_data->>'district'), trim(address_data->>'street'), coalesce(trim(address_data->>'house'), ''),
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

-- transition_order (current body: 20260806100000): only CASH,
-- CARD_ON_DELIVERY and CARD_AT_PICKUP auto-collect on DELIVERED/COLLECTED --
-- CLICK/PAYME keep whatever payment_status they already had (PENDING by
-- default) until staff verify receipt through some other means. Every other
-- line reproduced byte-identical from source.
create or replace function public.transition_order(p_order_id uuid,p_new_status public.order_status,p_reason text default null,p_notes text default null)
returns public.orders language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders; old public.order_status; app_role public.app_role; actor public.actor_type;
begin
  app_role:=public.current_app_role(); if app_role is null then raise exception 'AUTHENTICATION_REQUIRED|Xodim hisobi bilan kiring' using errcode='42501'; end if;
  select * into o from public.orders where id=p_order_id for update; if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi'; end if; old:=o.status;
  if o.order_type='DELIVERY' and o.delivery_review_status<>'APPROVED' and p_new_status not in('REJECTED','CANCELLED') then raise exception 'DELIVERY_REVIEW_REQUIRED|Avval yetkazish manzilini tasdiqlang' using errcode='42501'; end if;
  if o.order_type='PICKUP' and p_new_status in('DRIVER_ASSIGNED','PICKED_UP','ON_THE_WAY','ARRIVED','DELIVERED','DELIVERY_FAILED','RETURNED') then raise exception 'PICKUP_TRANSITION_FORBIDDEN|Olib ketish buyurtmasi haydovchi bosqichiga o‘tmaydi' using errcode='42501'; end if;
  if o.order_type='DELIVERY' and p_new_status='COLLECTED' then raise exception 'DELIVERY_TRANSITION_FORBIDDEN|Yetkazish buyurtmasi olib ketildi deb belgilanmaydi' using errcode='42501'; end if;
  if app_role='DRIVER' then
    if o.order_type='PICKUP' then raise exception 'PICKUP_DRIVER_FORBIDDEN|Haydovchi olib ketish buyurtmasini boshqarmaydi' using errcode='42501'; end if;
    if o.assigned_driver_id is distinct from auth.uid() then raise exception 'DRIVER_NOT_ASSIGNED|Bu buyurtma sizga biriktirilmagan' using errcode='42501'; end if;
    if p_new_status not in('PICKED_UP','ON_THE_WAY','ARRIVED','DELIVERED','DELIVERY_FAILED','RETURNED') then raise exception 'DRIVER_TRANSITION_FORBIDDEN|Haydovchi bu holatni o‘zgartira olmaydi' using errcode='42501'; end if;
    if old='DRIVER_ASSIGNED' and p_new_status='PICKED_UP' and o.assignment_accepted_at is null then raise exception 'ASSIGNMENT_NOT_ACCEPTED|Avval topshiriqni qabul qiling' using errcode='42501'; end if; actor:='DRIVER';
  elsif app_role='DISPATCHER' then actor:='DISPATCHER'; elsif app_role='RESTAURANT' then actor:='RESTAURANT'; else raise exception 'AUTHORIZATION_REQUIRED|Xodim roli talab qilinadi' using errcode='42501'; end if;
  perform public.assert_transition(old,p_new_status);
  if p_new_status in('REJECTED','CANCELLED','DELIVERY_FAILED') and coalesce(trim(p_reason),'')='' then raise exception 'REASON_REQUIRED|Sababni kiriting'; end if;
  update public.orders set status=p_new_status,rejection_reason=case when p_new_status='REJECTED' then trim(p_reason) else rejection_reason end,cancellation_reason=case when p_new_status='CANCELLED' then trim(p_reason) else cancellation_reason end,payment_status=case when p_new_status in('DELIVERED','COLLECTED') and o.payment_method not in('CLICK','PAYME') then 'COLLECTED' else payment_status end where id=p_order_id returning * into o;
  insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status,reason,notes) values(p_order_id,actor,auth.uid()::text,old,p_new_status,nullif(trim(p_reason),''),nullif(trim(p_notes),''));
  if p_new_status in('DELIVERED','DELIVERY_FAILED','RETURNED','CANCELLED') and o.assigned_driver_id is not null then update public.drivers set availability='AVAILABLE' where id=o.assigned_driver_id;update public.driver_assignments set ended_at=now() where order_id=p_order_id;end if;
  return o;
end $$;
