-- Delivery pilot policy: accept valid Navoiy delivery requests for manual
-- operator review without inventing a radius or polygon. This migration does
-- not activate delivery; production delivery_enabled remains unchanged.
create type public.delivery_policy_mode as enum ('RADIUS','MANUAL_CITY_REVIEW');
create type public.delivery_review_status as enum ('NOT_REQUIRED','REVIEW_REQUIRED','APPROVED','REJECTED');

alter table public.delivery_settings
  add column delivery_policy_mode public.delivery_policy_mode not null default 'RADIUS';

alter table public.orders
  add column delivery_review_status public.delivery_review_status not null default 'NOT_REQUIRED',
  add column delivery_review_reason text,
  add column delivery_reviewed_at timestamptz,
  add column delivery_reviewed_by uuid references auth.users(id);

alter table public.delivery_settings drop constraint if exists delivery_settings_enabled_zone_check;
alter table public.delivery_settings add constraint delivery_settings_enabled_zone_check
  check (not delivery_enabled or delivery_policy_mode='MANUAL_CITY_REVIEW' or maximum_delivery_radius_km is not null);

update public.delivery_settings
set delivery_policy_mode='MANUAL_CITY_REVIEW', updated_at=now()
where id=true;

create or replace function public.set_initial_delivery_review()
returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare policy public.delivery_policy_mode;
begin
  if new.order_type='PICKUP' then new.delivery_review_status='NOT_REQUIRED'; return new; end if;
  select delivery_policy_mode into policy from public.delivery_settings where id=true;
  if policy='MANUAL_CITY_REVIEW' and new.status='NEW' then
    new.delivery_review_status='REVIEW_REQUIRED';
  else
    new.delivery_review_status='APPROVED';
  end if;
  return new;
end $$;
create trigger orders_initial_delivery_review before insert on public.orders
for each row execute function public.set_initial_delivery_review();
revoke execute on function public.set_initial_delivery_review() from public,anon,authenticated;

create or replace function public.calculate_delivery_quote(
  p_latitude double precision,p_longitude double precision,p_subtotal integer,p_order_type public.order_type
) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare s public.delivery_settings; d double precision; fee integer;
begin
  if p_order_type='PICKUP' then return jsonb_build_object('eligible',true,'distanceKm',null,'deliveryFee',0,'zoneResult','ELIGIBLE','minimumOrder',0,'reviewRequired',false); end if;
  if p_latitude is null or p_longitude is null or p_latitude not between -90 and 90 or p_longitude not between -180 and 180 or (p_latitude=0 and p_longitude=0) then
    raise exception 'INVALID_COORDINATES|Xaritadan to‘g‘ri yetkazish nuqtasini tanlang' using errcode='22023';
  end if;
  select * into s from public.delivery_settings where id=true;
  if not found then raise exception 'DELIVERY_SETTINGS_UNAVAILABLE|Yetkazish sozlamalari vaqtincha mavjud emas'; end if;
  if not s.delivery_enabled then return jsonb_build_object('eligible',false,'distanceKm',null,'deliveryFee',0,'zoneResult','DELIVERY_DISABLED','minimumOrder',s.minimum_delivery_order,'reviewRequired',false,'message','Yetkazib berish vaqtincha o‘chirilgan'); end if;
  d:=public.geographic_distance_km(s.restaurant_latitude,s.restaurant_longitude,p_latitude,p_longitude);
  if p_subtotal<s.minimum_delivery_order then return jsonb_build_object('eligible',false,'distanceKm',round(d::numeric,3),'deliveryFee',0,'zoneResult','ELIGIBLE','minimumOrder',s.minimum_delivery_order,'reviewRequired',s.delivery_policy_mode='MANUAL_CITY_REVIEW','message',format('Yetkazish uchun eng kam buyurtma %s so‘m',s.minimum_delivery_order)); end if;
  if s.delivery_policy_mode='MANUAL_CITY_REVIEW' then
    return jsonb_build_object('eligible',true,'distanceKm',round(d::numeric,3),'deliveryFee',0,'zoneResult','ELIGIBLE','minimumOrder',s.minimum_delivery_order,'reviewRequired',true,'message','Manzil operator tomonidan tasdiqlanadi');
  end if;
  fee:=case when s.free_delivery_threshold is not null and p_subtotal>=s.free_delivery_threshold then 0 else s.base_delivery_fee end;
  return jsonb_build_object('eligible',d<=s.maximum_delivery_radius_km and p_subtotal>=s.minimum_delivery_order,'distanceKm',round(d::numeric,3),'deliveryFee',fee,'zoneResult',case when d<=s.maximum_delivery_radius_km then 'ELIGIBLE' else 'OUTSIDE_ZONE' end,'minimumOrder',s.minimum_delivery_order,'reviewRequired',false,'message',case when d>s.maximum_delivery_radius_km then 'Bu manzil yetkazish hududidan tashqarida' end);
