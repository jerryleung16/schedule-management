import { cloudConfigured, database } from "@/lib/data/client";
import { normalizeRecord, safeId, type EventRow, type ExceptionRow } from "@/lib/data/schema";
import type { ScheduleEvent } from "@/lib/schedule/types";
import { googleCalendarDeletionCandidates, googleCalendarIsConnected, retryGoogleCalendarDeletions, syncGoogleCalendarEvent, syncGoogleCalendarOccurrence, type GoogleCalendarSyncResult } from "./client";

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

function dateInTimezone(timestamp: string, timezone: string) {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value).join("-");
}

export async function syncSavedScheduleToGoogleCalendar(userId: string): Promise<{ events: number; occurrences: number; deleted: number }> {
  safeId(userId);
  if (!googleCalendarIsConnected(userId)) throw new Error("Connect or reconnect Google Calendar from My calendar, then try syncing again.");
  const deletionCandidates = googleCalendarDeletionCandidates(userId);
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

  // Load and validate the complete schedule before changing Google Calendar.
  for (const event of events) requireSynced(await syncGoogleCalendarEvent(event));

  let occurrences = 0;
  for (const row of exceptions) {
    const event = eventsById.get(row.event_id);
    if (!event?.recurrenceWeekdays.length || event.status === "cancelled" || event.status === "skipped") continue;
    if (new Date(row.original_starts_at).getTime() < new Date(event.startsAt).getTime()) continue;
    const originalDate = dateInTimezone(row.original_starts_at, event.timezone);
    if (event.recurrenceUntil && originalDate > event.recurrenceUntil) continue;
    if (!event.recurrenceWeekdays.includes(new Date(`${originalDate}T00:00:00Z`).getUTCDay())) continue;
    const originalEnd = new Date(new Date(row.original_starts_at).getTime() + new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime()).toISOString();
    requireSynced(await syncGoogleCalendarOccurrence(event, row.original_starts_at, {
      startsAt: row.starts_at ?? row.original_starts_at,
      endsAt: row.ends_at ?? originalEnd,
      title: row.title,
      detail: row.detail,
      kind: row.kind,
      tone: row.tone,
      travelMinutes: row.travel_minutes,
      hourlyRate: row.hourly_rate,
      fixedFee: row.fixed_fee,
      status: row.status,
    }));
    occurrences += 1;
  }

  const deleted = await retryGoogleCalendarDeletions(userId, [...eventsById.keys()], deletionCandidates);
  return { events: events.length, occurrences, deleted };
}
