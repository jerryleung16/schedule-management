import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const loaded = new Map();
function evaluate(source, dependencies = {}) {
  const evaluatedModule = { exports: {} };
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(output, { module: evaluatedModule, exports: evaluatedModule.exports, require: (name) => dependencies[name], Date, Intl, console });
  return evaluatedModule.exports;
}
function load(relative) {
  if (loaded.has(relative)) return loaded.get(relative);
  const source = readFileSync(path.join(root, relative), "utf8");
  const dependencies = {};
  for (const match of source.matchAll(/from "(\.\/.+?)"/g)) {
    const dependency = path.posix.normalize(`${path.posix.dirname(relative)}/${match[1]}.ts`);
    if (!dependency.endsWith("/types.ts")) dependencies[match[1]] = load(dependency);
  }
  const value = evaluate(source, dependencies);
  loaded.set(relative, value);
  return value;
}
const dates = load("src/lib/schedule/dates.ts");
const zone = load("src/lib/schedule/timezone.ts");
const recurrence = load("src/lib/schedule/recurrence.ts");
const instant = (day, time, timezone = "Asia/Hong_Kong") => zone.dateTimeInTimeZone(day, time, timezone).toISOString();
function event(overrides = {}) {
  return { id: "series", userId: "owner", startsAt: instant("2026-11-03", "10:00"), endsAt: instant("2026-11-03", "11:00"), timezone: "Asia/Hong_Kong", title: "Piano", detail: "Studio", kind: "lesson", tone: "coral", intensity: 4, prepMinutes: 15, travelMinutes: 20, hourlyRate: 35, fixedFee: 60, status: "scheduled", recurrenceWeekdays: [2], recurrenceUntil: null, studentId: "student", ...overrides };
}
function exception(overrides = {}) {
  return { id: "override", eventId: "series", originalStartsAt: instant("2026-11-03", "10:00"), startsAt: null, endsAt: null, status: "scheduled", title: null, detail: null, kind: null, tone: null, travelMinutes: null, hourlyRate: null, fixedFee: null, ...overrides };
}
const range = (start, end, timezone = "Asia/Hong_Kong") => ({ start: zone.dateTimeInTimeZone(start, "00:00", timezone), end: zone.dateTimeInTimeZone(end, "00:00", timezone) });

test("day and week ranges include the whole morning and finish at midnight", () => {
  for (const view of ["day", "week"]) {
    const value = dates.rangeForView(dates.dateFromKey("2026-11-03"), view);
    assert.equal(value.start.getHours(), 0);
    assert.equal(value.end.getHours(), 0);
    if (view === "week") { assert.equal(value.start.getDay(), 1); assert.equal(value.end.getDay(), 1); }
  }
});

test("all month grids contain complete Monday-to-Sunday weeks and every month date", () => {
  for (let month = 0; month < 12; month += 1) {
    const anchor = new Date(2026, month, 12);
    const value = dates.rangeForView(anchor, "month");
    const keys = [];
    for (let cursor = value.start; cursor < value.end; cursor = dates.addDays(cursor, 1)) keys.push(dates.dateKey(cursor));
    assert.equal(keys.length % 7, 0);
    assert.ok(keys.length >= 28 && keys.length <= 42);
    assert.equal(value.start.getDay(), 1);
    assert.equal(value.end.getDay(), 1);
    assert.ok(keys.includes(dates.dateKey(new Date(2026, month, 1))));
    assert.ok(keys.includes(dates.dateKey(new Date(2026, month + 1, 0))));
  }
});

test("zoned day bounds follow 23-hour and 25-hour DST days", () => {
  const spring = dates.rangeForView(dates.dateFromKey("2026-03-08"), "day", "America/New_York");
  const autumn = dates.rangeForView(dates.dateFromKey("2026-11-01"), "day", "America/New_York");
  assert.equal((spring.end - spring.start) / 3_600_000, 23);
  assert.equal((autumn.end - autumn.start) / 3_600_000, 25);
});

