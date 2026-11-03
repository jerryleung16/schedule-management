import type { EventKind, EventStatus, EventTone, ScheduleEvent } from "@/lib/schedule/types";

const googleCalendarScope = "https://www.googleapis.com/auth/calendar.events";
const googleCalendarScript = "https://accounts.google.com/gsi/client";
const connectionStorageKey = "daylight-google-calendar-connection";
const tokenStorageKey = "daylight-google-calendar-token";
const eventLinksStoragePrefix = "daylight-google-calendar-event-links";
const pendingDeletionsStoragePrefix = "daylight-google-calendar-pending-deletions";
export const googleCalendarConnectionChangedEvent = "daylight-google-calendar-connection-changed";

type StoredToken = {
  userId: string;
  accessToken: string;
  expiresAt: number;
};

type GoogleCalendarEvent = {
  id?: string;
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  recurrence: string[] | null;
  extendedProperties: { private: { daylightEventId: string } };
};

type GoogleCalendarEventResponse = GoogleCalendarEvent & {
  originalStartTime?: { dateTime?: string };
  recurringEventId?: string;
  status?: string;
};

type GoogleCalendarListResponse = {
  items?: GoogleCalendarEventResponse[];
  nextPageToken?: string;
};

let scriptPromise: Promise<void> | null = null;
let currentToken: StoredToken | null = null;

class GoogleCalendarError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function eventIsMissing(error: unknown) {
  return error instanceof GoogleCalendarError && (error.status === 404 || error.status === 410);
}

function googleClientId() {
  return process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
}

function connectionForUser(userId: string) {
  try {
    const stored = JSON.parse(window.localStorage.getItem(connectionStorageKey) ?? "null") as { userId?: string } | null;
    return stored?.userId === userId;
  } catch {
    return false;
  }
}

function setConnection(userId: string) {
  window.localStorage.setItem(connectionStorageKey, JSON.stringify({ userId }));
  notifyConnectionChanged();
}

function notifyConnectionChanged() {
  window.dispatchEvent(new Event(googleCalendarConnectionChangedEvent));
}

function clearConnection() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(connectionStorageKey) ?? "null") as { userId?: string } | null;
    if (stored?.userId) window.localStorage.removeItem(linksStorageKey(stored.userId));
  } catch { }
  window.localStorage.removeItem(connectionStorageKey);
  window.sessionStorage.removeItem(tokenStorageKey);
  currentToken = null;
  notifyConnectionChanged();
}

function connectedUserId(): string | undefined {
  try {
    return (JSON.parse(window.localStorage.getItem(connectionStorageKey) ?? "null") as { userId?: string } | null)?.userId;
  } catch { return undefined; }
}

function loadStoredToken(userId = connectedUserId()) {
  if (!userId) return null;
  if (currentToken?.userId === userId && currentToken.expiresAt > Date.now() + 60_000) return currentToken;
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(tokenStorageKey) ?? "null") as StoredToken | null;
    if (stored?.userId === userId && stored.expiresAt > Date.now() + 60_000) {
      currentToken = stored;
      return stored;
    }
  } catch {
    window.sessionStorage.removeItem(tokenStorageKey);
  }
  currentToken = null;
  return null;
}

async function loadGoogleIdentityServices() {
  if (typeof window === "undefined") throw new Error("Google Calendar is only available in a browser.");
  if (window.google?.accounts?.oauth2) return;
  if (!scriptPromise) {
    scriptPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector(`script[src="${googleCalendarScript}"]`);
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Google sign-in could not load.")), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = googleCalendarScript;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Google sign-in could not load."));
      document.head.appendChild(script);
    });
  }
  try {
    await scriptPromise;
  } catch (error) {
    document.querySelector(`script[src="${googleCalendarScript}"]`)?.remove();
    scriptPromise = null;
    throw error;
  }
}

export function prepareGoogleCalendar() {
  if (!googleClientId()) return Promise.resolve();
  return loadGoogleIdentityServices();
}