end $$;

create or replace function public.review_delivery_request(p_order_id uuid,p_approved boolean,p_reason text default null)
returns public.orders language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders; role public.app_role; actor public.actor_type;
begin
  role:=public.current_app_role();
  if role is null or role not in ('RESTAURANT','DISPATCHER') then raise exception 'DELIVERY_REVIEW_FORBIDDEN|Yetkazishni faqat restoran yoki dispatcher ko‘rib chiqadi' using errcode='42501'; end if;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi'; end if;
  if o.order_type<>'DELIVERY' or o.delivery_review_status<>'REVIEW_REQUIRED' then raise exception 'DELIVERY_REVIEW_NOT_REQUIRED|Bu buyurtma ko‘rib chiqishni kutmayapti' using errcode='22023'; end if;
  if not p_approved and coalesce(trim(p_reason),'')='' then raise exception 'REVIEW_REASON_REQUIRED|Rad etish sababini kiriting' using errcode='22023'; end if;
  actor:=case when role='DISPATCHER' then 'DISPATCHER'::public.actor_type else 'RESTAURANT'::public.actor_type end;
  if p_approved then
    update public.orders set delivery_review_status='APPROVED',delivery_review_reason=null,delivery_reviewed_at=now(),delivery_reviewed_by=auth.uid() where id=p_order_id returning * into o;
    insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status,notes) values(p_order_id,actor,auth.uid()::text,o.status,o.status,'DELIVERY_REVIEW_APPROVED');
  else
    update public.orders set delivery_review_status='REJECTED',delivery_review_reason=trim(p_reason),delivery_reviewed_at=now(),delivery_reviewed_by=auth.uid(),status='REJECTED',rejection_reason=trim(p_reason) where id=p_order_id returning * into o;
    insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status,reason,notes) values(p_order_id,actor,auth.uid()::text,'NEW','REJECTED',trim(p_reason),'DELIVERY_REVIEW_REJECTED');
  end if;
  return o;
end $$;