test("timezone conversion preserves winter/summer clock times and rejects nonexistent times", () => {
  assert.equal(instant("2026-03-01", "09:00", "America/New_York"), "2026-03-01T14:00:00.000Z");
  assert.equal(instant("2026-03-08", "09:00", "America/New_York"), "2026-03-08T13:00:00.000Z");
  assert.equal(instant("2026-11-01", "01:30", "America/New_York"), "2026-11-01T05:30:00.000Z");
  assert.throws(() => instant("2026-03-08", "02:30", "America/New_York"), /does not exist/);
});

test("weekly recurrence remains at the event-zone clock time across spring DST", () => {
  const value = event({ startsAt: instant("2026-03-01", "09:00", "America/New_York"), endsAt: instant("2026-03-01", "10:00", "America/New_York"), timezone: "America/New_York", recurrenceWeekdays: [0] });
  const occurrences = recurrence.expandEvents([value], [], range("2026-03-01", "2026-03-16", "America/New_York"));
  assert.deepEqual(Array.from(occurrences, (item) => item.startsAt), ["2026-03-01T14:00:00.000Z", "2026-03-08T13:00:00.000Z", "2026-03-15T13:00:00.000Z"]);
  assert.ok(occurrences.every((item) => zone.timeInTimeZone(item.startsAt, value.timezone) === "09:00"));
});

test("weekly recurrence remains at the event-zone clock time across autumn DST", () => {
  const value = event({ startsAt: instant("2026-10-25", "09:00", "America/New_York"), endsAt: instant("2026-10-25", "10:00", "America/New_York"), timezone: "America/New_York", recurrenceWeekdays: [0] });
  assert.deepEqual(Array.from(recurrence.expandEvents([value], [], range("2026-10-25", "2026-11-09", value.timezone)), (item) => item.startsAt), ["2026-10-25T13:00:00.000Z", "2026-11-01T14:00:00.000Z", "2026-11-08T14:00:00.000Z"]);
});

test("nonexistent weekly DST-gap times are skipped without shifting the lesson", () => {
  const value = event({ startsAt: instant("2026-03-01", "02:30", "America/New_York"), endsAt: instant("2026-03-01", "03:30", "America/New_York"), timezone: "America/New_York", recurrenceWeekdays: [0] });
  const occurrences = recurrence.expandEvents([value], [], range("2026-03-01", "2026-03-16", value.timezone));
  assert.deepEqual(Array.from(occurrences, (item) => zone.dateKeyInTimeZone(item.startsAt, value.timezone)), ["2026-03-01", "2026-03-15"]);
});

test("moved occurrences originating before a visible week appear on their new day", () => {
  const moved = exception({ startsAt: instant("2026-11-13", "10:00"), endsAt: instant("2026-11-13", "11:00") });
  const occurrences = recurrence.expandEvents([event()], [moved], range("2026-11-09", "2026-11-16"));
  assert.equal(occurrences.length, 2);
  assert.equal(occurrences.filter((item) => item.exceptionId === moved.id).length, 1);
  assert.equal(occurrences.find((item) => item.exceptionId === moved.id).originalStartsAt, moved.originalStartsAt);
});

test("moved occurrences originating after a visible week also appear on their new day", () => {
  const moved = exception({ originalStartsAt: instant("2026-11-17", "10:00"), startsAt: instant("2026-11-06", "10:00"), endsAt: instant("2026-11-06", "11:00") });
  const occurrences = recurrence.expandEvents([event()], [moved], range("2026-11-02", "2026-11-09"));
  assert.ok(occurrences.some((item) => item.exceptionId === moved.id));
});

test("a moved occurrence replaces its original and never duplicates inside one range", () => {
  const moved = exception({ startsAt: instant("2026-11-05", "14:00"), endsAt: instant("2026-11-05", "15:00") });
  const occurrences = recurrence.expandEvents([event()], [moved], range("2026-11-02", "2026-11-09"));
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].startsAt, moved.startsAt);
  assert.equal(occurrences[0].occurrenceKey, `series:${moved.originalStartsAt}`);
});

test("cancelling one occurrence preserves the rest of its recurring series", () => {
  const occurrences = recurrence.expandEvents([event()], [exception({ status: "cancelled" })], range("2026-11-02", "2026-11-16"));
  assert.deepEqual(Array.from(occurrences, (item) => zone.dateKeyInTimeZone(item.startsAt, "Asia/Hong_Kong")), ["2026-11-10"]);
});

