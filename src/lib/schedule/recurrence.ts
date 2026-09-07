import { addDays, dateKey } from "./dates";
import type { CalendarRange, ScheduleEvent, ScheduleEventException, ScheduleOccurrence } from "./types";

export function expandEvent(event: ScheduleEvent, exceptions: ScheduleEventException[], range: CalendarRange): ScheduleOccurrence[] {
  if (event.status === "cancelled" || event.status === "skipped") return [];
  const baseStart = new Date(event.startsAt);
  const baseEnd = new Date(event.endsAt);
  const duration = baseEnd.getTime() - baseStart.getTime();
  const recurring = event.recurrenceWeekdays.length > 0;
  const results: ScheduleOccurrence[] = [];
  const baseDate = new Date(baseStart.getFullYear(), baseStart.getMonth(), baseStart.getDate(), 12);
  const rangeDate = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate(), 12);
  const firstDate = recurring && baseDate < rangeDate ? rangeDate : recurring ? baseDate : baseStart;
  const lastDate = recurring ? new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate(), 12) : addDays(firstDate, 1);
  const exceptionMap = new Map(exceptions.filter((exception) => exception.eventId === event.id).map((exception) => [exception.originalStartsAt, exception]));

  for (let cursor = firstDate; cursor < lastDate; cursor = addDays(cursor, 1)) {
    if (recurring && !event.recurrenceWeekdays.includes(cursor.getDay())) continue;
    const generatedStart = recurring
      ? new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), baseStart.getHours(), baseStart.getMinutes())
      : baseStart;
    const exception = exceptionMap.get(generatedStart.toISOString());
    if (exception?.status === "cancelled" || exception?.status === "skipped") continue;
    const occurrenceStart = exception?.startsAt ? new Date(exception.startsAt) : generatedStart;
    const occurrenceEnd = exception?.endsAt ? new Date(exception.endsAt) : new Date(occurrenceStart.getTime() + duration);
    if (event.recurrenceUntil && dateKey(cursor) > event.recurrenceUntil) continue;
    if (occurrenceStart >= range.end || occurrenceEnd <= range.start) continue;

    results.push({
      ...event,
      title: exception?.title ?? event.title,
      detail: exception?.detail ?? event.detail,
      kind: exception?.kind ?? event.kind,
      tone: exception?.tone ?? event.tone,
      travelMinutes: exception?.travelMinutes ?? event.travelMinutes,
      hourlyRate: exception?.hourlyRate ?? event.hourlyRate,
      fixedFee: exception?.fixedFee ?? event.fixedFee,
      status: exception?.status ?? event.status,
      startsAt: occurrenceStart.toISOString(),
      endsAt: occurrenceEnd.toISOString(),
      occurrenceKey: `${event.id}:${generatedStart.toISOString()}`,
      originalStartsAt: generatedStart.toISOString(),
      isRecurring: recurring,
      exceptionId: exception?.id,
    });
    if (!recurring) break;
  }
  return results;
}

export function expandEvents(events: ScheduleEvent[], exceptions: ScheduleEventException[], range: CalendarRange) {
  return events.flatMap((event) => expandEvent(event, exceptions, range));
}