-- Public menu photos with OWNER-only, collision-resistant uploads.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('menu-images','menu-images',true,8388608,array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set
  public=excluded.public,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

create policy menu_images_public_read
on storage.objects for select
to public
using(bucket_id='menu-images');

create policy menu_images_owner_insert
on storage.objects for insert
to authenticated
with check(
  bucket_id='menu-images'
  and public.is_owner()
  and (storage.foldername(name))[1]=auth.uid()::text
);

-- Used only to remove a newly uploaded object when the guarded menu mutation
-- fails. Owners may remove only objects under their own UUID prefix.
create policy menu_images_owner_delete_own
on storage.objects for delete
to authenticated
using(
  bucket_id='menu-images'
  and public.is_owner()
  and (storage.foldername(name))[1]=auth.uid()::text
);

comment on policy menu_images_owner_insert on storage.objects is
  'Only authoritative OWNER profiles may add unique menu images below their own auth UUID prefix; no overwrite/update policy exists.';
