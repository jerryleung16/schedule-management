import { cloudConfigured, database } from "@/lib/data/client";
import { normalizeRecord, safeId, type EventRow, type ExceptionRow } from "@/lib/data/schema";
import type { ScheduleEvent, ScheduleEventException } from "@/lib/schedule/types";
import { isOriginalOccurrence } from "@/lib/schedule/recurrence";
import { googleCalendarDeletionCandidates, googleCalendarIsConnected, googleCalendarRemoteDeletionCandidates, reconcileGoogleCalendarOccurrences, retryGoogleCalendarDeletions, syncGoogleCalendarEvent, syncGoogleCalendarOccurrence, type GoogleCalendarSyncResult } from "./client";

function scheduleEventFromRow(row: EventRow): ScheduleEvent {
  return {
    id: row.id,
    userId: row.user_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    timezone: row.timezone,
    title: row.title,
    detail: row.detail,
    kind: row.kind,
    tone: row.tone,
    intensity: row.intensity,
    prepMinutes: row.prep_minutes,
    travelMinutes: row.travel_minutes,
    hourlyRate: row.hourly_rate,
    fixedFee: row.fixed_fee,
    status: row.status,
    recurrenceWeekdays: row.recurrence_weekdays,
    recurrenceUntil: row.recurrence_until,
    studentId: row.student_id,
  };
}

function localEvents(): ScheduleEvent[] {
  const events: ScheduleEvent[] = [];
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    const date = key?.match(/^daylight-lessons-(\d{4}-\d{2}-\d{2})$/)?.[1];
    if (!key || !date) continue;
    try {
      if (new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error("Invalid schedule date.");
      const lessons: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
      if (!Array.isArray(lessons)) throw new Error("Expected a list of saved events.");
      for (const lesson of lessons) {
        if (!lesson || typeof lesson !== "object" || Array.isArray(lesson)) throw new Error("Invalid saved event.");
        const row = lesson as Record<string, unknown>;
        if (typeof row.time !== "string" || !timePattern.test(row.time) || typeof row.end !== "string" || !timePattern.test(row.end)) {
          throw new Error("Invalid saved event times.");
        }
        const normalized = normalizeRecord("events", {
          id: safeId(row.id),
          starts_at: new Date(`${date}T${row.time}:00`).toISOString(),
          ends_at: new Date(`${date}T${row.end}:00`).toISOString(),
          timezone,
          title: row.title ?? "Lesson",
          detail: row.detail,
          kind: row.kind,
          tone: row.tone,
          intensity: row.intensity,
          prep_minutes: row.prepMinutes,
          travel_minutes: row.travelMinutes,
          hourly_rate: row.rate,
          status: row.status,
          student_id: row.studentId,
        }, "local");
        events.push(scheduleEventFromRow(normalized));
      }
    } catch (error) {
      throw new Error(`Saved schedule for ${date} could not be loaded: ${error instanceof Error ? error.message : "Invalid saved data."}`);
    }
  }
  return events;
}

function requireSynced(result: GoogleCalendarSyncResult) {
  if (result !== "synced") throw new Error("Google Calendar is not connected. Reconnect it and try syncing again.");
}

