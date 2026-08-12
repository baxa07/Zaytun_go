-- H3: Customer Feedback v1.
--
-- Internal operational signal, not a public review system: no star rating
-- shown to other customers, no aggregate published anywhere customer-facing.
-- Stable machine enum values are stored, never translated display text, so
-- frontend copy can change freely without a data migration.
--
-- Schema is intentionally small: order_id is the PRIMARY KEY (not a
-- separate surrogate id), which is itself the DB-level guarantee behind
-- H3.7 ("one feedback record per order") -- a second submission for the
-- same order hits a real unique-key violation, not just app-level logic.
-- branch_id is NOT duplicated onto this table: orders.branch_id is set
-- once at order creation and never updated afterward (confirmed by
-- reading every migration that touches orders), so joining through
-- order_id is exactly as reliable as a stored copy, with a smaller
-- schema. completed_driver_id IS captured at submission time (not derived
-- by a later join) specifically because Smart Dispatch Phase 6
-- (decline/reassignment, not yet built) could one day introduce paths
-- that revisit an assignment's terminal status -- this column exists so
-- feedback attribution can never be silently rewritten by a future
-- change to driver_assignments, per H3.9.

create type public.feedback_delivery_rating as enum ('FAST','NORMAL','LATE','ISSUE');
create type public.feedback_delivery_issue_reason as enum ('SPILLED_OR_TIPPED','POOR_HANDLING','LOCATION_DIFFICULTY','VERY_LATE','OTHER');
create type public.feedback_food_rating as enum ('EXCELLENT','GOOD','OKAY','BAD');
create type public.feedback_food_issue_reason as enum ('COLD','TASTE','PREPARATION','MISSING_ITEM','OTHER');

create table public.order_feedback (
  order_id uuid primary key references public.orders(id) on delete cascade,
  completed_driver_id uuid references public.drivers(id),
  delivery_rating public.feedback_delivery_rating,
  delivery_issue_reason public.feedback_delivery_issue_reason,
  food_rating public.feedback_food_rating not null,
  food_issue_reason public.feedback_food_issue_reason,
  comment text check (comment is null or length(comment) <= 500),
  submitted_at timestamptz not null default now()
);
comment on table public.order_feedback is 'Internal operational signal only -- never surfaced as a public review/rating. One row per order (order_id is the PK); submit once, no edits in v1.';

alter table public.order_feedback enable row level security;
-- Staff-only direct table reads (matches address_read/item_read/event_read
-- precedent) -- customers reach their own feedback status exclusively
-- through get_order_tracking's tracking-token-gated jsonb, never a raw
-- table policy, since most customers here are anonymous (no auth.uid()).
create policy order_feedback_staff_read on public.order_feedback for select to authenticated using (public.is_staff());
revoke all on public.order_feedback from public, anon, authenticated;
grant select on public.order_feedback to authenticated;
-- No INSERT/UPDATE/DELETE grant to anyone -- every write goes through
-- submit_order_feedback(), matching every other table in this schema.

