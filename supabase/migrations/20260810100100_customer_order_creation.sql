-- Authenticated Customer Foundation, Phase 1, migration 2: customer identity
-- resolution and authenticated order creation. Extracts the shared
-- validation/pricing/order-insert logic of the current
-- public.create_public_order (final body: 20260804190000, patched in place
-- by 20260806100000 to accept CARD_AT_PICKUP -- inspected directly from
-- source for this migration, not reimplemented from memory) into an
-- owner-only internal primitive, then re-expresses create_public_order as a
-- thin wrapper with byte-identical external behavior, and adds a new
-- authenticated create_customer_order wrapper alongside it.
--
-- ACL WARNING: see docs/production-readiness.md ("Default-ACL exposure" section). Production auto-grants
-- EXECUTE on every new function to anon/authenticated/service_role unless
-- explicitly revoked by named role. create_order_internal below is
-- revoked from all four (public, anon, authenticated, service_role) and
-- never re-granted -- only its two SECURITY DEFINER wrapper callers can
-- reach it, since each SECURITY DEFINER function runs as its own owner
-- regardless of the caller's grants on the function it calls.

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

  if typ = 'DELIVERY' and (
    jsonb_typeof(address_data) <> 'object' or
    coalesce(trim(address_data->>'district'), '') = '' or
    coalesce(trim(address_data->>'street'), '') = '' or
    coalesce(trim(address_data->>'house'), '') = '' or
    (coalesce(trim(address_data->>'landmark'), '') = '' and coalesce(trim(address_data->>'deliveryNotes'), '') = '')
  ) then
    raise exception 'INCOMPLETE_ADDRESS|Yozma yetkazish manzilini to‘liq kiriting' using errcode = '22023';
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
      oid, trim(address_data->>'district'), trim(address_data->>'street'), trim(address_data->>'house'),
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

-- Owner-only. No role, anywhere, may call this directly -- only the two
-- SECURITY DEFINER wrappers below can reach it.
revoke all on function public.create_order_internal(jsonb, uuid, public.actor_type, text)
  from public, anon, authenticated, service_role;

