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

const workspace = fileURLToPath(new URL("../", import.meta.url));
const pageFile = "src/app/page.tsx";

function loadMetrics() {
  const source = readFileSync(path.join(workspace, "src/lib/schedule/overview.ts"), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  const evaluatedModule = { exports: {} };
  vm.runInNewContext(outputText, { module: evaluatedModule, exports: evaluatedModule.exports, Date, Number, Math });
  return evaluatedModule.exports;
}

const block = (overrides = {}) => ({
  kind: "lesson", status: "scheduled", startsAt: "2026-11-04T03:00:00.000Z", endsAt: "2026-11-04T04:00:00.000Z",
  hourlyRate: 40, fixedFee: null, ...overrides,
});

test("earnings separate expected and completed income and respect fixed fees including zero", () => {
  const { summarizeLessonEarnings } = loadMetrics();
  const summary = summarizeLessonEarnings([
    block({ status: "completed", endsAt: "2026-11-04T04:30:00.000Z" }),
    block({ fixedFee: 75, hourlyRate: 999 }),
    block({ status: "completed", fixedFee: 0, hourlyRate: 999 }),
    block({ status: "cancelled", fixedFee: 500 }),
    block({ status: "skipped", fixedFee: 500 }),
    block({ kind: "personal", fixedFee: 500 }),
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(summary)), { expected: 135, completed: 60, expectedCount: 3, completedCount: 2 });
});

test("a lesson crossing a month boundary contributes its fee once in its start month", () => {
  const { summarizeLessonEarnings } = loadMetrics();
  const lesson = block({ startsAt: "2026-10-31T23:30:00.000Z", endsAt: "2026-11-01T00:30:00.000Z", status: "completed", fixedFee: 90 });
  const october = { start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") };
  const november = { start: october.end, end: new Date("2026-12-01T00:00:00Z") };
  assert.equal(summarizeLessonEarnings([lesson], october).completed, 90);
  assert.equal(summarizeLessonEarnings([lesson], november).completed, 0);
});

test("teaching hours exclude cancelled, skipped, and personal blocks and clip to the requested period", () => {
  const { teachingHoursInRange } = loadMetrics();
  const range = { start: new Date("2026-11-04T00:00:00Z"), end: new Date("2026-11-05T00:00:00Z") };
  const hours = teachingHoursInRange([
    block(), block({ status: "completed", intensity: 20, prepMinutes: 30, travelMinutes: 60 }),
    block({ startsAt: "2026-11-03T23:00:00Z", endsAt: "2026-11-04T01:00:00Z" }),
    block({ status: "cancelled" }), block({ status: "skipped" }), block({ kind: "personal" }),
  ], range);
  assert.equal(hours, 3);
});

test("workload meters use saved hour limits and handle a zero-hour allowance", () => {
  const { teachingCapacity, validTeachingHourLimit } = loadMetrics();
  assert.equal(teachingCapacity(4, 5).percent, 80);
  assert.equal(teachingCapacity(6, 5).overLimit, true);
  assert.equal(teachingCapacity(0, 0).percent, 0);
  assert.equal(teachingCapacity(1, 0).state, "overload");
  assert.equal(teachingCapacity(1, 0).percent, 100);
  assert.equal(validTeachingHourLimit(0, 40), 0);
  assert.equal(validTeachingHourLimit(undefined, 40), 40);
});

function nodes(node) {
  if (Array.isArray(node)) return node.flatMap(nodes);
  return React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(nodes)] : [];
}
function textOf(node) {
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return React.isValidElement(node) ? textOf(node.props.children) : "";
}
function one(matches, label) {
  assert.equal(matches.length, 1, `Expected one ${label}, received ${matches.length}`);
  return matches[0];
}

function overviewHarness({ timeZone = "Asia/Hong_Kong", now = "2026-11-03T22:30:00.000Z", state = {} } = {}) {
  process.env.TZ = timeZone;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return Date.parse(now); }
  }
  const values = new Map(Object.entries({ selectedDate: "2026-11-04", availabilityWeekDate: "2026-11-04", ...state }));
  const cache = new Map();
  const stored = new Map();
  const window = { localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, String(value)) }, addEventListener() {}, removeEventListener() {}, setTimeout, clearTimeout };
  const react = { ...React, useEffect() {}, useRef: value => ({ current: value }), useCallback: callback => callback, useMemo: factory => factory() };
  const mocks = {
    react, "react/jsx-runtime": jsxRuntime,
    "next/navigation": { useRouter: () => ({ push() {}, replace() {}, refresh() {} }) },
    "lucide-react": new Proxy({}, { get: () => () => null }),
    "@/lib/data/client": { cloudConfigured: true, database: {} },
    "@/lib/google-calendar/client": {},
  };
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const source = readFileSync(path.join(workspace, relative), "utf8");
    const namedStates = context => {
      const visit = node => {
        if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer && ts.isCallExpression(node.initializer)
          && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "useState") {
          const name = node.name.elements[0]?.name;
          if (name && ts.isIdentifier(name)) return context.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type,
            context.factory.createCallExpression(context.factory.createIdentifier("__overviewState"), undefined, [context.factory.createStringLiteral(name.text), ...node.initializer.arguments]));
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
    vm.runInNewContext(outputText, {
      module: evaluatedModule, exports: evaluatedModule.exports, Date: ClockDate, Intl, URLSearchParams, window,
      __overviewState: (name, initial) => {
        if (!values.has(name)) values.set(name, typeof initial === "function" ? initial() : initial);
        return [values.get(name), next => values.set(name, typeof next === "function" ? next(values.get(name)) : next)];
      },
      require: name => {
        if (Object.hasOwn(mocks, name)) return mocks[name];
        let candidate = name.startsWith("@/") ? `src/${name.slice(2)}` : path.posix.normalize(path.posix.join(path.posix.dirname(relative), name));
        if (!/\.tsx?$/.test(candidate)) candidate += existsSync(path.join(workspace, `${candidate}.ts`)) ? ".ts" : ".tsx";
        return load(candidate);
      },
    }, { filename: relative });
    return evaluatedModule.exports;
  }
  const Home = load(pageFile).default;
  return { render: () => Home(), values };
}

