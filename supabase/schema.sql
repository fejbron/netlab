-- NetLab account progress. Run this in the Supabase SQL editor (or with the CLI)
-- once per project. Auth itself is handled by Supabase Auth; this table stores
-- the best attempt per lab for each learner.

create table if not exists public.lab_progress (
  user_id      uuid        not null references auth.users (id) on delete cascade,
  lab_id       text        not null,
  score        integer     not null check (score between 0 and 100),
  stars        integer     not null check (stars between 0 and 3),
  -- What the pass is worth on the leaderboard: difficulty and exam weight times the
  -- share the stars earned. The client computes it (see src/lib/points.ts) because
  -- the lab catalogue lives in the app, not in the database.
  points       integer     not null default 0 check (points >= 0),
  -- Which learning path the lab belongs to, so the leaderboard can be split by path.
  -- Denormalised for the same reason as points: the catalogue lives in the app.
  path         text,
  completed_at timestamptz not null,
  updated_at   timestamptz not null default now(),
  primary key (user_id, lab_id)
);

-- Existing installations: add the column, then give rows written before points
-- existed an approximate value. The real value is written on the learner's next sync.
alter table public.lab_progress add column if not exists points integer not null default 0;
update public.lab_progress set points = stars * 100 where points = 0;

-- Existing installations: add the path column and fill it in from the lab id. Every
-- Linux lab id starts lx-, every SQL one db-, every Terraform one tf-, and the rest are CCNA. The client writes
-- the real value on the learner's next sync, so this only has to cover today's rows.
alter table public.lab_progress add column if not exists path text;
update public.lab_progress
   set path = case
                when lab_id like 'lx-%' then 'linux'
                when lab_id like 'db-%' then 'sql'
                when lab_id like 'tf-%' then 'terraform'
                else 'ccna'
              end
 where path is null;

create index if not exists lab_progress_user_idx on public.lab_progress (user_id);
create index if not exists lab_progress_path_idx on public.lab_progress (path);

-- Keep updated_at fresh on every write.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists lab_progress_touch on public.lab_progress;
create trigger lab_progress_touch
  before update on public.lab_progress
  for each row execute function public.touch_updated_at();

-- Row level security: learners only ever see and change their own rows.
alter table public.lab_progress enable row level security;

drop policy if exists "own progress: select" on public.lab_progress;
create policy "own progress: select" on public.lab_progress
  for select using (auth.uid() = user_id);

drop policy if exists "own progress: insert" on public.lab_progress;
create policy "own progress: insert" on public.lab_progress
  for insert with check (auth.uid() = user_id);

drop policy if exists "own progress: update" on public.lab_progress;
create policy "own progress: update" on public.lab_progress
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own progress: delete" on public.lab_progress;
create policy "own progress: delete" on public.lab_progress
  for delete using (auth.uid() = user_id);

-- Optional: a per-learner summary the dashboard could use later.
drop view if exists public.my_progress_summary;
create view public.my_progress_summary
  with (security_invoker = true) as
  select user_id,
         count(*) as labs_passed,
         sum(points)::int as total_points,
         sum(stars)::int as total_stars,
         max(completed_at) as last_completed
  from public.lab_progress
  group by user_id;

-- ---------------------------------------------------------------------------
-- Profiles and the leaderboard

-- One public profile per learner. Emails are never exposed; only the display
-- name is. Learners can opt out of the leaderboard.
create table if not exists public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  display_name        text not null check (char_length(display_name) between 2 and 32),
  show_on_leaderboard boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();

alter table public.profiles enable row level security;

drop policy if exists "profiles: public read" on public.profiles;
create policy "profiles: public read" on public.profiles
  for select using (true);

drop policy if exists "profiles: insert own" on public.profiles;
create policy "profiles: insert own" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- Default display name: GitHub user name, else the part of the email before @,
-- made unique with a short suffix when taken.
create or replace function public.default_display_name(u auth.users)
returns text language plpgsql as $$
declare
  base text;
  candidate text;
  n int := 0;
begin
  base := coalesce(
    nullif(u.raw_user_meta_data ->> 'user_name', ''),
    nullif(u.raw_user_meta_data ->> 'preferred_username', ''),
    nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
    'learner'
  );
  base := left(regexp_replace(base, '[^A-Za-z0-9_.-]', '', 'g'), 24);
  if char_length(base) < 2 then base := 'learner'; end if;
  candidate := base;
  while exists (select 1 from public.profiles where display_name = candidate) loop
    n := n + 1;
    candidate := base || '-' || n;
  end loop;
  return candidate;
end $$;

-- Create the profile automatically when an account is created.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, public.default_display_name(new))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Back-fill profiles for accounts created before this migration.
insert into public.profiles (id, display_name)
select u.id, public.default_display_name(u)
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- The leaderboard. This view is owned by the schema owner and deliberately does
-- NOT use security_invoker, so it can total points across every learner while the
-- lab_progress rows themselves stay private. It only exposes display names and
-- totals, and skips learners who opted out.
drop view if exists public.leaderboard;
create view public.leaderboard as
  select p.id as user_id,
         p.display_name,
         coalesce(sum(l.points), 0)::int as total_points,
         coalesce(sum(l.stars), 0)::int as total_stars,
         count(l.lab_id)::int as labs_passed,
         max(l.completed_at) as last_completed
  from public.profiles p
  left join public.lab_progress l on l.user_id = p.id
  where p.show_on_leaderboard
  group by p.id, p.display_name
  having count(l.lab_id) > 0
  order by total_points desc, labs_passed desc, last_completed asc;

grant select on public.leaderboard to anon, authenticated;

-- The same board, split by learning path, so each path can be ranked on its own.
-- An inner join rather than a left one: a learner appears on a path's board only once
-- they have passed something on it.
drop view if exists public.leaderboard_by_path;
create view public.leaderboard_by_path as
  select l.path,
         p.id as user_id,
         p.display_name,
         sum(l.points)::int as total_points,
         sum(l.stars)::int as total_stars,
         count(l.lab_id)::int as labs_passed,
         max(l.completed_at) as last_completed
  from public.profiles p
  join public.lab_progress l on l.user_id = p.id
  where p.show_on_leaderboard and l.path is not null
  group by l.path, p.id, p.display_name
  order by l.path, total_points desc, labs_passed desc, last_completed asc;

grant select on public.leaderboard_by_path to anon, authenticated;
