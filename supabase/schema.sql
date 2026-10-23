-- ===========================================================================
-- GeoAxis — Supabase schema
-- Run this ONCE in the Supabase dashboard:  SQL Editor  →  paste  →  Run.
-- Safe to re-run (uses IF NOT EXISTS / OR REPLACE / idempotent policies).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. profiles — one row per surveyor (linked to the auth user)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  full_name  text,
  firm       text,
  phone      text,
  email      text,
  created_at timestamptz default now()
);

-- Auto-create a profile whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- 2. projects — named survey projects; full app state in JSONB
-- ---------------------------------------------------------------------------
create table if not exists public.projects (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references auth.users (id) on delete cascade,
  name       text not null,
  state      jsonb not null default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists projects_owner_idx on public.projects (owner, updated_at desc);

-- ---------------------------------------------------------------------------
-- 3. check_ins — surveyor presence / collaboration
-- ---------------------------------------------------------------------------
create table if not exists public.check_ins (
  id            uuid primary key default gen_random_uuid(),
  surveyor      uuid not null references auth.users (id) on delete cascade,
  surveyor_name text,
  project_name  text,
  lat           double precision not null,
  lon           double precision not null,
  note          text,
  contact       text,                 -- shown to others only if share_contact
  share_contact boolean default true,
  active        boolean default true,
  created_at    timestamptz default now(),
  -- Privacy at the data layer: a non-sharing surveyor's contact is never stored,
  -- so RLS row reads can't leak it (RLS is row-level, not column-level).
  constraint contact_requires_share check (share_contact or contact is null)
);
create index if not exists check_ins_active_idx on public.check_ins (active, created_at desc);

-- Apply the privacy constraint to a pre-existing check_ins table (re-run safe).
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'contact_requires_share') then
    alter table public.check_ins add constraint contact_requires_share check (share_contact or contact is null);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. ref_marks — Botswana survey reference marks (shared reference database)
-- ---------------------------------------------------------------------------
create table if not exists public.ref_marks (
  id          uuid primary key default gen_random_uuid(),
  number      text not null unique,   -- official mark number / designation
  name        text,
  type        text,
  lat         double precision not null,
  lon         double precision not null,
  description text,
  status      text,
  region      text,
  created_at  timestamptz default now()
);

alter table public.ref_marks enable row level security;
-- Public reference data: readable by anyone; maintainable by signed-in surveyors.
drop policy if exists ref_marks_read on public.ref_marks;
create policy ref_marks_read on public.ref_marks for select to anon, authenticated using (true);
drop policy if exists ref_marks_write on public.ref_marks;
create policy ref_marks_write on public.ref_marks for insert to authenticated with check (true);
drop policy if exists ref_marks_update on public.ref_marks;
create policy ref_marks_update on public.ref_marks for update to authenticated using (true);
drop policy if exists ref_marks_delete on public.ref_marks;
create policy ref_marks_delete on public.ref_marks for delete to authenticated using (true);

-- The 16 hand-made starter marks once seeded here were dummy data (client
-- req 2026-10-22); the app now uses the official national list. Remove them:
delete from public.ref_marks where number in ('T 24/101', 'T 25/044', 'T 24/318', 'T 24/206', 'T 24/512', 'T 23/077', 'T 22/133', 'T 22/061', 'T 22/240', 'T 21/018', 'T 19/004', 'T 17/002', 'T 21/090', 'T 21/142', 'T 26/011', 'T 24/660');

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles  enable row level security;
alter table public.projects  enable row level security;
alter table public.check_ins enable row level security;

-- profiles: any signed-in surveyor can read names (for collaboration); write only own.
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);
drop policy if exists profiles_upsert on public.profiles;
create policy profiles_upsert on public.profiles for insert to authenticated with check (auth.uid() = id);
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated using (auth.uid() = id);

-- projects: an owner has full control of their own projects; nobody else sees them.
drop policy if exists projects_all on public.projects;
create policy projects_all on public.projects for all to authenticated
  using (auth.uid() = owner) with check (auth.uid() = owner);

-- check_ins: anyone signed-in can see ACTIVE check-ins (collaboration); write only own.
drop policy if exists check_ins_read on public.check_ins;
create policy check_ins_read on public.check_ins for select to authenticated using (active = true or auth.uid() = surveyor);
drop policy if exists check_ins_insert on public.check_ins;
create policy check_ins_insert on public.check_ins for insert to authenticated with check (auth.uid() = surveyor);
drop policy if exists check_ins_update on public.check_ins;
create policy check_ins_update on public.check_ins for update to authenticated using (auth.uid() = surveyor);
drop policy if exists check_ins_delete on public.check_ins;
create policy check_ins_delete on public.check_ins for delete to authenticated using (auth.uid() = surveyor);

-- Realtime for live collaboration (active check-ins) — add only if not already published.
do $$ begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'check_ins'
  ) then
    alter publication supabase_realtime add table public.check_ins;
  end if;
end $$;