-- Public/anonymous wrapper. Exact existing signature and grants (still
-- callable by anon and authenticated -- rollout is a runtime admission
-- check, not a grant change). Behavior while customer_auth_required=false
-- is byte-identical to before: customer_id is always null, actor remains
-- ('CUSTOMER','guest'). This is a SECURITY DEFINER admission boundary: the
-- rollout policy is enforced HERE, not in create_order_internal, which
-- stays unaware of it and reusable by both this wrapper and
-- create_customer_order. Enforcement is server-side and independent of
-- caller role, so it cannot be bypassed by calling this RPC directly with
-- any Postgres role that holds EXECUTE.
create or replace function public.create_public_order(p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  settings public.delivery_settings;
begin
  select * into settings from public.delivery_settings where id = true;
  if settings.customer_auth_required then
    raise exception 'CUSTOMER_AUTH_REQUIRED|Buyurtma berish uchun telefon raqamingizni tasdiqlang' using errcode = '42501';
  end if;
  return public.create_order_internal(p_order, null, 'CUSTOMER', 'guest');
end;
$$;
revoke execute on function public.create_public_order(jsonb) from public;
grant execute on function public.create_public_order(jsonb) to anon, authenticated;

create or replace function public.create_order(p_order jsonb)
returns jsonb
language sql
security definer
set search_path = pg_catalog, public
as $$ select public.create_public_order(p_order) $$;
revoke execute on function public.create_order(jsonb) from public;
grant execute on function public.create_order(jsonb) to anon, authenticated;

-- Idempotent, fail-closed customer identity resolution. Never silently
-- merges or reassigns an existing customer identity: the case analysis
-- below covers every combination of an existing row matched by auth_user_id
-- vs. by phone, with an unclaimed (auth_user_id IS NULL) row eligible to be
-- linked but a row already claimed by a different auth user always
-- rejected.
create or replace function public.ensure_current_customer()
returns public.customers
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  c public.customers;
  by_phone public.customers;
  raw_phone text;
  phone_confirmed timestamptz;
  verified_phone text;
begin
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED|Kirish talab qilinadi' using errcode = '28000';
  end if;

  select phone, phone_confirmed_at into raw_phone, phone_confirmed from auth.users where id = auth.uid();
  -- "Verified" means: present, confirmed (phone_confirmed_at is not null --
  -- an unconfirmed phone on the auth.users row is not proof of anything),
  -- and a genuinely Uzbek mobile number in GoTrue's bare-digit storage form
  -- (998 + 9 digits, confirmed empirically to be how GoTrue stores it).
  -- Anything else -- absent, unconfirmed, malformed, or a non-998 country
  -- code -- fails closed as PHONE_NOT_VERIFIED; this function must never
  -- let an unverified or non-canonical value reach customers.phone_e164.
  if coalesce(raw_phone, '') = '' or phone_confirmed is null or raw_phone !~ '^998[0-9]{9}$' then
    raise exception 'PHONE_NOT_VERIFIED|Telefon raqami tasdiqlanmagan' using errcode = '22023';
  end if;
  verified_phone := '+' || raw_phone;

  -- Case A: a customer row is already linked to this exact auth user.
  select * into c from public.customers where auth_user_id = auth.uid();
  if found then
    if c.phone_e164 = verified_phone then
      return c; -- A1: nothing changed
    end if;
    -- A2: this auth user's verified phone changed since we last recorded
    -- it (e.g. they re-verified a new number in Supabase Auth). Refresh
    -- our own row's phone, but only if the new phone isn't already owned
    -- by a different customer -- this is a self-update, never a merge.
    select * into by_phone from public.customers where phone_e164 = verified_phone;
    if found and by_phone.id <> c.id then
      raise exception 'CUSTOMER_PHONE_ALREADY_IN_USE|Bu telefon raqami boshqa hisobga tegishli' using errcode = '23505';
    end if;
    update public.customers set phone_e164 = verified_phone, updated_at = now()
      where id = c.id returning * into c;
    return c;
  end if;

  -- No row linked to this auth user yet -- look up by the verified phone.
  select * into by_phone from public.customers where phone_e164 = verified_phone;
  if found then
    if by_phone.auth_user_id is null then
      -- Case B: a pre-existing identity (e.g. a future Telegram-first
      -- signup) with no auth link yet -- this login may claim it.
      update public.customers set auth_user_id = auth.uid(), updated_at = now()
        where id = by_phone.id returning * into c;
      return c;
    else
      -- Case C: this phone already belongs to a DIFFERENT, non-null auth
      -- user. Never silently steal/reassign -- fail closed.
      raise exception 'CUSTOMER_PHONE_CONFLICT|Bu telefon raqami allaqachon boshqa hisobga bog‘langan' using errcode = '23505';
    end if;
  end if;

  -- Case D: brand-new identity.
  insert into public.customers(auth_user_id, phone_e164)
  values (auth.uid(), verified_phone)
  returning * into c;
  return c;
end;
$$;
revoke all on function public.ensure_current_customer() from public, anon, authenticated, service_role;
grant execute on function public.ensure_current_customer() to authenticated;

-- Authenticated wrapper. Requires a session, resolves the canonical
-- customer via ensure_current_customer() (never trusts a browser-supplied
-- customer id), overrides the order payload's customer phone with the
-- verified canonical phone, and sets customer_id in the initial INSERT
-- (not a follow-up UPDATE) via create_order_internal.
create or replace function public.create_customer_order(p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  c public.customers;
  patched_order jsonb;
begin
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED|Buyurtma berish uchun tizimga kiring' using errcode = '28000';
  end if;
  c := public.ensure_current_customer();
  patched_order := jsonb_set(coalesce(p_order, '{}'::jsonb), '{customer,primaryPhone}', to_jsonb(c.phone_e164));
  return public.create_order_internal(patched_order, c.id, 'CUSTOMER', auth.uid()::text);
end;
$$;
revoke all on function public.create_customer_order(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.create_customer_order(jsonb) to authenticated;
