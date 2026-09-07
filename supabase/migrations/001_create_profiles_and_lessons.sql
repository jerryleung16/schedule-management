create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  timezone text not null default 'UTC',
  daily_stamina_limit numeric not null default 16 check (daily_stamina_limit >= 0),
  weekly_stamina_limit numeric not null default 40 check (weekly_stamina_limit >= 0),
  created_at timestamptz not null default now()
);

create table public.lessons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  title text not null,
  detail text not null default '',
  kind text not null check (kind in ('lesson', 'personal')),
  tone text not null default 'coral' check (tone in ('blue', 'coral', 'teal', 'yellow')),
  intensity numeric not null default 2 check (intensity >= 0),
  prep_minutes integer not null default 0 check (prep_minutes >= 0),
  travel_minutes integer not null default 0 check (travel_minutes >= 0),
  hourly_rate numeric(10, 2) not null default 0 check (hourly_rate >= 0),
  status text not null default 'scheduled' check (status in ('scheduled', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lessons_end_after_start check (ends_at > starts_at)
);

create index lessons_user_starts_idx on public.lessons(user_id, starts_at);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.lessons enable row level security;

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.lessons from anon, authenticated;
grant select, insert, update, delete on table public.profiles to authenticated;
grant select, insert, update, delete on table public.lessons to authenticated;

create policy "Users can read their profile"
on public.profiles for select
to authenticated
using ((select auth.uid()) = id);

create policy "Users can create their profile"
on public.profiles for insert
to authenticated
with check ((select auth.uid()) = id);

create policy "Users can update their profile"
on public.profiles for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "Users can delete their profile"
on public.profiles for delete
to authenticated
using ((select auth.uid()) = id);

create policy "Users can read their lessons"
on public.lessons for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their lessons"
on public.lessons for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their lessons"
on public.lessons for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy "Users can delete their lessons"
on public.lessons for delete
to authenticated
using ((select auth.uid()) = user_id);