test("the actual Overview Today button selects the local date before 08:00 in Hong Kong", () => {
  const harness = overviewHarness({ state: { selectedDate: "2026-11-01" } });
  const tree = harness.render();
  one(nodes(tree).filter(node => node.type === "button" && /^Today\s*$/.test(textOf(node))), "Today button").props.onClick();
  assert.equal(harness.values.get("selectedDate"), "2026-11-04");
});

test("the actual Overview day arrows use civil date arithmetic in UTC+14", () => {
  const harness = overviewHarness({ timeZone: "Pacific/Kiritimati", state: { selectedDate: "2026-11-04" } });
  let tree = harness.render();
  one(nodes(tree).filter(node => node.props["aria-label"] === "Next day"), "Next day button").props.onClick();
  assert.equal(harness.values.get("selectedDate"), "2026-11-05");
  tree = harness.render();
  one(nodes(tree).filter(node => node.props["aria-label"] === "Previous day"), "Previous day button").props.onClick();
  assert.equal(harness.values.get("selectedDate"), "2026-11-04");
});

test("actual Overview cards show saved daily and weekly limits and distinct expected/completed earnings", () => {
  const harness = overviewHarness({ state: {
    lessons: [{ id: "lesson", time: "10:00", end: "12:00", title: "Lesson", detail: "", kind: "lesson", tone: "coral", status: "scheduled", rate: 40, prepMinutes: 30, travelMinutes: 60 }],
    weeklyLessonHours: 12, dailyTeachingLimit: 1, weeklyTeachingLimit: 10,
    monthlyEarnings: { expected: 135, completed: 60, expectedCount: 3, completedCount: 2 },
  } });
  const markup = renderToStaticMarkup(harness.render());
  assert.match(markup, /Weekly teaching/);
  assert.match(markup, /12<span class="metric-unit"> \/ 10 hrs/);
  assert.match(markup, /Over weekly limit/);
  assert.match(markup, /Selected-day teaching/);
  assert.match(markup, /2<span class="metric-unit"> \/ 1 hrs/);
  assert.match(markup, /Over daily limit/);
  assert.match(markup, /November expected earnings/);
  assert.match(markup, /\$135\.00/);
  assert.match(markup, /November completed earnings/);
  assert.match(markup, /\$60\.00/);
});

test("historical lessons keep their archived student's name and show a zero fixed fee accurately", () => {
  const student = { id: "archived", name: "Archived Alex", status: "archived" };
  const lesson = { id: "lesson", time: "10:00", end: "11:00", title: "Historical lesson", detail: "", kind: "lesson", tone: "coral", status: "completed", rate: 999, fixedFee: 0, studentId: student.id, prepMinutes: 0, travelMinutes: 0 };
  const harness = overviewHarness({ state: { students: [student, { id: "other-archived", name: "Other archived", status: "archived" }, { id: "active", name: "Active Amy", status: "active" }], lessons: [lesson], editingLesson: lesson, lessonDetailsOpen: true } });
  let tree = harness.render();
  const dialog = one(nodes(tree).filter(node => node.props["aria-labelledby"] === "lesson-details-title"), "lesson details");
  assert.match(textOf(dialog), /Archived Alex/);
  assert.match(textOf(dialog), /\$0 fixed fee/);
  one(nodes(dialog).filter(node => node.type === "button" && textOf(node) === "Edit"), "Edit button").props.onClick();
  tree = harness.render();
  const editor = one(nodes(tree).filter(node => node.props["aria-labelledby"] === "lesson-modal-title"), "lesson editor");
  const options = nodes(editor).filter(node => node.type === "option").map(textOf);
  assert.ok(options.includes("Archived Alex (archived)"));
  assert.ok(options.includes("Active Amy"));
  assert.equal(options.includes("Other archived (archived)"), false);
});
