-- OWNER-curated customer-menu recommendations. No product is enabled by default.
alter table public.menu_items add column is_bestseller boolean not null default false;

alter table public.menu_audit_log drop constraint menu_audit_log_action_check;
alter table public.menu_audit_log add constraint menu_audit_log_action_check
  check(action in ('PRODUCT_CREATED','PRODUCT_UPDATED','PRICE_CHANGED','AVAILABILITY_CHANGED','PACKAGING_CHANGED','BESTSELLER_CHANGED'));

create or replace function public.menu_item_audit_state(p_item public.menu_items)
returns jsonb language sql stable
set search_path=pg_catalog,public as $$
  select jsonb_build_object(
    'id',p_item.id,'categoryId',p_item.category_id,'name',p_item.name,
    'description',p_item.description,'price',p_item.price,'image',p_item.image,
    'available',p_item.available,'isBestseller',p_item.is_bestseller,
    'packagingRequired',p_item.packaging_required,
    'packagingUnitPrice',p_item.packaging_unit_price,
    'packagingCapacity',p_item.packaging_capacity,'updatedAt',p_item.updated_at
  )
$$;

create or replace function public.owner_update_menu_item(
  p_product_id text,p_expected_updated_at timestamptz,p_patch jsonb
) returns public.menu_items
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  old_item public.menu_items; new_item public.menu_items;
  next_name text; next_category text; next_description text; next_image text;
  next_price integer; next_available boolean; next_bestseller boolean;
  next_packaging_required boolean; next_packaging_price integer; next_packaging_capacity integer;
  audit_action text;
begin
  if not public.is_owner() then raise exception 'OWNER_ROLE_REQUIRED|Owner roli talab qilinadi' using errcode='42501'; end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch='{}'::jsonb then raise exception 'INVALID_MENU_PATCH|O‘zgarish kiritilmadi' using errcode='22023'; end if;
  if exists(select 1 from jsonb_object_keys(p_patch) key where key<>all(array[
    'name','categoryId','description','image','price','available','isBestseller',
    'packagingRequired','packagingUnitPrice','packagingCapacity'
  ])) then raise exception 'INVALID_MENU_PATCH|Noma’lum maydon' using errcode='22023'; end if;

  select * into old_item from public.menu_items where id=p_product_id for update;
  if not found then raise exception 'MENU_ITEM_NOT_FOUND|Mahsulot topilmadi' using errcode='22023'; end if;
  if p_expected_updated_at is null or old_item.updated_at is distinct from p_expected_updated_at then raise exception 'MENU_ITEM_STALE|Mahsulot boshqa oynada o‘zgartirilgan. Yangilang.' using errcode='40001'; end if;

  next_name:=case when p_patch?'name' then trim(p_patch->>'name') else old_item.name end;
  next_category:=case when p_patch?'categoryId' then trim(p_patch->>'categoryId') else old_item.category_id end;
  next_description:=case when p_patch?'description' then trim(coalesce(p_patch->>'description','')) else old_item.description end;
  next_image:=case when p_patch?'image' then trim(coalesce(p_patch->>'image','')) else old_item.image end;
  next_price:=case when p_patch?'price' then (p_patch->>'price')::integer else old_item.price end;
  next_available:=case when p_patch?'available' then (p_patch->>'available')::boolean else old_item.available end;
  next_bestseller:=case when p_patch?'isBestseller' then (p_patch->>'isBestseller')::boolean else old_item.is_bestseller end;
  next_packaging_required:=case when p_patch?'packagingRequired' then (p_patch->>'packagingRequired')::boolean else old_item.packaging_required end;
  if next_packaging_required then
    next_packaging_price:=case when p_patch?'packagingUnitPrice' then (p_patch->>'packagingUnitPrice')::integer else old_item.packaging_unit_price end;
    next_packaging_capacity:=case when p_patch?'packagingCapacity' then (p_patch->>'packagingCapacity')::integer else old_item.packaging_capacity end;
  else next_packaging_price:=0; next_packaging_capacity:=null; end if;

  if next_name='' or length(next_name)>160 then raise exception 'INVALID_PRODUCT_NAME|Mahsulot nomini kiriting' using errcode='22023'; end if;
  if next_price<=0 then raise exception 'INVALID_PRODUCT_PRICE|Narx noldan katta bo‘lishi kerak' using errcode='22023'; end if;
  if not exists(select 1 from public.menu_categories where id=next_category and active) then raise exception 'INVALID_PRODUCT_CATEGORY|Kategoriya topilmadi' using errcode='22023'; end if;
  if lower(next_image)~'^(data|javascript):' then raise exception 'INVALID_PRODUCT_IMAGE|Rasm uchun xavfsiz manzil kiriting' using errcode='22023'; end if;
  if next_packaging_required and (coalesce(next_packaging_price,0)<=0 or coalesce(next_packaging_capacity,0)<=0) then raise exception 'INVALID_PACKAGING_CONFIG|Quti narxi va sig‘imi noldan katta bo‘lishi kerak' using errcode='22023'; end if;

  update public.menu_items set name=next_name,category_id=next_category,description=next_description,image=next_image,
    price=next_price,available=next_available,is_bestseller=next_bestseller,
    packaging_required=next_packaging_required,packaging_unit_price=next_packaging_price,packaging_capacity=next_packaging_capacity
  where id=old_item.id returning * into new_item;

  audit_action:=case
    when old_item.is_bestseller is distinct from new_item.is_bestseller then 'BESTSELLER_CHANGED'
    when row(old_item.packaging_required,old_item.packaging_unit_price,old_item.packaging_capacity) is distinct from row(new_item.packaging_required,new_item.packaging_unit_price,new_item.packaging_capacity) then 'PACKAGING_CHANGED'
    when old_item.price is distinct from new_item.price then 'PRICE_CHANGED'
    when old_item.available is distinct from new_item.available then 'AVAILABILITY_CHANGED'
    else 'PRODUCT_UPDATED' end;
  insert into public.menu_audit_log(product_id,actor_user_id,action,before_state,after_state)
  values(new_item.id,auth.uid(),audit_action,public.menu_item_audit_state(old_item),public.menu_item_audit_state(new_item));
  return new_item;
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'INVALID_MENU_VALUE|Maydon qiymatini tekshiring' using errcode='22023';
end $$;

