import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import ts from "typescript";

const connectionKey = "daylight-google-calendar-connection";
const tokenKey = "daylight-google-calendar-token";
const linksKey = "daylight-google-calendar-event-links-user-1";
const userId = "user-1";

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    key: (index) => [...values.keys()][index] ?? null,
  };
}

function evaluate(relativePath, globals = {}, dependencies = {}) {
  const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const evaluatedModule = { exports: {} };
  const context = {
    module: evaluatedModule, exports: evaluatedModule.exports, URLSearchParams, Date, Intl, Event, AbortSignal, crypto: webcrypto, TextEncoder,
    process: { env: { NEXT_PUBLIC_GOOGLE_CLIENT_ID: "test-client" } },
    require: (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected import: ${name}`);
      return dependencies[name];
    },
    ...globals,
  };
  vm.runInNewContext(outputText, context, { filename: relativePath });
  return evaluatedModule.exports;
}

function browser() {
  const localStorage = storage();
  const sessionStorage = storage();
  const events = new EventTarget();
  localStorage.setItem(connectionKey, JSON.stringify({ userId }));
  sessionStorage.setItem(tokenKey, JSON.stringify({ userId, accessToken: "test-token", expiresAt: Date.now() + 3_600_000 }));
  return {
    localStorage,
    sessionStorage,
    dispatchEvent: events.dispatchEvent.bind(events),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    google: { accounts: { oauth2: {
      initTokenClient: ({ callback }) => ({
        requestAccessToken: () => callback({ access_token: "renewed-token", expires_in: 3600 }),
      }),
    } } },
  };
}

const event = (id = "event-1") => ({
  id, userId, title: "Piano lesson", detail: "Studio", kind: "lesson", tone: "coral",
  startsAt: "2026-11-03T10:00:00.000Z", endsAt: "2026-11-03T11:00:00.000Z",
  timezone: "Asia/Hong_Kong", status: "scheduled", recurrenceWeekdays: [], recurrenceUntil: null,
  intensity: 2, prepMinutes: 0, travelMinutes: 0, hourlyRate: 35, fixedFee: null, studentId: null,
});

const response = (status, body = {}) => ({
  status, ok: status >= 200 && status < 300, json: async () => body,
});

function calendarServer() {
  const events = new Map();
  const calls = [];
  let failNext = null;
  let sequence = 0;
  const fetch = async (url, init = {}) => {
    const request = { url: new URL(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null };
    calls.push(request);
    if (failNext) {
      const fail = failNext(request);
      if (fail) {
        failNext = null;
        if (fail instanceof Error) throw fail;
        return fail;
      }
    }
    const id = decodeURIComponent(request.url.pathname.split("/").at(-1));
    if (id === "events" && request.method === "GET") {
      const filter = request.url.searchParams.get("privateExtendedProperty");
      const [property, value] = filter?.split("=") ?? [];
      return response(200, { items: [...events.values()].filter((item) => !filter || item.extendedProperties?.private?.[property] === value) });
    }
    if (id === "events" && request.method === "POST") {
      const requestedId = request.body.id ?? `google-${++sequence}`;
      if (events.has(requestedId)) return response(409, { error: { message: "The requested identifier already exists.", errors: [{ reason: "duplicate" }] } });
      const created = { ...request.body, id: requestedId };
      events.set(created.id, created);
      return response(200, created);
    }
    if (!events.has(id)) return response(404, { error: { message: "Not found" } });
    if (request.method === "DELETE") { events.delete(id); return response(204); }
    if (request.method === "PATCH") events.set(id, { ...events.get(id), ...request.body });
    return response(200, events.get(id));
  };
  return { events, calls, fetch, failOnce: (callback) => { failNext = callback; } };
}

function loadClient(window, fetch, document) {
  return evaluate("src/lib/google-calendar/client.ts", { window, fetch, document }, scheduleModules());
}

function scheduleModules() {
  const timezone = evaluate("src/lib/schedule/timezone.ts");
  const recurrence = evaluate("src/lib/schedule/recurrence.ts", {}, { "./timezone": timezone });
  return { "@/lib/schedule/timezone": timezone, "@/lib/schedule/recurrence": recurrence };
}

test("login connection check verifies Calendar access on every check without opening Google sign-in", async () => {
  const window = browser();
  let requests = 0;
  window.google.accounts.oauth2.initTokenClient = () => { throw new Error("Login check must not open a popup"); };
  const client = loadClient(window, async (url, init) => {
    requests += 1;
    const parsed = new URL(url);
    assert.equal(parsed.pathname, "/calendar/v3/calendars/primary/events");
    assert.equal(parsed.searchParams.get("maxResults"), "1");
    assert.equal(init.headers.Authorization, "Bearer test-token");
    return response(200, { items: [] });
  });
  assert.equal(await client.checkGoogleCalendarConnection(userId), "connected");
  assert.equal(await client.checkGoogleCalendarConnection(userId), "connected");
  assert.equal(requests, 2, "A cached token must not bypass the next login verification");
  const stored = JSON.parse(window.sessionStorage.getItem(tokenKey));
  assert.equal(client.googleCalendarTokenExpiresAt(userId), stored.expiresAt);
});

test("unconnected and expired sessions request reconnection without network calls or popups", async () => {
  const window = browser();
  window.google.accounts.oauth2.initTokenClient = () => { throw new Error("Login check must not open a popup"); };
  const client = loadClient(window, async () => { throw new Error("Unexpected network request"); });
  window.localStorage.removeItem(connectionKey);
  assert.equal(await client.checkGoogleCalendarConnection(userId), "not-connected");
  assert.equal(client.googleCalendarTokenExpiresAt(userId), null);
  window.localStorage.setItem(connectionKey, JSON.stringify({ userId }));
  window.sessionStorage.setItem(tokenKey, JSON.stringify({ userId, accessToken: "expired", expiresAt: Date.now() - 1 }));
  assert.equal(await client.checkGoogleCalendarConnection(userId), "reconnect-required");
  assert.equal(client.googleCalendarTokenExpiresAt(userId), null);
});

for (const status of [401, 403]) {
  test(`login verification detects revoked authorization (${status}) and keeps retry metadata`, async () => {
    const window = browser();
    const linked = JSON.stringify({ "event-1": "google-1" });
    window.localStorage.setItem(linksKey, linked);
    const client = loadClient(window, async () => response(status, { error: { message: "Calendar permission was revoked", errors: [{ reason: status === 403 ? "insufficientPermissions" : "authError" }] } }));
    const notices = [];
    window.addEventListener(client.googleCalendarConnectionChangedEvent, (event) => notices.push(event.type));
    assert.equal(await client.checkGoogleCalendarConnection(userId), "reconnect-required");
    assert.equal(client.googleCalendarIsConnected(userId), false);
    assert.equal(client.googleCalendarTokenExpiresAt(userId), null);
    assert.equal(window.localStorage.getItem(linksKey), linked);
    assert.equal(JSON.parse(window.localStorage.getItem(connectionKey)).userId, userId);
    assert.equal(notices.length, 1, "Connection UI should be notified that authorization is no longer usable");
  });
}

test("failed login verification reports network and server failures instead of a connected state", async () => {
  const window = browser();
  const offlineClient = loadClient(window, async () => { throw new Error("Network unavailable"); });
  await assert.rejects(offlineClient.checkGoogleCalendarConnection(userId), /Network unavailable/);
  assert.ok(offlineClient.googleCalendarTokenExpiresAt(userId), "A network failure must not discard usable authorization");
  const unavailableClient = loadClient(window, async () => response(503, { error: { message: "Calendar service unavailable" } }));
  await assert.rejects(unavailableClient.checkGoogleCalendarConnection(userId), /Calendar service unavailable/);
  assert.ok(unavailableClient.googleCalendarTokenExpiresAt(userId));
});

test("a Google token from another workspace account cannot satisfy login verification", async () => {
  const window = browser();
  const anotherUser = "user-2";
  window.localStorage.setItem(connectionKey, JSON.stringify({ userId: anotherUser }));
  let popups = 0;
  window.google.accounts.oauth2.initTokenClient = ({ callback }) => ({
    requestAccessToken: () => { popups += 1; callback({ access_token: "user-2-token", expires_in: 3600 }); },
  });
  const tokens = [];
  const client = loadClient(window, async (_url, init) => { tokens.push(init.headers.Authorization); return response(200, { items: [] }); });
  assert.equal(client.googleCalendarIsConnected(anotherUser), false);
  assert.equal(client.googleCalendarTokenExpiresAt(anotherUser), null);
  assert.equal(await client.checkGoogleCalendarConnection(anotherUser), "reconnect-required");
  assert.equal(popups, 0);
  assert.deepEqual(tokens, []);
  await client.connectGoogleCalendar(anotherUser);
  assert.equal(popups, 1);
  assert.deepEqual(tokens, ["Bearer user-2-token"]);
  assert.equal(JSON.parse(window.sessionStorage.getItem(tokenKey)).userId, anotherUser);
});

test("legacy tokens require authorization instead of being silently assigned to the signed-in account", async () => {
  const window = browser();
  window.sessionStorage.setItem(tokenKey, JSON.stringify({ accessToken: "legacy-token", expiresAt: Date.now() + 3_600_000 }));
  const client = loadClient(window, async () => { throw new Error("Legacy token must not be sent to Google"); });
  assert.equal(await client.checkGoogleCalendarConnection(userId), "reconnect-required");
  assert.equal(client.googleCalendarTokenExpiresAt(userId), null);
});

test("connection changes notify mounted views when authorization is granted and disconnected", async () => {
  const window = browser();
  window.localStorage.removeItem(connectionKey);
  window.sessionStorage.removeItem(tokenKey);
  const client = loadClient(window, async () => response(200, { items: [] }));
  const notices = [];
  window.addEventListener(client.googleCalendarConnectionChangedEvent, (event) => notices.push(event.type));
  await client.connectGoogleCalendar(userId);
  assert.ok(notices.length >= 1);
  const afterConnect = notices.length;
  assert.equal(await client.checkGoogleCalendarConnection(userId), "connected");
  await client.disconnectGoogleCalendar();
  assert.ok(notices.length > afterConnect);
  assert.equal(await client.checkGoogleCalendarConnection(userId), "not-connected");
});

for (const reason of ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "accessNotConfigured"]) {
  test(`Calendar 403 ${reason} preserves authorization for retry`, async () => {
    const window = browser();
    const client = loadClient(window, async () => response(403, { error: { message: reason, errors: [{ reason }] } }));
    const stored = window.sessionStorage.getItem(tokenKey);
    await assert.rejects(client.checkGoogleCalendarConnection(userId), new RegExp(reason));
    assert.equal(window.sessionStorage.getItem(tokenKey), stored);
    assert.equal(client.googleCalendarIsConnected(userId), true);
  });
}

test("a permission-denied connect discards its token so the next gesture can authorize again", async () => {
  const window = browser();
  window.localStorage.removeItem(connectionKey);
  window.sessionStorage.removeItem(tokenKey);
  let popups = 0;
  window.google.accounts.oauth2.initTokenClient = ({ callback }) => ({ requestAccessToken: () => {
    popups += 1;
    callback({ access_token: `new-token-${popups}`, expires_in: 3600 });
  } });
  const client = loadClient(window, async (_url, init) => init.headers.Authorization === "Bearer new-token-1"
    ? response(403, { error: { message: "Insufficient scope", errors: [{ reason: "insufficientPermissions" }] } })
    : response(200, { items: [] }));
  await assert.rejects(client.connectGoogleCalendar(userId), /Calendar permission/i);
  assert.equal(window.sessionStorage.getItem(tokenKey), null);
  await client.connectGoogleCalendar(userId);
  assert.equal(popups, 2);
  assert.equal(client.googleCalendarIsConnected(userId), true);
});

test("a late 401 from an old token cannot erase newly renewed authorization", async () => {
  const window = browser();
  let releaseOld;
  let markStarted;
  const delayed = new Promise((resolve) => { releaseOld = resolve; });
  const started = new Promise((resolve) => { markStarted = resolve; });
  let oldRequests = 0;
  const client = loadClient(window, async (_url, init) => {
    if (init.headers.Authorization === "Bearer test-token") {
      oldRequests += 1;
      if (oldRequests === 1) { markStarted(); return delayed; }
      return response(401);
    }
    assert.equal(init.headers.Authorization, "Bearer renewed-token");
    return response(200, { items: [] });
  });
  const firstCheck = client.checkGoogleCalendarConnection(userId);
  await started;
  assert.equal(await client.checkGoogleCalendarConnection(userId), "reconnect-required");
  await client.connectGoogleCalendar(userId);
  releaseOld(response(401));
  assert.equal(await firstCheck, "connected");
  assert.equal(client.googleCalendarIsConnected(userId), true);
  assert.equal(JSON.parse(window.sessionStorage.getItem(tokenKey)).accessToken, "renewed-token");
});

test("disconnect clears immediately and a late revoke cannot clear a new connection", async () => {
  const window = browser();
  const pendingKey = `daylight-google-calendar-pending-deletions-${userId}`;
  window.localStorage.setItem(pendingKey, JSON.stringify(["deleted-event"]));
  let releaseRevoke;
  const revoking = new Promise((resolve) => { releaseRevoke = resolve; });
  const client = loadClient(window, async (url, init) => {
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) {
      assert.ok(init.signal instanceof AbortSignal);
      return revoking;
    }
    return response(200, { items: [] });
  });
  const disconnected = client.disconnectGoogleCalendar();
  assert.equal(client.googleCalendarIsConnected(userId), false);
  assert.equal(window.localStorage.getItem(connectionKey), null);
  assert.equal(window.localStorage.getItem(pendingKey), JSON.stringify(["deleted-event"]));
  await client.connectGoogleCalendar(userId);
  releaseRevoke(response(200));
  await disconnected;
  assert.equal(client.googleCalendarIsConnected(userId), true);
});

test("concurrent tabs create one Google event using the same deterministic identifier", async () => {
  const window = browser();
  const server = calendarServer();
  const firstTab = loadClient(window, server.fetch);
  const secondTab = loadClient(window, server.fetch);
  await Promise.all([firstTab.syncGoogleCalendarEvent(event()), secondTab.syncGoogleCalendarEvent(event())]);
  assert.equal(server.events.size, 1);
  const inserts = server.calls.filter((call) => call.method === "POST");
  assert.equal(inserts.length, 2, "Both tabs observed no event before either insert completed");
  assert.equal(inserts[0].body.id, inserts[1].body.id);
  assert.match(inserts[0].body.id, /^[0-9a-v]{5,1024}$/);
  assert.equal(server.calls.filter((call) => call.method === "PATCH").length, 1, "The conflicting insert converges on the existing event");
});

test("the same schedule identifier in different workspace accounts does not adopt another owner's Google event", async () => {
  const firstWindow = browser();
  const server = calendarServer();
  const firstClient = loadClient(firstWindow, server.fetch);
  await firstClient.syncGoogleCalendarEvent(event());
  const anotherWindow = browser();
  anotherWindow.localStorage.setItem(connectionKey, JSON.stringify({ userId: "another-user" }));
  anotherWindow.sessionStorage.setItem(tokenKey, JSON.stringify({ userId: "another-user", accessToken: "another-token", expiresAt: Date.now() + 3_600_000 }));
  const secondClient = loadClient(anotherWindow, server.fetch);
  await secondClient.syncGoogleCalendarEvent({ ...event(), userId: "another-user", title: "Other account's event" });
  assert.equal(server.events.size, 2);
  assert.deepEqual([...server.events.values()].map((item) => item.extendedProperties.private.daylightUserId).sort(), ["another-user", userId]);
  assert.equal([...server.events.values()].find((item) => item.extendedProperties.private.daylightUserId === userId).summary, event().title);
});

test("a lost insert response remains idempotent while the property search is stale", async () => {
  const window = browser();
  const server = calendarServer();
  let lost = false;
  const client = loadClient(window, async (url, init = {}) => {
    if (lost && !init.method && new URL(url).pathname.endsWith("/events")) return response(200, { items: [] });
    const result = await server.fetch(url, init);
    if (init.method === "POST" && !lost) { lost = true; throw new Error("Lost response"); }
    return result;
  });
  await assert.rejects(client.syncGoogleCalendarEvent(event()), /Lost response/);
  await client.syncGoogleCalendarEvent(event());
  assert.equal(server.events.size, 1);
  assert.equal(server.calls.filter((call) => call.method === "POST").length, 2);
});

test("a cancelled deterministic event can be restored when Google retains only its identifier and status", async () => {
  const window = browser();
  const server = calendarServer();
  const client = loadClient(window, server.fetch);
  await client.syncGoogleCalendarEvent(event());
  const id = [...server.events.keys()][0];
  server.events.set(id, { id, status: "cancelled" });
  await client.syncGoogleCalendarEvent(event());
  assert.equal(server.events.size, 1);
  assert.equal(server.events.get(id).status, "confirmed");
  assert.equal(server.events.get(id).summary, event().title);
  assert.equal(server.events.get(id).extendedProperties.private.daylightEventId, event().id);
});

test("retry updates the existing event without creating duplicates", async () => {
  const window = browser();
  const server = calendarServer();
  const client = loadClient(window, server.fetch);
  await client.syncGoogleCalendarEvent(event());
  await client.syncGoogleCalendarEvent({ ...event(), title: "Updated lesson" });
  await client.syncGoogleCalendarEvent({ ...event(), title: "Updated lesson" });
  assert.equal(server.events.size, 1);
  assert.equal([...server.events.values()][0].summary, "Updated lesson");
  assert.equal(server.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(server.calls.filter((call) => call.method === "PATCH").length, 2);
});

test("retry finds an event after Google saved it but the response was lost", async () => {
  const window = browser();
  const server = calendarServer();
  let loseResponse = true;
  const client = loadClient(window, async (url, init) => {
    const result = await server.fetch(url, init);
    if (init?.method === "POST" && loseResponse) { loseResponse = false; throw new Error("Network lost"); }
    return result;
  });
  await assert.rejects(client.syncGoogleCalendarEvent(event()), /Network lost/);
  await client.syncGoogleCalendarEvent(event());
  assert.equal(server.events.size, 1);
  assert.equal(server.calls.filter((call) => call.method === "POST").length, 1);
});

test("temporary HTTP errors preserve event links and do not create replacements", async () => {
  const window = browser();
  const server = calendarServer();
  const client = loadClient(window, server.fetch);
  await client.syncGoogleCalendarEvent(event());
  const linked = window.localStorage.getItem(linksKey);
  server.failOnce(() => response(503, { error: { message: "Temporarily unavailable" } }));
  await assert.rejects(client.syncGoogleCalendarEvent(event()), /Temporarily unavailable/);
  assert.equal(window.localStorage.getItem(linksKey), linked);
  assert.equal(server.calls.filter((call) => call.method === "POST").length, 1);
});

test("event lookup skips instances and cancelled records across empty result pages", async () => {
  const window = browser();
  window.localStorage.setItem(linksKey, JSON.stringify({ "event-1": "cached-instance" }));
  const calls = [];
  const client = loadClient(window, async (url, init = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, method: init.method ?? "GET" });
    if (parsed.pathname.endsWith("/cached-instance")) return response(200, { id: "cached-instance", recurringEventId: "series-parent" });
    if (parsed.pathname.endsWith("/events") && !init.method) {
      const page = parsed.searchParams.get("pageToken");
      if (!page) return response(200, {
        items: [
          { id: "cancelled-parent", status: "cancelled" },
          { id: "instance", recurringEventId: "series-parent" },
          { id: "instance-with-original", originalStartTime: { dateTime: event().startsAt } },
        ],
        nextPageToken: "empty-page",
      });
      if (page === "empty-page") return response(200, { items: [], nextPageToken: "parent-page" });
      assert.equal(page, "parent-page");
      return response(200, { items: [{ id: "series-parent", status: "confirmed" }] });
    }
    assert.equal(parsed.pathname.split("/").at(-1), "series-parent");
    assert.equal(init.method, "PATCH");
    return response(200, { id: "series-parent" });
  });
  await client.syncGoogleCalendarEvent({ ...event(), recurrenceWeekdays: [2] });
  const searches = calls.filter((call) => call.url.pathname.endsWith("/events"));
  assert.deepEqual(searches.map((call) => call.url.searchParams.get("pageToken")), [null, "empty-page", "parent-page"]);
  assert.ok(searches.every((call) => call.url.searchParams.get("singleEvents") === "false"));
  assert.equal(JSON.parse(window.localStorage.getItem(linksKey))["event-1"], "series-parent");
  assert.equal(calls.filter((call) => call.method === "PATCH").length, 1);
  assert.equal(calls.some((call) => call.method === "POST"), false);
});

test("sync clears recurrence when a weekly event becomes one-time", async () => {
  const window = browser();
  const server = calendarServer();
  const client = loadClient(window, server.fetch);
  await client.syncGoogleCalendarEvent({ ...event(), recurrenceWeekdays: [2] });
  assert.ok([...server.events.values()][0].recurrence.length);
  await client.syncGoogleCalendarEvent(event());
  assert.equal(server.events.size, 1);
  assert.equal([...server.events.values()][0].recurrence, null);
});

for (const fixture of [
  { zone: "America/Los_Angeles", start: "2026-11-04T01:00:00.000Z", until: "2026-11-03", cutoff: "20261104T075959Z", weekday: 2 },
  { zone: "America/New_York", start: "2026-10-25T13:00:00.000Z", until: "2026-11-01", cutoff: "20261102T045959Z", weekday: 0 },
  { zone: "America/New_York", start: "2026-03-01T14:00:00.000Z", until: "2026-03-08", cutoff: "20260309T035959Z", weekday: 0 },
]) {
  test(`weekly cutoff uses the event timezone through ${fixture.zone} ${fixture.until}`, async () => {
    const window = browser();
    const server = calendarServer();
    const client = loadClient(window, server.fetch);
    await client.syncGoogleCalendarEvent({ ...event(), timezone: fixture.zone, startsAt: fixture.start,
      endsAt: new Date(Date.parse(fixture.start) + 3_600_000).toISOString(), recurrenceWeekdays: [fixture.weekday], recurrenceUntil: fixture.until });
    assert.ok([...server.events.values()][0].recurrence[0].endsWith(`;UNTIL=${fixture.cutoff}`));
  });
}

test("bulk reconciliation restores orphan overrides, preserves saved changes, and removes obsolete slots", async () => {
  const window = browser();
  const server = calendarServer();
  const series = { ...event(), title: "Current series title", recurrenceWeekdays: [2], recurrenceUntil: "2026-12-01" };
  window.localStorage.setItem(linksKey, JSON.stringify({ "event-1": "parent" }));
  const privateMarker = { private: { daylightEventId: series.id, daylightUserId: userId } };
  server.events.set("parent", { id: "parent", extendedProperties: privateMarker });
  const instance = (id, original, extras = {}) => ({ id, recurringEventId: "parent", status: "confirmed", summary: "Old override", originalStartTime: { dateTime: original }, extendedProperties: privateMarker, ...extras });
  const overrides = [
    instance("orphan-edit", "2026-11-17T10:00:00.000Z"),
    instance("saved-skip", "2026-11-10T10:00:00.000Z", { status: "cancelled" }),
    { id: "orphan-cancel", recurringEventId: "parent", status: "cancelled", originalStartTime: { dateTime: "2026-11-24T10:00:00.000Z" } },
    instance("obsolete-time", "2026-11-17T11:00:00.000Z"),
    instance("other-parent", "2026-11-17T10:00:00.000Z", { recurringEventId: "another-parent" }),
  ];
  for (const item of overrides) server.events.set(item.id, item);
  const pages = [];
  const client = loadClient(window, async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/events") && parsed.searchParams.get("showDeleted") === "true") {
      assert.equal(parsed.searchParams.get("singleEvents"), "false");
      assert.equal(parsed.searchParams.has("privateExtendedProperty"), false, "Cancelled exceptions without private metadata must be discoverable");
      assert.equal(server.calls.filter((call) => call.method !== "GET").length, 0, "Read all override pages before changing instances");
      const page = parsed.searchParams.get("pageToken");
      pages.push(page);
      if (!page) return response(200, { items: [overrides[0]], nextPageToken: "empty" });
      if (page === "empty") return response(200, { items: [], nextPageToken: "remaining" });
      return response(200, { items: overrides.slice(1) });
    }
    return server.fetch(url, init);
  });
  await client.reconcileGoogleCalendarOccurrences(series, [{ eventId: series.id, originalStartsAt: "2026-11-10T10:00:00.000Z" }]);
  assert.deepEqual(pages, [null, "empty", "remaining"]);
  for (const id of ["orphan-edit", "orphan-cancel"]) {
    assert.equal(server.events.get(id).status, "confirmed");
    assert.equal(server.events.get(id).summary, series.title);
    assert.equal(server.events.get(id).start.dateTime, server.events.get(id).originalStartTime.dateTime);
  }
  assert.equal(server.events.get("saved-skip").status, "cancelled");
  assert.equal(server.events.get("other-parent").summary, "Old override");
  assert.equal(server.events.has("obsolete-time"), false);
  assert.deepEqual(server.calls.filter((call) => call.method === "PATCH").map((call) => call.url.pathname.split("/").at(-1)), ["orphan-edit", "orphan-cancel"]);
});

test("another browser can recover an owned deleted event without old browser links", async () => {
  const window = browser();
  const server = calendarServer();
  const client = loadClient(window, server.fetch);
  await client.syncGoogleCalendarEvent(event());
  server.events.set("unrelated", { id: "unrelated", summary: "Unrelated appointment", extendedProperties: { private: { daylightEventId: "some-other-id" } } });
  window.localStorage.removeItem(linksKey);
  const anotherBrowser = loadClient(window, server.fetch);
  const candidates = await anotherBrowser.googleCalendarRemoteDeletionCandidates(userId);
  assert.deepEqual(Array.from(candidates), [event().id]);
  assert.equal(await anotherBrowser.retryGoogleCalendarDeletions(userId, [], candidates), 1);
  assert.equal(server.events.size, 1);
  assert.ok(server.events.has("unrelated"));
});

test("remote deletion discovery paginates and excludes instances, other owners, and unmarked events", async () => {
  const window = browser();
  const marked = (id, owner = userId) => ({ id: `google-${id}`, extendedProperties: { private: { daylightEventId: id, daylightUserId: owner } } });
  const queries = [];
  const client = loadClient(window, async (url) => {
    const params = new URL(url).searchParams;
    assert.equal(params.get("privateExtendedProperty"), `daylightUserId=${userId}`);
    const page = params.get("pageToken");
    queries.push(page);
    if (!page) return response(200, { items: [marked("first"), marked("wrong-owner", "another-user"), { id: "unmarked" }, { ...marked("instance"), recurringEventId: "parent" }], nextPageToken: "empty" });
    if (page === "empty") return response(200, { items: [], nextPageToken: "last" });
    return response(200, { items: [marked("last"), { ...marked("deleted"), status: "cancelled" }] });
  });
  assert.deepEqual(Array.from(await client.googleCalendarRemoteDeletionCandidates(userId)), ["first", "last"]);
  assert.deepEqual(queries, [null, "empty", "last"]);
  assert.deepEqual(JSON.parse(window.localStorage.getItem(linksKey)), { first: "google-first", last: "google-last" });
});

function recurringCalendar(instanceOverrides = {}) {
  const window = browser();
  const server = calendarServer();
  const queries = [];
  const patches = [];
  let deleteCount = 0;
  let missing = false;
  let instance = {
    id: "instance-1", status: "confirmed", recurringEventId: "series-1",
    originalStartTime: { dateTime: event().startsAt },
    start: { dateTime: "2026-12-22T10:00:00.000Z" },
    end: { dateTime: "2026-12-22T11:00:00.000Z" },
    ...instanceOverrides,
  };
  const client = loadClient(window, async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith("/instances")) {
      queries.push(parsed.searchParams);
      const matchesOriginal = parsed.searchParams.get("originalStart") === event().startsAt;
      return response(200, { items: !missing && matchesOriginal ? [instance] : [] });
    }
    if (parsed.pathname.endsWith("/instance-1")) {
      if (init.method === "DELETE") { deleteCount += 1; instance = { ...instance, status: "cancelled" }; return response(204); }
      assert.equal(init.method, "PATCH");
      const patch = JSON.parse(init.body);
      patches.push(patch);
      instance = { ...instance, ...patch };
      return response(200, instance);
    }
    return server.fetch(url, init);
  });
  return { client, queries, patches, deleteCount: () => deleteCount, makeMissing: () => { missing = true; } };
}

const occurrenceChange = (overrides = {}) => ({
  startsAt: "2026-11-17T10:00:00.000Z", endsAt: "2026-11-17T11:00:00.000Z",
  title: "Moved lesson", detail: null, kind: null, tone: null, travelMinutes: null,
  hourlyRate: null, fixedFee: null, status: "scheduled", ...overrides,
});

test("occurrence retry finds a moved instance using its original start", async () => {
  const { client, queries, patches } = recurringCalendar();
  const series = { ...event(), recurrenceWeekdays: [2] };
  await client.syncGoogleCalendarEvent(series);
  await client.syncGoogleCalendarOccurrence(series, event().startsAt, occurrenceChange());
  assert.equal(queries.length, 1);
  assert.equal(queries[0].get("originalStart"), event().startsAt);
  assert.equal(queries[0].has("timeMin"), false);
  assert.equal(queries[0].has("timeMax"), false);
  assert.equal(queries[0].get("showDeleted"), "true");
  assert.equal(patches[0].start.dateTime, "2026-11-17T10:00:00.000Z");
});

test("retrying an occurrence cancellation sends no duplicate DELETE", async () => {
  const calendar = recurringCalendar();
  const series = { ...event(), recurrenceWeekdays: [2] };
  await calendar.client.syncGoogleCalendarEvent(series);
  const cancellation = occurrenceChange({ status: "skipped", startsAt: null, endsAt: null });
  await calendar.client.syncGoogleCalendarOccurrence(series, event().startsAt, cancellation);
  await calendar.client.syncGoogleCalendarOccurrence(series, event().startsAt, cancellation);
  assert.equal(calendar.deleteCount(), 1);
});

test("a missing occurrence rejects the retry instead of reporting success", async () => {
  const calendar = recurringCalendar();
  const series = { ...event(), recurrenceWeekdays: [2] };
  await calendar.client.syncGoogleCalendarEvent(series);
  calendar.makeMissing();
  await assert.rejects(calendar.client.syncGoogleCalendarOccurrence(series, event().startsAt, occurrenceChange()), /occurrence could not be found/i);
  assert.deepEqual(calendar.patches, []);
});

test("replaying an edited occurrence restores a previously cancelled instance", async () => {
  const { client, patches } = recurringCalendar({ status: "cancelled" });
  const series = { ...event(), recurrenceWeekdays: [2] };
  await client.syncGoogleCalendarEvent(series);
  await client.syncGoogleCalendarOccurrence(series, event().startsAt, occurrenceChange({ startsAt: null, endsAt: null }));
  assert.equal(patches[0].status, "confirmed");
  assert.equal(patches[0].start.dateTime, event().startsAt);
  assert.equal(patches[0].end.dateTime, event().endsAt);
});

test("failed deletion remains retryable after a page reload", async () => {
  const window = browser();
  const server = calendarServer();
  const firstClient = loadClient(window, server.fetch);
  await firstClient.syncGoogleCalendarEvent(event());
  server.failOnce((call) => call.method === "DELETE" ? new Error("Network lost") : null);
  await assert.rejects(firstClient.deleteGoogleCalendarEvent(event()), /Network lost/);
  assert.equal(server.events.size, 1);
  const reloadedClient = loadClient(window, server.fetch);
  assert.equal(await reloadedClient.retryGoogleCalendarDeletions(userId, []), 1);
  assert.equal(server.events.size, 0);
  assert.equal(await reloadedClient.retryGoogleCalendarDeletions(userId, []), 0);
});

test("deletion is queued even if the lookup failed before obtaining a Google event link", async () => {
  const window = browser();
  const server = calendarServer();
  const firstClient = loadClient(window, server.fetch);
  await firstClient.syncGoogleCalendarEvent(event());
  window.localStorage.removeItem(linksKey);
  server.failOnce(() => new Error("Offline"));
  await assert.rejects(firstClient.deleteGoogleCalendarEvent(event()), /Offline/);
  const reloadedClient = loadClient(window, server.fetch);
  assert.equal(await reloadedClient.retryGoogleCalendarDeletions(userId, []), 1);
  assert.equal(server.events.size, 0);
});

test("deletion retry preserves saved events and unrelated Google events", async () => {
  const window = browser();
  const server = calendarServer();
  const client = loadClient(window, server.fetch);
  await client.syncGoogleCalendarEvent(event("keep"));
  await client.syncGoogleCalendarEvent(event("removed"));
  server.events.set("unrelated", { id: "unrelated", summary: "Appointment" });
  assert.equal(await client.retryGoogleCalendarDeletions(userId, ["keep"]), 1);
  assert.equal(server.events.size, 2);
  assert.ok(server.events.has("unrelated"));
  assert.ok([...server.events.values()].some((item) => item.extendedProperties?.private?.daylightEventId === "keep"));
});

test("pending deletion survives expired authorization and reconnect", async () => {
  const window = browser();
  const server = calendarServer();
  const client = loadClient(window, server.fetch);
  await client.syncGoogleCalendarEvent(event());
  server.failOnce(() => response(401, { error: { message: "Expired" } }));
  await assert.rejects(client.deleteGoogleCalendarEvent(event()), /authorization expired/i);
  assert.equal(client.googleCalendarIsConnected(userId), false);
  await client.connectGoogleCalendar(userId);
  assert.equal(await client.retryGoogleCalendarDeletions(userId, []), 1);
  assert.equal(server.events.size, 0);
});

test("failed Google sign-in script can load again after network recovery", async () => {
  const window = browser();
  delete window.google;
  const scripts = [];
  const document = {
    querySelector: () => scripts.find((script) => !script.removed) ?? null,
    createElement: () => {
      const listeners = {};
      const script = {
        addEventListener: (name, listener) => { listeners[name] = listener; },
        remove: () => { script.removed = true; },
        dispatch: (name) => { script[`on${name}`]?.(); listeners[name]?.(); },
      };
      return script;
    },
    head: { appendChild: (script) => scripts.push(script) },
  };
  const client = loadClient(window, async () => { throw new Error("Unexpected API request"); }, document);
  const firstAttempt = assert.rejects(client.prepareGoogleCalendar(), /could not load/);
  scripts[0].dispatch("error");
  await firstAttempt;
  const retry = client.prepareGoogleCalendar();
  assert.equal(scripts.length, 2);
  window.google = { accounts: { oauth2: {} } };
  scripts[1].dispatch("load");
  await retry;
});

function eventRow(id = "event-1", overrides = {}) {
  return {
    id, user_id: userId, title: "Piano lesson", starts_at: event().startsAt, ends_at: event().endsAt,
    timezone: "Asia/Hong_Kong", recurrence_weekdays: [2], recurrence_until: "2026-12-01", ...overrides,
  };
}

function bulkSync({ rows = [eventRow()], exceptions = [], exceptionsError = null, cloud = true, window = browser(), syncResult = "synced" } = {}) {
  const calls = [];
  const schema = evaluate("src/lib/data/schema.ts");
  const database = {
    listEvents: async (...args) => { calls.push({ action: "loadEvents", args }); return { data: rows, error: null }; },
    listExceptions: async (ids) => { calls.push({ action: "loadExceptions", ids }); return { data: exceptions, error: exceptionsError }; },
  };
  const client = {
    googleCalendarIsConnected: () => true,
    googleCalendarDeletionCandidates: (uid) => { calls.push({ action: "candidates", uid }); return ["removed"]; },
    googleCalendarRemoteDeletionCandidates: async (uid) => { calls.push({ action: "remoteCandidates", uid }); return []; },
    syncGoogleCalendarEvent: async (value) => { calls.push({ action: "event", value }); return syncResult; },
    reconcileGoogleCalendarOccurrences: async (value, changes) => { calls.push({ action: "reconcile", value, changes }); },
    syncGoogleCalendarOccurrence: async (value, originalStartsAt, change) => { calls.push({ action: "occurrence", value, originalStartsAt, change }); return syncResult; },
    retryGoogleCalendarDeletions: async (uid, ids, candidates) => { calls.push({ action: "delete", uid, ids, candidates }); return 2; },
  };
  const syncModule = evaluate("src/lib/google-calendar/sync.ts", { window }, {
    ...scheduleModules(),
    "@/lib/data/client": { cloudConfigured: cloud, database },
    "@/lib/data/schema": schema,
    "./client": client,
  });
  return { sync: syncModule.syncSavedScheduleToGoogleCalendar, calls };
}

test("bulk retry loads occurrence changes before changing Google Calendar", async () => {
  const { sync, calls } = bulkSync({ exceptionsError: new Error("Database offline") });
  await assert.rejects(sync(userId), /Database offline/);
  assert.deepEqual(calls.map((call) => call.action), ["candidates", "remoteCandidates", "loadEvents", "loadExceptions"]);
  assert.equal(calls.find((call) => call.action === "loadEvents").args.length, 0, "Load the complete schedule without a visible date range");
});

test("bulk retry applies events then valid occurrence overrides before deletion cleanup", async () => {
  const original = "2026-11-10T10:00:00.000Z";
  const { sync, calls } = bulkSync({
    rows: [eventRow(), eventRow("cancelled", { status: "cancelled" }), eventRow("one-time", { recurrence_weekdays: [] })],
    exceptions: [
      { id: "override", event_id: "event-1", original_starts_at: original, title: "Updated occurrence", status: "scheduled" },
      { id: "cancelled-series", event_id: "cancelled", original_starts_at: original, status: "skipped" },
      { id: "non-recurring", event_id: "one-time", original_starts_at: original, status: "skipped" },
      { id: "truncated", event_id: "event-1", original_starts_at: "2026-12-08T10:00:00.000Z", status: "skipped" },
    ],
  });
  const result = await sync(userId);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { events: 3, occurrences: 1, deleted: 2 });
  const writes = calls.filter((call) => ["event", "reconcile", "occurrence", "delete"].includes(call.action));
  assert.deepEqual(writes.map((call) => call.action), ["event", "event", "event", "reconcile", "occurrence", "delete"]);
  const occurrence = calls.find((call) => call.action === "occurrence");
  assert.equal(occurrence.originalStartsAt, original);
  assert.equal(occurrence.change.startsAt, null);
  assert.equal(occurrence.change.endsAt, null);
  assert.equal(occurrence.change.title, "Updated occurrence");
  const cleanup = calls.find((call) => call.action === "delete");
  assert.deepEqual(Array.from(cleanup.ids), ["event-1", "cancelled", "one-time"]);
  assert.deepEqual(Array.from(cleanup.candidates), ["removed"]);
});

test("bulk retry does not report success or remove events when authorization is lost", async () => {
  const { sync, calls } = bulkSync({ syncResult: "not-connected" });
  await assert.rejects(sync(userId), /not connected/i);
  assert.equal(calls.some((call) => call.action === "delete"), false);
});

test("bulk retry validates all saved records before making any Google changes", async () => {
  const { sync, calls } = bulkSync({ rows: [eventRow(), eventRow("invalid", { ends_at: "invalid" })] });
  await assert.rejects(sync(userId), /Invalid timestamp/);
  assert.equal(calls.some((call) => call.action === "event" || call.action === "delete"), false);
});

test("local retry includes saved dates outside the current calendar view", async () => {
  const window = browser();
  window.localStorage.setItem("daylight-lessons-2026-11-03", JSON.stringify([{ id: "today", title: "Today", time: "10:00", end: "11:00" }]));
  window.localStorage.setItem("daylight-lessons-2027-01-04", JSON.stringify([{ id: "future", title: "Future", time: "16:00", end: "17:00" }]));
  const { sync, calls } = bulkSync({ cloud: false, window });
  await sync("local");
  const synced = calls.filter((call) => call.action === "event").map((call) => call.value);
  assert.deepEqual(synced.map((value) => value.id), ["today", "future"]);
  assert.equal(synced[0].timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  assert.ok(synced.every((value) => value.userId === "local"));
});

test("malformed local schedule prevents partial replay and deletion cleanup", async () => {
  const window = browser();
  window.localStorage.setItem("daylight-lessons-2026-11-03", JSON.stringify([{ id: "valid", title: "Valid", time: "10:00", end: "11:00" }]));
  window.localStorage.setItem("daylight-lessons-2026-11-04", "invalid json");
  const { sync, calls } = bulkSync({ cloud: false, window });
  await assert.rejects(sync("local"), /2026-11-04 could not be loaded/);
  assert.deepEqual(calls.map((call) => call.action), ["candidates", "remoteCandidates"]);
});

test("bulk cleanup preserves a Google event linked after the saved-schedule snapshot started", async () => {
  const window = browser();
  const server = calendarServer();
  const client = loadClient(window, server.fetch);
  await client.syncGoogleCalendarEvent(event("existing"));
  await client.syncGoogleCalendarEvent(event("removed"));
  const database = {
    listEvents: async () => {
      // A different tab adds a schedule event while this sync is loading an older snapshot.
      await client.syncGoogleCalendarEvent(event("just-created"));
      return { data: [eventRow("existing", { recurrence_weekdays: [] })], error: null };
    },
    listExceptions: async () => ({ data: [], error: null }),
  };
  const schema = evaluate("src/lib/data/schema.ts");
  const syncModule = evaluate("src/lib/google-calendar/sync.ts", { window }, {
    ...scheduleModules(),
    "@/lib/data/client": { cloudConfigured: true, database },
    "@/lib/data/schema": schema,
    "./client": client,
  });
  const result = await syncModule.syncSavedScheduleToGoogleCalendar(userId);
  assert.equal(result.deleted, 1);
  assert.equal(server.events.size, 2);
  const remainingIds = [...server.events.values()].map((value) => value.extendedProperties.private.daylightEventId).sort();
  assert.deepEqual(remainingIds, ["existing", "just-created"]);
});
