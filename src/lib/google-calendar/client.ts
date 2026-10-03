import type { EventKind, EventStatus, EventTone, ScheduleEvent } from "@/lib/schedule/types";

const googleCalendarScope = "https://www.googleapis.com/auth/calendar.events";
const googleCalendarScript = "https://accounts.google.com/gsi/client";
const connectionStorageKey = "daylight-google-calendar-connection";
const tokenStorageKey = "daylight-google-calendar-token";
const eventLinksStoragePrefix = "daylight-google-calendar-event-links";

type StoredToken = {
  accessToken: string;
  expiresAt: number;
};

type GoogleCalendarEvent = {
  id?: string;
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  recurrence?: string[];
  extendedProperties: { private: { daylightEventId: string } };
};

type GoogleCalendarEventResponse = GoogleCalendarEvent & {
  originalStartTime?: { dateTime?: string };
};

type GoogleCalendarListResponse = {
  items?: GoogleCalendarEventResponse[];
};

let scriptPromise: Promise<void> | null = null;
let currentToken: StoredToken | null = null;

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
}

function clearConnection() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(connectionStorageKey) ?? "null") as { userId?: string } | null;
    if (stored?.userId) window.localStorage.removeItem(linksStorageKey(stored.userId));
  } catch { }
  window.localStorage.removeItem(connectionStorageKey);
  window.sessionStorage.removeItem(tokenStorageKey);
  currentToken = null;
}

function loadStoredToken() {
  if (currentToken && currentToken.expiresAt > Date.now() + 60_000) return currentToken;
  try {
    const stored = JSON.parse(window.sessionStorage.getItem(tokenStorageKey) ?? "null") as StoredToken | null;
    if (stored && stored.expiresAt > Date.now() + 60_000) {
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
  await scriptPromise;
}

export function prepareGoogleCalendar() {
  if (!googleClientId()) return Promise.resolve();
  return loadGoogleIdentityServices();
}

async function requestAccessToken(prompt = "") {
  const stored = loadStoredToken();
  if (stored) return stored.accessToken;
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
        const token = { accessToken: response.access_token, expiresAt: Date.now() + Number(response.expires_in ?? 3600) * 1000 } satisfies StoredToken;
        currentToken = token;
        window.sessionStorage.setItem(tokenStorageKey, JSON.stringify(token));
        resolve(token.accessToken);
      },
      error_callback: (error) => reject(new Error(error.message ?? "Google Calendar authorization was not completed.")),
    });
    if (!tokenClient) {
      reject(new Error("Google sign-in could not be initialized."));
      return;
    }
    tokenClient.requestAccessToken({ prompt });
  });
}