async function requestAccessToken(allowPopup = false, userId = connectedUserId()) {
  const stored = loadStoredToken(userId);
  if (stored) return stored.accessToken;
  if (!allowPopup) throw new Error("Google Calendar authorization expired. Reconnect from My calendar to sync your saved events.");
  if (!userId) throw new Error("Sign in before connecting Google Calendar.");
  if (!googleClientId()) throw new Error("Add NEXT_PUBLIC_GOOGLE_CLIENT_ID to enable Google Calendar sync.");
  if (!window.google?.accounts?.oauth2) await loadGoogleIdentityServices();
  return new Promise<string>((resolve, reject) => {
    const tokenClient = window.google?.accounts.oauth2.initTokenClient({
      client_id: googleClientId(),
      scope: googleCalendarScope,
      callback: (response) => {
        if (!response.access_token) {
          reject(new Error(response.error_description ?? "Google Calendar authorization was not completed."));
          return;
        }
        const token = { userId, accessToken: response.access_token, expiresAt: Date.now() + Number(response.expires_in ?? 3600) * 1000 } satisfies StoredToken;
        currentToken = token;
        window.sessionStorage.setItem(tokenStorageKey, JSON.stringify(token));
        notifyConnectionChanged();
        resolve(token.accessToken);
      },
      error_callback: (error) => reject(new Error(error.message ?? "Google Calendar authorization was not completed.")),
    });
    if (!tokenClient) {
      reject(new Error("Google sign-in could not be initialized."));
      return;
    }
    tokenClient.requestAccessToken({ prompt: "" });
  });
}

