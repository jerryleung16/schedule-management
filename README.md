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
- Optional one-way Google Calendar event synchronization from the calendar workspace.
- A mobile navigation layout and desktop sidebar.

Firebase Authentication and Cloud Firestore provide private cross-device storage. Cloud mode is the default and requires configuration plus an approved account. For an explicit browser-only demo, set `NEXT_PUBLIC_DATA_MODE=local`. Missing cloud configuration never silently switches you to local storage.

## Run locally
```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Enable Firebase

1. Create a Firebase project, register a web app, enable Email/Password authentication, and create a Firestore database.
2. Copy [the environment example](.env.example) into your local environment and fill in the four Firebase web configuration values.
3. Follow the [migration and setup runbook](docs/firebase-migration.md) to deploy security rules/indexes, export Supabase data, rehearse, import, verify, and activate your private account.
4. Add the public Firebase configuration to GitHub Actions repository variables before deploying. Do not upload admin credentials.

Application access is restricted by Firestore rules and the admin-only `access/{uid}` allowlist. Firebase configuration alone does not grant data access.

## Enable Google Calendar sync

1. In [Google Cloud Console](https://console.cloud.google.com/), enable the Google Calendar API.
2. Create an OAuth client ID for a web application.
3. Add `http://localhost:3000`, `http://localhost:3001`, your deployed site origin, and any other development origin under Authorized JavaScript origins.
4. Add the client ID to `.env.local`:

```env
NEXT_PUBLIC_GOOGLE_CLIENT_ID=your-web-application-client-id.apps.googleusercontent.com
```

Google Calendar sync runs in the browser so it works with the static GitHub Pages deployment. Daylight requests the Calendar events scope and only creates, updates, or removes events that Daylight owns. It never imports Google Calendar events or applies Google-side edits back to the schedule. Access tokens stay in the browser session and can be revoked from Settings by disconnecting the calendar.

Open **My calendar** and use **Sync to Google Calendar** to resend the complete saved schedule after a connection failure. The connection panel also lets you connect or reconnect without leaving My calendar. Sync replays recurring-event changes and retries deletions remembered by this browser.

After each workspace login, Daylight verifies Google Calendar access and syncs the saved schedule when authorization is valid. It checks again when the browser regains focus, the network returns, or the token expires. Google requires a user gesture to renew expired authorization, so Daylight shows a Connect/Reconnect button when needed; it never treats an expired token or failed network request as a verified connection. Authorization is scoped to the signed-in workspace account.

My calendar opens in Day view on phones, with a daily agenda, touch-friendly controls, and a compact month grid. Recurring events appear in Overview; edit or delete them through My calendar to choose one occurrence, following occurrences, or the series. Editing a series retains its original start and preserves applicable skips and reschedules. Series changes and exception migration save together.

Full sync verifies that the saved schedule has not changed before reporting success and restarts when edits occur during replay. Google event IDs are stable to prevent simultaneous requests from creating duplicates. Daylight-owned events carry a workspace marker so missed deletions can be recovered on another browser; older unmarked events use browser links until they have been synced again.

## Validate

```bash
npm run lint
npm run build
npm test
```

The calendar uses the profile timezone for display, expands weekly events only within the visible range, and keeps the event series separate from occurrence exceptions. Scheduled events do not count toward actual earnings; completed lesson events use hourly duration multiplied by rate, while skipped and cancelled events are excluded.

## Deploy to GitHub Pages

This repository includes a GitHub Actions workflow at `.github/workflows/deploy-pages.yml`. It builds the Next.js app as a static export and deploys the `out` directory to:

`https://jerryleung16.github.io/schedule-management/`

In the repository settings, set **Pages > Build and deployment > Source** to **GitHub Actions**. The workflow runs on pushes to `master`.

For cloud persistence and authentication, add these repository variables under **Settings > Secrets and variables > Actions > Variables**:

```env
NEXT_PUBLIC_FIREBASE_API_KEY=your-firebase-web-api-key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project
NEXT_PUBLIC_FIREBASE_APP_ID=your-firebase-web-app-id
NEXT_PUBLIC_GOOGLE_CLIENT_ID=your-web-application-client-id.apps.googleusercontent.com
```

GitHub Pages remains the static host. Firebase Authentication runs in the browser, and Firestore rules enforce access independently of the UI. Add your Pages hostname to Firebase Authentication authorized domains. The deployment workflow checks all required Firebase variables before building; rules and indexes must be deployed separately first.

## Planned product direction

- Next.js and TypeScript for the web application.
- Firebase Authentication and Cloud Firestore for private cross-device data.
- GitHub Pages for static deployment from GitHub.
- Configurable daily and weekly stamina budgets using weighted lesson load points.
- Hourly and fixed lesson rates, with completed lessons contributing to actual earnings.
- Recurring lessons with reschedule, skip, and cancellation exceptions.

Tax calculation, invoicing, and payment reconciliation are intentionally outside the first release.
