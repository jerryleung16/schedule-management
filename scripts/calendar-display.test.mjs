import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

// This process models the browser in the reported UTC/Hong Kong mismatch.
process.env.TZ = "Asia/Hong_Kong";
const workspace = fileURLToPath(new URL("../", import.meta.url));
const pageFile = "src/app/calendar/page.tsx";

function children(node) {
  return React.isValidElement(node) ? React.Children.toArray(node.props.children) : [];
}

function descendants(node) {
  const result = [];
  for (const child of Array.isArray(node) ? node : [node]) {
    if (!React.isValidElement(child)) continue;
    result.push(child, ...descendants(children(child)));
  }
  return result;
}

function textOf(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return React.isValidElement(node) ? textOf(node.props.children) : "";
}

function byClass(tree, className) {
  return descendants(tree).filter(node => String(node.props.className ?? "").split(/\s+/).includes(className));
}

function requireOne(nodes, label) {
  assert.equal(nodes.length, 1, `Expected one ${label}, received ${nodes.length}`);
  return nodes[0];
}

function clockMinutes(value) {
  const match = value.match(/(\d{1,2}):(\d{2})(?:\s*([AP]M))?/i);
  assert.ok(match, `Missing clock time: ${value}`);
  let hour = Number(match[1]);
  if (match[3]) hour = hour % 12 + (match[3].toUpperCase() === "PM" ? 12 : 0);
  return hour * 60 + Number(match[2]);
}

const fixtureEvent = (overrides = {}) => ({
  id: "utc-lesson", userId: "user-1", startsAt: "2026-11-03T08:30:00.000Z", endsAt: "2026-11-03T09:30:00.000Z",
  timezone: "UTC", title: "Display consistency lesson", detail: "", kind: "lesson", tone: "coral",
  intensity: 2, prepMinutes: 0, travelMinutes: 0, hourlyRate: 35, fixedFee: null, status: "scheduled",
  recurrenceWeekdays: [], recurrenceUntil: null, studentId: null, ...overrides,
});

function calendarHarness({ event = fixtureEvent(), view = "week", date = "2026-11-03", profileTimezone = "UTC", phone = false } = {}) {
  const originalEvent = JSON.stringify(event);
  const databaseCalls = [];
  const values = new Map(Object.entries({ events: [event], exceptions: [], userId: "user-1", profileTimezone, loading: false, chosenView: view }));
  const stored = new Map();
  const window = {
    location: { search: `?date=${date}` },
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)), removeItem: key => stored.delete(key) },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({ matches: phone, addEventListener() {}, removeEventListener() {} }),
    setTimeout, clearTimeout,
  };
  const useFixtureState = (name, initial) => {
    if (!values.has(name)) values.set(name, typeof initial === "function" ? initial() : initial);
    return [values.get(name), next => values.set(name, typeof next === "function" ? next(values.get(name)) : next)];
  };
  const react = { ...React, useEffect() {}, useRef: initial => ({ current: initial }), useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot() };
  const googleCalendar = { userId: "user-1", configured: true, status: "connected", busy: null, notice: "", error: "", connectAndSync: async () => {}, sync: async () => {}, check: async () => {} };
  const mocks = {
    react,
    "react/jsx-runtime": jsxRuntime,
    "next/navigation": { useRouter: () => ({ push() {}, replace() {}, refresh() {} }) },
    "lucide-react": new Proxy({}, { get: (_object, name) => () => React.createElement("svg", { "data-icon": String(name) }) }),
    "@/components/google-calendar-connection": { useGoogleCalendarConnection: () => googleCalendar },
    "@/lib/data/client": { cloudConfigured: true, database: new Proxy({}, { get: (_object, name) => (...args) => {
      databaseCalls.push({ name, args });
      throw new Error(`Opening or displaying a calendar event must not call database.${String(name)}`);
    } }) },
    "@/lib/firebase/client": { getFirebase: () => ({ auth: { currentUser: { uid: "user-1" } } }) },
    "@/lib/google-calendar/client": { googleCalendarIsConnected: () => true },
    "@/lib/google-calendar/sync": {},
  };
  const cache = new Map();
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const source = readFileSync(path.join(workspace, relative), "utf8");
    // Seed the actual page's named state, without depending on hook order or copying its rendering.
    const namedStates = context => {
      const visit = node => {
        if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer && ts.isCallExpression(node.initializer)
          && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "useState") {
          const name = node.name.elements[0]?.name;
          if (name && ts.isIdentifier(name)) return context.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type,
            context.factory.createCallExpression(context.factory.createIdentifier("__calendarState"), undefined, [context.factory.createStringLiteral(name.text), ...node.initializer.arguments]));
        }
        return ts.visitEachChild(node, visit, context);
      };
      return node => ts.visitNode(node, visit);
    };
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
      transformers: relative === pageFile ? { before: [namedStates] } : undefined,
    });
    const evaluatedModule = { exports: {} };
    cache.set(relative, evaluatedModule.exports);
    const context = {
      module: evaluatedModule, exports: evaluatedModule.exports, Date, Intl, Event, URLSearchParams, window, navigator: { onLine: true },
      __calendarState: useFixtureState,
      require: name => {
        if (Object.hasOwn(mocks, name)) return mocks[name];
        let candidate = name.startsWith("@/") ? `src/${name.slice(2)}` : path.posix.normalize(path.posix.join(path.posix.dirname(relative), name));
        if (!/\.tsx?$/.test(candidate)) candidate += existsSync(path.join(workspace, `${candidate}.ts`)) ? ".ts" : ".tsx";
        assert.ok(candidate.startsWith("src/"), `Unexpected dependency: ${name}`);
        return load(candidate);
      },
    };
    vm.runInNewContext(outputText, context, { filename: relative });
    return evaluatedModule.exports;
  }
  const Calendar = load(pageFile).default;
  const render = () => {
    const tree = Calendar();
    assert.equal(databaseCalls.length, 0, "Displaying and inspecting events must not write to the database");
    assert.equal(JSON.stringify(event), originalEvent, "Changing display timezone must preserve the saved instant");
    return tree;
  };
  const clickCard = tree => {
    const cards = byClass(tree, view === "month" ? "month-event" : "calendar-event");
    const card = requireOne(cards, "rendered lesson card");
    card.props.onClick({ stopPropagation() {} });
    return render();
  };
  return { render, clickCard, values, load, window };
}

