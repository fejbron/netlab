-- NetLab account progress. Run this in the Supabase SQL editor (or with the CLI)
-- once per project. Auth itself is handled by Supabase Auth; this table stores
-- the best attempt per lab for each learner.

create table if not exists public.lab_progress (
  user_id      uuid        not null references auth.users (id) on delete cascade,
  lab_id       text        not null,
  score        integer     not null check (score between 0 and 100),
  stars        integer     not null check (stars between 0 and 3),
  completed_at timestamptz not null,
  updated_at   timestamptz not null default now(),
  primary key (user_id, lab_id)
);

create index if not exists lab_progress_user_idx on public.lab_progress (user_id);

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
create or replace view public.my_progress_summary
  with (security_invoker = true) as
  select user_id, count(*) as labs_passed, sum(stars) as total_stars, max(completed_at) as last_completed
  from public.lab_progress
  group by user_id;
