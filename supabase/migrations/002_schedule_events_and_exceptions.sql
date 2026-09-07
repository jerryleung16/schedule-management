create table public.schedule_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'UTC',
  title text not null,
  detail text not null default '',
  kind text not null check (kind in ('lesson', 'personal')),
  tone text not null default 'coral' check (tone in ('blue', 'coral', 'teal', 'yellow')),
  intensity numeric not null default 2 check (intensity >= 0),
  prep_minutes integer not null default 0 check (prep_minutes >= 0),
  travel_minutes integer not null default 0 check (travel_minutes >= 0),
  hourly_rate numeric(10, 2) not null default 0 check (hourly_rate >= 0),
  fixed_fee numeric(10, 2) check (fixed_fee >= 0),
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'cancelled', 'skipped')),
  recurrence_weekdays smallint[] not null default '{}',
  recurrence_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint schedule_events_end_after_start check (ends_at > starts_at),
  constraint schedule_events_recurrence_end check (recurrence_until is null or recurrence_until >= (starts_at at time zone timezone)::date)
);

create table public.schedule_event_exceptions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.schedule_events(id) on delete cascade,
  original_starts_at timestamptz not null,
  starts_at timestamptz,
  ends_at timestamptz,
  status text not null default 'skipped' check (status in ('scheduled', 'completed', 'cancelled', 'skipped')),
  title text,
  detail text,
  hourly_rate numeric(10, 2),
  fixed_fee numeric(10, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, original_starts_at),
  constraint schedule_event_exceptions_end_after_start check (ends_at is null or starts_at is null or ends_at > starts_at)
);

create index schedule_events_user_starts_idx on public.schedule_events(user_id, starts_at);
create index schedule_event_exceptions_event_start_idx on public.schedule_event_exceptions(event_id, original_starts_at);

insert into public.schedule_events (id, user_id, starts_at, ends_at, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, status)
select id, user_id, starts_at, ends_at, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, status
from public.lessons
on conflict (id) do nothing;

alter table public.schedule_events enable row level security;
alter table public.schedule_event_exceptions enable row level security;

revoke all on table public.schedule_events from anon, authenticated;
revoke all on table public.schedule_event_exceptions from anon, authenticated;
grant select, insert, update, delete on table public.schedule_events to authenticated;
grant select, insert, update, delete on table public.schedule_event_exceptions to authenticated;

create policy "Users can read their schedule events"
on public.schedule_events for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can create their schedule events"
on public.schedule_events for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users can update their schedule events"
on public.schedule_events for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users can delete their schedule events"
on public.schedule_events for delete to authenticated using ((select auth.uid()) = user_id);

create policy "Users can read their event exceptions"
on public.schedule_event_exceptions for select to authenticated
using (exists (select 1 from public.schedule_events where schedule_events.id = event_id and schedule_events.user_id = auth.uid()));
create policy "Users can create their event exceptions"
on public.schedule_event_exceptions for insert to authenticated
with check (exists (select 1 from public.schedule_events where schedule_events.id = event_id and schedule_events.user_id = auth.uid()));
create policy "Users can update their event exceptions"
on public.schedule_event_exceptions for update to authenticated
using (exists (select 1 from public.schedule_events where schedule_events.id = event_id and schedule_events.user_id = auth.uid()))
with check (exists (select 1 from public.schedule_events where schedule_events.id = event_id and schedule_events.user_id = auth.uid()));
create policy "Users can delete their event exceptions"
on public.schedule_event_exceptions for delete to authenticated
using (exists (select 1 from public.schedule_events where schedule_events.id = event_id and schedule_events.user_id = auth.uid()));