-- get_order_tracking (current body: 20260806100000) gains exactly one
-- additive field, `feedback` -- null until submitted, then the customer's
-- own stable enum answers so the tracking page can render "already
-- submitted" without a second round trip. Every other line reproduced
-- byte-identical from source.
create or replace function public.get_order_tracking(p_order_id uuid,p_tracking_token uuid)
returns jsonb language sql stable security definer set search_path=public as $$
select jsonb_build_object('id',o.id,'number',o.number,'customer_name','','primary_phone','','order_type',o.order_type,'payment_method',o.payment_method,'payment_status',o.payment_status,'special_instructions','','status',o.status,'delivery_review_status',o.delivery_review_status,'delivery_review_reason',o.delivery_review_reason,'subtotal',o.subtotal,'delivery_fee',o.delivery_fee,'total',o.total,'estimated_minutes',o.estimated_minutes,'assigned_driver_id',null,'assignment_accepted_at',null,'created_at',o.created_at,'restaurant_name',s.restaurant_display_name,'restaurant_address',s.restaurant_address,'restaurant_phone',s.restaurant_phone,'customer_addresses','[]'::jsonb,'order_items',(select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'order_id',i.order_id,'menu_item_id',i.menu_item_id,'name',i.name,'unit_price',i.unit_price,'quantity',i.quantity,'modifier_ids',i.modifier_ids,'modifier_names',i.modifier_names,'instructions',i.instructions,'total',i.total)),'[]'::jsonb)from public.order_items i where i.order_id=o.id),'order_events',(select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'order_id',e.order_id,'actor_type','SYSTEM','actor_id','public','previous_status',e.previous_status,'new_status',e.new_status,'reason',case when e.notes='DELIVERY_REVIEW_REJECTED' then e.reason else null end,'notes',e.notes,'occurred_at',e.occurred_at)order by e.occurred_at),'[]'::jsonb)from public.order_events e where e.order_id=o.id),'delivery_issues','[]'::jsonb,'feedback',(select jsonb_build_object('deliveryRating',f.delivery_rating,'deliveryIssueReason',f.delivery_issue_reason,'foodRating',f.food_rating,'foodIssueReason',f.food_issue_reason,'comment',f.comment,'submittedAt',f.submitted_at)from public.order_feedback f where f.order_id=o.id))from public.orders o cross join public.delivery_settings s where s.id=true and o.id=p_order_id and o.tracking_token=p_tracking_token
$$;
revoke execute on function public.get_public_restaurant_config(),public.get_order_tracking(uuid,uuid) from public;
grant execute on function public.get_public_restaurant_config(),public.get_order_tracking(uuid,uuid) to anon,authenticated;

