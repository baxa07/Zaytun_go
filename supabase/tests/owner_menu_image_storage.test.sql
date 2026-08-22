begin;
select plan(14);

select is((select public from storage.buckets where id='menu-images'),true,'menu images are publicly readable');
select is((select file_size_limit from storage.buckets where id='menu-images'),8388608::bigint,'bucket enforces 8 MB limit');
select is((select allowed_mime_types from storage.buckets where id='menu-images'),array['image/jpeg','image/png','image/webp'],'bucket restricts image MIME types');
select is((select count(*)::integer from pg_policies where schemaname='storage' and tablename='objects' and policyname='menu_images_owner_insert'),1,'OWNER insert policy exists');
select is((select count(*)::integer from pg_policies where schemaname='storage' and tablename='objects' and policyname='menu_images_public_read'),1,'public read policy exists');
select is((select count(*)::integer from pg_policies where schemaname='storage' and tablename='objects' and cmd='UPDATE' and (qual like '%menu-images%' or with_check like '%menu-images%')),0,'no overwrite policy exists');

set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000005',true);
select set_config('request.jwt.claim.role','authenticated',true);
select lives_ok($$insert into storage.objects(bucket_id,name,owner_id,metadata) values('menu-images','10000000-0000-0000-0000-000000000005/owner.jpg','10000000-0000-0000-0000-000000000005','{"mimetype":"image/jpeg","size":10}')$$,'OWNER uploads below own UUID prefix');
select throws_ok($$insert into storage.objects(bucket_id,name,owner_id,metadata) values('menu-images','other/forbidden.jpg','10000000-0000-0000-0000-000000000005','{"mimetype":"image/jpeg","size":10}')$$,'42501',null,'OWNER cannot write arbitrary paths');

select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000003',true);
select throws_ok($$insert into storage.objects(bucket_id,name,owner_id,metadata) values('menu-images','10000000-0000-0000-0000-000000000003/restaurant.jpg','10000000-0000-0000-0000-000000000003','{"mimetype":"image/jpeg","size":10}')$$,'42501',null,'RESTAURANT cannot upload');
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000001',true);
select throws_ok($$insert into storage.objects(bucket_id,name,owner_id,metadata) values('menu-images','10000000-0000-0000-0000-000000000001/driver.jpg','10000000-0000-0000-0000-000000000001','{"mimetype":"image/jpeg","size":10}')$$,'42501',null,'DRIVER cannot upload');
select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000006',true);
select throws_ok($$insert into storage.objects(bucket_id,name,owner_id,metadata) values('menu-images','10000000-0000-0000-0000-000000000006/customer.jpg','10000000-0000-0000-0000-000000000006','{"mimetype":"image/jpeg","size":10}')$$,'42501',null,'CUSTOMER cannot upload');

reset role;
set local role anon;
select throws_ok($$insert into storage.objects(bucket_id,name,metadata) values('menu-images','anon.jpg','{"mimetype":"image/jpeg","size":10}')$$,'42501',null,'anonymous cannot upload');
select lives_ok($$select name from storage.objects where bucket_id='menu-images'$$,'anonymous may read public menu images');
reset role;

select is((select public.menu_item_audit_state(item) ? 'image' from public.menu_items item limit 1),true,'menu audit snapshots retain safe image references');

select * from finish();
rollback;