async function loadSavedSchedule(userId: string) {
  let events: ScheduleEvent[];
  let exceptions: ExceptionRow[] = [];
  if (cloudConfigured) {
    if (userId === "local") throw new Error("Sign in before syncing your saved schedule.");
    const eventResult = await database.listEvents();
    if (eventResult.error) throw new Error(`Your saved schedule could not be loaded: ${eventResult.error.message}`);
    events = eventResult.data.map((row) => scheduleEventFromRow(normalizeRecord("events", { ...row, id: safeId(row.id) }, userId)));
    const exceptionResult = await database.listExceptions(events.map((event) => event.id));
    if (exceptionResult.error) throw new Error(`Your saved occurrence changes could not be loaded: ${exceptionResult.error.message}`);
    exceptions = exceptionResult.data.map((row) => normalizeRecord("eventExceptions", row, userId));
  } else {
    if (userId !== "local") throw new Error("The local schedule cannot be synced for another account.");
    events = localEvents();
  }

  const eventsById = new Map(events.map((event) => [event.id, event]));
  if (eventsById.size !== events.length) throw new Error("The saved schedule contains duplicate event IDs. Resolve them before syncing.");
  const changes: ScheduleEventException[] = exceptions.map((row) => ({
    id: row.id,
    eventId: row.event_id,
    originalStartsAt: row.original_starts_at,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    title: row.title,
    detail: row.detail,
    kind: row.kind,
    tone: row.tone,
    travelMinutes: row.travel_minutes,
    hourlyRate: row.hourly_rate,
    fixedFee: row.fixed_fee,
    status: row.status,
  }));
  const fingerprint = JSON.stringify({
    events: [...events].sort((left, right) => left.id.localeCompare(right.id)),
    exceptions: [...changes].sort((left, right) => left.id.localeCompare(right.id)),
  });
  return { events, changes, fingerprint };
}

type SyncSummary = { events: number; occurrences: number; deleted: number };
const runningSyncs = new Map<string, Promise<SyncSummary>>();
class ScheduleChangedDuringSync extends Error {}
const scheduleVersion = () => window.localStorage.getItem("daylight-schedule-version");

async function replaySavedSchedule(userId: string): Promise<SyncSummary> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const version = scheduleVersion();
    const deletionCandidates = [...new Set([...googleCalendarDeletionCandidates(userId), ...await googleCalendarRemoteDeletionCandidates(userId)])];
    const snapshot = await loadSavedSchedule(userId);
    const assertCurrent = () => {
      if (version !== scheduleVersion()) throw new ScheduleChangedDuringSync();
    };
    const verifySnapshot = async () => {
      assertCurrent();
      const latest = await loadSavedSchedule(userId);
      assertCurrent();
      if (latest.fingerprint !== snapshot.fingerprint) throw new ScheduleChangedDuringSync();
    };
    try {
      assertCurrent();
      for (const event of snapshot.events) {
        assertCurrent();
        requireSynced(await syncGoogleCalendarEvent(event));
        assertCurrent();
      }
      let occurrences = 0;
      for (const event of snapshot.events) {
        if (!event.recurrenceWeekdays.length || event.status === "cancelled" || event.status === "skipped") continue;
        const changes = snapshot.changes.filter((change) => change.eventId === event.id && isOriginalOccurrence(event, change.originalStartsAt));
        assertCurrent();
        await reconcileGoogleCalendarOccurrences(event, changes);
        assertCurrent();
        for (const change of changes) {
          assertCurrent();
          requireSynced(await syncGoogleCalendarOccurrence(event, change.originalStartsAt, change));
          assertCurrent();
          occurrences += 1;
        }
      }
      // Validate the complete current data before removing linked events, and again before success.
      // A slow replay must never finish by reviving an event deleted during that replay.
      await verifySnapshot();
      const deleted = await retryGoogleCalendarDeletions(userId, snapshot.events.map((event) => event.id), deletionCandidates);
      await verifySnapshot();
      return { events: snapshot.events.length, occurrences, deleted };
    } catch (error) {
      if (!(error instanceof ScheduleChangedDuringSync)) throw error;
    }
  }
  throw new Error("Your schedule changed during synchronization. Your changes are saved; sync again to send the latest schedule.");
}

export function syncSavedScheduleToGoogleCalendar(userId: string): Promise<SyncSummary> {
  safeId(userId);
  if (!googleCalendarIsConnected(userId)) return Promise.reject(new Error("Connect or reconnect Google Calendar from My calendar, then try syncing again."));
  const current = runningSyncs.get(userId);
  if (current) return current;
  const operation = replaySavedSchedule(userId).finally(() => {
    if (runningSyncs.get(userId) === operation) runningSyncs.delete(userId);
  });
  runningSyncs.set(userId, operation);
  return operation;
}
