-- handle_new_user (0001) is SECURITY DEFINER and only meant to run as the
-- on_auth_user_created trigger. Postgres grants EXECUTE to PUBLIC by default,
-- so without this it's also callable directly via /rest/v1/rpc/handle_new_user
-- by anon/authenticated, inserting arbitrary profiles rows. Triggers don't
-- need the EXECUTE grant to fire, so revoking it only closes the RPC path.
-- Pinning search_path closes the mutable-search-path lint too.

alter function public.handle_new_user() set search_path = public;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
