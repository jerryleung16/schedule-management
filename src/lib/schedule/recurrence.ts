import { addDateKeyDays, dateKeyInTimeZone, dateTimeInTimeZone, timeInTimeZone } from "./timezone";
import type { CalendarRange, ScheduleEvent, ScheduleEventException, ScheduleOccurrence } from "./types";

export function isOriginalOccurrence(event: ScheduleEvent, originalStartsAt: string): boolean {
  const original = new Date(originalStartsAt);
  const base = new Date(event.startsAt);
  if (!Number.isFinite(original.getTime()) || original < base) return false;
  if (!event.recurrenceWeekdays.length) return original.getTime() === base.getTime();
  const zone = event.timezone;
  const day = dateKeyInTimeZone(original, zone);
  if (event.recurrenceUntil && day > event.recurrenceUntil) return false;
  if (!event.recurrenceWeekdays.includes(new Date(`${day}T00:00:00Z`).getUTCDay())) return false;
  const time = timeInTimeZone(base, zone, true);
  if (timeInTimeZone(original, zone, true) !== time) return false;
  if (day === dateKeyInTimeZone(base, zone)) return original.getTime() === base.getTime();
  try { return dateTimeInTimeZone(day, time, zone).getTime() === original.getTime(); }
  catch { return false; }
}

export function expandEvent(event: ScheduleEvent, exceptions: ScheduleEventException[], range: CalendarRange): ScheduleOccurrence[] {
  if (event.status === "cancelled" || event.status === "skipped") return [];
  const baseStart = new Date(event.startsAt);
  const duration = new Date(event.endsAt).getTime() - baseStart.getTime();
  const recurring = event.recurrenceWeekdays.length > 0;
  const relevant = exceptions.filter((exception) => exception.eventId === event.id);
  const exceptionMap = new Map(relevant.map((exception) => [new Date(exception.originalStartsAt).toISOString(), exception]));
  const results = new Map<string, ScheduleOccurrence>();
  const append = (original: Date, exception?: ScheduleEventException) => {
    if (exception?.status === "cancelled" || exception?.status === "skipped") return;
    const starts = exception?.startsAt ? new Date(exception.startsAt) : original;
    const ends = exception?.endsAt ? new Date(exception.endsAt) : new Date(starts.getTime() + duration);
    if (starts >= range.end || ends <= range.start) return;
    const originalStartsAt = original.toISOString();
    const occurrenceKey = `${event.id}:${originalStartsAt}`;
    results.set(occurrenceKey, {
      ...event,
      title: exception?.title ?? event.title,
      detail: exception?.detail ?? event.detail,
      kind: exception?.kind ?? event.kind,
      tone: exception?.tone ?? event.tone,
      travelMinutes: exception?.travelMinutes ?? event.travelMinutes,
      hourlyRate: exception?.hourlyRate ?? event.hourlyRate,
      fixedFee: exception?.fixedFee ?? event.fixedFee,
      status: exception?.status ?? event.status,
      startsAt: starts.toISOString(),
      endsAt: ends.toISOString(),
      occurrenceKey,
      originalStartsAt,
      isRecurring: recurring,
      exceptionId: exception?.id,
    });
  };

  if (!recurring) {
    append(baseStart, exceptionMap.get(baseStart.toISOString()));
    return [...results.values()];
  }

  const zone = event.timezone;
  const baseDay = dateKeyInTimeZone(baseStart, zone);
  const baseTime = timeInTimeZone(baseStart, zone, true);
  const earliest = dateKeyInTimeZone(new Date(range.start.getTime() - duration), zone);
  const lastDay = dateKeyInTimeZone(range.end, zone);
  for (let day = earliest < baseDay ? baseDay : earliest; day <= lastDay; day = addDateKeyDays(day, 1)) {
    if (event.recurrenceUntil && day > event.recurrenceUntil) break;
    if (!event.recurrenceWeekdays.includes(new Date(`${day}T00:00:00Z`).getUTCDay())) continue;
    let original: Date;
    try { original = day === baseDay ? baseStart : dateTimeInTimeZone(day, baseTime, zone); }
    catch { continue; } // A weekly clock time in the spring DST gap has no occurrence.
    append(original, exceptionMap.get(original.toISOString()));
  }

  // A rescheduled occurrence can originate outside the visible range entirely.
  for (const exception of relevant) {
    if (isOriginalOccurrence(event, exception.originalStartsAt)) append(new Date(exception.originalStartsAt), exception);
  }
  return [...results.values()].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
}

export function expandEvents(events: ScheduleEvent[], exceptions: ScheduleEventException[], range: CalendarRange) {
  return events.flatMap((event) => expandEvent(event, exceptions, range)).sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.occurrenceKey.localeCompare(right.occurrenceKey));
}