async function googleFetch<T>(path: string, init: RequestInit = {}) {
  const accessToken = await requestAccessToken();
  const response = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  if (response.status === 401) {
    clearConnection();
    throw new Error("Google Calendar authorization expired. Connect it again in Settings.");
  }
  if (!response.ok) {
    let message = "Google Calendar could not be updated.";
    try {
      const body = await response.json() as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch { }
    throw new Error(message);
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
    : undefined;
  return {
    summary: event.title,
    description: event.detail,
    start: { dateTime: event.startsAt, timeZone: timezone },
    end: { dateTime: event.endsAt, timeZone: timezone },
    ...(recurrence ? { recurrence } : {}),
    extendedProperties: { private: { daylightEventId: event.id } },
  };
}

async function findGoogleEventId(event: ScheduleEvent) {
  const links = readEventLinks(event.userId);
  if (links[event.id]) {
    try {
      await googleFetch<GoogleCalendarEventResponse>(`/calendars/primary/events/${encodeURIComponent(links[event.id])}`);
      return links[event.id];
    } catch {
      removeEventLink(event.userId, event.id);
    }
  }
  const params = new URLSearchParams({ privateExtendedProperty: `daylightEventId=${event.id}`, showDeleted: "false", maxResults: "1" });
  const result = await googleFetch<GoogleCalendarListResponse>(`/calendars/primary/events?${params.toString()}`);
  const id = result.items?.[0]?.id;
  if (id) writeEventLink(event.userId, event.id, id);
  return id ?? null;
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
  return connectionForUser(userId);
}

export async function connectGoogleCalendar(userId: string) {
  if (!googleClientId()) throw new Error("Add NEXT_PUBLIC_GOOGLE_CLIENT_ID to enable Google Calendar sync.");
  await requestAccessToken("consent");
  await googleFetch("/calendars/primary");
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
  if (!googleCalendarIsConnected(event.userId)) return "not-connected";
  const existingId = await findGoogleEventId(event);
  if (event.status === "cancelled" || event.status === "skipped") {
    if (existingId) {
      await googleFetch(`/calendars/primary/events/${encodeURIComponent(existingId)}`, { method: "DELETE" });
      removeEventLink(event.userId, event.id);
    }
    return "synced";
  }
  const resource = googleEventFromScheduleEvent(event);
  if (existingId) {
    await googleFetch(`/calendars/primary/events/${encodeURIComponent(existingId)}`, { method: "PATCH", body: JSON.stringify(resource) });
  } else {
    const created = await googleFetch<GoogleCalendarEventResponse>("/calendars/primary/events", { method: "POST", body: JSON.stringify(resource) });
    if (created.id) writeEventLink(event.userId, event.id, created.id);
  }
  return "synced";
}

export async function deleteGoogleCalendarEvent(event: ScheduleEvent) {
  if (!googleCalendarIsConnected(event.userId)) return "not-connected" as GoogleCalendarSyncResult;
  const existingId = await findGoogleEventId(event);
  if (existingId) {
    await googleFetch(`/calendars/primary/events/${encodeURIComponent(existingId)}`, { method: "DELETE" });
    removeEventLink(event.userId, event.id);
  }
  return "synced" as GoogleCalendarSyncResult;
}

export async function syncGoogleCalendarOccurrence(event: ScheduleEvent, originalStartsAt: string, change: GoogleCalendarOccurrenceChange): Promise<GoogleCalendarSyncResult> {
  if (!googleCalendarIsConnected(event.userId)) return "not-connected";
  const recurringEventId = await findGoogleEventId(event);
  if (!recurringEventId) return "synced";
  const timeMin = new Date(new Date(originalStartsAt).getTime() - 86400000).toISOString();
  const timeMax = new Date(new Date(originalStartsAt).getTime() + 86400000).toISOString();
  const params = new URLSearchParams({ timeMin, timeMax, showDeleted: "false", maxResults: "50" });
  const instances = await googleFetch<GoogleCalendarListResponse>(`/calendars/primary/events/${encodeURIComponent(recurringEventId)}/instances?${params.toString()}`);
  const originalTime = new Date(originalStartsAt).getTime();
  const instance = instances.items?.find((item) => item.id && item.originalStartTime?.dateTime && Math.abs(new Date(item.originalStartTime.dateTime).getTime() - originalTime) < 60_000);
  if (!instance?.id) return "synced";
  if (change.status === "cancelled" || change.status === "skipped") {
    await googleFetch(`/calendars/primary/events/${encodeURIComponent(instance.id)}`, { method: "DELETE" });
    return "synced";
  }
  if (!change.startsAt || !change.endsAt) return "synced";
  await googleFetch(`/calendars/primary/events/${encodeURIComponent(instance.id)}`, {
    method: "PATCH",
    body: JSON.stringify({
      summary: change.title ?? event.title,
      description: change.detail ?? event.detail,
      start: { dateTime: change.startsAt, timeZone: event.timezone },
      end: { dateTime: change.endsAt, timeZone: event.timezone },
      extendedProperties: { private: { daylightEventId: event.id } },
    }),
  });
  return "synced";
}
