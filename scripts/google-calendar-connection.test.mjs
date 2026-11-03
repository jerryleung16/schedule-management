import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Exercise the real provider without a browser or Google access; hooks retain React's cell/effect lifecycle.
function mount({ check = async () => "connected", afterSync = () => {}, previousSync = null } = {}) {
  const cells = [];
  const events = new EventTarget();
  const local = new Map([["daylight-schedule-version", "version-1"]]);
  const timers = new Map();
  const state = { checks: 0, syncs: 0, connects: 0, lastSync: previousSync, history: [] };
  let cursor = 0;
  let queued = false;
  let unmounted = false;
  let latest;
  let pendingEffects = [];
  const window = {
    localStorage: { getItem: key => local.get(key) ?? null },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
    setTimeout: callback => { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  };
  const scheduleRender = () => {
    if (queued || unmounted) return;
    queued = true;
    queueMicrotask(() => { queued = false; if (!unmounted) render(); });
  };
  const equal = (left, right) => left && right && left.length === right.length && left.every((item, index) => Object.is(item, right[index]));
  const hooks = {
    createContext: () => ({ Provider: "connection-provider" }),
    useContext: () => latest,
    useState: initial => {
      const index = cursor++;
      if (!cells[index]) cells[index] = { value: typeof initial === "function" ? initial() : initial };
      return [cells[index].value, value => {
        const next = typeof value === "function" ? value(cells[index].value) : value;
        if (!Object.is(next, cells[index].value)) { cells[index].value = next; scheduleRender(); }
      }];
    },
    useRef: initial => { const index = cursor++; if (!cells[index]) cells[index] = { current: initial }; return cells[index]; },
    useCallback: (callback, deps) => {
      const index = cursor++;
      if (!cells[index] || !equal(cells[index].deps, deps)) cells[index] = { value: callback, deps };
      return cells[index].value;
    },
    useEffect: (effect, deps) => {
      const index = cursor++;
      if (!cells[index] || !equal(cells[index].deps, deps)) {
        const previous = cells[index];
        cells[index] = { deps, cleanup: previous?.cleanup };
        pendingEffects.push(() => { cells[index].cleanup?.(); cells[index].cleanup = effect(); });
      }
    },
  };
  const imports = {
    react: hooks,
    "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    "next/navigation": { usePathname: () => "/calendar" },
    "lucide-react": { Link2: "link", RotateCw: "retry" },
    "@/lib/google-calendar/client": {
      checkGoogleCalendarConnection: async () => { state.checks += 1; return check(state.checks); },
      connectGoogleCalendar: async () => { state.connects += 1; },
      googleCalendarConfigured: () => true,
      googleCalendarConnectionChangedEvent: "connection-changed",
      googleCalendarErrorMessage: () => "Google Calendar could not be reached. Your schedule is saved; retry syncing.",
      googleCalendarIsConnected: () => true,
      googleCalendarNeedsReconnect: () => false,
      googleCalendarTokenExpiresAt: () => Date.now() + 3_600_000,
      prepareGoogleCalendar: async () => {},
    },
    "@/lib/google-calendar/sync": {
      googleCalendarLastSync: () => state.lastSync,
      googleCalendarSyncCompletedEvent: "sync-completed",
      syncSavedScheduleToGoogleCalendar: async () => {
        state.syncs += 1;
        state.lastSync = { at: new Date().toISOString(), version: local.get("daylight-schedule-version") ?? null };
        window.dispatchEvent(new Event("sync-completed"));
        await afterSync({ state, local, window });
        return { events: 1, occurrences: 0, deleted: 0 };
      },
    },
  };
  const source = readFileSync(new URL("../src/components/google-calendar-connection.tsx", import.meta.url), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const evaluatedModule = { exports: {} };
  vm.runInNewContext(output, { module: evaluatedModule, exports: evaluatedModule.exports, require: name => { assert.ok(Object.hasOwn(imports, name), name); return imports[name]; }, window, navigator: { onLine: true }, queueMicrotask, Date });
  function render() {
    cursor = 0;
    const tree = evaluatedModule.exports.GoogleCalendarConnection({ userId: "teacher", children: null });
    latest = tree.props.value;
    state.history.push({ status: latest.status, syncPending: latest.syncPending, notice: latest.notice, currentVersion: local.get("daylight-schedule-version"), completedVersion: state.lastSync?.version });
    const effects = pendingEffects;
    pendingEffects = [];
    effects.forEach(effect => effect());
  }
  render();
  return {
    state, local, window, value: () => latest,
    unmount: () => { unmounted = true; cells.forEach(cell => cell.cleanup?.()); },
  };
}

async function flush() { for (let index = 0; index < 40; index += 1) await Promise.resolve(); }

test("recovery events arriving during a failed active check are coalesced and retried afterward", async () => {
  const first = deferred();
  const app = mount({ check: count => count === 1 ? first.promise : Promise.resolve("connected") });
  await flush();
  assert.equal(app.state.checks, 1);
  app.window.dispatchEvent(new Event("online"));
  app.window.dispatchEvent(new Event("online"));
  first.reject(new Error("Fetch aborted"));
  await flush();
  assert.equal(app.state.checks, 2);
  assert.equal(app.state.syncs, 1);
  assert.equal(app.state.connects, 0, "Recovery must never open an authorization popup automatically");
  assert.equal(app.value().status, "connected");
  assert.equal(app.value().error, "");
  assert.equal(app.value().syncPending, false);
  assert.ok(Number.isFinite(Date.parse(app.value().lastSyncedAt)));
  app.unmount();
});

test("a saved change at the full-sync completion boundary stays pending until a fresh replay succeeds", async () => {
  const app = mount({ afterSync: ({ state, local, window }) => {
    if (state.syncs !== 1) return;
    local.set("daylight-schedule-version", "version-2");
    window.dispatchEvent(new Event("daylight-schedule-changed"));
  } });
  await flush();
  assert.equal(app.state.syncs, 2);
  assert.equal(app.value().syncPending, false);
  assert.equal(app.state.lastSync.version, "version-2");
  assert.equal(app.state.history.some(item => /up to date/.test(item.notice) && item.currentVersion !== item.completedVersion), false);
  app.unmount();
});

test("a failed connection check retains the last successful sync time", async () => {
  const last = { at: "2026-11-03T10:00:00.000Z", version: "version-0" };
  const app = mount({ previousSync: last, check: async () => { throw new Error("Fetch aborted"); } });
  await flush();
  assert.equal(app.value().status, "error");
  assert.equal(app.value().lastSyncedAt, last.at);
  assert.equal(app.value().syncPending, true);
  assert.match(app.value().error, /schedule is saved/);
  assert.equal(app.state.syncs, 0);
  app.unmount();
});

test("unmounting invalidates a pending check before it can start Google writes", async () => {
  const first = deferred();
  const app = mount({ check: () => first.promise });
  await flush();
  app.window.dispatchEvent(new Event("online"));
  app.unmount();
  first.resolve("connected");
  await flush();
  assert.equal(app.state.checks, 1);
  assert.equal(app.state.syncs, 0);
});
