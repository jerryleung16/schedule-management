# Supabase to Firebase migration

The website stays on GitHub Pages. Firebase Authentication and Cloud Firestore replace Supabase; no Firebase Hosting, application server, or Cloud Functions are required by this implementation. Existing SQL migrations remain as source-history and backup reference, not as Firebase deployment inputs.

## Safety boundaries

- Nothing in the application or migration scripts deletes or writes to Supabase.
- Cloud mode is the default and fails closed if Firebase settings are missing. Local demo mode requires an explicit `NEXT_PUBLIC_DATA_MODE=local`; it is not a fallback for cloud failures.
- Firebase web configuration is public. Security comes from deployed Firestore rules plus an administrator-controlled `access/{uid}.enabled` allowlist. Even an authenticated but unapproved account cannot read application records.
- Never put a Firebase service-account key or Supabase service-role key in browser code, `NEXT_PUBLIC_*` variables, GitHub Pages output, or committed files.
- Password hashes and sessions are not migrated. The import creates a disabled Firebase account; enable it only after verification, then send a password-reset email through Firebase Authentication.
- The default target Firebase UID is the original Supabase user UUID. This preserves application ownership and browser Google Calendar link keys. Event/student IDs are preserved too; occurrence exceptions receive deterministic IDs based on event ID and original timestamp.
- Import refuses an active/nonempty unrelated target, mismatched service-account projects, or a different snapshot over an existing migration. An interrupted import can be retried with the identical snapshot, project, and UID.

## 1. Provision Firebase

1. Create a Firebase project and register a web app. Review current plan quotas and choose a database region before creating Firestore; enable it in production mode, not test mode.
2. Enable Authentication > Email/Password. Do not manually create the migrating user: the importer preserves its original UUID.
3. Add `jerryleung16.github.io` and your development hostname (for example `localhost`) under Authentication > Settings > Authorized domains. Add any custom domain separately.
4. Copy the four Firebase web configuration values into `.env.local` using [the example](../.env.example). Keep the existing Google Calendar client ID. Remove old public Supabase variables when ready; the new app does not use them.
5. Deploy the checked-in rules and indexes with `npx firebase-tools login`, followed by `npx firebase-tools deploy --only firestore --project YOUR_PROJECT_ID`. Wait for the composite indexes to finish building.
6. Download a Firebase Admin service-account key to a protected location outside this repository. Grant only the administrative capabilities required for this one-time migration. Delete/revoke the key after successful cutover.

## 2. Export a private backup

Requires Node.js 24 and `npm install`. Create an ignored `.env.migration` locally:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_PRIVATE_SERVER_KEY
SUPABASE_USER_ID=YOUR_EXISTING_USER_UUID
GOOGLE_APPLICATION_CREDENTIALS=C:/secure/daylight.service-account.json
```

The exporter is scoped to one user. It reads all eight tables, paginates with exact counts, and exports only the account email/ID/verification flag (not passwords). If a required table is missing, apply/review the source migrations before proceeding; do not silently omit data.

```powershell
npm.cmd run migration -- export --out .migration-backups/supabase-final.json
npm.cmd run migration -- plan --input .migration-backups/supabase-final.json
```

Export never overwrites an existing backup. Stop source edits before the final export; pagination is not a cross-table database transaction. Keep a second protected copy outside the repository. The dry run makes no network calls, validates every record and relationship, prints normalized counts and SHA-256 fingerprints, and reconciles legacy lessons by ID with canonical events winning.

## 3. Rehearse locally

Use a separate preliminary export for rehearsal and the Firebase Auth/Firestore emulators. Java 21+ is required by current Firestore emulator releases. Never point emulator runs at a production project.

```powershell
npx.cmd firebase-tools emulators:start --only auth,firestore --project demo-daylight
```

In another PowerShell terminal set both variables:

```powershell
$env:FIRESTORE_EMULATOR_HOST="127.0.0.1:8080"
$env:FIREBASE_AUTH_EMULATOR_HOST="127.0.0.1:9099"
npm.cmd run migration -- import --input .migration-backups/rehearsal.json --project demo-daylight --confirm-project demo-daylight
npm.cmd run migration -- verify --input .migration-backups/rehearsal.json --project demo-daylight --confirm-project demo-daylight
```

For browser rehearsal, set `NEXT_PUBLIC_FIREBASE_EMULATORS=true`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-daylight`, and dummy nonempty Firebase web config values in a temporary local configuration. Restart the dev server. Restore the real config and remove both admin emulator environment variables before production commands. Do not sync rehearsal data to your real Google Calendar.

