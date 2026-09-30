create table public.weekly_working_places (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  place text not null check (char_length(btrim(place)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, weekday)
);

create index weekly_working_places_user_day_idx
  on public.weekly_working_places(user_id, weekday);

alter table public.weekly_working_places enable row level security;

revoke all on table public.weekly_working_places from anon, authenticated;
grant select, insert, update, delete on table public.weekly_working_places to authenticated;

create policy "Users can read their weekly working places"
on public.weekly_working_places for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their weekly working places"
on public.weekly_working_places for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their weekly working places"
on public.weekly_working_places for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their weekly working places"
on public.weekly_working_places for delete to authenticated
using ((select auth.uid()) = user_id);