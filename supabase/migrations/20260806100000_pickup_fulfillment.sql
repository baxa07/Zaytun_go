-- First-class pickup payments and lifecycle. This does not enable delivery.
alter table public.delivery_settings
  add column pickup_payment_methods public.payment_method[] not null default array['CASH','CARD_AT_PICKUP']::public.payment_method[],
  add column delivery_payment_methods public.payment_method[] not null default array['CASH']::public.payment_method[];

alter table public.delivery_settings
  add constraint pickup_payment_methods_not_empty check(cardinality(pickup_payment_methods)>0),
  add constraint delivery_payment_methods_not_empty check(cardinality(delivery_payment_methods)>0);

update public.delivery_settings set
  supported_payment_methods=array['CASH','CARD_AT_PICKUP']::public.payment_method[],
  pickup_payment_methods=array['CASH','CARD_AT_PICKUP']::public.payment_method[],
  delivery_payment_methods=array['CASH']::public.payment_method[],
  updated_at=now()
where id=true;

-- Preserve the audited server-authoritative pricing body while extending its
-- narrow payment parser. Fulfillment-specific authorization remains enforced
-- by enforce_order_configuration() on the atomic order insert.
do $$
declare definition text; updated text;
begin
  select pg_get_functiondef('public.create_public_order(jsonb)'::regprocedure) into definition;
  updated:=replace(definition,$search$if p_order->>'paymentMethod' not in ('CASH','CARD_ON_DELIVERY') then$search$,$replacement$if p_order->>'paymentMethod' not in ('CASH','CARD_ON_DELIVERY','CARD_AT_PICKUP') then$replacement$);
  if updated=definition then raise exception 'create_public_order payment parser signature was not found'; end if;
  execute updated;
end $$;

create or replace function public.enforce_order_configuration()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare settings public.delivery_settings; allowed public.payment_method[];
begin
  select * into settings from public.delivery_settings where id=true;
  if not found then raise exception 'RESTAURANT_CONFIG_UNAVAILABLE|Restoran sozlamalari mavjud emas'; end if;
  allowed:=case when new.order_type='PICKUP' then settings.pickup_payment_methods else settings.delivery_payment_methods end;
  if not (new.payment_method=any(allowed)) then
    raise exception 'UNSUPPORTED_PAYMENT_METHOD|Tanlangan to‘lov usuli bu buyurtma turi uchun mavjud emas' using errcode='22023';
  end if;
  return new;
end $$;

create or replace function public.assert_transition(p_from public.order_status,p_to public.order_status)
returns void language plpgsql immutable set search_path=pg_catalog,public as $$
begin
  if not(case p_from when 'NEW' then p_to in('CONFIRMED','REJECTED','CANCELLED') when 'CONFIRMED' then p_to in('PREPARING','CANCELLED') when 'PREPARING' then p_to in('READY','CANCELLED') when 'READY' then p_to in('COLLECTED','DRIVER_ASSIGNED','CANCELLED') when 'DRIVER_ASSIGNED' then p_to in('PICKED_UP','CANCELLED') when 'PICKED_UP' then p_to in('ON_THE_WAY','DELIVERY_FAILED','RETURNED') when 'ON_THE_WAY' then p_to in('ARRIVED','DELIVERY_FAILED','RETURNED') when 'ARRIVED' then p_to in('DELIVERED','DELIVERY_FAILED','RETURNED') when 'DELIVERY_FAILED' then p_to='RETURNED' else false end) then
    raise exception 'Illegal transition: % -> %',p_from,p_to using errcode='23514';
  end if;
end $$;

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
  update public.orders set status=p_new_status,rejection_reason=case when p_new_status='REJECTED' then trim(p_reason) else rejection_reason end,cancellation_reason=case when p_new_status='CANCELLED' then trim(p_reason) else cancellation_reason end,payment_status=case when p_new_status in('DELIVERED','COLLECTED') then 'COLLECTED' else payment_status end where id=p_order_id returning * into o;
  insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status,reason,notes) values(p_order_id,actor,auth.uid()::text,old,p_new_status,nullif(trim(p_reason),''),nullif(trim(p_notes),''));
  if p_new_status in('DELIVERED','DELIVERY_FAILED','RETURNED','CANCELLED') and o.assigned_driver_id is not null then update public.drivers set availability='AVAILABLE' where id=o.assigned_driver_id;update public.driver_assignments set ended_at=now() where order_id=p_order_id;end if;
  return o;
end $$;

create or replace function public.assign_driver(p_order_id uuid,p_driver_id uuid)
returns public.driver_assignments language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders;d public.drivers;a public.driver_assignments;
begin
  if not public.is_staff() then raise exception 'STAFF_ROLE_REQUIRED|Xodim roli talab qilinadi' using errcode='42501'; end if;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi'; end if;
  if o.order_type<>'DELIVERY' then raise exception 'PICKUP_DRIVER_FORBIDDEN|Olib ketish buyurtmasiga haydovchi biriktirilmaydi' using errcode='42501'; end if;
  if o.delivery_review_status<>'APPROVED' then raise exception 'DELIVERY_REVIEW_REQUIRED|Tasdiqlanmagan yetkazish haydovchiga berilmaydi' using errcode='42501'; end if;
  perform public.assert_transition(o.status,'DRIVER_ASSIGNED');select * into d from public.drivers where id=p_driver_id for update;if d.availability<>'AVAILABLE' then raise exception 'DRIVER_NOT_AVAILABLE|Haydovchi band';end if;
  insert into public.driver_assignments(order_id,driver_id,assigned_by)values(p_order_id,p_driver_id,auth.uid())returning * into a;update public.drivers set availability='BUSY'where id=p_driver_id;update public.orders set assigned_driver_id=p_driver_id,status='DRIVER_ASSIGNED'where id=p_order_id;insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status)values(p_order_id,'DISPATCHER',auth.uid()::text,'READY','DRIVER_ASSIGNED');return a;
