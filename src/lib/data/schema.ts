import type { EventKind, EventStatus, EventTone, StudentStatus } from "../schedule/types";

export type Row = Record<string, unknown> & { id: string; user_id: string; created_at: string; updated_at: string };
export type ProfileRow = Row & { display_name: string; timezone: string; daily_stamina_limit: number; weekly_stamina_limit: number; default_lesson_rate: number; default_travel_minutes: number; default_lesson_tone: EventTone; default_personal_tone: EventTone };
export type StudentRow = Row & { name: string; email: string; phone: string; notes: string; status: StudentStatus };
export type EventRow = Row & { starts_at: string; ends_at: string; timezone: string; title: string; detail: string; kind: EventKind; tone: EventTone; intensity: number; prep_minutes: number; travel_minutes: number; hourly_rate: number; fixed_fee: number | null; status: EventStatus; recurrence_weekdays: number[]; recurrence_until: string | null; student_id: string | null; range_end: string };
export type ExceptionRow = Row & { event_id: string; original_starts_at: string; starts_at: string | null; ends_at: string | null; status: EventStatus; title: string | null; detail: string | null; kind: EventKind | null; tone: EventTone | null; travel_minutes: number | null; hourly_rate: number | null; fixed_fee: number | null };
export type Interval = { weekday: number; starts: string; ends: string };
export type AvailabilityRow = Row & Interval;
export type OverrideRow = Row & { week_start: string };
export type OverrideIntervalRow = AvailabilityRow & { week_start: string };
export type WorkingPlaceRow = Row & { weekday: number; place: string };
export type TableRows = { profiles: ProfileRow; students: StudentRow; events: EventRow; eventExceptions: ExceptionRow; weeklyAvailability: AvailabilityRow; availabilityOverrides: OverrideRow; overrideIntervals: OverrideIntervalRow; workingPlaces: WorkingPlaceRow };
export type CollectionName = keyof TableRows;
export const collections: CollectionName[] = ["profiles", "students", "events", "eventExceptions", "weeklyAvailability", "availabilityOverrides", "overrideIntervals", "workingPlaces"];
const tones = ["blue", "coral", "teal", "yellow", "violet"];
const statuses = ["scheduled", "completed", "cancelled", "skipped"];

function text(value: unknown, fallback = "", max = 10000) {
  const result = value == null ? fallback : String(value);
  if (result.length > max) throw new Error("A text field exceeds its maximum length.");
  return result;
}
function number(value: unknown, fallback = 0, integer = false) {
  const result = value == null ? fallback : Number(value);
  if (!Number.isFinite(result) || result < 0 || (integer && !Number.isInteger(result))) throw new Error("Numbers must be finite and non-negative.");
  return result;
}
function choice(value: unknown, choices: string[], fallback: string) {
  const result = text(value, fallback);
  if (!choices.includes(result)) throw new Error("Invalid value: " + result);
  return result;
}
function instant(value: unknown) {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) throw new Error("Invalid timestamp.");
  return new Date(value).toISOString();
}
function day(value: unknown) {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString().slice(0, 10) !== result) throw new Error("Invalid date.");
  return result;
}
function timezone(value: unknown) {
  const result = text(value, "UTC", 100);
  new Intl.DateTimeFormat("en", { timeZone: result });
  return result;
}
export function safeId(value: unknown) {
  const result = text(value);
  if (!result || result.length > 200 || result.includes("/") || result === "." || result === "..") throw new Error("Invalid record ID.");
  return result;
}
export function exceptionId(eventId: string, originalStartsAt: string) {
  return safeId(eventId) + "__" + instant(originalStartsAt);
}
export function normalizeInterval(input: Record<string, unknown>): Interval {
  const weekday = number(input.weekday, 0, true);
  const starts = text(input.starts).slice(0, 5);
  const ends = text(input.ends).slice(0, 5);
  if (weekday > 6 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(starts) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(ends) || ends <= starts) throw new Error("Invalid availability interval.");
  return { weekday, starts, ends };
}

