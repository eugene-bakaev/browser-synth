-- The browser never touches sessions/session_snapshots directly (see 0002):
-- all access goes through the realtime server's privileged DATABASE_URL
-- connection, which owns these tables and is unaffected by RLS. Enabling RLS
-- with no policies closes the PostgREST/anon exposure flagged by the linter
-- (rls_disabled_in_public, sensitive_columns_exposed) without changing any
-- app behavior.

alter table public.sessions enable row level security;
alter table public.session_snapshots enable row level security;
