-- Local-dev schema for Fiddle Synth. NOT the production schema: the
-- auth.users FK, RLS policies, and signup trigger from supabase/migrations are
-- intentionally dropped. RLS guards only direct browser DB access, which never
-- happens — the privileged server is the sole client. owner_user_id stays a
-- plain uuid so a REAL Supabase login (whose user id has no local auth.users
-- row) can still create and persist a session.

create table if not exists sessions (
  id              text primary key,
  name            text not null,
  description     text not null default '',
  owner_user_id   uuid,
  owner_client_id text,
  settings        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists sessions_owner_user_id_idx on sessions (owner_user_id);

create table if not exists session_snapshots (
  session_id text primary key references sessions(id) on delete cascade,
  project    jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists profiles (
  id         uuid primary key,
  username   text unique,
  created_at timestamptz not null default now()
);
