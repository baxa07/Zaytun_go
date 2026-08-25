begin;
select plan(4);

select has_column(
  'public',
  'branches',
  'notification_chat_id',
  'branch keeps its server-managed Telegram notification destination'
);

set local role anon;
select lives_ok(
  $$select id, name, slug, address, latitude, longitude, active from public.branches limit 1$$,
  'anonymous customers can still read safe branch metadata'
);
select throws_ok(
  $$select notification_chat_id from public.branches limit 1$$,
  '42501',
  null,
  'anonymous users cannot read the Telegram chat destination'
);

reset role;
set local role authenticated;
select throws_ok(
  $$select notification_chat_id from public.branches limit 1$$,
  '42501',
  null,
  'authenticated browser users cannot read the Telegram chat destination'
);

select * from finish();
rollback;
