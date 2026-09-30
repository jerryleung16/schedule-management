create table if not exists public.weekly_availability_overrides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  intervals jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_availability_overrides_week_start_monday check (extract(isodow from week_start) = 1),
  constraint weekly_availability_overrides_intervals_array check (jsonb_typeof(intervals) = 'array'),
  constraint weekly_availability_overrides_user_week_unique unique (user_id, week_start)
);

create index if not exists weekly_availability_overrides_user_week_idx
  on public.weekly_availability_overrides (user_id, week_start);

alter table public.weekly_availability_overrides enable row level security;

grant select, insert, update, delete on public.weekly_availability_overrides to authenticated;

create policy "Users can view their weekly availability overrides"
  on public.weekly_availability_overrides for select
  to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert their weekly availability overrides"
  on public.weekly_availability_overrides for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update their weekly availability overrides"
  on public.weekly_availability_overrides for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their weekly availability overrides"
  on public.weekly_availability_overrides for delete
  to authenticated
  using (auth.uid() = user_id);