async function googleFetch<T>(path: string, init: RequestInit = {}, userId = connectedUserId()) {
  const accessToken = await requestAccessToken(false, userId);
  const response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (response.status === 401) {
    window.sessionStorage.removeItem(tokenStorageKey);
    currentToken = null;
    notifyConnectionChanged();
    throw new GoogleCalendarError("Google Calendar authorization expired. Reconnect from My calendar, then sync again.", 401);
  }
  if (!response.ok) {
    let message = "Google Calendar could not be updated.";
    try {
      const body = await response.json() as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch { }
    throw new GoogleCalendarError(message, response.status);
  }
  if (response.status === 204) return null as T;
  return await response.json() as T;
}

function linksStorageKey(userId: string) {
  return `${eventLinksStoragePrefix}-${userId}`;
}

function readEventLinks(userId: string) {
  try {
    return JSON.parse(window.localStorage.getItem(linksStorageKey(userId)) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

function writeEventLink(userId: string, eventId: string, googleEventId: string) {
  const links = readEventLinks(userId);
  links[eventId] = googleEventId;
  window.localStorage.setItem(linksStorageKey(userId), JSON.stringify(links));
}

function removeEventLink(userId: string, eventId: string) {
  const links = readEventLinks(userId);
  delete links[eventId];
  window.localStorage.setItem(linksStorageKey(userId), JSON.stringify(links));
}

function pendingDeletionsStorageKey(userId: string) {
  return `${pendingDeletionsStoragePrefix}-${userId}`;
}

function readPendingDeletions(userId: string): string[] {
  return JSON.parse(window.localStorage.getItem(pendingDeletionsStorageKey(userId)) ?? "[]") as string[];
}

function setPendingDeletion(userId: string, eventId: string, pending: boolean) {
  const ids = new Set(readPendingDeletions(userId));
  if (pending) ids.add(eventId);
  else ids.delete(eventId);
  window.localStorage.setItem(pendingDeletionsStorageKey(userId), JSON.stringify([...ids]));
}

function weekdayCode(weekday: number) {
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][weekday] ?? "MO";
}

function recurrenceUntil(value: string) {
  const localEnd = new Date(`${value}T23:59:59`);
  if (Number.isNaN(localEnd.getTime())) return "";
  const utc = localEnd.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `;UNTIL=${utc}`;
}

function googleEventFromScheduleEvent(event: ScheduleEvent): GoogleCalendarEvent {
  const timezone = event.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const recurrence = event.recurrenceWeekdays.length > 0
    ? [`RRULE:FREQ=WEEKLY;BYDAY=${event.recurrenceWeekdays.map(weekdayCode).join(",")}${event.recurrenceUntil ? recurrenceUntil(event.recurrenceUntil) : ""}`]
    : null;
  return {
    summary: event.title,
    description: event.detail,
    start: { dateTime: event.startsAt, timeZone: timezone },
    end: { dateTime: event.endsAt, timeZone: timezone },
    recurrence,
    extendedProperties: { private: { daylightEventId: event.id } },
  };
}

async function findGoogleEventId(event: Pick<ScheduleEvent, "id" | "userId">) {
  const links = readEventLinks(event.userId);
  if (links[event.id]) {
    try {
      const existing = await googleFetch<GoogleCalendarEventResponse>(`/calendars/primary/events/${encodeURIComponent(links[event.id])}`, {}, event.userId);
      if (existing.status !== "cancelled" && !existing.recurringEventId && !existing.originalStartTime) return links[event.id];
      removeEventLink(event.userId, event.id);
    } catch (error) {
      if (!eventIsMissing(error)) throw error;
      removeEventLink(event.userId, event.id);
    }
  }
  const params = new URLSearchParams({ privateExtendedProperty: `daylightEventId=${event.id}`, showDeleted: "false", singleEvents: "false", maxResults: "250" });
  while (true) {
    const result = await googleFetch<GoogleCalendarListResponse>(`/calendars/primary/events?${params.toString()}`, {}, event.userId);
    const id = result.items?.find((item) => item.id && item.status !== "cancelled" && !item.recurringEventId && !item.originalStartTime)?.id;
    if (id) {
      writeEventLink(event.userId, event.id, id);
      return id;
    }
    if (!result.nextPageToken) return null;
    params.set("pageToken", result.nextPageToken);
  }
}

export type GoogleCalendarSyncResult = "synced" | "not-connected";

export type GoogleCalendarOccurrenceChange = {
  startsAt: string | null;
  endsAt: string | null;
  title: string | null;
  detail: string | null;
  kind: EventKind | null;
  tone: EventTone | null;
  travelMinutes: number | null;
  hourlyRate: number | null;
  fixedFee: number | null;
  status: EventStatus;
};

export function googleCalendarConfigured() {
  return Boolean(googleClientId());
}

export function googleCalendarIsConnected(userId: string) {
  return connectionForUser(userId) && Boolean(loadStoredToken(userId));
}

export function googleCalendarNeedsReconnect(userId: string) {
  return connectionForUser(userId) && !loadStoredToken(userId);
}

export function googleCalendarTokenExpiresAt(userId: string): number | null {
  return connectionForUser(userId) ? loadStoredToken(userId)?.expiresAt ?? null : null;
}

export async function checkGoogleCalendarConnection(userId: string): Promise<"connected" | "not-connected" | "reconnect-required"> {
  if (!connectionForUser(userId)) return "not-connected";
  if (!loadStoredToken(userId)) return "reconnect-required";
  try {
    await googleFetch("/calendars/primary/events?maxResults=1&showDeleted=false", {}, userId);
    return googleCalendarIsConnected(userId) ? "connected" : connectionForUser(userId) ? "reconnect-required" : "not-connected";
  } catch (error) {
    if (error instanceof GoogleCalendarError && error.status === 401) return "reconnect-required";
    if (error instanceof GoogleCalendarError && error.status === 403) {
      window.sessionStorage.removeItem(tokenStorageKey);
      currentToken = null;
      notifyConnectionChanged();
      return "reconnect-required";
    }
    throw error;
  }
}

export async function connectGoogleCalendar(userId: string) {
  if (!googleClientId()) throw new Error("Add NEXT_PUBLIC_GOOGLE_CLIENT_ID to enable Google Calendar sync.");
  await requestAccessToken(true, userId);
  await googleFetch("/calendars/primary/events?maxResults=1&showDeleted=false", {}, userId);
  setConnection(userId);
}

export async function disconnectGoogleCalendar() {
  const token = loadStoredToken();
  if (token) {
    try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token.accessToken)}`, { method: "POST" }); } catch { }
  }
  clearConnection();
}

export async function syncGoogleCalendarEvent(event: ScheduleEvent): Promise<GoogleCalendarSyncResult> {
  if (!connectionForUser(event.userId)) return "not-connected";
  if (event.status === "cancelled" || event.status === "skipped") {
    return deleteGoogleCalendarEvent(event);
  }
  const existingId = await findGoogleEventId(event);
  const resource = googleEventFromScheduleEvent(event);
  if (existingId) {
    await googleFetch(`/calendars/primary/events/${encodeURIComponent(existingId)}`, { method: "PATCH", body: JSON.stringify(resource) }, event.userId);
  } else {
    const created = await googleFetch<GoogleCalendarEventResponse>("/calendars/primary/events", { method: "POST", body: JSON.stringify(resource) }, event.userId);
    if (created.id) writeEventLink(event.userId, event.id, created.id);
  }
  return "synced";
}

export async function deleteGoogleCalendarEvent(event: Pick<ScheduleEvent, "id" | "userId">) {
  if (!connectionForUser(event.userId)) return "not-connected" as GoogleCalendarSyncResult;
  setPendingDeletion(event.userId, event.id, true);
  const existingId = await findGoogleEventId(event);
  if (existingId) {
    try {
      await googleFetch(`/calendars/primary/events/${encodeURIComponent(existingId)}`, { method: "DELETE" }, event.userId);
    } catch (error) {
      if (!eventIsMissing(error)) throw error;
    }
    removeEventLink(event.userId, event.id);
  }
  setPendingDeletion(event.userId, event.id, false);
  return "synced" as GoogleCalendarSyncResult;
}

export function googleCalendarDeletionCandidates(userId: string): string[] {
  return [...new Set([...readPendingDeletions(userId), ...Object.keys(readEventLinks(userId))])];
}

// Capture candidates before loading the saved schedule, so new links are never treated as deletions.
export async function retryGoogleCalendarDeletions(userId: string, activeEventIds: string[], candidates = googleCalendarDeletionCandidates(userId)): Promise<number> {
  if (!googleCalendarIsConnected(userId)) throw new Error("Reconnect Google Calendar from My calendar, then sync again.");
  const activeIds = new Set(activeEventIds);
  let deleted = 0;
  for (const id of new Set(candidates)) {
    // Preserve a deletion queued after the snapshot while a saved event was being replayed.
    if (activeIds.has(id)) continue;
    const result = await deleteGoogleCalendarEvent({ id, userId });
    if (result !== "synced") throw new Error("Reconnect Google Calendar from My calendar, then sync again.");
    deleted += 1;
  }
  return deleted;
}

export async function syncGoogleCalendarOccurrence(event: ScheduleEvent, originalStartsAt: string, change: GoogleCalendarOccurrenceChange): Promise<GoogleCalendarSyncResult> {
  if (!connectionForUser(event.userId)) return "not-connected";
  const recurringEventId = await findGoogleEventId(event);
  if (!recurringEventId) throw new Error("The recurring event could not be found in Google Calendar. Try syncing the saved schedule again.");
  const params = new URLSearchParams({ originalStart: new Date(originalStartsAt).toISOString(), showDeleted: "true", maxResults: "50" });
  const instances = await googleFetch<GoogleCalendarListResponse>(`/calendars/primary/events/${encodeURIComponent(recurringEventId)}/instances?${params.toString()}`, {}, event.userId);
  const originalTime = new Date(originalStartsAt).getTime();
  const instance = instances.items?.find((item) => item.id && item.originalStartTime?.dateTime && Math.abs(new Date(item.originalStartTime.dateTime).getTime() - originalTime) < 60_000);
  if (!instance?.id) throw new Error("An occurrence could not be found in Google Calendar. Try syncing the saved schedule again.");
  if (change.status === "cancelled" || change.status === "skipped") {
    if (instance.status !== "cancelled") {
      try {
        await googleFetch(`/calendars/primary/events/${encodeURIComponent(instance.id)}`, { method: "DELETE" }, event.userId);
      } catch (error) {
        if (!eventIsMissing(error)) throw error;
      }
    }
    return "synced";
  }
  const startsAt = change.startsAt ?? originalStartsAt;
  const endsAt = change.endsAt ?? new Date(new Date(startsAt).getTime() + new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime()).toISOString();
  await googleFetch(`/calendars/primary/events/${encodeURIComponent(instance.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      summary: change.title ?? event.title,
      description: change.detail ?? event.detail,
      status: "confirmed",
      start: { dateTime: startsAt, timeZone: event.timezone },
      end: { dateTime: endsAt, timeZone: event.timezone },
      extendedProperties: { private: { daylightEventId: event.id } },
    }),
  }, event.userId);
  return "synced";
}