create or replace function public.transition_order(p_order_id uuid,p_new_status public.order_status,p_reason text default null,p_notes text default null)
returns public.orders language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders; old public.order_status; app_role public.app_role; actor public.actor_type;
begin
  app_role:=public.current_app_role(); if app_role is null then raise exception 'AUTHENTICATION_REQUIRED|Xodim hisobi bilan kiring' using errcode='42501'; end if;
  select * into o from public.orders where id=p_order_id for update; if not found then raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi'; end if; old:=o.status;
  if o.order_type='DELIVERY' and o.delivery_review_status<>'APPROVED' and p_new_status not in ('REJECTED','CANCELLED') then raise exception 'DELIVERY_REVIEW_REQUIRED|Avval yetkazish manzilini tasdiqlang' using errcode='42501'; end if;
  if app_role='DRIVER' then
    if o.assigned_driver_id is distinct from auth.uid() then raise exception 'DRIVER_NOT_ASSIGNED|Bu buyurtma sizga biriktirilmagan' using errcode='42501'; end if;
    if p_new_status not in ('PICKED_UP','ON_THE_WAY','ARRIVED','DELIVERED','DELIVERY_FAILED','RETURNED') then raise exception 'DRIVER_TRANSITION_FORBIDDEN|Haydovchi bu holatni o‘zgartira olmaydi' using errcode='42501'; end if;
    if old='DRIVER_ASSIGNED' and p_new_status='PICKED_UP' and o.assignment_accepted_at is null then raise exception 'ASSIGNMENT_NOT_ACCEPTED|Avval topshiriqni qabul qiling' using errcode='42501'; end if; actor:='DRIVER';
  elsif app_role='DISPATCHER' then actor:='DISPATCHER'; elsif app_role='RESTAURANT' then actor:='RESTAURANT'; else raise exception 'AUTHORIZATION_REQUIRED|Xodim roli talab qilinadi' using errcode='42501'; end if;
  perform public.assert_transition(old,p_new_status);
  if p_new_status in ('REJECTED','CANCELLED','DELIVERY_FAILED') and coalesce(trim(p_reason),'')='' then raise exception 'REASON_REQUIRED|Sababni kiriting'; end if;
  update public.orders set status=p_new_status,rejection_reason=case when p_new_status='REJECTED' then trim(p_reason) else rejection_reason end,cancellation_reason=case when p_new_status='CANCELLED' then trim(p_reason) else cancellation_reason end,payment_status=case when p_new_status='DELIVERED' and payment_method='CASH' then 'COLLECTED' else payment_status end where id=p_order_id returning * into o;
  insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status,reason,notes) values(p_order_id,actor,auth.uid()::text,old,p_new_status,nullif(trim(p_reason),''),nullif(trim(p_notes),''));
  if p_new_status in ('DELIVERED','DELIVERY_FAILED','RETURNED','CANCELLED') and o.assigned_driver_id is not null then update public.drivers set availability='AVAILABLE' where id=o.assigned_driver_id;update public.driver_assignments set ended_at=now() where order_id=p_order_id;end if;
  return o;
end $$;

create or replace function public.assign_driver(p_order_id uuid,p_driver_id uuid)
returns public.driver_assignments language plpgsql security definer set search_path=pg_catalog,public as $$
declare o public.orders;d public.drivers;a public.driver_assignments;
begin
  if not public.is_staff() then raise exception 'STAFF_ROLE_REQUIRED|Xodim roli talab qilinadi' using errcode='42501'; end if;
  select * into o from public.orders where id=p_order_id for update;
  if o.order_type='DELIVERY' and o.delivery_review_status<>'APPROVED' then raise exception 'DELIVERY_REVIEW_REQUIRED|Tasdiqlanmagan yetkazish haydovchiga berilmaydi' using errcode='42501'; end if;
  perform public.assert_transition(o.status,'DRIVER_ASSIGNED');select * into d from public.drivers where id=p_driver_id for update;if d.availability<>'AVAILABLE' then raise exception 'DRIVER_NOT_AVAILABLE|Haydovchi band';end if;
  insert into public.driver_assignments(order_id,driver_id,assigned_by)values(p_order_id,p_driver_id,auth.uid())returning * into a;update public.drivers set availability='BUSY'where id=p_driver_id;update public.orders set assigned_driver_id=p_driver_id,status='DRIVER_ASSIGNED'where id=p_order_id;insert into public.order_events(order_id,actor_type,actor_id,previous_status,new_status)values(p_order_id,'DISPATCHER',auth.uid()::text,'READY','DRIVER_ASSIGNED');return a;
end $$;

create or replace function public.accept_assignment(p_order_id uuid)
returns public.driver_assignments language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.driver_assignments;
begin
  if public.current_app_role() is distinct from 'DRIVER' then raise exception 'DRIVER_ROLE_REQUIRED|Haydovchi hisobi talab qilinadi' using errcode='42501'; end if;
  if exists(select 1 from public.orders where id=p_order_id and order_type='DELIVERY' and delivery_review_status<>'APPROVED') then raise exception 'DELIVERY_REVIEW_REQUIRED|Tasdiqlanmagan yetkazish qabul qilinmaydi' using errcode='42501'; end if;
  update public.driver_assignments set accepted_at=now() where order_id=p_order_id and driver_id=auth.uid() and accepted_at is null and ended_at is null returning * into a;if not found then raise exception 'ASSIGNMENT_NOT_FOUND|Faol topshiriq topilmadi';end if;update public.orders set assignment_accepted_at=a.accepted_at where id=p_order_id;return a;
