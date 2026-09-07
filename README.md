# Daylight

Daylight is a personal schedule and lesson planning workspace. It is designed to make time, teaching income, and physical energy visible in one place.

## Current milestone

The first implementation is a responsive dashboard prototype with:

- Daily schedule blocks for lessons, personal time, and recovery.
- Weekly teaching-hour and stamina summaries.
- Current-month completed earnings with no synthetic starting balance.
- Week and month calendar views with range navigation.
- One-time and weekly recurring event creation with optional end dates.
- A general arithmetic calculator with keyboard-friendly keypad controls.
- Safe calculator parsing for numbers, decimals, parentheses, addition, subtraction, multiplication, and division.
- Add and edit schedule blocks with time validation, intensity, preparation, and travel inputs.
- Delete schedule blocks and keep changes in browser localStorage between visits.
- Live weekly teaching-hour summaries based on the current schedule.
- Supabase SSR authentication and cloud lesson persistence when environment variables are configured.
- A mobile navigation layout and desktop sidebar.

Without Supabase variables, the app runs in local demo mode. With Supabase configured, login is required and lesson add/edit/delete operations are stored in the authenticated user's database rows.

## Run locally

Install dependencies and start the development server:

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Enable Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. In the Supabase Authentication dashboard, create your private user with email/password.
3. Copy `.env.example` to `.env.local` and fill in the project URL and publishable key from the Supabase Connect dialog.
4. Run `supabase/migrations/001_create_profiles_and_lessons.sql` in the Supabase SQL Editor.
5. Run `supabase/migrations/002_schedule_events_and_exceptions.sql` after the initial migration. It creates the range-aware event store, recurrence fields, exception table, indexes, RLS policies, and migrates existing lessons.
6. Restart the development server. The dashboard will redirect signed-out visitors to `/login`.

The first migration creates `profiles` and `lessons`, a profile trigger for new users, ownership indexes, and explicit Row Level Security policies. The second migration adds `schedule_events` and `schedule_event_exceptions` for one-time and weekly events. Existing lessons are copied into the new event table; keep the original table during the transition. Do not put a Supabase secret/service-role key in `.env.local`, browser code, GitHub, or Vercel client variables.

For Vercel, add these same two variables under Project Settings > Environment Variables:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

Then add your local and production URLs under Supabase Authentication > URL Configuration.

## Validate

```bash
npm run lint
npm run build
```

The calendar uses the profile timezone for display, expands weekly events only within the visible range, and keeps the event series separate from occurrence exceptions. Scheduled events do not count toward actual earnings; completed lesson events use hourly duration multiplied by rate, while skipped and cancelled events are excluded.

## Deploy to GitHub Pages

This repository includes a GitHub Actions workflow at `.github/workflows/deploy-pages.yml`. It builds the Next.js app as a static export and deploys the `out` directory to:

`https://jerryleung16.github.io/schedule-management/`

In the repository settings, set **Pages > Build and deployment > Source** to **GitHub Actions**. The workflow runs on pushes to `master`.

For cloud persistence and authentication, add these repository variables under **Settings > Secrets and variables > Actions > Variables**:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-publishable-key
```

GitHub Pages is a static host, so the server-side Supabase proxy is not available there. The dashboard and calendar retain their client-side authentication checks and use the public Supabase publishable key. Add the Pages URL under Supabase Authentication > URL Configuration.

## Planned product direction

- Next.js and TypeScript for the web application.
- Supabase Authentication and PostgreSQL for private cross-device data.
- Vercel for deployment from GitHub.
- Configurable daily and weekly stamina budgets using weighted lesson load points.
- Hourly and fixed lesson rates, with completed lessons contributing to actual earnings.
- Recurring lessons with reschedule, skip, and cancellation exceptions.

External calendar synchronization, tax calculation, invoicing, and payment reconciliation are intentionally outside the first release.
