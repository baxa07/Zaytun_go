-- Launch hardening: physical terminal semantics, staff-confirmed manual
-- Click/Payme transfers,
-- immutable driver restaurant-arrival evidence, and staff activation.

alter table public.profiles add column if not exists active boolean not null default true;

create or replace function public.current_app_role()
returns public.app_role language sql stable security definer
set search_path=pg_catalog,public as $$
  select role from public.profiles where id=auth.uid() and active
$$;

-- Replace only the current parser whitelist; abort if the expected reviewed
-- function body is not present rather than silently weakening validation.
do $do$
declare definition text; updated text;
begin
  select pg_get_functiondef('public.create_order_internal(jsonb,uuid,public.actor_type,text)'::regprocedure) into definition;
  updated := replace(definition,
    $needle$('CASH','CARD_ON_DELIVERY','CARD_AT_PICKUP','CLICK','PAYME')$needle$,
    $needle$('CASH','CARD_ON_DELIVERY','CARD_AT_PICKUP','TERMINAL','CLICK','PAYME')$needle$);
  if updated = definition then
    raise exception 'create_order_internal payment whitelist did not match reviewed definition';
  end if;
  execute updated;
end $do$;

update public.delivery_settings
set supported_payment_methods=array['CASH','TERMINAL','CLICK','PAYME']::public.payment_method[],
    pickup_payment_methods=array['CASH','TERMINAL']::public.payment_method[],
    delivery_payment_methods=array['CASH','CLICK','PAYME']::public.payment_method[],
    updated_at=now()
where id=true;

create or replace function public.enforce_manual_payment_before_preparation()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if new.status='PREPARING' and old.status is distinct from 'PREPARING'
     and new.payment_method in ('CLICK','PAYME') and new.payment_status<>'CONFIRMED' then
    raise exception 'PAYMENT_CONFIRMATION_REQUIRED|Avval Click/Payme to‘lovini tasdiqlang' using errcode='23514';
  end if;
  return new;
end $$;
create trigger orders_manual_payment_before_preparation
before update of status on public.orders for each row
execute function public.enforce_manual_payment_before_preparation();

create or replace function public.confirm_manual_payment(p_order_id uuid)
returns public.orders language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders;
begin
  if public.current_app_role() not in ('RESTAURANT','DISPATCHER') then
    raise exception 'STAFF_ROLE_REQUIRED|Restaurant xodimi talab qilinadi' using errcode='42501';
  end if;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi' using errcode='22023'; end if;
  if o.payment_method not in ('CLICK','PAYME') then raise exception 'MANUAL_PAYMENT_NOT_REQUIRED|Bu buyurtma Click/Payme emas' using errcode='22023'; end if;
  if o.payment_status='CONFIRMED' then return o; end if;
  if o.payment_status<>'PENDING' then raise exception 'PAYMENT_NOT_PENDING|To‘lov kutilmayapti' using errcode='22023'; end if;
  update public.orders set payment_status='CONFIRMED' where id=p_order_id returning * into o;
  insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status,notes)
  values(o.id,'RESTAURANT',auth.uid()::text,o.status,o.status,'MANUAL_PAYMENT_CONFIRMED');
  return o;
end $$;
revoke all on function public.confirm_manual_payment(uuid) from public,anon,authenticated,service_role;
grant execute on function public.confirm_manual_payment(uuid) to authenticated;

create or replace function public.mark_driver_at_restaurant(p_order_id uuid)
returns public.driver_assignments
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.driver_assignments; o public.orders; first_arrival boolean;
begin
  if public.current_app_role() is distinct from 'DRIVER' then
    raise exception 'DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi' using errcode='42501';
  end if;
  select * into a from public.driver_assignments
  where order_id=p_order_id and driver_id=auth.uid() and accepted_at is not null and ended_at is null
  for update;
  if not found then raise exception 'ASSIGNMENT_NOT_FOUND|Faol topshiriq topilmadi' using errcode='22023'; end if;
  select * into o from public.orders where id=p_order_id for update;
  if o.status not in ('CONFIRMED','PREPARING','READY','DRIVER_ASSIGNED') then
    raise exception 'ASSIGNMENT_NOT_FOUND|Faol topshiriq topilmadi' using errcode='22023';
  end if;
  first_arrival := a.arrived_at_restaurant_at is null;
  if first_arrival then
    update public.driver_assignments set arrived_at_restaurant_at=now() where id=a.id returning * into a;
    insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status,notes)
    values(p_order_id,'DRIVER',auth.uid()::text,o.status,o.status,'DRIVER_ARRIVED_RESTAURANT');
  end if;
  return a;
end $$;
revoke all on function public.mark_driver_at_restaurant(uuid) from public,anon,authenticated,service_role;
grant execute on function public.mark_driver_at_restaurant(uuid) to authenticated;
