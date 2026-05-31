-- Profiles: one row per authenticated user. Holds the claimable username; the
-- realtime server reads this (privileged) to resolve a room handle. RLS guards
-- only the browser's direct access — the server connects with DATABASE_URL.

create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text unique,                       -- claimable, nullable until set
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "own profile read"   on public.profiles for select using  (auth.uid() = id);
create policy "own profile write"  on public.profiles for update using  (auth.uid() = id);
create policy "own profile insert" on public.profiles for insert with check (auth.uid() = id);

-- Auto-create an empty profile row on signup (standard Supabase trigger).
create function public.handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
