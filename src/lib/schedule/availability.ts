import { addDays, dateKey } from "./dates";
import type { CalendarRange, ScheduleOccurrence, StaminaState, SuggestedSlot, WeeklyAvailability } from "./types";

type BusyOccurrence = Pick<ScheduleOccurrence, "startsAt" | "endsAt">;

export type PracticalAvailabilitySlot = {
  weekday: number;
  starts: string;
  ends: string;
};

export type AvailabilityConflict = {
  weekday: number;
  starts: string;
  ends: string;
  eventTitle: string;
  eventStarts: string;
  eventEnds: string;
};

export const practicalAvailabilityStart = 8 * 60;
export const practicalAvailabilityEnd = 20 * 60;

export function lessonHours(occurrences: Pick<ScheduleOccurrence, "startsAt" | "endsAt" | "kind">[]) {
  return occurrences
    .filter((occurrence) => occurrence.kind === "lesson")
    .reduce((total, occurrence) => total + (new Date(occurrence.endsAt).getTime() - new Date(occurrence.startsAt).getTime()) / 3600000, 0);
}

export function staminaState(hours: number): StaminaState {
  if (hours <= 15) return "low";
  if (hours <= 20) return "mid";
  if (hours <= 25) return "high";
  return "overload";
}

export function slotConflicts(startsAt: string | Date, endsAt: string | Date, busy: BusyOccurrence[]) {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  return busy.some((occurrence) => {
    const existingStart = new Date(occurrence.startsAt).getTime();
    const existingEnd = new Date(occurrence.endsAt).getTime();
    return start < existingEnd && end > existingStart;
  });
}

const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function minutesFromTime(value: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60 ? hours * 60 + minutes : null;
}

