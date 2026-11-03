import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import ts from "typescript";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const pageFile = "src/app/page.tsx";
const previousWindow = { weekday: 2, starts: "09:00", ends: "10:00" };
const savedWindow = { weekday: 2, starts: "14:00", ends: "15:00" };

function elements(node) {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  return [node, ...React.Children.toArray(node.props.children).flatMap(elements)];
}
function textOf(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return React.isValidElement(node) ? textOf(node.props.children) : "";
}
function button(tree, label) {
  const matches = elements(tree).filter(node => node.type === "button" && textOf(node).trim() === label);
  assert.equal(matches.length, 1, `Expected one ${label} button`);
  return matches[0];
}

// Execute the real page's asynchronous effects and event handlers with named state.
function harness(failedRead = "listAvailability") {
  const values = new Map(Object.entries({
    userId: "user-1", selectedDate: "2026-11-03", availabilityWeekDate: "2026-11-03",
    availability: [previousWindow], availabilityDefault: [previousWindow], workingPlaces: { 2: "Old studio" },
  }));
  const listeners = new Map();
  const effects = [];
  const pendingEffects = [];
  const writes = [];
  const storageReads = [];
  let effectIndex = 0;
  let failure = failedRead;
  let saveFailure = false;
  const router = { push() {}, replace() {}, refresh() {} };
  const window = {
    localStorage: {
      getItem(key) { storageReads.push(key); return JSON.stringify([{ weekday: 2, starts: "01:00", ends: "02:00" }]); },
      setItem() { throw new Error("Cloud failure must not write an unscoped browser fallback"); }, removeItem() {},
    },
    addEventListener(name, callback) { (listeners.get(name) ?? listeners.set(name, new Set()).get(name)).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    dispatchEvent() {}, setTimeout() { return 1; }, clearTimeout() {},
  };
  const success = data => ({ data, error: null });
  const database = {
    listAvailability: async () => failure === "listAvailability" ? { data: null, error: new Error("Offline") } : success([savedWindow]),
    listAvailabilityOverrides: async () => failure === "listAvailabilityOverrides" ? { data: null, error: new Error("Offline") } : success([]),
    listWorkingPlaces: async () => failure === "listWorkingPlaces" ? { data: null, error: new Error("Offline") } : success([{ weekday: 2, place: "Saved studio" }]),
    saveAvailability: async (...args) => {
      writes.push(args);
      return saveFailure ? { data: null, error: new Error("Network lost") } : success(null);
    },
    auth: {},
  };
  const react = {
    ...React,
    useRef: initial => ({ current: initial }),
    useEffect(callback, dependencies) {
      const index = effectIndex++;
      const previous = effects[index];
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous.dependencies[i]))) {
        pendingEffects.push(() => {
          previous?.cleanup?.();
          effects[index] = { dependencies, cleanup: callback() };
        });
      }
    },
  };
  const mocks = {
    react, "react/jsx-runtime": jsxRuntime,
    "next/navigation": { useRouter: () => router },
    "lucide-react": new Proxy({}, { get: () => () => React.createElement("svg") }),
    "@/lib/data/client": { cloudConfigured: true, database },
    "@/lib/google-calendar/client": { deleteGoogleCalendarEvent() {}, syncGoogleCalendarEvent() {}, googleCalendarErrorMessage: error => String(error) },
  };
  const cache = new Map();
  function load(relative) {
    if (cache.has(relative)) return cache.get(relative);
    const namedStates = context => {
      const visit = node => {
        if (ts.isVariableDeclaration(node) && ts.isArrayBindingPattern(node.name) && node.initializer && ts.isCallExpression(node.initializer)
          && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "useState") {
          const name = node.name.elements[0]?.name;
          if (name && ts.isIdentifier(name)) return context.factory.updateVariableDeclaration(node, node.name, node.exclamationToken, node.type,
            context.factory.createCallExpression(context.factory.createIdentifier("__state"), undefined, [context.factory.createStringLiteral(name.text), ...node.initializer.arguments]));
        }
        return ts.visitEachChild(node, visit, context);
      };
      return node => ts.visitNode(node, visit);
    };
    const { outputText } = ts.transpileModule(readFileSync(path.join(workspace, relative), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
      transformers: relative === pageFile ? { before: [namedStates] } : undefined,
    });
    const evaluatedModule = { exports: {} };
    cache.set(relative, evaluatedModule.exports);
    vm.runInNewContext(outputText, {
      module: evaluatedModule, exports: evaluatedModule.exports, window, Date, Intl, Event, URLSearchParams, crypto,
      __state(name, initial) {
        if (!values.has(name)) values.set(name, typeof initial === "function" ? initial() : initial);
        return [values.get(name), next => values.set(name, typeof next === "function" ? next(values.get(name)) : next)];
      },
      require(name) {
        if (Object.hasOwn(mocks, name)) return mocks[name];
        let candidate = name.startsWith("@/") ? `src/${name.slice(2)}` : path.posix.normalize(path.posix.join(path.posix.dirname(relative), name));
        if (!/\.tsx?$/.test(candidate)) candidate += existsSync(path.join(workspace, `${candidate}.ts`)) ? ".ts" : ".tsx";
        assert.ok(candidate.startsWith("src/"), `Unexpected import ${name}`);
        return load(candidate);
      },
    }, { filename: relative });
    return evaluatedModule.exports;
  }
  const Overview = load(pageFile).default;
  const render = () => { effectIndex = 0; return Overview(); };
  const flush = async () => {
    while (pendingEffects.length) pendingEffects.shift()();
    await new Promise(resolve => setImmediate(resolve));
  };
  return { values, writes, storageReads, render, flush, recover: () => { failure = ""; },
    failSaving: () => { saveFailure = true; },
    online: () => { for (const callback of listeners.get("online") ?? []) callback(); } };
}

