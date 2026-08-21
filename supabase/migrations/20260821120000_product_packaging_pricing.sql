-- Product-driven takeaway packaging with immutable order snapshots.
-- Food prices and delivery pricing remain unchanged; packaging is a
-- separate, server-derived component of the final order total.

alter table public.menu_items
  add column packaging_required boolean not null default false,
  add column packaging_unit_price integer not null default 0,
  add column packaging_capacity integer;

alter table public.menu_items
  add constraint menu_items_packaging_config_valid check (
    (not packaging_required and packaging_unit_price = 0 and packaging_capacity is null)
    or
    (packaging_required and packaging_unit_price > 0 and packaging_capacity > 0)
  );

-- Real initial configuration, identified by stable menu ids rather than
-- translated/display names.
update public.menu_items
set packaging_required=false, packaging_unit_price=0, packaging_capacity=null
where id in ('nacional-somsa-obychnyy-i-ostryy','nacional-somsa-baranina');

update public.menu_items
set packaging_required=true, packaging_unit_price=3000, packaging_capacity=15
where id='nacional-olot-somsa';

alter table public.orders add column packaging_total integer not null default 0 check(packaging_total>=0);
alter table public.orders drop column total;
alter table public.orders add column total integer generated always as(subtotal+packaging_total+delivery_fee) stored;

alter table public.order_items
  add column packaging_box_count integer not null default 0 check(packaging_box_count>=0),
  add column packaging_unit_price integer not null default 0 check(packaging_unit_price>=0),
  add column packaging_capacity integer check(packaging_capacity>0),
  add column packaging_total integer generated always as(packaging_box_count*packaging_unit_price) stored;

create or replace function public.snapshot_order_item_packaging()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare config public.menu_items;
begin
  if new.menu_item_id is null then
    new.packaging_box_count:=0;
    new.packaging_unit_price:=0;
    new.packaging_capacity:=null;
    return new;
  end if;
  select * into strict config from public.menu_items where id=new.menu_item_id for share;
  if config.packaging_required then
    new.packaging_capacity:=config.packaging_capacity;
    new.packaging_unit_price:=config.packaging_unit_price;
    new.packaging_box_count:=ceil(new.quantity::numeric/config.packaging_capacity)::integer;
  else
    new.packaging_capacity:=null;
    new.packaging_unit_price:=0;
    new.packaging_box_count:=0;
  end if;
  return new;
end $$;

create trigger order_items_snapshot_packaging
before insert on public.order_items
for each row execute function public.snapshot_order_item_packaging();

create or replace function public.sync_order_packaging_total()
returns trigger
language plpgsql
security definer
set search_path=pg_catalog,public
as $$
declare affected_order_id uuid;
begin
  affected_order_id:=case when tg_op='DELETE' then old.order_id else new.order_id end;
  update public.orders
  set packaging_total=coalesce((select sum(packaging_total) from public.order_items where order_id=affected_order_id),0)
  where id=affected_order_id;
  return coalesce(new,old);
end $$;

create trigger order_items_sync_packaging_total
after insert or update or delete on public.order_items
for each row execute function public.sync_order_packaging_total();

-- Browser-supplied packaging values are forbidden rather than merely
-- ignored. Only menu configuration and ordered quantity drive the charge.
create or replace function public.assert_no_client_packaging(p_order jsonb)
returns void
language plpgsql
immutable
set search_path=pg_catalog,public
as $$
begin
  if p_order ?| array['packagingTotal','packaging_total','packagingBoxCount','packagingUnitPrice','packagingCapacity']
     or exists(
       select 1 from jsonb_array_elements(coalesce(p_order->'items','[]'::jsonb)) line
       where line ?| array['packagingTotal','packaging_total','packagingBoxCount','packagingUnitPrice','packagingCapacity','packagingRequired']
     ) then
    raise exception 'CLIENT_PRICING_FIELDS_FORBIDDEN|Qadoqlash narxi server tomonidan hisoblanadi' using errcode='22023';
  end if;
end $$;
revoke all on function public.assert_no_client_packaging(jsonb) from public,anon,authenticated;

create or replace function public.order_creation_result(p_order_id uuid)
returns jsonb
language sql
stable
security definer
set search_path=pg_catalog,public
as $$
  select jsonb_build_object(
    'id',o.id,'number',o.number,'trackingToken',o.tracking_token,
    'subtotal',o.subtotal,'packagingTotal',o.packaging_total,
    'deliveryFee',o.delivery_fee,'total',o.total,
    'items',coalesce((select jsonb_agg(jsonb_build_object(
      'id',i.id,'menuItemId',i.menu_item_id,'name',i.name,
      'unitPrice',i.unit_price,'quantity',i.quantity,
      'modifierIds',i.modifier_ids,'modifierNames',i.modifier_names,
      'instructions',i.instructions,'total',i.total,
      'packagingBoxCount',i.packaging_box_count,
      'packagingUnitPrice',i.packaging_unit_price,
      'packagingCapacity',i.packaging_capacity,
      'packagingTotal',i.packaging_total
    ) order by i.id) from public.order_items i where i.order_id=o.id),'[]'::jsonb)
  ) from public.orders o where o.id=p_order_id
