import { addDays, dateKey } from "./dates";
import type { CalendarRange, ScheduleOccurrence, StaminaState, SuggestedSlot, WeeklyAvailability } from "./types";

type BusyOccurrence = Pick<ScheduleOccurrence, "startsAt" | "endsAt">;

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

export function formatWeeklyAvailabilityMessage(intervals: WeeklyAvailability[], timezone?: string) {
  const normalized = normalizeWeeklyAvailability(intervals);
  const lines = ["Hi, here is my recurring weekly availability:", ""];
  if (!normalized.length) lines.push("I do not have any availability windows set yet.");
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const dayIntervals = normalized.filter((interval) => interval.weekday === weekday);
    if (dayIntervals.length) {
      lines.push(`${weekdayNames[weekday]}: ${dayIntervals.map((interval) => `${formatAvailabilityTime(interval.starts)}–${formatAvailabilityTime(interval.ends)}`).join(", ")}`);
    }
  }
  if (timezone) lines.push("", `Timezone: ${timezone}`);
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
