import { expandEvent, isOriginalOccurrence } from "./recurrence";
import { dateKeyInTimeZone, endOfDayInTimeZone } from "./timezone";
import type { CalendarRange, ScheduleEvent, ScheduleEventException, ScheduleOccurrence } from "./types";

const day = 86_400_000;
const week = 7 * day;
const maximumExpandedOccurrences = 20_000;

type ConflictOptions = { candidateOriginalStartsAt?: string };
type Conflict = { proposed: ScheduleOccurrence; existing: ScheduleOccurrence };

function active(event: Pick<ScheduleEvent, "status">) {
  return event.status !== "cancelled" && event.status !== "skipped";
}

function overlaps(left: Pick<ScheduleEvent, "startsAt" | "endsAt">, right: Pick<ScheduleEvent, "startsAt" | "endsAt">) {
  return Date.parse(left.startsAt) < Date.parse(right.endsAt) && Date.parse(left.endsAt) > Date.parse(right.startsAt);
}

function relevantExceptions(event: ScheduleEvent, exceptions: ScheduleEventException[]) {
  return exceptions.filter(exception => exception.eventId === event.id && isOriginalOccurrence(event, exception.originalStartsAt));
}

function bounds(event: ScheduleEvent, exceptions: ScheduleEventException[]): CalendarRange {
  let start = Date.parse(event.startsAt);
  let end = event.recurrenceWeekdays.length && event.recurrenceUntil
    ? endOfDayInTimeZone(event.recurrenceUntil, event.timezone).getTime() + Date.parse(event.endsAt) - start : Date.parse(event.endsAt);
  for (const exception of relevantExceptions(event, exceptions)) {
    if (!active(exception)) continue;
    if (exception.startsAt) start = Math.min(start, Date.parse(exception.startsAt));
    if (exception.endsAt) end = Math.max(end, Date.parse(exception.endsAt));
  }
  return { start: new Date(start), end: new Date(end) };
}

function expand(event: ScheduleEvent, exceptions: ScheduleEventException[], range: CalendarRange) {
  if (!active(event)) return [];
  const estimated = Math.max(0, (range.end.getTime() - range.start.getTime()) / day) * event.recurrenceWeekdays.length / 7;
  if (estimated > maximumExpandedOccurrences) throw new Error("This series is too large to check in one operation. Choose an earlier Repeat until date before saving.");
  return expandEvent(event, exceptions, range);
}

function selfConflict(occurrences: ScheduleOccurrence[]): Conflict | null {
  const sorted = [...occurrences].sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  let longest: ScheduleOccurrence | undefined;
  for (const occurrence of sorted) {
    if (longest && overlaps(longest, occurrence)) return { proposed: occurrence, existing: longest };
    if (!longest || Date.parse(occurrence.endsAt) > Date.parse(longest.endsAt)) longest = occurrence;
  }
  return null;
}

function conflictWith(occurrences: ScheduleOccurrence[], existing: ScheduleOccurrence[]): Conflict | null {
  const busy = [...existing].sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  for (const proposed of occurrences) {
    for (const occurrence of busy) {
      if (Date.parse(occurrence.startsAt) >= Date.parse(proposed.endsAt)) break;
      if (overlaps(proposed, occurrence)) return { proposed, existing: occurrence };
    }
  }
  return null;
}

// These zones have a fixed future offset in IANA rules. Other zones require a finite
// end date when an open-ended pattern comparison cannot be proved safely.
// Hong Kong's last DST rule ended in 1979: https://data.iana.org/time-zones/tzdb/asia
function hasFixedOffset(event: ScheduleEvent, after: number) {
  const zone = new Intl.DateTimeFormat("en", { timeZone: event.timezone }).resolvedOptions().timeZone;
  return zone === "UTC" || /^Etc\/GMT(?:[+-]\d+)?$/.test(zone)
    || (zone === "Asia/Hong_Kong" && Math.min(after, Date.parse(event.startsAt)) >= Date.parse("1980-01-01T00:00:00Z"));
}

function firstPatternStarts(event: ScheduleEvent) {
  const start = Date.parse(event.startsAt);
  const weekday = new Date(`${dateKeyInTimeZone(event.startsAt, event.timezone)}T00:00:00Z`).getUTCDay();
  return event.recurrenceWeekdays.map(value => start + ((value - weekday + 7) % 7) * day);
}

function futurePatternConflict(left: ScheduleEvent, right: ScheduleEvent, after: number): Conflict | null {
  const leftDuration = Date.parse(left.endsAt) - Date.parse(left.startsAt);
  const rightDuration = Date.parse(right.endsAt) - Date.parse(right.startsAt);
  for (const firstLeft of firstPatternStarts(left)) {
    const leftStart = firstLeft + Math.max(0, Math.ceil((after - firstLeft) / week)) * week;
    for (const firstRight of firstPatternStarts(right)) {
      const near = firstRight + Math.max(0, Math.floor((leftStart - firstRight) / week)) * week;
      for (const rightStart of [near - week, near, near + week]) {
        if (rightStart < firstRight || leftStart >= rightStart + rightDuration || leftStart + leftDuration <= rightStart) continue;
        const occurrence = (event: ScheduleEvent, start: number, duration: number): ScheduleOccurrence => ({ ...event, startsAt: new Date(start).toISOString(), endsAt: new Date(start + duration).toISOString(), originalStartsAt: new Date(start).toISOString(), occurrenceKey: `${event.id}:${new Date(start).toISOString()}`, isRecurring: true });
        return { proposed: occurrence(left, leftStart, leftDuration), existing: occurrence(right, rightStart, rightDuration) };
      }
    }
  }
  return null;
}

