alter table public.schedule_events
  drop constraint if exists schedule_events_tone_check;

alter table public.schedule_events
  add constraint schedule_events_tone_check
  check (tone in ('blue', 'coral', 'teal', 'yellow', 'violet'));

alter table public.lessons
  drop constraint if exists lessons_tone_check;

alter table public.lessons
  add constraint lessons_tone_check
  check (tone in ('blue', 'coral', 'teal', 'yellow', 'violet'));

alter table public.schedule_event_exceptions
  add column if not exists kind text,
  add column if not exists tone text,
  add column if not exists travel_minutes integer;

alter table public.schedule_event_exceptions
  drop constraint if exists schedule_event_exceptions_kind_check,
  drop constraint if exists schedule_event_exceptions_tone_check,
  drop constraint if exists schedule_event_exceptions_travel_minutes_check;

alter table public.schedule_event_exceptions
  add constraint schedule_event_exceptions_kind_check
    check (kind is null or kind in ('lesson', 'personal')),
  add constraint schedule_event_exceptions_tone_check
    check (tone is null or tone in ('blue', 'coral', 'teal', 'yellow', 'violet')),
  add constraint schedule_event_exceptions_travel_minutes_check
    check (travel_minutes is null or travel_minutes >= 0);