for (const failedRead of ["listAvailability", "listAvailabilityOverrides", "listWorkingPlaces"]) {
  test(`failed ${failedRead} retains the last snapshot and blocks saving stale availability`, async () => {
    const view = harness(failedRead);
    let tree = view.render();
    await view.flush();
    tree = view.render();
    assert.equal(button(tree, "Save availability").props.disabled, true);
    assert.match(textOf(tree), /could not be loaded completely/);
    assert.deepEqual(view.values.get("availability"), [previousWindow]);
    assert.deepEqual(view.values.get("workingPlaces"), { 2: "Old studio" });
    assert.deepEqual(view.storageReads, []);
    button(tree, "Save availability").props.onClick();
    await view.flush();
    assert.deepEqual(view.writes, []);

    view.recover();
    button(tree, "Retry loading availability").props.onClick();
    view.render();
    await view.flush();
    tree = view.render();
    assert.equal(button(tree, "Save availability").props.disabled, false);
    assert.equal(view.values.get("availability")[0].starts, "14:00");
    assert.equal(view.values.get("workingPlaces")[2], "Saved studio");
    button(tree, "Save availability").props.onClick();
    await view.flush();
    assert.equal(view.writes.length, 1);
    assert.equal(view.writes[0][0][0].starts, "14:00");
  });
}

test("network recovery retries an incomplete snapshot instead of saving browser fallback values", async () => {
  const view = harness();
  view.render();
  await view.flush();
  view.render();
  await view.flush();
  view.recover();
  view.online();
  view.render();
  await view.flush();
  const tree = view.render();
  assert.equal(button(tree, "Save availability").props.disabled, false);
  assert.equal(view.values.get("availability")[0].starts, "14:00");
  assert.deepEqual(view.storageReads, []);
  assert.deepEqual(view.writes, []);
});

test("a failed cloud save retains the edited form without creating browser fallback values", async () => {
  const view = harness("");
  view.render();
  await view.flush();
  view.values.set("availability", [{ weekday: 2, starts: "16:00", ends: "17:00" }]);
  const tree = view.render();
  view.failSaving();
  button(tree, "Save availability").props.onClick();
  await view.flush();
  const failed = view.render();
  assert.match(textOf(failed), /Your changes are still in this form/);
  assert.equal(view.values.get("availability")[0].starts, "16:00");
  assert.deepEqual(view.storageReads, []);
  assert.equal(view.writes.length, 1);
  assert.equal(button(failed, "Save availability").props.disabled, false);
});
