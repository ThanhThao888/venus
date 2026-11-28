-- 004_user_devices_delete.sql
-- Lets a signed-in user delete their OWN rows in user_devices (to remove old devices).
-- No other table, policy or function is changed. Safe to run more than once.
-- Note: the database can't know which device is "this one"; the app must never offer to remove it.
begin;

do $$
begin
  -- Granting DELETE on a table without RLS would let any signed-in user delete anyone's rows.
  if not (select relrowsecurity from pg_class where oid = 'public.user_devices'::regclass) then
    raise exception 'RLS is not enabled on public.user_devices; nothing was changed';
  end if;
end $$;

drop policy if exists user_devices_delete_own on public.user_devices;
create policy user_devices_delete_own on public.user_devices
  for delete to authenticated
  using ((select auth.uid()) = user_id);

revoke delete on public.user_devices from anon;
grant delete on public.user_devices to authenticated;

commit;
