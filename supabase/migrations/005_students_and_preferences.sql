create table public.students (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  email text not null default '',
  phone text not null default '',
  notes text not null default '',
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index students_user_status_name_idx on public.students(user_id, status, name);

alter table public.schedule_events
  add column if not exists student_id uuid references public.students(id) on delete set null;

alter table public.lessons
  add column if not exists student_id uuid references public.students(id) on delete set null;

alter table public.profiles
  add column if not exists default_lesson_rate numeric(10, 2) not null default 35 check (default_lesson_rate >= 0),
  add column if not exists default_travel_minutes integer not null default 0 check (default_travel_minutes >= 0),
  add column if not exists default_lesson_tone text not null default 'coral' check (default_lesson_tone in ('blue', 'coral', 'teal', 'yellow', 'violet')),
  add column if not exists default_personal_tone text not null default 'teal' check (default_personal_tone in ('blue', 'coral', 'teal', 'yellow', 'violet'));

alter table public.students enable row level security;
revoke all on table public.students from anon, authenticated;
grant select, insert, update, delete on table public.students to authenticated;

create policy "Users can read their students"
on public.students for select to authenticated
using ((select auth.uid()) = user_id);
create policy "Users can create their students"
on public.students for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy "Users can update their students"
on public.students for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy "Users can delete their students"
on public.students for delete to authenticated
using ((select auth.uid()) = user_id);

create index schedule_events_student_idx on public.schedule_events(student_id);
create index lessons_student_idx on public.lessons(student_id);
