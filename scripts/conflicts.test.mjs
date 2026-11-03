import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function load(file, dependencies = {}) {
  const evaluated = { exports: {} };
  const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  vm.runInNewContext(outputText, { module: evaluated, exports: evaluated.exports, Date, Intl, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected import ${name}`);
    return dependencies[name];
  } }, { filename: file });
  return evaluated.exports;
}
const timezone = load("src/lib/schedule/timezone.ts");
const recurrence = load("src/lib/schedule/recurrence.ts", { "./timezone": timezone });
const conflicts = load("src/lib/schedule/conflicts.ts", { "./timezone": timezone, "./recurrence": recurrence });
const start = (date, time = "10:00", zone = "Asia/Hong_Kong") => timezone.dateTimeInTimeZone(date, time, zone).toISOString();
const event = (id, date = "2026-11-03", time = "10:00", overrides = {}) => {
  const zone = overrides.timezone ?? "Asia/Hong_Kong";
  const startsAt = start(date, time, zone);
  return { id, userId: "user", startsAt, endsAt: new Date(Date.parse(startsAt) + 3_600_000).toISOString(), timezone: zone, title: id, detail: "", status: "scheduled", kind: "lesson", tone: "coral", recurrenceWeekdays: [], recurrenceUntil: null, intensity: 2, prepMinutes: 0, travelMinutes: 0, hourlyRate: 100, fixedFee: null, studentId: null, ...overrides };
};
const weekly = (id, overrides = {}) => event(id, "2026-11-03", "10:00", { recurrenceWeekdays: [2], recurrenceUntil: "2026-12-01", ...overrides });
const exception = (eventId, date, overrides = {}) => ({ id: `${eventId}:${date}`, eventId, originalStartsAt: start(date), startsAt: null, endsAt: null, status: "skipped", title: null, detail: null, kind: null, tone: null, travelMinutes: null, hourlyRate: null, fixedFee: null, ...overrides });

test("single-event validation checks the target date outside the currently displayed week", () => {
  const candidate = event("new", "2027-02-09");
  const existing = event("Existing February lesson", "2027-02-09", "10:30");
  assert.throws(() => conflicts.assertNoScheduleConflicts(candidate, [], [existing], []), /Existing February lesson/);
});

test("every finite repeat is checked, including a later collision", () => {
  const candidate = weekly("Weekly lesson");
  const conflict = conflicts.findScheduleConflict(candidate, [], [event("Later appointment", "2026-11-24", "10:30")], []);
  assert.equal(conflict.existing.title, "Later appointment");
  assert.equal(conflict.proposed.startsAt, start("2026-11-24"));
});

test("skipped occurrences and cancelled parents do not cause false collisions", () => {
  const parent = weekly("series");
  assert.equal(conflicts.findScheduleConflict(event("new", "2026-11-10"), [], [parent], [exception(parent.id, "2026-11-10")]), null);
  assert.equal(conflicts.findScheduleConflict(event("new"), [], [{ ...parent, status: "cancelled" }], []), null);
});

test("rescheduled occurrences are checked at their actual target dates", () => {
  const parent = weekly("series");
  const moved = exception(parent.id, "2026-11-10", { status: "scheduled", startsAt: start("2026-11-18"), endsAt: start("2026-11-18", "11:00") });
  assert.ok(conflicts.findScheduleConflict(event("new", "2026-11-18"), [], [parent], [moved]));
});

test("moving one occurrence onto another occurrence in the same series is rejected", () => {
  const parent = weekly("series");
  const moved = exception(parent.id, "2026-11-10", { status: "scheduled", startsAt: start("2026-11-17"), endsAt: start("2026-11-17", "11:00") });
  assert.ok(conflicts.findScheduleConflict(parent, [moved], [parent], [], { candidateOriginalStartsAt: moved.originalStartsAt }));
});

test("the original edited occurrence is excluded while back-to-back appointments remain valid", () => {
  const parent = weekly("series");
  const edit = exception(parent.id, "2026-11-10", { status: "scheduled", startsAt: start("2026-11-10"), endsAt: start("2026-11-10", "11:00") });
  assert.equal(conflicts.findScheduleConflict(parent, [edit], [parent, event("after", "2026-11-10", "11:00")], [], { candidateOriginalStartsAt: edit.originalStartsAt }), null);
});

test("a finite series detects overlaps between its own moved and regular occurrences", () => {
  const parent = weekly("series");
  const moved = exception(parent.id, "2026-11-10", { status: "scheduled", startsAt: start("2026-11-17"), endsAt: start("2026-11-17", "11:00") });
  assert.ok(conflicts.findScheduleConflict(parent, [moved], [], []));
});

test("an open-ended candidate checks a finite appointment decades in the future", () => {
  let date = "2100-01-01";
  while (new Date(`${date}T00:00:00Z`).getUTCDay() !== 2) date = timezone.addDateKeyDays(date, 1);
  const parent = weekly("series", { recurrenceUntil: null });
  assert.ok(conflicts.findScheduleConflict(parent, [], [event("Distant appointment", date)], []));
});

test("open-ended fixed-offset weekly patterns are compared without an arbitrary horizon", () => {
  const left = weekly("left", { recurrenceUntil: null });
  const right = weekly("right", { recurrenceUntil: null });
  const farSkip = exception(right.id, "2400-11-07");
  const conflict = conflicts.findScheduleConflict(left, [], [right], [farSkip]);
  assert.ok(conflict);
  assert.ok(Date.parse(conflict.proposed.startsAt) > Date.parse(farSkip.originalStartsAt));
  const after = event("after", "2026-11-03", "11:00", { recurrenceWeekdays: [2] });
  assert.equal(conflicts.findScheduleConflict(left, [], [after], []), null);
});

test("fixed-offset patterns in different named zones compare actual instants", () => {
  const hongKong = weekly("HK", { recurrenceUntil: null });
  const utc = event("UTC", "2026-11-03", "02:00", { timezone: "UTC", recurrenceWeekdays: [2] });
  assert.ok(conflicts.findScheduleConflict(hongKong, [], [utc], []));
});

test("unproven open-ended DST comparisons require an explicit end date", () => {
  const newYork = event("NY", "2026-11-03", "10:00", { timezone: "America/New_York", recurrenceWeekdays: [2] });
  const london = event("London", "2026-11-03", "10:00", { timezone: "Europe/London", recurrenceWeekdays: [2] });
  assert.throws(() => conflicts.findScheduleConflict(newYork, [], [london], []), /Repeat until/);
});

test("historical Hong Kong DST anchors are not treated as a fixed UTC pattern", () => {
  const old = event("Old HK", "1975-06-03", "10:00", { recurrenceWeekdays: [2] });
  const other = event("UTC", "2026-11-03", "12:00", { timezone: "UTC", recurrenceWeekdays: [2] });
  assert.throws(() => conflicts.findScheduleConflict(old, [], [other], []), /Repeat until/);
});

test("finite DST-series checks use elapsed time across a spring clock jump", () => {
  const candidate = event("Long lesson", "2026-03-01", "01:00", { timezone: "America/New_York", recurrenceWeekdays: [0], recurrenceUntil: "2026-03-15" });
  candidate.endsAt = new Date(Date.parse(candidate.startsAt) + 90 * 60_000).toISOString();
  const existing = event("After jump", "2026-03-08", "03:00", { timezone: "America/New_York" });
  assert.ok(conflicts.findScheduleConflict(candidate, [], [existing], []));
});

test("explicit moved dates in an open-ended existing series are checked independently", () => {
  const candidate = weekly("new", { recurrenceUntil: null });
  const existing = event("other", "2026-11-03", "14:00", { recurrenceWeekdays: [2] });
  const moved = exception(existing.id, "2026-11-10", { originalStartsAt: start("2026-11-10", "14:00"), status: "scheduled", startsAt: start("2026-11-18"), endsAt: start("2026-11-18", "11:00") });
  const candidateMove = exception(candidate.id, "2026-11-17", { status: "scheduled", startsAt: start("2026-11-18", "10:30"), endsAt: start("2026-11-18", "11:30") });
  assert.ok(conflicts.findScheduleConflict(candidate, [candidateMove], [existing], [moved]));
});