create or replace function public.owner_create_menu_item(p_item jsonb)
returns public.menu_items
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  created public.menu_items; generated_id text;
  item_name text:=trim(coalesce(p_item->>'name','')); item_category text:=trim(coalesce(p_item->>'categoryId',''));
  item_description text:=trim(coalesce(p_item->>'description','')); item_image text:=trim(coalesce(p_item->>'image',''));
  item_price integer; item_available boolean:=coalesce((p_item->>'available')::boolean,true);
  item_bestseller boolean:=coalesce((p_item->>'isBestseller')::boolean,false);
  item_packaging boolean:=coalesce((p_item->>'packagingRequired')::boolean,true);
  item_packaging_price integer; item_packaging_capacity integer;
begin
  if not public.is_owner() then raise exception 'OWNER_ROLE_REQUIRED|Owner roli talab qilinadi' using errcode='42501'; end if;
  if p_item is null or jsonb_typeof(p_item)<>'object' then raise exception 'INVALID_MENU_ITEM|Mahsulot ma’lumotlarini kiriting' using errcode='22023'; end if;
  item_price:=(p_item->>'price')::integer;
  if item_packaging then item_packaging_price:=coalesce((p_item->>'packagingUnitPrice')::integer,3000);item_packaging_capacity:=coalesce((p_item->>'packagingCapacity')::integer,1);else item_packaging_price:=0;item_packaging_capacity:=null;end if;
  if item_name='' or length(item_name)>160 then raise exception 'INVALID_PRODUCT_NAME|Mahsulot nomini kiriting' using errcode='22023'; end if;
  if item_price<=0 then raise exception 'INVALID_PRODUCT_PRICE|Narx noldan katta bo‘lishi kerak' using errcode='22023'; end if;
  if not exists(select 1 from public.menu_categories where id=item_category and active) then raise exception 'INVALID_PRODUCT_CATEGORY|Kategoriya topilmadi' using errcode='22023'; end if;
  if lower(item_image)~'^(data|javascript):' then raise exception 'INVALID_PRODUCT_IMAGE|Rasm uchun xavfsiz manzil kiriting' using errcode='22023'; end if;
  if item_packaging and (item_packaging_price<=0 or item_packaging_capacity<=0) then raise exception 'INVALID_PACKAGING_CONFIG|Quti narxi va sig‘imini tekshiring' using errcode='22023'; end if;
  loop generated_id:=item_category||'-'||substr(replace(gen_random_uuid()::text,'-',''),1,12);exit when not exists(select 1 from public.menu_items where id=generated_id);end loop;
  insert into public.menu_items(id,category_id,name,description,price,image,available,is_bestseller,sort_order,packaging_required,packaging_unit_price,packaging_capacity)
  values(generated_id,item_category,item_name,item_description,item_price,item_image,item_available,item_bestseller,coalesce((select max(sort_order)+10 from public.menu_items where category_id=item_category),10),item_packaging,item_packaging_price,item_packaging_capacity)
  returning * into created;
  insert into public.menu_audit_log(product_id,actor_user_id,action,before_state,after_state) values(created.id,auth.uid(),'PRODUCT_CREATED',null,public.menu_item_audit_state(created));
  return created;
exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'INVALID_MENU_VALUE|Maydon qiymatini tekshiring' using errcode='22023';
end $$;

revoke all on function public.menu_item_audit_state(public.menu_items) from public,anon,authenticated;
revoke all on function public.owner_update_menu_item(text,timestamptz,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.owner_create_menu_item(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.owner_update_menu_item(text,timestamptz,jsonb) to authenticated;
grant execute on function public.owner_create_menu_item(jsonb) to authenticated;

comment on column public.menu_items.is_bestseller is 'OWNER-curated featured recommendation; never inferred from sales or client state.';