## 4. Import the frozen final snapshot

```powershell
npm.cmd run migration -- import --input .migration-backups/supabase-final.json --project YOUR_PROJECT_ID --confirm-project YOUR_PROJECT_ID
npm.cmd run migration -- verify --input .migration-backups/supabase-final.json --project YOUR_PROJECT_ID --confirm-project YOUR_PROJECT_ID
```

The importer validates everything before remote writes, uses deterministic document IDs, and compares every imported document's content hash and collection count. It retains a checkpoint in `_migrations/{uid}`. The account stays disabled and has no access grant until a separate activation:

```powershell
npm.cmd run migration -- activate --input .migration-backups/supabase-final.json --project YOUR_PROJECT_ID --confirm-project YOUR_PROJECT_ID
```

Activation re-verifies the snapshot before enabling the account and its allowlist document. Send a password-reset email from Firebase Authentication and set a new password. Do not run `verify` against the old snapshot after making legitimate application edits and expect the hashes still to match.

If an existing disabled Firebase account must be used instead, pass `--firebase-uid THAT_UID` consistently to plan/import/verify/activate. Its email must match. This changes browser storage ownership keys, so reconnect Google Calendar and verify matching by preserved event IDs before enabling sync.

## 5. Switch GitHub Pages

Add repository Actions **variables**:

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`
- Keep `NEXT_PUBLIC_GOOGLE_CLIENT_ID`.

The workflow refuses to deploy if a required Firebase variable is empty. It does not deploy rules or provision accounts; those must be ready first. Review changes, commit/push when authorized, then run the GitHub Pages workflow. The repository base path and public site URL stay unchanged. Firebase Hosting is not configured.

## Acceptance checks

- Signed-out visitors see login; unapproved users cannot read or write any application data.
- Approved users can only access their own records; forged user IDs and foreign event/student references are denied.
- Create/edit/delete events; add students and archive/restore them; save preferences.
- Recurring events, cancelled/skipped occurrences, moved exceptions (including outside the original recurrence range), and following-occurrence deletions behave as before.
- Compare event counts, displayed timezones, rates/fixed fees, earnings, availability overrides and working places against the source before edits.
- Test refresh, session restoration, sign-out, and a second device.
- Reconnect Google Calendar if necessary and verify an existing event is updated rather than duplicated. Keep the existing browser profile to retain link keys; access tokens are not migrated.
- Run `npm run lint`, `npx tsc --noEmit`, and a GitHub Pages-mode build (set `GITHUB_ACTIONS=true`).

The repository fetches events by bounded overlap queries and includes parents of rescheduled exceptions. Exception ID queries are chunked. Availability and working-place replacements use one atomic batch. Deleting an event deletes its parent first (blocking new exceptions), then removes its exceptions in batches; if cleanup fails, retry the same deletion. Student deletion is intentionally denied; archive instead.

Availability override intervals are separate documents so rules validate each interval without exceeding Firestore expression limits. A single availability save is capped at 450 document changes. Date/time strings are normalized to UTC ISO timestamps before writing. Firestore rules enforce ownership, field sets, types, and core value constraints; richer timezone and recurrence validation also runs in the shared normalizer.

## Rollback and retirement

Keep Supabase and the old deployment intact during validation. Keep edits stopped until the replacement passes checks. If rolling back after Firebase has accepted new edits, export/reconcile those changes first; simply redeploying the old app would hide them.

Only after successful live verification and an observation period should you remove old Supabase repository variables, retain secure backups, revoke temporary admin credentials, and explicitly delete the old Supabase project to release its slot. Deleting the project is a separate manual, irreversible step; no script performs it.

## Cutover status — 2026-10-31

The production cutover is already deployed. Continue with acceptance checks and the observation period rather than importing again into the active workspace.

- Firebase project `schedule-management-c1b2f` has an activated migration checkpoint, an enabled account, and an enabled access grant. Authentication records a successful sign-in after deployment.
- [GitHub Pages deployment of commit 3fe0584](https://github.com/jerryleung16/schedule-management/actions/runs/41099824666) succeeded. The [live application](https://jerryleung16.github.io/schedule-management/) redirects signed-out visitors to the Firebase login screen.
- A read-only production verification against the original private snapshot matched all eight collection counts and content hashes: 1 profile, 3 students, 26 events, 15 event exceptions, 0 weekly availability records, 2 availability overrides, 0 override intervals, and 7 working places.
- A fresh read-only Supabase export on 2026-10-31 produced the same import fingerprint (`f891f609afef22fbb90d17e501cb1dbd3f000b92552ac3ec6cf302528fdb75f7`), confirming no source drift at this check.
- The existing local emulator verification report records 25 passing security/data checks. This historical report is not a fresh production rules test.

The signed-in production workspace loaded the overview, settings, and calendar with the migrated records. Google Calendar connection succeeded and the application reported syncing all 26 existing events. A labeled one-time personal event was created, survived a page refresh, was edited, and was deleted. Each operation reported a Google Calendar update. A direct Google Calendar API read after deletion showed that the linked test event has `cancelled` status; the test event no longer appears in the schedule. A temporary three-occurrence weekly series was also created; cancelling its middle occurrence survived refresh while the final occurrence remained. The entire series was then deleted, and a Google Calendar search found zero active matches for its test label. A final Firestore read found the original 26 events and 15 exceptions, with no test events or orphan exceptions. A production student was archived and restored; all three students are again active. This legitimate write updates metadata, so the original snapshot hash is no longer expected to match exactly. The tests revealed misleading one-time event success messages and a stale weekday default when changing the date before selecting Weekly; both fixes are included in the current change.

The [follow-up Pages deployment of commit c2b5162](https://github.com/jerryleung16/schedule-management/actions/runs/41128145861) succeeded. Its corrected repeat-weekday default was confirmed on the live site by changing a new event's date to Monday before selecting Weekly; Monday was selected without a manual weekday edit. An unchanged settings save succeeded and its values survived refresh. An existing custom availability week also saved successfully without changing its schedule. A separate temporary series had an occurrence moved beyond the parent's recurrence end date; the moved occurrence remained visible after refresh. "This and following" removed it while preserving the earlier occurrence. The remaining series was deleted. A final direct Firestore check found 26 events, 15 exceptions, no test events, and no orphan exceptions. Google Calendar had zero active matches for the test label.

The user confirmed a normal Firebase sign-in on a second device on 2026-10-31 and confirmed that all students are visible there. Visibility of the migrated events on that device has not been explicitly confirmed. Google Calendar authorization is browser-local, so reconnect it there if that device also needs sync.

During validation, the user reported a 26-second calendar load and a successful schedule save followed by a Google Calendar popup error. Commits `5639826` and `c7e0313` reduce repeated reads, use long polling on networks that buffer Firestore responses, and require a direct Settings reconnect when the browser's Google access token expires. On 2026-10-31, the user reconnected in the shared live Settings tab; it then showed **Connected** and reported that 26 existing events and 14 recurring occurrence changes synced. The source snapshot has 15 exceptions, but one belongs to a nonrecurring event and is intentionally skipped by the recurrence sync loop. The user confirmed that calendar load time on the previously affected device is now fine.

## Retirement status — 2026-10-31

The user requested immediate deletion to free a Supabase project slot, shortening the planned seven-day observation period. A fresh read-only source export retained the original import fingerprint (`f891f609afef22fbb90d17e501cb1dbd3f000b92552ac3ec6cf302528fdb75f7`). Its private JSON backup is in the ignored `.migration-backups/` directory and a second, SHA-256-verified copy is in a private OneDrive folder outside the repository (file SHA-256 `d94faeb6595d42ea3618c004c51319066b131f6dfc6e8f0c690ce413547cb5ce`). The export contains application rows and account metadata, not the old password or a full SQL database dump.

Immediately before deletion, a read-only Firebase Admin check found the activated account and access grant, 1 profile, 3 students, 26 events, 15 exceptions, 0 weekly availability records, 2 availability overrides, 0 override intervals, and 7 working places. The matching Supabase **Daylight** project (`bxfwpmwewrevgwakxcvu`) had one Auth user and no Storage buckets. It was deleted from the Supabase dashboard; the organization project count fell from two to one. The live Firebase calendar loaded again after deletion. The two obsolete Supabase GitHub Actions variables were removed, and the repository now has only Firebase and Google deployment variables. The temporary Firebase Admin service-account key was deleted from Google Cloud and its local copy and the ignored `.env.migration` file were removed.
