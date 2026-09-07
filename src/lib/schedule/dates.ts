import type { CalendarRange, CalendarView } from "./types";

export function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateFromKey(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, 12);
}

export function addDays(date: Date, amount: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + amount);
  return result;
}

export function startOfWeek(date: Date) {
  return addDays(new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12), -((date.getDay() + 6) % 7));
}

export function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1, 12);
}

export function rangeForView(date: Date, view: CalendarView): CalendarRange {
  if (view === "day") {
    const start = dateFromKey(dateKey(date));
    return { start, end: addDays(start, 1) };
  }

  if (view === "month") {
    const monthStart = startOfMonth(date);
    const gridStart = startOfWeek(monthStart);
    const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0, 12);
    const gridEnd = addDays(startOfWeek(addDays(monthEnd, 6)), 1);
    return { start: gridStart, end: gridEnd };
  }

  const start = startOfWeek(date);
  return { start, end: addDays(start, 7) };
}

export function formatDateKey(date: Date) {
  return dateKey(date);
}

export function minutesSinceMidnight(date: Date) {
  return date.getHours() * 60 + date.getMinutes();
}

export function formatRangeLabel(date: Date, view: CalendarView) {
  if (view === "day") {
    return date.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }

  if (view === "month") {
    return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }
  const start = startOfWeek(date);
  const end = addDays(start, 6);
  if (start.getMonth() === end.getMonth()) {
    return `${start.toLocaleDateString("en-US", { month: "long" })} ${start.getDate()}–${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${start.toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${end.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}