-- Feedback submission: the ONLY write path onto order_feedback. Proves
-- possession of the order the exact same way every other public
-- order-mutating RPC does (id + tracking_token match) -- see
-- revise_delivery_address for the identical pattern. Eligibility
-- (DELIVERED for delivery feedback, COLLECTED for pickup food-only
-- feedback) is enforced here, server-side, not just hidden client-side.
create or replace function public.submit_order_feedback(
  p_order_id uuid,
  p_tracking_token uuid,
  p_food_rating public.feedback_food_rating,
  p_delivery_rating public.feedback_delivery_rating default null,
  p_delivery_issue_reason public.feedback_delivery_issue_reason default null,
  p_food_issue_reason public.feedback_food_issue_reason default null,
  p_comment text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  o public.orders;
  v_completed_driver_id uuid;
begin
  select * into o from public.orders where id = p_order_id and tracking_token = p_tracking_token;
  if not found then
    raise exception 'ORDER_NOT_FOUND|Buyurtma topilmadi' using errcode = '42501';
  end if;

  if o.order_type = 'DELIVERY' then
    if o.status <> 'DELIVERED' then
      raise exception 'FEEDBACK_NOT_YET_AVAILABLE|Fikr faqat yetkazib berilgandan keyin qoldiriladi' using errcode = '22023';
    end if;
    if p_delivery_rating is null then
      raise exception 'DELIVERY_RATING_REQUIRED|Yetkazib berish bahosini tanlang' using errcode = '22023';
    end if;
    if p_delivery_rating <> 'ISSUE' and p_delivery_issue_reason is not null then
      raise exception 'DELIVERY_ISSUE_REASON_NOT_ALLOWED|Sabab faqat muammo tanlanganda kiritiladi' using errcode = '22023';
    end if;
  else
    if o.status <> 'COLLECTED' then
      raise exception 'FEEDBACK_NOT_YET_AVAILABLE|Fikr faqat olib ketilgandan keyin qoldiriladi' using errcode = '22023';
    end if;
    if p_delivery_rating is not null or p_delivery_issue_reason is not null then
      raise exception 'DELIVERY_FEEDBACK_NOT_APPLICABLE|Olib ketish buyurtmasida yetkazib berish bahosi bo‘lmaydi' using errcode = '22023';
    end if;
  end if;

  if p_food_rating not in ('OKAY','BAD') and p_food_issue_reason is not null then
    raise exception 'FOOD_ISSUE_REASON_NOT_ALLOWED|Sabab faqat qoniqarsiz baholarda kiritiladi' using errcode = '22023';
  end if;
  if length(coalesce(p_comment, '')) > 500 then
    raise exception 'COMMENT_TOO_LONG|Izoh 500 belgidan oshmasin' using errcode = '22023';
  end if;

  select driver_id into v_completed_driver_id
  from public.driver_assignments where order_id = p_order_id and status = 'COMPLETED' limit 1;

  insert into public.order_feedback(order_id, completed_driver_id, delivery_rating, delivery_issue_reason, food_rating, food_issue_reason, comment)
  values (p_order_id, v_completed_driver_id, p_delivery_rating, p_delivery_issue_reason, p_food_rating, p_food_issue_reason, nullif(trim(coalesce(p_comment, '')), ''));

  return public.get_order_tracking(p_order_id, p_tracking_token);
exception
  when unique_violation then
    raise exception 'FEEDBACK_ALREADY_SUBMITTED|Fikr allaqachon yuborilgan' using errcode = '23505';
end;
$$;
revoke all on function public.submit_order_feedback(uuid, uuid, public.feedback_food_rating, public.feedback_delivery_rating, public.feedback_delivery_issue_reason, public.feedback_food_issue_reason, text) from public;
grant execute on function public.submit_order_feedback(uuid, uuid, public.feedback_food_rating, public.feedback_delivery_rating, public.feedback_delivery_issue_reason, public.feedback_food_issue_reason, text) to anon, authenticated;

-- H3.13: History integration. list_restaurant_order_history (H1) gains
-- exactly one additive column, `has_feedback` -- a subtle "Fikr bor"
-- indicator only; the full review stays behind the existing order-detail
-- open, never inlined into the History row itself. RETURNS TABLE cannot be
-- widened via CREATE OR REPLACE, so this is DROP + CREATE; every other
-- line reproduced byte-identical from the H1 body (20260813100000).
drop function public.list_restaurant_order_history(text, date, date, uuid, uuid, public.order_status, public.order_type, public.payment_method, text, integer, integer);
create function public.list_restaurant_order_history(
  p_preset text,
  p_custom_from date default null,
  p_custom_to date default null,
  p_branch_id uuid default null,
  p_driver_id uuid default null,
  p_status public.order_status default null,
  p_fulfillment public.order_type default null,
  p_payment_method public.payment_method default null,
  p_search text default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table(
  id uuid,
  number text,
  created_at timestamptz,
  finished_at timestamptz,
  branch_id uuid,
  branch_name text,
  customer_name text,
  order_type public.order_type,
  status public.order_status,
  assigned_driver_id uuid,
  driver_name text,
  payment_method public.payment_method,
  total integer,
  has_feedback boolean,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  terminal_statuses constant public.order_status[] := array['DELIVERED','COLLECTED','CANCELLED','REJECTED','DELIVERY_FAILED','RETURNED'];
  v_from timestamptz;
  v_to timestamptz;
  v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_search text := nullif(trim(coalesce(p_search, '')), '');
begin
  if not public.is_staff() then
    raise exception 'STAFF_ROLE_REQUIRED|Xodim roli talab qilinadi' using errcode = '42501';
  end if;
  select w.window_start, w.window_end into v_from, v_to from public.resolve_history_window(p_preset, p_custom_from, p_custom_to) w;

  return query
  with filtered as (
    select o.*
    from public.orders o
    where o.created_at >= v_from and o.created_at < v_to
      and (p_branch_id is null or o.branch_id = p_branch_id)
      and (p_driver_id is null or o.assigned_driver_id = p_driver_id)
      and (p_status is null or o.status = p_status)
      and (p_fulfillment is null or o.order_type = p_fulfillment)
      and (p_payment_method is null or o.payment_method = p_payment_method)
      and (v_search is null or o.number ilike '%' || v_search || '%')
  )
  select
    f.id, f.number, f.created_at,
    (select e.occurred_at from public.order_events e
     where e.order_id = f.id and e.new_status = f.status and f.status = any(terminal_statuses)
     order by e.occurred_at desc limit 1) as finished_at,
    f.branch_id, b.name as branch_name, f.customer_name, f.order_type, f.status,
    f.assigned_driver_id, p.display_name as driver_name, f.payment_method, f.total,
    exists(select 1 from public.order_feedback fb where fb.order_id = f.id) as has_feedback,
    count(*) over() as total_count
  from filtered f
  left join public.branches b on b.id = f.branch_id
  left join public.profiles p on p.id = f.assigned_driver_id
  order by f.created_at desc, f.id
  limit v_limit offset v_offset;
end;
$$;
revoke all on function public.list_restaurant_order_history(text, date, date, uuid, uuid, public.order_status, public.order_type, public.payment_method, text, integer, integer) from public, anon;
grant execute on function public.list_restaurant_order_history(text, date, date, uuid, uuid, public.order_status, public.order_type, public.payment_method, text, integer, integer) to authenticated;

-- H3.14: Driver Ledger integration. list_driver_ledger_summary (H2) gains
-- a small delivery-feedback breakdown per driver -- counts only, no
-- score, no ranking, per the explicit "do not invent a driver score"
-- instruction. Sourced from order_feedback.completed_driver_id, the same
-- immutable, submission-time-snapshotted attribution H3 itself uses.
drop function public.list_driver_ledger_summary(text, date, date, uuid);
create function public.list_driver_ledger_summary(
  p_preset text,
  p_custom_from date default null,
  p_custom_to date default null,
  p_branch_id uuid default null
)
returns table(
  driver_id uuid,
  driver_name text,
  total_assignments integer,
  accepted integer,
  completed integer,
  failed integer,
  returned integer,
  declined integer,
  superseded integer,
  feedback_received integer,
  feedback_fast integer,
  feedback_normal integer,
  feedback_late integer,
  feedback_issue integer
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from timestamptz;
  v_to timestamptz;
begin
  if not public.is_staff() then
    raise exception 'STAFF_ROLE_REQUIRED|Xodim roli talab qilinadi' using errcode = '42501';
  end if;
  select w.window_start, w.window_end into v_from, v_to from public.resolve_history_window(p_preset, p_custom_from, p_custom_to) w;

  return query
  select
    a.driver_id,
    p.display_name,
    count(*)::integer,
    count(*) filter (where a.accepted_at is not null)::integer,
    count(*) filter (where a.status = 'COMPLETED')::integer,
    count(*) filter (where a.status = 'FAILED')::integer,
    count(*) filter (where a.status = 'RETURNED')::integer,
    count(*) filter (where a.status = 'DECLINED')::integer,
    count(*) filter (where a.status = 'SUPERSEDED')::integer,
    count(fb.order_id)::integer,
    count(*) filter (where fb.delivery_rating = 'FAST')::integer,
    count(*) filter (where fb.delivery_rating = 'NORMAL')::integer,
    count(*) filter (where fb.delivery_rating = 'LATE')::integer,
    count(*) filter (where fb.delivery_rating = 'ISSUE')::integer
  from public.driver_assignments a
  join public.orders o on o.id = a.order_id
  join public.profiles p on p.id = a.driver_id
  left join public.order_feedback fb on fb.completed_driver_id = a.driver_id and fb.order_id = a.order_id
  where a.assigned_at >= v_from and a.assigned_at < v_to
    and (p_branch_id is null or o.branch_id = p_branch_id)
  group by a.driver_id, p.display_name
  order by count(*) filter (where a.status = 'COMPLETED') desc, p.display_name;
end;
$$;
revoke all on function public.list_driver_ledger_summary(text, date, date, uuid) from public, anon;
grant execute on function public.list_driver_ledger_summary(text, date, date, uuid) to authenticated;