function detailTime(tree) {
  const grid = requireOne(byClass(tree, "event-detail-grid"), "event details");
  const field = requireOne(children(grid).filter(node => children(node).some(child => child.type === "span" && /^Time(?:\s|$)/.test(textOf(child)))), "Time field");
  return textOf(requireOne(children(field).filter(node => node.type === "strong"), "detail time value"));
}

function chooseSavedTimezone(harness, tree) {
  const selector = requireOne(descendants(tree).filter(node => node.type === "select" && children(node).some(option => option.props.value === "device") && children(node).some(option => option.props.value === "saved")), "calendar timezone selector");
  selector.props.onChange({ target: { value: "saved" } });
  return harness.render();
}

test("the actual week card, timeline position, and clicked details use the device timezone together", () => {
  const harness = calendarHarness();
  let tree = harness.render();
  const card = requireOne(byClass(tree, "calendar-event"), "week lesson card");
  assert.equal(clockMinutes(textOf(card)), 16 * 60 + 30);
  assert.ok(Math.abs(Number.parseFloat(card.props.style.top) - 63.3333333333) < 0.001, "16:30 belongs at the 16:30 grid line");
  const axis = requireOne(byClass(tree, "week-times"), "timeline axis");
  const tick = requireOne(children(axis).filter(node => textOf(node) === "16:30"), "16:30 tick");
  assert.equal(tick.props.style.top, card.props.style.top);
  assert.match(renderToStaticMarkup(tree), /Asia\/Hong_Kong/);
  tree = harness.clickCard(tree);
  const time = detailTime(tree);
  assert.equal(clockMinutes(time), 16 * 60 + 30);
  assert.equal(clockMinutes(time.split(/[–—]/)[1]), 17 * 60 + 30);
});

test("switching the actual timezone selector to saved UTC moves both the card and its details", () => {
  const harness = calendarHarness();
  let tree = chooseSavedTimezone(harness, harness.render());
  const card = requireOne(byClass(tree, "calendar-event"), "week lesson card");
  assert.equal(clockMinutes(textOf(card)), 8 * 60 + 30);
  assert.ok(Math.abs(Number.parseFloat(card.props.style.top) - 10) < 0.001, "08:30 belongs at the 08:30 grid line");
  const axis = requireOne(byClass(tree, "week-times"), "timeline axis");
  assert.equal(requireOne(children(axis).filter(node => textOf(node) === "08:30"), "08:30 tick").props.style.top, card.props.style.top);
  tree = harness.clickCard(tree);
  const time = detailTime(tree);
  assert.equal(clockMinutes(time), 8 * 60 + 30);
  assert.equal(clockMinutes(time.split(/[–—]/)[1]), 9 * 60 + 30);
});

