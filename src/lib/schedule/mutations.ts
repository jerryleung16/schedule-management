import type { ScheduleEvent, ScheduleEventException, ScheduleOccurrence } from "./types";
import { addDateKeyDays, dateKeyInTimeZone, dateTimeInTimeZone, timeInTimeZone } from "./timezone";

function dayNumber(date: string) {
  return Date.parse(`${date}T00:00:00Z`) / 86400000;
}

function weekday(date: string) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function alignRecurringStart(event: ScheduleEvent): ScheduleEvent {
  if (!event.recurrenceWeekdays.length) return event;
  const date = dateKeyInTimeZone(event.startsAt, event.timezone);
  const offset = Array.from({ length: 7 }, (_, index) => index).find((days) => event.recurrenceWeekdays.includes(weekday(addDateKeyDays(date, days)))) ?? 0;
  if (!offset) return event;
  const startsAt = dateTimeInTimeZone(addDateKeyDays(date, offset), timeInTimeZone(event.startsAt, event.timezone), event.timezone);
  const duration = Date.parse(event.endsAt) - Date.parse(event.startsAt);
  return { ...event, startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + duration).toISOString() };
}

function sameWeekdays(left: number[], right: number[]) {
  return left.length === right.length && left.every((day) => right.includes(day));
}

// A series edit changes its pattern, rather than moving its start to the selected later instance.
export function planSeriesEdit(base: ScheduleEvent, selected: ScheduleOccurrence, proposed: ScheduleEvent, previous: ScheduleEventException[]) {
  const zone = base.timezone;
  const selectedDate = dateKeyInTimeZone(selected.startsAt, zone);
  const proposedDate = dateKeyInTimeZone(proposed.startsAt, zone);
  const dateShift = dayNumber(proposedDate) - dayNumber(selectedDate);
  const time = timeInTimeZone(proposed.startsAt, zone) === timeInTimeZone(selected.startsAt, zone)
    ? timeInTimeZone(base.startsAt, zone) : timeInTimeZone(proposed.startsAt, zone);
  const duration = Date.parse(proposed.endsAt) - Date.parse(proposed.startsAt) === Date.parse(selected.endsAt) - Date.parse(selected.startsAt)
    ? Date.parse(base.endsAt) - Date.parse(base.startsAt) : Date.parse(proposed.endsAt) - Date.parse(proposed.startsAt);
  const anchor = dateTimeInTimeZone(addDateKeyDays(dateKeyInTimeZone(base.startsAt, zone), dateShift), time, zone);
  const weekdays = dateShift && sameWeekdays(proposed.recurrenceWeekdays, base.recurrenceWeekdays)
    ? proposed.recurrenceWeekdays.map((day) => ((day + dateShift) % 7 + 7) % 7) : proposed.recurrenceWeekdays;
  const next = alignRecurringStart({
    ...proposed, id: base.id, userId: base.userId, timezone: zone,
    title: proposed.title === selected.title ? base.title : proposed.title,
    detail: proposed.detail === selected.detail ? base.detail : proposed.detail,
    kind: proposed.kind === selected.kind ? base.kind : proposed.kind,
    tone: proposed.tone === selected.tone ? base.tone : proposed.tone,
    travelMinutes: proposed.travelMinutes === selected.travelMinutes ? base.travelMinutes : proposed.travelMinutes,
    hourlyRate: proposed.hourlyRate === selected.hourlyRate ? base.hourlyRate : proposed.hourlyRate,
    studentId: proposed.studentId === selected.studentId ? base.studentId : proposed.studentId,
    status: proposed.status === selected.status ? base.status : proposed.status,
    startsAt: anchor.toISOString(), endsAt: new Date(anchor.getTime() + duration).toISOString(),
    intensity: base.intensity, prepMinutes: base.prepMinutes, fixedFee: base.fixedFee,
    recurrenceWeekdays: weekdays,
  });
  const exceptions: ScheduleEventException[] = [];
  for (const exception of previous) {
    if (exception.eventId !== base.id || !next.recurrenceWeekdays.length) continue;
    const originalDate = addDateKeyDays(dateKeyInTimeZone(exception.originalStartsAt, zone), dateShift);
    if (!next.recurrenceWeekdays.includes(weekday(originalDate)) || (next.recurrenceUntil && originalDate > next.recurrenceUntil)) continue;
    const original = dateTimeInTimeZone(originalDate, time, zone).toISOString();
    if (Date.parse(original) < Date.parse(next.startsAt)) continue;
    const inheritedTime = exception.startsAt === null || (Date.parse(exception.startsAt) === Date.parse(exception.originalStartsAt)
      && exception.endsAt !== null && Date.parse(exception.endsAt) - Date.parse(exception.startsAt) === Date.parse(base.endsAt) - Date.parse(base.startsAt));
    const shiftActual = (value: string | null) => value === null ? null : dateTimeInTimeZone(addDateKeyDays(dateKeyInTimeZone(value, zone), dateShift), timeInTimeZone(value, zone), zone).toISOString();
    const selectedException = Date.parse(exception.originalStartsAt) === Date.parse(selected.originalStartsAt);
    const inherited = <Key extends "title" | "detail" | "kind" | "tone" | "travelMinutes" | "hourlyRate" | "fixedFee">(key: Key): ScheduleEventException[Key] => {
      if (exception[key] === base[key] || (selectedException && proposed[key] !== selected[key])) return null;
      return exception[key];
    };
    exceptions.push({
      ...exception, id: `${base.id}__${original}`, originalStartsAt: original,
      startsAt: inheritedTime ? null : shiftActual(exception.startsAt),
      endsAt: inheritedTime ? null : shiftActual(exception.endsAt),
      title: inherited("title"), detail: inherited("detail"), kind: inherited("kind"), tone: inherited("tone"),
      travelMinutes: inherited("travelMinutes"), hourlyRate: inherited("hourlyRate"), fixedFee: inherited("fixedFee"),
      status: exception.status === base.status ? next.status : exception.status,
    });
  }
  return { event: next, exceptions };
}

export function exceptionInput(exception: ScheduleEventException): Record<string, unknown> {
  return {
    id: exception.id, event_id: exception.eventId, original_starts_at: exception.originalStartsAt,
    starts_at: exception.startsAt, ends_at: exception.endsAt, status: exception.status,
    title: exception.title, detail: exception.detail, kind: exception.kind, tone: exception.tone,
    travel_minutes: exception.travelMinutes, hourly_rate: exception.hourlyRate, fixed_fee: exception.fixedFee,
  };
}

export function eventInput(event: ScheduleEvent): Record<string, unknown> {
  return {
    id: event.id, user_id: event.userId, starts_at: event.startsAt, ends_at: event.endsAt, timezone: event.timezone,
    title: event.title, detail: event.detail, kind: event.kind, tone: event.tone, intensity: event.intensity,
    prep_minutes: event.prepMinutes, travel_minutes: event.travelMinutes, hourly_rate: event.hourlyRate,
    fixed_fee: event.fixedFee, status: event.status, recurrence_weekdays: event.recurrenceWeekdays,
    recurrence_until: event.recurrenceUntil, student_id: event.studentId,
  };
}
