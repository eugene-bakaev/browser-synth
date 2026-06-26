-- Preset library: per-engine patches saved by logged-in users. Private by
-- default; is_public shares into a global pool. Server-only access via
-- DATABASE_URL (no RLS), consistent with sessions / session_snapshots.

create table public.presets (
  id             text primary key,         -- 9-char Crockford Base32
  name           text not null,
  engine_type    text not null,            -- one of the 10 engine keys
  params         jsonb not null,           -- the Preset.params blob
  schema_version int  not null default 1,  -- forward-compat for param migrations
  owner_user_id  uuid not null references auth.users(id) on delete cascade,
  is_public      boolean not null default false,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index presets_owner_idx  on public.presets (owner_user_id);
create index presets_public_idx on public.presets (is_public) where is_public;

-- Enable RLS with no policies (same rationale as 0003_sessions_rls): the browser
-- never touches this table — all access is via the server's privileged
-- DATABASE_URL connection, which owns the table and is unaffected by RLS.
-- This closes the PostgREST/anon exposure the Supabase linter flags
-- (rls_disabled_in_public) without changing any app behavior.
alter table public.presets enable row level security;