end $$;

create or replace function public.get_public_restaurant_config()
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
select jsonb_build_object('restaurantName',restaurant_display_name,'restaurantAddress',restaurant_address,'restaurantPhone',restaurant_phone,'restaurantLatitude',restaurant_latitude,'restaurantLongitude',restaurant_longitude,'operatingHours',operating_hours,'deliveryEnabled',delivery_enabled,'deliveryPolicyMode',delivery_policy_mode,'deliveryReviewMessage',case when delivery_policy_mode='MANUAL_CITY_REVIEW' then 'Navoiy shahri bo‘ylab yetkazib berish bepul. Manzil operator tomonidan tasdiqlanadi.' else null end,'deliveryRadiusKm',maximum_delivery_radius_km,'deliveryAreaDescription',delivery_area_description,'minimumDeliverySubtotal',minimum_delivery_order,'baseDeliveryFee',base_delivery_fee,'freeDeliveryThreshold',free_delivery_threshold,'maximumItemQuantity',maximum_item_quantity,'supportedPaymentMethods',supported_payment_methods,'estimatedPreparationMinutes',estimated_preparation_minutes,'estimatedDeliveryMinutes',estimated_delivery_minutes,'defaultMapZoom',default_map_zoom)from public.delivery_settings where id=true
$$;

create or replace function public.get_order_tracking(p_order_id uuid,p_tracking_token uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
select jsonb_build_object('id',o.id,'number',o.number,'customer_name','','primary_phone','','order_type',o.order_type,'payment_method',o.payment_method,'payment_status',o.payment_status,'special_instructions','','status',o.status,'delivery_review_status',o.delivery_review_status,'delivery_review_reason',o.delivery_review_reason,'subtotal',o.subtotal,'delivery_fee',o.delivery_fee,'total',o.total,'estimated_minutes',o.estimated_minutes,'assigned_driver_id',null,'assignment_accepted_at',null,'created_at',o.created_at,'customer_addresses','[]'::jsonb,'order_items',(select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'order_id',i.order_id,'menu_item_id',i.menu_item_id,'name',i.name,'unit_price',i.unit_price,'quantity',i.quantity,'modifier_ids',i.modifier_ids,'modifier_names',i.modifier_names,'instructions',i.instructions,'total',i.total)),'[]'::jsonb)from public.order_items i where i.order_id=o.id),'order_events',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'order_id',e.order_id,'actor_type','SYSTEM','actor_id','public','previous_status',e.previous_status,'new_status',e.new_status,'reason',case when e.notes='DELIVERY_REVIEW_REJECTED' then e.reason else null end,'notes',e.notes,'occurred_at',e.occurred_at)order by e.occurred_at),'[]'::jsonb)from public.order_events e where e.order_id=o.id),'delivery_issues','[]'::jsonb)from public.orders o where o.id=p_order_id and o.tracking_token=p_tracking_token
$$;

revoke execute on function public.review_delivery_request(uuid,boolean,text) from public,anon;
grant execute on function public.review_delivery_request(uuid,boolean,text) to authenticated;
revoke execute on function public.calculate_delivery_quote(double precision,double precision,integer,public.order_type) from public;
grant execute on function public.calculate_delivery_quote(double precision,double precision,integer,public.order_type) to anon,authenticated;
revoke execute on function public.transition_order(uuid,public.order_status,text,text),public.assign_driver(uuid,uuid),public.accept_assignment(uuid) from public,anon;
grant execute on function public.transition_order(uuid,public.order_status,text,text),public.assign_driver(uuid,uuid),public.accept_assignment(uuid) to authenticated;
revoke execute on function public.get_public_restaurant_config(),public.get_order_tracking(uuid,uuid) from public;
grant execute on function public.get_public_restaurant_config(),public.get_order_tracking(uuid,uuid) to anon,authenticated;