function cannotProveForever() {
  throw new Error("Add a Repeat until date to check every occurrence safely. Open-ended comparisons across changing timezones cannot be verified indefinitely.");
}

export function findScheduleConflict(candidate: ScheduleEvent, candidateExceptions: ScheduleEventException[], savedEvents: ScheduleEvent[], savedExceptions: ScheduleEventException[], options: ConflictOptions = {}): Conflict | null {
  if (!active(candidate)) return null;
  const others = savedEvents.filter(event => active(event) && (event.id !== candidate.id || Boolean(options.candidateOriginalStartsAt)));
  const excludedOriginal = options.candidateOriginalStartsAt ? Date.parse(options.candidateOriginalStartsAt) : null;
  const existingIn = (range: CalendarRange) => others.flatMap(event => expand(event, savedExceptions, range))
    .filter(occurrence => !(occurrence.id === candidate.id && excludedOriginal === Date.parse(occurrence.originalStartsAt)));

  if (options.candidateOriginalStartsAt) {
    const original = options.candidateOriginalStartsAt;
    const override = candidateExceptions.find(exception => exception.eventId === candidate.id && Date.parse(exception.originalStartsAt) === Date.parse(original));
    if (override && !active(override)) return null;
    const starts = override?.startsAt ?? original;
    const ends = override?.endsAt ?? new Date(Date.parse(starts) + Date.parse(candidate.endsAt) - Date.parse(candidate.startsAt)).toISOString();
    const range = { start: new Date(starts), end: new Date(ends) };
    const proposed = expand(candidate, candidateExceptions, range).filter(occurrence => Date.parse(occurrence.originalStartsAt) === Date.parse(original));
    return conflictWith(proposed, existingIn(range));
  }

  const unbounded = candidate.recurrenceWeekdays.length > 0 && !candidate.recurrenceUntil;
  if (!unbounded) {
    const range = bounds(candidate, candidateExceptions);
    const proposed = expand(candidate, candidateExceptions, range);
    return selfConflict(proposed) ?? conflictWith(proposed, existingIn(range));
  }

  const exceptions = relevantExceptions(candidate, candidateExceptions);
  const future = Math.max(Date.parse(candidate.startsAt), ...savedEvents.filter(event => event.recurrenceWeekdays.length && !event.recurrenceUntil).map(event => Date.parse(event.startsAt)), ...[...exceptions, ...savedExceptions].flatMap(exception => [Date.parse(exception.originalStartsAt), exception.endsAt ? Date.parse(exception.endsAt) : 0])) + 2 * week;
  if (hasFixedOffset(candidate, future)) {
    const starts = firstPatternStarts(candidate).sort((left, right) => left - right);
    const duration = Date.parse(candidate.endsAt) - Date.parse(candidate.startsAt);
    if (starts.some((start, index) => (starts[(index + 1) % starts.length] + (index === starts.length - 1 ? week : 0) - start) < duration)) {
      const proposed = expand(candidate, [], { start: new Date(future), end: new Date(future + 2 * week) });
      return selfConflict(proposed);
    }
  } else {
    const weekdays = [...candidate.recurrenceWeekdays].sort((left, right) => left - right);
    const minimumGap = Math.min(...weekdays.map((value, index) => ((weekdays[(index + 1) % weekdays.length] - value + 7) % 7 || 7) * day));
    // Every IANA UTC offset is within ±24h; this proves separated instances cannot overlap.
    if (minimumGap - 2 * day < Date.parse(candidate.endsAt) - Date.parse(candidate.startsAt)) cannotProveForever();
  }

  // Explicitly moved occurrences have finite dates, even in an open-ended series.
  for (const exception of exceptions) {
    if (!active(exception) || !exception.startsAt || !exception.endsAt) continue;
    const range = { start: new Date(exception.startsAt), end: new Date(exception.endsAt) };
    const proposed = expand(candidate, candidateExceptions, range);
    const conflict = selfConflict(proposed) ?? conflictWith(proposed, existingIn(range));
    if (conflict) return conflict;
  }

  for (const existing of others) {
    if (!existing.recurrenceWeekdays.length || existing.recurrenceUntil) {
      const range = bounds(existing, savedExceptions);
      const conflict = conflictWith(expand(candidate, candidateExceptions, range), expand(existing, savedExceptions, range));
      if (conflict) return conflict;
    } else {
      // First check all finite overrides before comparing the patterns after the last override.
      for (const exception of relevantExceptions(existing, savedExceptions)) {
        if (!active(exception) || !exception.startsAt || !exception.endsAt) continue;
        const range = { start: new Date(exception.startsAt), end: new Date(exception.endsAt) };
        const conflict = conflictWith(expand(candidate, candidateExceptions, range), expand(existing, savedExceptions, range));
        if (conflict) return conflict;
      }
      if (!hasFixedOffset(candidate, future) || !hasFixedOffset(existing, future)) cannotProveForever();
      const conflict = futurePatternConflict(candidate, existing, future);
      if (conflict) return conflict;
    }
  }
  return null;
}

export function assertNoScheduleConflicts(...args: Parameters<typeof findScheduleConflict>) {
  const conflict = findScheduleConflict(...args);
  if (!conflict) return;
  const zone = args[0].timezone;
  const date = new Intl.DateTimeFormat("en", { timeZone: zone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(conflict.proposed.startsAt));
  throw new Error(`This would overlap “${conflict.existing.title}” on ${date}. Choose another time.`);
}
