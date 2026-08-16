-- Notify a linked customer as soon as the courier starts the trip.
-- This additive trigger composes with the latest transition_order body.
create or replace function public.enqueue_customer_on_the_way_notification()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if new.status='ON_THE_WAY'
     and old.status is distinct from new.status
     and new.customer_telegram_chat_id is not null then
    begin
      insert into public.notification_outbox(order_id,channel)
      values(new.id,'TELEGRAM_CUSTOMER_ON_THE_WAY')
      on conflict(order_id,channel) do nothing;
    exception when others then
      raise warning 'failed to enqueue on-the-way notification for order %: %',new.id,sqlerrm;
    end;
  end if;
  return new;
end $$;

create trigger orders_enqueue_customer_on_the_way
after update of status on public.orders
for each row execute function public.enqueue_customer_on_the_way_notification();
