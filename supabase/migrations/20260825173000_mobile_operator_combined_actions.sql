-- Keep the detailed canonical lifecycle and audit events, but let one
-- deliberate mobile tap perform adjacent mechanical transitions.
create or replace function public.restaurant_accept_and_start(p_order_id uuid)
returns public.orders language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders; app_role public.app_role;
begin
  app_role:=public.current_app_role();
  if app_role is null then raise exception 'AUTHENTICATION_REQUIRED|Xodim hisobi bilan kiring' using errcode='42501'; end if;
  if app_role not in('OWNER','DISPATCHER','RESTAURANT') then raise exception 'AUTHORIZATION_REQUIRED|Oshxona roli talab qilinadi' using errcode='42501'; end if;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi'; end if;
  if o.status<>'NEW' then raise exception 'ORDER_STATE_CHANGED|Buyurtma holati allaqachon o‘zgargan'; end if;
  select * into o from public.transition_order(p_order_id,'CONFIRMED',null,'MOBILE_ACCEPT_AND_START');
  if o.payment_method in('CLICK','PAYME') and o.payment_status<>'CONFIRMED' then return o; end if;
  select * into o from public.transition_order(p_order_id,'PREPARING',null,'MOBILE_ACCEPT_AND_START');
  return o;
end$$;

create or replace function public.driver_pickup_and_depart(p_order_id uuid)
returns public.orders language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders; app_role public.app_role;
begin
  app_role:=public.current_app_role();
  if app_role is null then raise exception 'AUTHENTICATION_REQUIRED|Haydovchi hisobi bilan kiring' using errcode='42501'; end if;
  if app_role<>'DRIVER' then raise exception 'AUTHORIZATION_REQUIRED|Haydovchi roli talab qilinadi' using errcode='42501'; end if;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi'; end if;
  if o.status<>'DRIVER_ASSIGNED' then raise exception 'ORDER_STATE_CHANGED|Buyurtma olib ketish bosqichida emas'; end if;
  select * into o from public.transition_order(p_order_id,'PICKED_UP',null,'MOBILE_PICKUP_AND_DEPART');
  select * into o from public.transition_order(p_order_id,'ON_THE_WAY',null,'MOBILE_PICKUP_AND_DEPART');
  return o;
end$$;

create or replace function public.driver_complete_delivery(p_order_id uuid)
returns public.orders language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders; app_role public.app_role;
begin
  app_role:=public.current_app_role();
  if app_role is null then raise exception 'AUTHENTICATION_REQUIRED|Haydovchi hisobi bilan kiring' using errcode='42501'; end if;
  if app_role<>'DRIVER' then raise exception 'AUTHORIZATION_REQUIRED|Haydovchi roli talab qilinadi' using errcode='42501'; end if;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi'; end if;
  if o.status='PICKED_UP' then select * into o from public.transition_order(p_order_id,'ON_THE_WAY',null,'MOBILE_COMPLETE_DELIVERY'); end if;
  if o.status='ON_THE_WAY' then select * into o from public.transition_order(p_order_id,'ARRIVED',null,'MOBILE_COMPLETE_DELIVERY'); end if;
  if o.status<>'ARRIVED' then raise exception 'ORDER_STATE_CHANGED|Buyurtma yetkazish bosqichida emas'; end if;
  select * into o from public.transition_order(p_order_id,'DELIVERED',null,'MOBILE_COMPLETE_DELIVERY');
  return o;
end$$;

revoke all on function public.restaurant_accept_and_start(uuid) from public,anon;
revoke all on function public.driver_pickup_and_depart(uuid) from public,anon;
revoke all on function public.driver_complete_delivery(uuid) from public,anon;
grant execute on function public.restaurant_accept_and_start(uuid) to authenticated;
grant execute on function public.driver_pickup_and_depart(uuid) to authenticated;
grant execute on function public.driver_complete_delivery(uuid) to authenticated;
