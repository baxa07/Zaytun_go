-- Customer order recovery and authenticated Telegram linking.
-- This migration is intentionally rollout-safe: it does not enable Phone Auth
-- and does not flip delivery_settings.customer_auth_required.

alter table public.telegram_link_requests
  add column customer_id uuid references public.customers(id) on delete cascade;

create or replace function public.inherit_customer_telegram_destination()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if new.customer_id is not null and new.customer_telegram_chat_id is null then
    select telegram_user_id into new.customer_telegram_chat_id
    from public.customers where id=new.customer_id;
  end if;
  return new;
end $$;
create trigger orders_inherit_customer_telegram_destination
  before insert or update of customer_id on public.orders
  for each row execute function public.inherit_customer_telegram_destination();

create or replace function public.request_telegram_link(p_order_id uuid,p_tracking_token uuid)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders; new_token uuid;
begin
  select * into o from public.orders where id=p_order_id and tracking_token=p_tracking_token;
  if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma yoki kuzatuv kodi noto‘g‘ri' using errcode='P0001'; end if;
  if o.order_type<>'DELIVERY' then raise exception 'PICKUP_NO_ARRIVAL|Olib ketish buyurtmasida kuryer kelishi kuzatilmaydi' using errcode='22023'; end if;
  insert into public.telegram_link_requests(order_id,customer_id)
  values(o.id,o.customer_id) returning token into new_token;
  return new_token;
end $$;
revoke execute on function public.request_telegram_link(uuid,uuid) from public;
grant execute on function public.request_telegram_link(uuid,uuid) to anon,authenticated;

create or replace function public.get_my_order_tracking(p_order_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path=pg_catalog,public
as $$
declare
  o public.orders;
begin
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED|Telefon raqamingiz bilan kiring' using errcode='42501';
  end if;

  select orders.* into o
  from public.orders
  join public.customers on customers.id=orders.customer_id
  where orders.id=p_order_id and customers.auth_user_id=auth.uid();

  if not found then
    raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi' using errcode='P0001';
  end if;
  return public.get_order_tracking(o.id,o.tracking_token);
end $$;
revoke all on function public.get_my_order_tracking(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_my_order_tracking(uuid) to authenticated;

create or replace function public.request_my_telegram_link(p_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  o public.orders;
  new_token uuid;
begin
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED|Telefon raqamingiz bilan kiring' using errcode='42501';
  end if;

  select orders.* into o
  from public.orders
  join public.customers on customers.id=orders.customer_id
  where orders.id=p_order_id and customers.auth_user_id=auth.uid();

  if not found then
    raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi' using errcode='P0001';
  end if;
  if o.order_type<>'DELIVERY' then
    raise exception 'PICKUP_NO_ARRIVAL|Olib ketish buyurtmasida kuryer kelishi kuzatilmaydi' using errcode='22023';
  end if;

  insert into public.telegram_link_requests(order_id,customer_id)
  values(o.id,o.customer_id)
  returning token into new_token;
  return new_token;
end $$;
revoke all on function public.request_my_telegram_link(uuid) from public,anon,authenticated,service_role;
grant execute on function public.request_my_telegram_link(uuid) to authenticated;

-- The webhook calls this with Telegram-authored identity fields. It is the
-- only consumption path: private chat is mandatory, the token is consumed
-- atomically, and an existing customer mapping cannot be silently replaced.
create or replace function public.consume_customer_telegram_link(
  p_token uuid,
  p_chat_id bigint,
  p_telegram_user_id bigint,
  p_chat_type text
)
returns boolean
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare
  link public.telegram_link_requests;
  existing_telegram_user_id bigint;
begin
  if p_chat_type<>'private' or p_chat_id is distinct from p_telegram_user_id then
    return false;
  end if;

  select * into link
  from public.telegram_link_requests
  where token=p_token and consumed_at is null and expires_at>now()
  for update;
  if not found then return false; end if;

  if link.customer_id is not null then
    select telegram_user_id into existing_telegram_user_id
    from public.customers where id=link.customer_id for update;
    if existing_telegram_user_id is not null
       and existing_telegram_user_id is distinct from p_telegram_user_id then
      return false;
    end if;
    update public.customers
      set telegram_user_id=p_telegram_user_id,updated_at=now()
      where id=link.customer_id;
  end if;

  update public.orders set customer_telegram_chat_id=p_chat_id where id=link.order_id;
  update public.telegram_link_requests set consumed_at=now() where token=link.token;
  return true;
end $$;
revoke all on function public.consume_customer_telegram_link(uuid,bigint,bigint,text)
  from public,anon,authenticated;
grant execute on function public.consume_customer_telegram_link(uuid,bigint,bigint,text)
  to service_role;