$$;
revoke all on function public.order_creation_result(uuid) from public,anon,authenticated;

create or replace function public.create_public_order(p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public,extensions
as $$
declare settings public.delivery_settings; created jsonb;
begin
  perform public.assert_no_client_packaging(p_order);
  select * into settings from public.delivery_settings where id=true;
  if settings.customer_auth_required then
    raise exception 'CUSTOMER_AUTH_REQUIRED|Buyurtma berish uchun telefon raqamingizni tasdiqlang' using errcode='42501';
  end if;
  created:=public.create_order_internal(p_order,null,'CUSTOMER','guest');
  return public.order_creation_result((created->>'id')::uuid);
end $$;
revoke execute on function public.create_public_order(jsonb) from public;
grant execute on function public.create_public_order(jsonb) to anon,authenticated;

create or replace function public.create_order(p_order jsonb)
returns jsonb language sql security definer set search_path=pg_catalog,public
as $$select public.create_public_order(p_order)$$;
revoke execute on function public.create_order(jsonb) from public;
grant execute on function public.create_order(jsonb) to anon,authenticated;

create or replace function public.create_customer_order(p_order jsonb)
returns jsonb
language plpgsql
security definer
set search_path=pg_catalog,public,extensions
as $$
declare c public.customers; patched_order jsonb; created jsonb;
begin
  if auth.uid() is null then
    raise exception 'AUTHENTICATION_REQUIRED|Buyurtma berish uchun tizimga kiring' using errcode='28000';
  end if;
  perform public.assert_no_client_packaging(p_order);
  c:=public.ensure_current_customer();
  patched_order:=jsonb_set(coalesce(p_order,'{}'::jsonb),'{customer,primaryPhone}',to_jsonb(c.phone_e164));
  created:=public.create_order_internal(patched_order,c.id,'CUSTOMER',auth.uid()::text);
  return public.order_creation_result((created->>'id')::uuid);
end $$;
revoke all on function public.create_customer_order(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.create_customer_order(jsonb) to authenticated;

comment on column public.menu_items.packaging_required is 'Whether this product requires separately charged takeaway packaging.';
comment on column public.order_items.packaging_total is 'Immutable packaging charge snapshot for this ordered line.';
comment on column public.orders.packaging_total is 'Sum of immutable order-item packaging snapshots, separate from food subtotal and delivery fee.';

-- Preserve the tracking capability boundary while exposing only the
-- already-charged packaging snapshots (never mutable menu configuration).
create or replace function public.get_order_tracking(p_order_id uuid,p_tracking_token uuid)
returns jsonb language sql stable security definer set search_path=public as $$
select jsonb_build_object('id',o.id,'number',o.number,'customer_name','','primary_phone','','order_type',o.order_type,'payment_method',o.payment_method,'payment_status',o.payment_status,'special_instructions','','status',o.status,'delivery_review_status',o.delivery_review_status,'delivery_review_reason',o.delivery_review_reason,'subtotal',o.subtotal,'packaging_total',o.packaging_total,'delivery_fee',o.delivery_fee,'total',o.total,'estimated_minutes',o.estimated_minutes,'assigned_driver_id',null,'assignment_accepted_at',null,'created_at',o.created_at,'restaurant_name',s.restaurant_display_name,'restaurant_address',s.restaurant_address,'restaurant_phone',s.restaurant_phone,'customer_addresses','[]'::jsonb,'order_items',(select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'order_id',i.order_id,'menu_item_id',i.menu_item_id,'name',i.name,'unit_price',i.unit_price,'quantity',i.quantity,'modifier_ids',i.modifier_ids,'modifier_names',i.modifier_names,'instructions',i.instructions,'total',i.total,'packaging_box_count',i.packaging_box_count,'packaging_unit_price',i.packaging_unit_price,'packaging_capacity',i.packaging_capacity,'packaging_total',i.packaging_total)),'[]'::jsonb)from public.order_items i where i.order_id=o.id),'order_events',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'order_id',e.order_id,'actor_type','SYSTEM','actor_id','public','previous_status',e.previous_status,'new_status',e.new_status,'reason',case when e.notes='DELIVERY_REVIEW_REJECTED' then e.reason else null end,'notes',e.notes,'occurred_at',e.occurred_at)order by e.occurred_at),'[]'::jsonb)from public.order_events e where e.order_id=o.id),'delivery_issues','[]'::jsonb,'feedback',(select jsonb_build_object('deliveryRating',f.delivery_rating,'deliveryIssueReason',f.delivery_issue_reason,'foodRating',f.food_rating,'foodIssueReason',f.food_issue_reason,'comment',f.comment,'submittedAt',f.submitted_at)from public.order_feedback f where f.order_id=o.id))from public.orders o cross join public.delivery_settings s where s.id=true and o.id=p_order_id and o.tracking_token=p_tracking_token
$$;
revoke execute on function public.get_order_tracking(uuid,uuid) from public;
grant execute on function public.get_order_tracking(uuid,uuid) to anon,authenticated;