test("event-zone recurrence cutoff includes the last original date and rejects later moved exceptions", () => {
  const value = event({ startsAt: instant("2026-11-03", "00:30"), endsAt: instant("2026-11-03", "01:30"), recurrenceUntil: "2026-11-03" });
  const laterMoved = exception({ originalStartsAt: instant("2026-11-10", "00:30"), startsAt: instant("2026-11-04", "12:00"), endsAt: instant("2026-11-04", "13:00") });
  const occurrences = recurrence.expandEvents([value], [laterMoved], range("2026-11-02", "2026-11-16"));
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].startsAt, "2026-11-02T16:30:00.000Z");
  assert.equal(recurrence.isOriginalOccurrence(value, laterMoved.originalStartsAt), false);
});

test("original occurrence validation rejects old clock keys after series retiming", () => {
  const value = event({ startsAt: instant("2026-11-03", "11:00"), endsAt: instant("2026-11-03", "12:00") });
  assert.equal(recurrence.isOriginalOccurrence(value, instant("2026-11-10", "10:00")), false);
  assert.equal(recurrence.isOriginalOccurrence(value, instant("2026-11-10", "11:00")), true);
});

test("single events use overlap boundaries and cancelled events stay absent", () => {
  const value = event({ recurrenceWeekdays: [], startsAt: instant("2026-11-02", "23:30"), endsAt: instant("2026-11-03", "00:30") });
  assert.equal(recurrence.expandEvents([value], [], range("2026-11-03", "2026-11-04")).length, 1);
  assert.equal(recurrence.expandEvents([{ ...value, status: "cancelled" }], [], range("2026-11-03", "2026-11-04")).length, 0);
});

test("Google recurrence cutoff uses the true last millisecond in the event timezone", () => {
  assert.equal(zone.endOfDayInTimeZone("2026-03-08", "America/New_York").toISOString(), "2026-03-09T03:59:59.999Z");
  assert.equal(zone.endOfDayInTimeZone("2026-11-03", "Asia/Hong_Kong").toISOString(), "2026-11-03T15:59:59.999Z");
});

function overviewFunctions() {
  const source = readFileSync(path.join(root, "src/app/page.tsx"), "utf8");
  const parsed = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["lessonFromOccurrence", "lessonToScheduleRow"];
  const functions = parsed.statements.filter((statement) => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text)).map((statement) => statement.getText(parsed));
  assert.equal(functions.length, names.length);
  return evaluate(`const {dateKeyInTimeZone,timeInTimeZone}=require('timezone');\n${functions.join("\n")}\nmodule.exports={lessonFromOccurrence,lessonToScheduleRow};`, { timezone: zone });
}

test("Overview one-time edits preserve canonical timezone, fixed fee, prep and intensity", () => {
  const functions = overviewFunctions();
  const value = event({ recurrenceWeekdays: [] });
  const source = recurrence.expandEvents([value], [], range("2026-11-02", "2026-11-09"))[0];
  const lesson = functions.lessonFromOccurrence(source);
  const date = zone.dateKeyInTimeZone(source.startsAt, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const saved = functions.lessonToScheduleRow({ ...lesson, title: "Renamed" }, value.userId, date);
  assert.equal(saved.starts_at, source.startsAt);
  assert.equal(saved.ends_at, source.endsAt);
  assert.equal(saved.timezone, value.timezone);
  assert.equal(saved.fixed_fee, value.fixedFee);
  assert.equal(saved.prep_minutes, value.prepMinutes);
  assert.equal(saved.intensity, value.intensity);
});

test("Overview retains occurrence identity and refuses to flatten a recurring event", () => {
  const functions = overviewFunctions();
  const source = recurrence.expandEvents([event()], [], range("2026-11-09", "2026-11-16"))[0];
  const lesson = functions.lessonFromOccurrence(source);
  assert.equal(lesson.source.id, event().id);
  assert.equal(lesson.source.originalStartsAt, instant("2026-11-10", "10:00"));
  assert.throws(() => functions.lessonToScheduleRow(lesson, "owner", "2026-11-10"), /My calendar/);
});