export function normalizeRecord<Collection extends CollectionName>(collection: Collection, input: Record<string, unknown>, userId: string): TableRows[Collection] {
  const now = new Date().toISOString();
  if (input.user_id != null && input.user_id !== userId) throw new Error("Record ownership does not match the signed-in user.");
  const base = { id: safeId(input.id ?? crypto.randomUUID()), user_id: safeId(userId), created_at: instant(input.created_at ?? now), updated_at: instant(input.updated_at ?? now) };
  let result: Record<string, unknown>;
  switch (collection) {
    case "profiles":
      result = { ...base, id: userId, display_name: text(input.display_name, "Your day", 200), timezone: timezone(input.timezone), daily_stamina_limit: number(input.daily_stamina_limit, 16), weekly_stamina_limit: number(input.weekly_stamina_limit, 40), default_lesson_rate: number(input.default_lesson_rate, 35), default_travel_minutes: number(input.default_travel_minutes, 0, true), default_lesson_tone: choice(input.default_lesson_tone, tones, "coral"), default_personal_tone: choice(input.default_personal_tone, tones, "teal") };
      break;
    case "students": {
      const name = text(input.name, "", 200).trim();
      if (!name) throw new Error("Student name is required.");
      result = { ...base, name, email: text(input.email, "", 320), phone: text(input.phone, "", 100), notes: text(input.notes), status: choice(input.status, ["active", "archived"], "active") };
      break;
    }
    case "events": {
      const starts = instant(input.starts_at);
      const ends = instant(input.ends_at);
      if (ends <= starts) throw new Error("The event must end after it starts.");
      const weekdays = input.recurrence_weekdays ?? [];
      if (!Array.isArray(weekdays) || weekdays.some(value => !Number.isInteger(value) || value < 0 || value > 6) || new Set(weekdays).size !== weekdays.length) throw new Error("Invalid recurrence weekdays.");
      const until = input.recurrence_until == null ? null : day(input.recurrence_until);
      const zone = timezone(input.timezone);
      if (until && until < new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(starts))) throw new Error("Recurrence ends before the event starts.");
      const rangeEnd = !weekdays.length ? ends : !until ? "9999-12-31T23:59:59.999Z" : new Date(Date.parse(until) + 2 * 86400000 + Date.parse(ends) - Date.parse(starts)).toISOString();
      const title = text(input.title, "", 500).trim();
      if (!title) throw new Error("Event title is required.");
      result = { ...base, starts_at: starts, ends_at: ends, timezone: zone, title, detail: text(input.detail), kind: choice(input.kind, ["lesson", "personal"], "lesson"), tone: choice(input.tone, tones, "coral"), intensity: number(input.intensity, 2), prep_minutes: number(input.prep_minutes, 0, true), travel_minutes: number(input.travel_minutes, 0, true), hourly_rate: number(input.hourly_rate), fixed_fee: input.fixed_fee == null ? null : number(input.fixed_fee), status: choice(input.status, statuses, "scheduled"), recurrence_weekdays: weekdays, recurrence_until: until, student_id: input.student_id == null ? null : safeId(input.student_id), range_end: rangeEnd };
      break;
    }
    case "eventExceptions": {
      const eventId = safeId(input.event_id);
      const original = instant(input.original_starts_at);
      const starts = input.starts_at == null ? null : instant(input.starts_at);
      const ends = input.ends_at == null ? null : instant(input.ends_at);
      if ((starts === null) !== (ends === null) || (starts && ends && ends <= starts)) throw new Error("Invalid occurrence times.");
      result = { ...base, id: exceptionId(eventId, original), event_id: eventId, original_starts_at: original, starts_at: starts, ends_at: ends, status: choice(input.status, statuses, "skipped"), title: input.title == null ? null : text(input.title, "", 500), detail: input.detail == null ? null : text(input.detail), kind: input.kind == null ? null : choice(input.kind, ["lesson", "personal"], "lesson"), tone: input.tone == null ? null : choice(input.tone, tones, "coral"), travel_minutes: input.travel_minutes == null ? null : number(input.travel_minutes, 0, true), hourly_rate: input.hourly_rate == null ? null : number(input.hourly_rate), fixed_fee: input.fixed_fee == null ? null : number(input.fixed_fee) };
      break;
    }
    case "weeklyAvailability": {
      const interval = normalizeInterval(input);
      result = { ...base, ...interval, id: interval.weekday + "_" + interval.starts + "_" + interval.ends };
      break;
    }
    case "availabilityOverrides": {
      const week = day(input.week_start);
      if (new Date(week).getUTCDay() !== 1) throw new Error("Overrides require a Monday.");
      result = { ...base, id: week, week_start: week };
      break;
    }
    case "overrideIntervals": {
      const week = day(input.week_start);
      if (new Date(week).getUTCDay() !== 1) throw new Error("Overrides require a Monday.");
      const interval = normalizeInterval(input);
      result = { ...base, ...interval, week_start: week, id: week + "_" + interval.weekday + "_" + interval.starts + "_" + interval.ends };
      break;
    }
    case "workingPlaces": {
      const weekday = number(input.weekday, 0, true);
      const place = text(input.place, "", 120).trim();
      if (weekday > 6 || !place) throw new Error("Invalid working place.");
      result = { ...base, id: String(weekday), weekday, place };
      break;
    }
  }
  return result! as TableRows[Collection];
}
