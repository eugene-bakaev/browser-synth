-- Sessions: durable, listable rooms. Metadata (sessions) is split from the
-- project blob (session_snapshots) so lobby list queries stay lean and a future
-- version-history table is additive. The realtime server reads/writes these via
-- DATABASE_URL (privileged). No RLS: the browser never touches these tables
-- directly — all access is through the server and the /api/sessions endpoints.

create table public.sessions (
  id              text primary key,                -- 9-char Crockford Base32 room id
  name            text not null,
  description     text not null default '',
  owner_user_id   uuid references auth.users(id) on delete set null,  -- null for guests
  owner_client_id text,                            -- guest creator's clientId
  settings        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index sessions_owner_user_id_idx on public.sessions (owner_user_id);

create table public.session_snapshots (
  session_id text primary key references public.sessions(id) on delete cascade,
  project    jsonb not null,
  updated_at timestamptz not null default now()
);
