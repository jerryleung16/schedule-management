export type CalendarTimeZoneMode = "device" | "saved";

export function calendarTimeZoneModeStorageKey(userId: string) {
  return `daylight-calendar-timezone-mode-${userId}`;
}

function validTimeZone(value: string | null | undefined): value is string {
  if (!value) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; }
  catch { return false; }
}

export function resolveCalendarDisplayTimeZone(mode: CalendarTimeZoneMode, deviceZone: string, savedZone?: string | null): string {
  if (mode === "saved" && validTimeZone(savedZone)) return savedZone;
  return validTimeZone(deviceZone) ? deviceZone : "UTC";
}

export function formatCalendarTime(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function formatCalendarDate(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date(value));
}
