import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function load(path, globals = {}, imports = {}) {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const evaluatedModule = { exports: {} };
  vm.runInNewContext(compiled.outputText, {
    module: evaluatedModule, exports: evaluatedModule.exports, Date, Intl, crypto, Event,
    require: (name) => { assert.ok(Object.hasOwn(imports, name), name); return imports[name]; },
    ...globals,
  }, { filename: path });
  return evaluatedModule.exports;
}

const event = (title = "Original lesson") => ({
  id: "lesson", user_id: "teacher", title, starts_at: "2026-11-03T10:00:00.000Z",
  ends_at: "2026-11-03T11:00:00.000Z", timezone: "Asia/Hong_Kong", recurrence_weekdays: [],
});

function setup(onUpsert = () => {}) {
  let rows = [event()];
  const local = new Map();
  const remote = new Map();
  const writes = [];
  let reads = 0;
  let overrideReads = 0;
  const state = {
    remote, writes, local,
    setRows: (next) => { rows = next; },
    changed: () => local.set("daylight-schedule-version", crypto.randomUUID()),
    reads: () => reads,
    overrideReads: () => overrideReads,
  };
  const client = {
    googleCalendarIsConnected: () => true,
    googleCalendarDeletionCandidates: () => [...remote.keys()],
    googleCalendarRemoteDeletionCandidates: async () => [],
    syncGoogleCalendarEvent: async (value) => {
      writes.push(value.title);
      await onUpsert(state, value);
      remote.set(value.id, value);
      return "synced";
    },
    reconcileGoogleCalendarOccurrences: async () => {},
    loadGoogleCalendarOverrides: async () => { overrideReads += 1; return []; },
    syncGoogleCalendarOccurrence: async () => "synced",
    retryGoogleCalendarDeletions: async (_user, activeIds, candidates) => {
      let removed = 0;
      for (const id of candidates) if (!activeIds.includes(id)) { remote.delete(id); removed += 1; }
      return removed;
    },
  };
  const syncModule = load("src/lib/google-calendar/sync.ts", { window: { localStorage: { getItem: (key) => local.get(key) ?? null, setItem: (key, value) => local.set(key, value) }, dispatchEvent: () => {} } }, {
    "@/lib/data/client": { cloudConfigured: true, database: {
      listEvents: async () => { reads += 1; return { data: rows, error: null }; },
      listExceptions: async () => ({ data: [], error: null }),
    } },
    "@/lib/data/schema": load("src/lib/data/schema.ts"),
    "@/lib/schedule/recurrence": { isOriginalOccurrence: () => true },
    "./client": client,
  });
  return { ...state, sync: syncModule.syncSavedScheduleToGoogleCalendar, lastSync: () => syncModule.googleCalendarLastSync("teacher") };
}

test("an edit made while a slow replay is in flight wins over the old snapshot", async () => {
  let first = true;
  const state = setup((current) => {
    if (!first) return;
    first = false;
    current.setRows([event("New lesson title")]);
    current.changed();
  });
  await state.sync("teacher");
  assert.equal(state.remote.get("lesson").title, "New lesson title");
  assert.deepEqual(state.writes, ["Original lesson", "New lesson title"]);
});

test("an event deleted during replay is removed again instead of being resurrected", async () => {
  let first = true;
  const state = setup((current) => {
    if (!first) return;
    first = false;
    current.setRows([]);
    current.changed();
  });
  const result = await state.sync("teacher");
  assert.equal(result.events, 0);
  assert.equal(state.remote.size, 0);
});

test("final server snapshot verification detects changes made on another device", async () => {
  let first = true;
  const state = setup((current) => {
    if (!first) return;
    first = false;
    current.setRows([event("Edited on another device")]);
  });
  await state.sync("teacher");
  assert.equal(state.remote.get("lesson").title, "Edited on another device");
  assert.ok(state.reads() >= 4);
});

test("continuous edits stop with a retry message instead of a false success", async () => {
  const state = setup((current) => current.changed());
  await assert.rejects(state.sync("teacher"), /schedule changed.*sync again/i);
  assert.equal(state.writes.length, 3);
});

test("two simultaneous full-sync requests for one user share a single replay", async () => {
  const state = setup();
  const first = state.sync("teacher");
  const second = state.sync("teacher");
  assert.equal(first, second);
  await first;
  assert.equal(state.writes.length, 1);
});

test("a completed sync records its verified version and a failure never advances the timestamp", async () => {
  let fail = false;
  const state = setup(() => { if (fail) throw new Error("Google unavailable"); });
  assert.equal(state.lastSync(), null);
  state.changed();
  await state.sync("teacher");
  const completed = state.lastSync();
  assert.ok(Number.isFinite(Date.parse(completed.at)));
  assert.equal(completed.version, state.local.get("daylight-schedule-version"));
  fail = true;
  state.changed();
  await assert.rejects(state.sync("teacher"), /Google unavailable/);
  assert.deepEqual(state.lastSync(), completed);
  assert.notEqual(state.lastSync().version, state.local.get("daylight-schedule-version"));
});

test("all recurring parents share one Google override scan per replay", async () => {
  const state = setup();
  state.setRows([{ ...event(), recurrence_weekdays: [2] }, { ...event("Another series"), id: "another", recurrence_weekdays: [2] }]);
  await state.sync("teacher");
  assert.equal(state.overrideReads(), 1);
});