end $$;

create or replace function public.accept_assignment(p_order_id uuid)
returns public.driver_assignments language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.driver_assignments;
begin
  if public.current_app_role() is distinct from 'DRIVER' then raise exception 'DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi' using errcode='42501'; end if;
  if exists(select 1 from public.orders where id=p_order_id and order_type='PICKUP') then raise exception 'PICKUP_DRIVER_FORBIDDEN|Haydovchi olib ketish buyurtmasini qabul qilmaydi' using errcode='42501'; end if;
  if exists(select 1 from public.orders where id=p_order_id and order_type='DELIVERY' and delivery_review_status<>'APPROVED') then raise exception 'DELIVERY_REVIEW_REQUIRED|Tasdiqlanmagan yetkazish qabul qilinmaydi' using errcode='42501'; end if;
  update public.driver_assignments set accepted_at=now() where order_id=p_order_id and driver_id=auth.uid() and accepted_at is null and ended_at is null returning * into a;
  if not found then raise exception 'ASSIGNMENT_NOT_FOUND|Faol topshiriq topilmadi'; end if;
  update public.orders set assignment_accepted_at=a.accepted_at where id=p_order_id;
  return a;
end $$;

create or replace function public.get_public_restaurant_config()
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
select jsonb_build_object('restaurantName',restaurant_display_name,'restaurantAddress',restaurant_address,'restaurantPhone',restaurant_phone,'restaurantLatitude',restaurant_latitude,'restaurantLongitude',restaurant_longitude,'operatingHours',operating_hours,'deliveryEnabled',delivery_enabled,'deliveryPolicyMode',delivery_policy_mode,'deliveryReviewMessage',case when delivery_policy_mode='MANUAL_CITY_REVIEW' then 'Navoiy shahri bo‘ylab yetkazib berish bepul. Manzil operator tomonidan tasdiqlanadi.' else null end,'deliveryRadiusKm',maximum_delivery_radius_km,'deliveryAreaDescription',delivery_area_description,'minimumDeliverySubtotal',minimum_delivery_order,'baseDeliveryFee',base_delivery_fee,'freeDeliveryThreshold',free_delivery_threshold,'maximumItemQuantity',maximum_item_quantity,'supportedPaymentMethods',supported_payment_methods,'pickupPaymentMethods',pickup_payment_methods,'deliveryPaymentMethods',delivery_payment_methods,'estimatedPreparationMinutes',estimated_preparation_minutes,'estimatedDeliveryMinutes',estimated_delivery_minutes,'defaultMapZoom',default_map_zoom)from public.delivery_settings where id=true
$$;

create or replace function public.get_order_tracking(p_order_id uuid,p_tracking_token uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
select jsonb_build_object('id',o.id,'number',o.number,'customer_name','','primary_phone','','order_type',o.order_type,'payment_method',o.payment_method,'payment_status',o.payment_status,'special_instructions','','status',o.status,'delivery_review_status',o.delivery_review_status,'delivery_review_reason',o.delivery_review_reason,'subtotal',o.subtotal,'delivery_fee',o.delivery_fee,'total',o.total,'estimated_minutes',o.estimated_minutes,'assigned_driver_id',null,'assignment_accepted_at',null,'created_at',o.created_at,'restaurant_name',s.restaurant_display_name,'restaurant_address',s.restaurant_address,'restaurant_phone',s.restaurant_phone,'customer_addresses','[]'::jsonb,'order_items',(select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'order_id',i.order_id,'menu_item_id',i.menu_item_id,'name',i.name,'unit_price',i.unit_price,'quantity',i.quantity,'modifier_ids',i.modifier_ids,'modifier_names',i.modifier_names,'instructions',i.instructions,'total',i.total)),'[]'::jsonb)from public.order_items i where i.order_id=o.id),'order_events',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'order_id',e.order_id,'actor_type','SYSTEM','actor_id','public','previous_status',e.previous_status,'new_status',e.new_status,'reason',case when e.notes='DELIVERY_REVIEW_REJECTED' then e.reason else null end,'notes',e.notes,'occurred_at',e.occurred_at)order by e.occurred_at),'[]'::jsonb)from public.order_events e where e.order_id=o.id),'delivery_issues','[]'::jsonb)from public.orders o cross join public.delivery_settings s where s.id=true and o.id=p_order_id and o.tracking_token=p_tracking_token
$$;

revoke execute on function public.transition_order(uuid,public.order_status,text,text),public.assign_driver(uuid,uuid) from public,anon;
grant execute on function public.transition_order(uuid,public.order_status,text,text),public.assign_driver(uuid,uuid) to authenticated;
revoke execute on function public.get_public_restaurant_config(),public.get_order_tracking(uuid,uuid) from public;
grant execute on function public.get_public_restaurant_config(),public.get_order_tracking(uuid,uuid) to anon,authenticated;