function timeFromMinutes(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function formatTimeRange(starts: number, ends: number) {
  return { starts: timeFromMinutes(starts), ends: timeFromMinutes(ends) };
}

function localDayStart(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function occurrenceParts(occurrence: Pick<ScheduleOccurrence, "startsAt" | "endsAt">) {
  const start = new Date(occurrence.startsAt);
  const end = new Date(occurrence.endsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return [];

  const parts: Array<{ weekday: number; starts: number; ends: number; dayKey: string }> = [];
  for (let day = localDayStart(start); day < end; day = addDays(day, 1)) {
    const dayStart = localDayStart(day);
    const nextDayStart = addDays(dayStart, 1);
    const starts = Math.max(start.getTime(), dayStart.getTime());
    const ends = Math.min(end.getTime(), nextDayStart.getTime());
    if (starts < ends) {
      parts.push({
        weekday: dayStart.getDay(),
        starts: Math.max(0, Math.round((starts - dayStart.getTime()) / 60000)),
        ends: Math.min(24 * 60, Math.round((ends - dayStart.getTime()) / 60000)),
        dayKey: dateKey(dayStart),
      });
    }
  }
  return parts;
}

export function practicalFreeSlots(occurrences: BusyOccurrence[]): PracticalAvailabilitySlot[] {
  const occupied = new Map<number, Array<{ starts: number; ends: number }>>();
  for (const occurrence of occurrences) {
    for (const part of occurrenceParts(occurrence)) {
      const starts = Math.max(practicalAvailabilityStart, part.starts);
      const ends = Math.min(practicalAvailabilityEnd, part.ends);
      if (starts >= ends) continue;
      const dayParts = occupied.get(part.weekday) ?? [];
      dayParts.push({ starts, ends });
      occupied.set(part.weekday, dayParts);
    }
  }

  const freeSlots: PracticalAvailabilitySlot[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const merged = (occupied.get(weekday) ?? [])
      .sort((left, right) => left.starts - right.starts)
      .reduce<Array<{ starts: number; ends: number }>>((ranges, range) => {
        const previous = ranges[ranges.length - 1];
        if (previous && range.starts <= previous.ends) {
          previous.ends = Math.max(previous.ends, range.ends);
        } else {
          ranges.push({ ...range });
        }
        return ranges;
      }, []);
    let cursor = practicalAvailabilityStart;
    for (const range of merged) {
      if (cursor < range.starts) freeSlots.push({ weekday, ...formatTimeRange(cursor, range.starts) });
      cursor = Math.max(cursor, range.ends);
    }
    if (cursor < practicalAvailabilityEnd) freeSlots.push({ weekday, ...formatTimeRange(cursor, practicalAvailabilityEnd) });
  }
  return freeSlots;
}

export function occupiedAvailabilityByWeekday(occurrences: ScheduleOccurrence[]) {
  return occurrences.flatMap((occurrence) => occurrenceParts(occurrence).map((part) => ({
    ...part,
    title: occurrence.title,
    startsAt: occurrence.startsAt,
    endsAt: occurrence.endsAt,
    eventDate: part.dayKey,
  })));
}

export function availabilityConflicts(intervals: WeeklyAvailability[], occurrences: ScheduleOccurrence[]): AvailabilityConflict[] {
  const conflicts: AvailabilityConflict[] = [];
  for (const interval of intervals) {
    const starts = minutesFromTime(interval.starts);
    const ends = minutesFromTime(interval.ends);
    if (starts === null || ends === null || ends <= starts) continue;
    for (const occurrence of occurrences) {
      for (const part of occurrenceParts(occurrence)) {
        if (part.weekday !== interval.weekday || starts >= part.ends || ends <= part.starts) continue;
        conflicts.push({
          weekday: interval.weekday,
          starts: interval.starts,
          ends: interval.ends,
          eventTitle: occurrence.title,
          eventStarts: `${part.dayKey} ${timeFromMinutes(part.starts)}`,
          eventEnds: timeFromMinutes(part.ends),
        });
      }
    }
  }
  return conflicts;
}

function formatAvailabilityTime(value: string) {
  const minutes = minutesFromTime(value) ?? 0;
  const date = new Date(2000, 0, 1, Math.floor(minutes / 60), minutes % 60);
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export function validateWeeklyAvailability(intervals: WeeklyAvailability[]) {
  const sorted = [...intervals].sort((left, right) => left.weekday - right.weekday || left.starts.localeCompare(right.starts));
  for (const interval of sorted) {
    const starts = minutesFromTime(interval.starts);
    const ends = minutesFromTime(interval.ends);
    if (interval.weekday < 0 || interval.weekday > 6 || starts === null || ends === null || ends <= starts) {
      return "Each availability window needs a valid start and an end after it.";
    }
  }
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous.weekday === current.weekday && (minutesFromTime(current.starts) ?? 0) < (minutesFromTime(previous.ends) ?? 0)) {
      return `${weekdayNames[current.weekday]} has overlapping availability windows.`;
    }
  }
  return "";
}

export function normalizeWeeklyAvailability(intervals: WeeklyAvailability[]) {
  return [...intervals]
    .filter((interval) => interval.weekday >= 0 && interval.weekday <= 6)
    .sort((left, right) => left.weekday - right.weekday || left.starts.localeCompare(right.starts));
}

export function formatWeeklyAvailabilityMessage(intervals: WeeklyAvailability[]) {
  const normalized = normalizeWeeklyAvailability(intervals);
  const lines = ["Dear Client,", "", "Please find my recurring weekly availability below:", ""];
  if (!normalized.length) lines.push("I do not have any availability windows set yet.");
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const dayIntervals = normalized.filter((interval) => interval.weekday === weekday);
    if (dayIntervals.length) {
      lines.push(`${weekdayNames[weekday]}: ${dayIntervals.map((interval) => `${formatAvailabilityTime(interval.starts)}–${formatAvailabilityTime(interval.ends)}`).join(", ")}`);
    }
  }
  lines.push("", "Please let me know which of these times would be most convenient for you.", "", "Kind regards,");
  return lines.join("\n");
}

function priorityFor(day: Date, startMinutes: number, endMinutes: number): SuggestedSlot["priority"] {
  const weekend = day.getDay() === 0 || day.getDay() === 6;
  if (!weekend && startMinutes >= 16 * 60 && endMinutes <= 18 * 60) return "weekday-evening";
  if (weekend && startMinutes >= 11 * 60 && endMinutes <= 15 * 60) return "weekend-midday";
  return "other";
}

function priorityRank(priority: SuggestedSlot["priority"]) {
  return priority === "weekday-evening" ? 0 : priority === "weekend-midday" ? 1 : 2;
}

export function suggestLessonSlots(range: CalendarRange, busyOccurrences: BusyOccurrence[], limit = 6): SuggestedSlot[] {
  const candidates: Array<SuggestedSlot & { rank: number; timestamp: number }> = [];
  for (let day = new Date(range.start); day < range.end; day = addDays(day, 1)) {
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8, 0);
    const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), day.getDay() === 0 || day.getDay() === 6 ? 18 : 20, 0);
    for (const durationMinutes of [60, 90]) {
      for (let startMinutes = dayStart.getHours() * 60; startMinutes + durationMinutes <= dayEnd.getHours() * 60; startMinutes += 30) {
        const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(startMinutes / 60), startMinutes % 60);
        const end = new Date(start.getTime() + durationMinutes * 60000);
        if (slotConflicts(start, end, busyOccurrences)) continue;
        const priority = priorityFor(day, startMinutes, startMinutes + durationMinutes);
        const preferredDistance = priority === "weekday-evening"
          ? Math.abs(startMinutes - 16 * 60)
          : priority === "weekend-midday"
            ? Math.abs(startMinutes - 11 * 60)
            : Math.min(Math.abs(startMinutes - 16 * 60), Math.abs(startMinutes - 11 * 60));
        candidates.push({
          date: dateKey(day),
          starts: `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`,
          ends: `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`,
          durationMinutes,
          priority,
          rank: priorityRank(priority) * 10000 + preferredDistance * 10 + (durationMinutes === 60 ? 0 : 1),
          timestamp: start.getTime(),
        });
      }
    }
  }
  return candidates
    .sort((left, right) => left.rank - right.rank || left.timestamp - right.timestamp)
    .slice(0, limit)
    .map((slot) => ({
      date: slot.date,
      starts: slot.starts,
      ends: slot.ends,
      durationMinutes: slot.durationMinutes,
      priority: slot.priority,
    }));
}
