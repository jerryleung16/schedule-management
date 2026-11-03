import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function load(path, dependencies = {}) {
  const evaluated = { exports: {} };
  const { outputText } = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  vm.runInNewContext(outputText, { module: evaluated, exports: evaluated.exports, Date, Intl, crypto, require: name => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected import ${name}`);
    return dependencies[name];
  } }, { filename: path });
  return evaluated.exports;
}
const timezone = load("src/lib/schedule/timezone.ts");
const mutations = load("src/lib/schedule/mutations.ts", { "./timezone": timezone });
const layout = load("src/lib/schedule/calendar-layout.ts");
const schema = load("src/lib/data/schema.ts");
const instant = (date, time = "10:00") => timezone.dateTimeInTimeZone(date, time, "Asia/Hong_Kong").toISOString();
const base = () => ({ id: "series", userId: "user", startsAt: instant("2026-11-03"), endsAt: instant("2026-11-03", "11:00"), timezone: "Asia/Hong_Kong", title: "Piano", detail: "Studio", kind: "lesson", tone: "coral", intensity: 5, prepMinutes: 20, travelMinutes: 15, hourlyRate: 100, fixedFee: 120, status: "scheduled", recurrenceWeekdays: [2], recurrenceUntil: "2026-12-31", studentId: "student" });
const occurrence = (date = "2026-11-17", changes = {}) => ({ ...base(), startsAt: instant(date), endsAt: instant(date, "11:00"), originalStartsAt: instant(date), occurrenceKey: `series:${instant(date)}`, isRecurring: true, ...changes });
const exception = (date, changes = {}) => ({ id: `series__${instant(date)}`, eventId: "series", originalStartsAt: instant(date), startsAt: null, endsAt: null, status: "skipped", title: null, detail: null, kind: null, tone: null, travelMinutes: null, hourlyRate: null, fixedFee: null, ...changes });

test("editing a later instance's title keeps the original anchor and hidden metadata", () => {
  const selected = occurrence();
  const plan = mutations.planSeriesEdit(base(), selected, { ...selected, title: "Updated piano", intensity: 2, prepMinutes: 0, fixedFee: null }, [exception("2026-11-10")]);
  assert.equal(plan.event.startsAt, base().startsAt);
  assert.equal(plan.event.title, "Updated piano");
  assert.equal(plan.event.intensity, 5);
  assert.equal(plan.event.prepMinutes, 20);
  assert.equal(plan.event.fixedFee, 120);
  assert.equal(plan.exceptions[0].status, "skipped");
});

test("changing series time migrates skip keys while retaining explicitly moved appointments", () => {
  const selected = occurrence();
  const moved = exception("2026-11-24", { status: "scheduled", startsAt: instant("2026-11-25", "15:00"), endsAt: instant("2026-11-25", "16:00") });
  const plan = mutations.planSeriesEdit(base(), selected, { ...selected, startsAt: instant("2026-11-17", "11:00"), endsAt: instant("2026-11-17", "12:00") }, [exception("2026-11-10"), moved]);
  assert.equal(plan.event.startsAt, instant("2026-11-03", "11:00"));
  assert.equal(plan.exceptions[0].originalStartsAt, instant("2026-11-10", "11:00"));
  assert.equal(plan.exceptions[0].startsAt, null);
  assert.equal(plan.exceptions[1].originalStartsAt, instant("2026-11-24", "11:00"));
  assert.equal(plan.exceptions[1].startsAt, moved.startsAt);
});

test("an explicit date move shifts the series and its exception dates coherently", () => {
  const selected = occurrence();
  const moved = exception("2026-11-24", { status: "scheduled", startsAt: instant("2026-11-25", "15:00"), endsAt: instant("2026-11-25", "16:00") });
  const plan = mutations.planSeriesEdit(base(), selected, { ...selected, startsAt: instant("2026-11-18"), endsAt: instant("2026-11-18", "11:00") }, [moved]);
  assert.equal(plan.event.startsAt, instant("2026-11-04"));
  assert.equal(plan.event.recurrenceWeekdays.join(","), "3");
  assert.equal(plan.exceptions[0].originalStartsAt, instant("2026-11-25"));
  assert.equal(plan.exceptions[0].startsAt, instant("2026-11-26", "15:00"));
});

test("removing a weekday retains other applicable exceptions and removes obsolete ones", () => {
  const parent = { ...base(), recurrenceWeekdays: [2, 4] };
  const selected = { ...occurrence(), recurrenceWeekdays: [2, 4] };
  const plan = mutations.planSeriesEdit(parent, selected, { ...selected, recurrenceWeekdays: [4] }, [exception("2026-11-10"), exception("2026-11-12")]);
  assert.equal(plan.event.startsAt, instant("2026-11-05"));
  assert.equal(plan.exceptions.length, 1);
  assert.equal(plan.exceptions[0].originalStartsAt, instant("2026-11-12"));
});

test("editing a moved occurrence's title for all does not copy its moved date or time to the series", () => {
  const selected = occurrence("2026-11-17", { startsAt: instant("2026-11-18", "15:00"), endsAt: instant("2026-11-18", "16:00"), title: "Moved piano", exceptionId: "moved" });
  const moved = exception("2026-11-17", { status: "scheduled", title: "Moved piano", startsAt: selected.startsAt, endsAt: selected.endsAt });
  const plan = mutations.planSeriesEdit(base(), selected, { ...selected, title: "New title" }, [moved]);
  assert.equal(plan.event.startsAt, base().startsAt);
  assert.equal(plan.event.title, "New title");
  assert.equal(plan.exceptions[0].startsAt, selected.startsAt);
  assert.equal(plan.exceptions[0].title, null);
});

test("one-time conversion removes recurrence exceptions and new series align to an actual repeat day", () => {
  const selected = occurrence();
  const plan = mutations.planSeriesEdit(base(), selected, { ...selected, recurrenceWeekdays: [], recurrenceUntil: null }, [exception("2026-11-10")]);
  assert.equal(plan.exceptions.length, 0);
  const aligned = mutations.alignRecurringStart({ ...base(), recurrenceWeekdays: [4] });
  assert.equal(aligned.startsAt, instant("2026-11-05"));
  assert.equal(Date.parse(aligned.endsAt) - Date.parse(aligned.startsAt), 3_600_000);
});

test("sequential events use full width while actual overlaps share lanes", () => {
  const items = [occurrence("2026-11-17"), occurrence("2026-11-17", { id: "next", startsAt: instant("2026-11-17", "11:00"), endsAt: instant("2026-11-17", "12:00") })];
  assert.ok(layout.calendarEventLanes(items).every(item => item.lanes === 1));
  const overlapping = layout.calendarEventLanes([...items, occurrence("2026-11-17", { id: "overlap", startsAt: instant("2026-11-17", "10:30"), endsAt: instant("2026-11-17", "11:30") })]);
  assert.ok(overlapping.every(item => item.lanes === 2));
});

function memoryDatabase() {
  const records = new Map();
  const state = { failCommit: false };
  const snapshot = (reference) => ({ id: reference.path.split("/").at(-1), exists: () => records.has(reference.path), data: () => records.has(reference.path) ? structuredClone(records.get(reference.path)) : undefined });
  const api = {
    doc: (_store, ...parts) => ({ path: parts.join("/") }),
    collection: (_store, ...parts) => ({ path: parts.join("/") }),
    query: (source, ...constraints) => ({ ...source, constraints: [...(source.constraints ?? []), ...constraints] }),
    where: (field, operator, value) => ({ field, operator, value }), limit: value => ({ limit: value }), orderBy: () => ({}), startAfter: () => ({}),
    getDocFromServer: async reference => snapshot(reference),
    getDocsFromServer: async source => {
      const docs = [...records.keys()].filter(path => path.startsWith(`${source.path}/`) && path.split("/").length === source.path.split("/").length + 1).filter(path => source.constraints.every(rule => !rule.field || records.get(path)[rule.field] === rule.value)).map(path => snapshot({ path }));
      return { size: docs.length, docs };
    },
    runTransaction: async (_store, callback) => {
      const writes = [];
      const result = await callback({ get: async reference => snapshot(reference), set: (reference, value) => writes.push(() => records.set(reference.path, value)), delete: reference => writes.push(() => records.delete(reference.path)) });
      if (state.failCommit) throw new Error("Network lost before commit");
      writes.forEach(write => write());
      return result;
    },
    deleteDoc: async reference => records.delete(reference.path), writeBatch: () => { throw new Error("Unexpected non-atomic batch"); },
  };
  const database = load("src/lib/data/client.ts", {
    "firebase/auth": { signInWithEmailAndPassword: () => {}, signOut: () => {} },
    "firebase/firestore": api,
    "../firebase/client": { cloudConfigured: true, getFirebase: () => ({ store: {}, auth: { currentUser: { uid: "user" }, authStateReady: async () => {} } }) },
    "./schema": schema, "../schedule/mutations": mutations,
  }).database;
  records.set("users/user/events/series", schema.normalizeRecord("events", mutations.eventInput(base()), "user"));
  const previous = exception("2026-11-10");
  records.set(`users/user/eventExceptions/${previous.id}`, schema.normalizeRecord("eventExceptions", mutations.exceptionInput(previous), "user"));
  return { database, records, state, previous };
}

test("a failed series transaction preserves both parent and original exception", async () => {
  const { database, records, state, previous } = memoryDatabase();
  const selected = occurrence();
  const plan = mutations.planSeriesEdit(base(), selected, { ...selected, startsAt: instant("2026-11-17", "11:00"), endsAt: instant("2026-11-17", "12:00") }, [previous]);
  state.failCommit = true;
  const result = await database.updateEventSeries(base(), mutations.eventInput(plan.event), [previous], plan.exceptions);
  assert.match(result.error?.message ?? "", /Network lost/);
  assert.equal(records.get("users/user/events/series").starts_at, base().startsAt);
  assert.ok(records.has(`users/user/eventExceptions/${previous.id}`));
  assert.equal(records.size, 2);
});

test("a successful series transaction migrates exception identity together with parent time", async () => {
  const { database, records, previous } = memoryDatabase();
  const selected = occurrence();
  const plan = mutations.planSeriesEdit(base(), selected, { ...selected, startsAt: instant("2026-11-17", "11:00"), endsAt: instant("2026-11-17", "12:00") }, [previous]);
  const result = await database.updateEventSeries(base(), mutations.eventInput(plan.event), [previous], plan.exceptions);
  assert.equal(result.error, null);
  assert.equal(records.get("users/user/events/series").starts_at, plan.event.startsAt);
  assert.equal(records.has(`users/user/eventExceptions/${previous.id}`), false);
  assert.ok(records.has(`users/user/eventExceptions/${plan.exceptions[0].id}`));
});

test("deletion commits parent and exceptions together or preserves both", async () => {
  const { database, records, state } = memoryDatabase();
  state.failCommit = true;
  const failed = await database.deleteEvent("series");
  assert.match(failed.error?.message ?? "", /Network lost/);
  assert.equal(records.size, 2);
  state.failCommit = false;
  const success = await database.deleteEvent("series");
  assert.equal(success.error, null);
  assert.equal(records.size, 0);
});
