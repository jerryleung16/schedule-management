const formatters = new Map<string, Intl.DateTimeFormat>();

function parts(value: Date | string, timeZone: string) {
  const instant = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(instant.getTime())) throw new Error("Invalid date or time.");
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, formatter);
  }
  const values = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second), millisecond: instant.getUTCMilliseconds() };
}

export function dateKeyInTimeZone(value: Date | string, timeZone: string): string {
  const result = parts(value, timeZone);
  return `${String(result.year).padStart(4, "0")}-${String(result.month).padStart(2, "0")}-${String(result.day).padStart(2, "0")}`;
}

export function timeInTimeZone(value: Date | string, timeZone: string, includeSeconds = false): string {
  const result = parts(value, timeZone);
  const time = `${String(result.hour).padStart(2, "0")}:${String(result.minute).padStart(2, "0")}`;
  return includeSeconds ? `${time}:${String(result.second).padStart(2, "0")}.${String(result.millisecond).padStart(3, "0")}` : time;
}

export function addDateKeyDays(dateKey: string, amount: number): string {
  const date = new Date(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateKey || !Number.isInteger(amount)) throw new Error("Invalid schedule date.");
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

// Use the earlier instant for an ambiguous clock time. Nonexistent DST times are rejected.
export function dateTimeInTimeZone(dateKey: string, time: string, timeZone: string, disambiguation: "earlier" | "later" = "earlier"): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?$/.test(time)) throw new Error("Invalid schedule date or time.");
  const target = new Date(`${dateKey}T${time.length === 5 ? `${time}:00` : time}Z`);
  if (!Number.isFinite(target.getTime()) || target.toISOString().slice(0, 10) !== dateKey) throw new Error("Invalid schedule date.");
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const sample = new Date(target.getTime() + hours * 3_600_000);
    const local = parts(sample, timeZone);
    offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, local.millisecond) - sample.getTime());
  }
  const candidates = [...offsets].map((offset) => new Date(target.getTime() - offset)).filter((candidate) => {
    const local = parts(candidate, timeZone);
    return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, local.millisecond) === target.getTime();
  }).sort((left, right) => left.getTime() - right.getTime());
  if (!candidates.length) throw new Error(`This time does not exist in ${timeZone} because the clocks change. Choose another time.`);
  return disambiguation === "later" ? candidates[candidates.length - 1] : candidates[0];
}

export function endOfDayInTimeZone(dateKey: string, timeZone: string): Date {
  return dateTimeInTimeZone(dateKey, "23:59:59.999", timeZone, "later");
}
