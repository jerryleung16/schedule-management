create table public.weekly_availability (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  starts time not null,
  ends time not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_availability_end_after_start check (ends > starts),
  unique (user_id, weekday, starts, ends)
);

create index weekly_availability_user_day_idx
  on public.weekly_availability(user_id, weekday, starts);

alter table public.weekly_availability enable row level security;

revoke all on table public.weekly_availability from anon, authenticated;
grant select, insert, update, delete on table public.weekly_availability to authenticated;

create policy "Users can read their weekly availability"
on public.weekly_availability for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their weekly availability"
on public.weekly_availability for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their weekly availability"
on public.weekly_availability for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their weekly availability"
on public.weekly_availability for delete to authenticated
using ((select auth.uid()) = user_id);
