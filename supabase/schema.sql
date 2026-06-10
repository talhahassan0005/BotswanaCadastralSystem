-- ===========================================================================
-- Botswana Cadastral System — Supabase schema
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

-- Seed the 16 starter marks (idempotent). Replace/extend with the official DSM export.
insert into public.ref_marks (number, name, type, lat, lon, description, status, region) values
  ('T 24/101','Gaborone','Trigonometrical beacon',-24.6282,25.9231,'Concrete pillar, brass bolt','In good order','South-East'),
  ('T 25/044','Lobatse','Trigonometrical beacon',-25.2210,25.6770,'Concrete beacon on hill','In good order','South-East'),
  ('T 24/318','Molepolole','Town survey mark',-24.4067,25.4951,'Standard iron peg in kerb','In good order','Kweneng'),
  ('T 24/206','Kanye','Trigonometrical beacon',-24.9833,25.3500,'Pillar with vane','Witness mark','Southern'),
  ('T 24/512','Jwaneng','Reference mark',-24.6017,24.7280,'Brass plate in concrete','In good order','Southern'),
  ('T 23/077','Mahalapye','Trigonometrical beacon',-23.1041,26.8142,'Concrete beacon','Reported destroyed','Central'),
  ('T 22/133','Palapye','Town survey mark',-22.5500,27.1250,'Iron peg, 12mm','In good order','Central'),
  ('T 22/061','Serowe','Trigonometrical beacon',-22.3875,26.7108,'Pillar on koppie','In good order','Central'),
  ('T 22/240','Selebi-Phikwe','Reference mark',-21.9764,27.8478,'Brass bolt in slab','Not visited','Central'),
  ('T 21/018','Francistown','Trigonometrical beacon',-21.1702,27.5078,'Concrete pillar','In good order','North-East'),
  ('T 19/004','Maun','Trigonometrical beacon',-19.9833,23.4167,'Beacon near airport','In good order','North-West'),
  ('T 17/002','Kasane','Reference mark',-17.8000,25.1500,'Brass plate, riverbank','Witness mark','Chobe'),
  ('T 21/090','Ghanzi','Trigonometrical beacon',-21.7000,21.6500,'Concrete beacon','In good order','Ghanzi'),
  ('T 21/142','Charleshill','Reference mark',-21.9300,20.9800,'Iron peg near Lot 14182','In good order','Ghanzi'),
  ('T 26/011','Tsabong','Trigonometrical beacon',-26.0167,22.4000,'Pillar, sand dune ridge','Not visited','Kgalagadi'),
  ('T 24/660','Ramotswa','Town survey mark',-24.8667,25.8167,'Standard mark in pavement','In good order','South-East')
on conflict (number) do nothing;

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