test("the actual month card and day agenda agree with the clicked event details", () => {
  for (const view of ["month", "day"]) {
    const harness = calendarHarness({ view, phone: true });
    let tree = harness.render();
    const card = requireOne(byClass(tree, view === "month" ? "month-event" : "calendar-agenda-event"), `${view} lesson`);
    assert.equal(clockMinutes(textOf(card)), 16 * 60 + 30);
    card.props.onClick({ stopPropagation() {} });
    tree = harness.render();
    assert.equal(clockMinutes(detailTime(tree)), 16 * 60 + 30);
  }
});

test("cross-midnight device dates are consistent between the calendar day and details", () => {
  const harness = calendarHarness({ view: "day", date: "2026-11-03", event: fixtureEvent({ startsAt: "2026-11-03T23:30:00.000Z", endsAt: "2026-11-04T00:30:00.000Z" }) });
  harness.window.location.search += "&event=utc-lesson&at=2026-11-03T23%3A30%3A00.000Z";
  let tree = harness.render();
  assert.match(textOf(requireOne(byClass(tree, "calendar-toolbar-left"), "displayed day heading")), /November 4, 2026/);
  const agenda = requireOne(byClass(tree, "calendar-agenda-event"), "next-day agenda lesson");
  assert.equal(clockMinutes(textOf(agenda)), 7 * 60 + 30);
  assert.equal(clockMinutes(textOf(requireOne(byClass(tree, "calendar-event"), "next-day timeline lesson"))), 7 * 60 + 30);
  agenda.props.onClick();
  tree = harness.render();
  const details = requireOne(byClass(tree, "event-details-modal"), "clicked event details dialog");
  assert.match(textOf(details), /November 4, 2026/);
  assert.equal(clockMinutes(detailTime(tree)), 7 * 60 + 30);
});

test("editing a displayed HK lesson explicitly labels the original UTC event timezone", () => {
  const harness = calendarHarness();
  let tree = harness.clickCard(harness.render());
  const dialog = requireOne(byClass(tree, "event-details-modal"), "event details dialog");
  const edit = requireOne(descendants(dialog).filter(node => node.type === "button" && textOf(node) === "Edit"), "Edit button");
  edit.props.onClick();
  tree = harness.render();
  const editor = requireOne(byClass(tree, "calendar-editor"), "event editor");
  assert.match(textOf(editor), /Editing in UTC/);
  const times = descendants(editor).filter(node => node.type === "input" && node.props.type === "time").map(node => node.props.value);
  assert.deepEqual(times, ["08:30", "09:30"]);
});

test("the recurring deletion scope keeps the same displayed date, timezone, and clock time", () => {
  const harness = calendarHarness({ event: fixtureEvent({ recurrenceWeekdays: [2] }) });
  let tree = harness.clickCard(harness.render());
  const details = requireOne(byClass(tree, "event-details-modal"), "event details");
  requireOne(descendants(details).filter(node => node.type === "button" && textOf(node) === "Delete event"), "Delete event button").props.onClick();
  tree = harness.render();
  requireOne(descendants(tree).filter(node => node.type === "button" && textOf(node) === "Choose deletion scope"), "deletion scope button").props.onClick();
  tree = harness.render();
  const dialog = requireOne(descendants(tree).filter(node => node.props["aria-labelledby"] === "delete-event-title"), "deletion scope dialog");
  assert.match(textOf(dialog), /Asia\/Hong_Kong/);
  assert.match(textOf(dialog), /November 3, 2026/);
  assert.equal(clockMinutes(textOf(dialog)), 16 * 60 + 30);
});

test("display timezone helpers keep preferences account-specific and fall back from invalid saved zones", () => {
  const harness = calendarHarness();
  const display = harness.load("src/lib/schedule/calendar-display.ts");
  assert.notEqual(display.calendarTimeZoneModeStorageKey("first-user"), display.calendarTimeZoneModeStorageKey("second-user"));
  assert.equal(display.resolveCalendarDisplayTimeZone("device", "Asia/Hong_Kong", "UTC"), "Asia/Hong_Kong");
  assert.equal(display.resolveCalendarDisplayTimeZone("saved", "Asia/Hong_Kong", "UTC"), "UTC");
  assert.equal(display.resolveCalendarDisplayTimeZone("saved", "Asia/Hong_Kong", "invalid-zone"), "Asia/Hong_Kong");
  assert.equal(clockMinutes(display.formatCalendarTime(fixtureEvent().startsAt, "Asia/Hong_Kong")), 16 * 60 + 30);
});
