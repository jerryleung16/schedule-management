"use client";

import { FormEvent, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Link2, Plus, RotateCw, Sparkles, X } from "lucide-react";
import { useGoogleCalendarConnection } from "@/components/google-calendar-connection";
import { database, cloudConfigured } from "@/lib/data/client";
import { getFirebase } from "@/lib/firebase/client";
import { deleteGoogleCalendarEvent, googleCalendarIsConnected, syncGoogleCalendarEvent, syncGoogleCalendarOccurrence } from "@/lib/google-calendar/client";
import { syncSavedScheduleToGoogleCalendar } from "@/lib/google-calendar/sync";
import { slotConflicts } from "@/lib/schedule/availability";
import { addDays, dateKey, dateFromKey, formatRangeLabel, rangeForView } from "@/lib/schedule/dates";
import { expandEvents } from "@/lib/schedule/recurrence";
import { alignRecurringStart, eventInput, planSeriesEdit } from "@/lib/schedule/mutations";
import { calendarEventLanes } from "@/lib/schedule/calendar-layout";
import { addDateKeyDays, dateKeyInTimeZone, dateTimeInTimeZone, timeInTimeZone } from "@/lib/schedule/timezone";
import { normalizeWeeklyWorkingPlaces, workingPlaceForWeekday, workingPlaceStorageKey, workingPlacesToMap } from "@/lib/schedule/workplaces";
import type { CalendarView, DeleteScope, EditScope, EventKind, EventStatus, EventTone, ScheduleEvent, ScheduleEventException, ScheduleOccurrence, Student, WeeklyWorkingPlace, WorkingPlacesByWeekday } from "@/lib/schedule/types";

type EventForm = {
  title: string;
  detail: string;
  date: string;
  starts: string;
  ends: string;
  kind: EventKind;
  tone: EventTone;
  travelMinutes: number;
  hourlyRate: number;
  studentId: string;
  status: EventStatus;
  recurring: boolean;
  weekdays: number[];
  recurrenceUntil: string;
};

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const eventTones: EventTone[] = ["blue", "coral", "teal", "yellow", "violet"];
const initialDateKey = "2000-01-01";
const subscribeToBrowser = () => () => {};
const subscribeToLocation = (callback: () => void) => {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
};
const getBrowserDateKey = () => dateKey(new Date());
const getBrowserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const getInitialDateKey = () => initialDateKey;
const getInitialTimezone = () => "UTC";
const getBrowserStudentQuery = () => new URLSearchParams(window.location.search).get("student") ?? "";
const getInitialStudentQuery = () => "";
const getBrowserDateQuery = () => {
  const value = new URLSearchParams(window.location.search).get("date") ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : "";
};
const getBrowserEventQuery = () => new URLSearchParams(window.location.search).get("event") ?? "";
const getBrowserOccurrenceQuery = () => new URLSearchParams(window.location.search).get("occurrence") ?? "";
const subscribeToViewport = (callback: () => void) => {
  const viewport = window.matchMedia("(max-width: 680px)");
  viewport.addEventListener("change", callback);
  return () => viewport.removeEventListener("change", callback);
};
const getPhoneViewport = () => window.matchMedia("(max-width: 680px)").matches;
const getInitialPhoneViewport = () => false;
const storageKey = "daylight-lessons";
const scheduleChangedEvent = "daylight-schedule-changed";
const CALENDAR_START_MINUTES = 7 * 60;
const CALENDAR_END_MINUTES = 22 * 60;
const CALENDAR_INTERVAL_MINUTES = 30;
const CALENDAR_DURATION_MINUTES = CALENDAR_END_MINUTES - CALENDAR_START_MINUTES;
const calendarTimeLabels = Array.from(
  { length: (CALENDAR_DURATION_MINUTES / CALENDAR_INTERVAL_MINUTES) + 1 },
  (_, index) => {
    const totalMinutes = CALENDAR_START_MINUTES + index * CALENDAR_INTERVAL_MINUTES;
    return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
  },
);

function notifyScheduleChanged() {
  window.localStorage.setItem("daylight-schedule-version", crypto.randomUUID());
  window.dispatchEvent(new Event(scheduleChangedEvent));
}

function emptyForm(date = initialDateKey): EventForm {
  const weekday = dateFromKey(date).getDay();
  return {
    title: "",
    detail: "",
    date,
    starts: "10:00",
    ends: "11:00",
    kind: "lesson",
    tone: "coral",
    travelMinutes: 0,
    hourlyRate: 35,
    studentId: "",
    status: "scheduled",
    recurring: false,
    weekdays: [weekday],
    recurrenceUntil: "",
  };
}

function eventFromRow(row: Record<string, unknown>, userId: string): ScheduleEvent {
  return {
    id: String(row.id),
    userId,
    startsAt: String(row.starts_at),
    endsAt: String(row.ends_at),
    timezone: String(row.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone),
    title: String(row.title),
    detail: String(row.detail ?? ""),
    kind: row.kind === "personal" ? "personal" : "lesson",
    tone: (row.tone as EventTone) ?? "coral",
    intensity: Number(row.intensity ?? 2),
    prepMinutes: Number(row.prep_minutes ?? 0),
    travelMinutes: Number(row.travel_minutes ?? 0),
    hourlyRate: Number(row.hourly_rate ?? 0),
    fixedFee: row.fixed_fee === null || row.fixed_fee === undefined ? null : Number(row.fixed_fee),
    status: (row.status as EventStatus) ?? "scheduled",
    recurrenceWeekdays: Array.isArray(row.recurrence_weekdays) ? row.recurrence_weekdays.map(Number) : [],
    recurrenceUntil: row.recurrence_until ? String(row.recurrence_until) : null,
    studentId: row.student_id ? String(row.student_id) : null,
  };
}

function normalizedTimestamp(value: unknown) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function formatTime(value: string, timeZone?: string) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone });
}

function localEventFromLesson(lesson: Record<string, unknown>, date: string): ScheduleEvent {
  return {
    id: String(lesson.id), userId: "local", startsAt: new Date(`${date}T${String(lesson.time)}:00`).toISOString(), endsAt: new Date(`${date}T${String(lesson.end)}:00`).toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, title: String(lesson.title ?? "Lesson"), detail: String(lesson.detail ?? ""), kind: lesson.kind === "personal" ? "personal" : "lesson",
    tone: (lesson.tone as EventTone) ?? "coral", intensity: Number(lesson.intensity ?? 2), prepMinutes: Number(lesson.prepMinutes ?? 0), travelMinutes: Number(lesson.travelMinutes ?? 0),
    hourlyRate: Number(lesson.rate ?? 0), fixedFee: lesson.fixedFee == null ? null : Number(lesson.fixedFee), status: (lesson.status as EventStatus) ?? "scheduled", recurrenceWeekdays: [], recurrenceUntil: null,
    studentId: lesson.studentId ? String(lesson.studentId) : null,
  };
}

function occurrenceDay(occurrence: ScheduleOccurrence, timeZone: string) {
  return dateKeyInTimeZone(occurrence.startsAt, timeZone);
}

function eventStyle(occurrence: ScheduleOccurrence, lane: number, laneCount: number, timeZone: string) {
  const [hour, minute] = timeInTimeZone(occurrence.startsAt, timeZone).split(":").map(Number);
  const startMinutes = hour * 60 + minute;
  const endMinutes = startMinutes + (Date.parse(occurrence.endsAt) - Date.parse(occurrence.startsAt)) / 60000;
  const visibleStart = Math.max(CALENDAR_START_MINUTES, startMinutes);
  const visibleEnd = Math.min(CALENDAR_END_MINUTES, endMinutes);
  const top = ((visibleStart - CALENDAR_START_MINUTES) / CALENDAR_DURATION_MINUTES) * 100;
  const height = Math.max(2.5, ((visibleEnd - visibleStart) / CALENDAR_DURATION_MINUTES) * 100);
  return { top: `${top}%`, height: `${height}%`, left: `calc(${(lane / laneCount) * 100}% + 6px)`, width: `calc(${(100 / laneCount)}% - 12px)` };
}

export default function CalendarPage() {
  const router = useRouter();
  const googleCalendar = useGoogleCalendarConnection();
  const isPhone = useSyncExternalStore(subscribeToViewport, getPhoneViewport, getInitialPhoneViewport);
  const [chosenView, setView] = useState<CalendarView | null>(null);
  const view = chosenView ?? (isPhone ? "day" : "week");
  const browserTodayKey = useSyncExternalStore(subscribeToBrowser, getBrowserDateKey, getInitialDateKey);
  const [anchorDate, setAnchorDate] = useState(dateFromKey(initialDateKey));
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [exceptions, setExceptions] = useState<ScheduleEventException[]>([]);
  const [userId, setUserId] = useState("");
  const [profileTimezone, setProfileTimezone] = useState<string | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [studentDirectory, setStudentDirectory] = useState<Student[]>([]);
  const [workingPlaces, setWorkingPlaces] = useState<WorkingPlacesByWeekday>({});
  const [studentFilter, setStudentFilter] = useState("all");
  const [defaultLessonRate, setDefaultLessonRate] = useState(35);
  const [defaultTravelMinutes, setDefaultTravelMinutes] = useState(0);
  const [defaultLessonTone, setDefaultLessonTone] = useState<EventTone>("coral");
  const [defaultPersonalTone, setDefaultPersonalTone] = useState<EventTone>("teal");
  const browserTimezone = useSyncExternalStore(subscribeToBrowser, getBrowserTimezone, getInitialTimezone);
  const timezone = profileTimezone ?? browserTimezone;
  const hydrated = browserTodayKey !== initialDateKey;
  const todayKey = hydrated ? dateKeyInTimeZone(new Date(), timezone) : initialDateKey;
  const requestedDate = useSyncExternalStore(subscribeToLocation, getBrowserDateQuery, getInitialStudentQuery);
  const requestedEvent = useSyncExternalStore(subscribeToLocation, getBrowserEventQuery, getInitialStudentQuery);
  const requestedOccurrence = useSyncExternalStore(subscribeToLocation, getBrowserOccurrenceQuery, getInitialStudentQuery);
  const openedRequestedEvent = useRef("");
  const activeAnchorKey = anchorDate.getTime() === dateFromKey(initialDateKey).getTime() ? requestedDate || todayKey : dateKey(anchorDate);
  const activeAnchorDate = dateFromKey(activeAnchorKey);
  const [loading, setLoading] = useState(true);
  const metadataLoaded = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<EventForm>(emptyForm());
  const [selectedOccurrence, setSelectedOccurrence] = useState<ScheduleOccurrence | null>(null);
  const [editingOccurrence, setEditingOccurrence] = useState<ScheduleOccurrence | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [editScopeOpen, setEditScopeOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteScopeOpen, setDeleteScopeOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);
  const mutationBusy = useRef(false);

  const range = rangeForView(activeAnchorDate, view, timezone);
  const rangeStartMs = range.start.getTime();
  const rangeEndMs = range.end.getTime();
  const occurrences = expandEvents(events, exceptions, range);
  const requestedStudent = useSyncExternalStore(subscribeToLocation, getBrowserStudentQuery, getInitialStudentQuery);
  const effectiveStudentFilter = requestedStudent || studentFilter;
  const visibleOccurrences = occurrences.filter((occurrence) => effectiveStudentFilter === "all"
    || (effectiveStudentFilter === "unlinked" ? !occurrence.studentId : occurrence.studentId === effectiveStudentFilter));
  const firstDayKey = dateKeyInTimeZone(range.start, timezone);
  const dayCount = view === "day" ? 1 : view === "week" ? 7 : (Date.parse(dateKeyInTimeZone(range.end, timezone)) - Date.parse(firstDayKey)) / 86400000;
  const days = Array.from({ length: dayCount }, (_, index) => dateFromKey(addDateKeyDays(firstDayKey, index)));

  const studentName = (studentId: string | null) => studentDirectory.find((student) => student.id === studentId)?.name ?? "No student linked";

  const syncSavedEvent = async (event: ScheduleEvent) => {
    try {
      const result = await syncGoogleCalendarEvent(event);
      if (result === "synced") setNotice((current) => `${current} Google Calendar updated.`);
    } catch (syncError) {
      setError(`The schedule was saved, but Google Calendar sync failed: ${syncError instanceof Error ? syncError.message : "unknown error"}`);
    }
  };

  const syncDeletedEvent = async (event: ScheduleEvent) => {
    try {
      const result = await deleteGoogleCalendarEvent(event);
      if (result === "synced") setNotice((current) => `${current} Google Calendar updated.`);
    } catch (syncError) {
      setError(`The schedule was changed, but Google Calendar sync failed: ${syncError instanceof Error ? syncError.message : "unknown error"}`);
    }
  };

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError("");
        if (!cloudConfigured) {
          const localEvents: ScheduleEvent[] = [];
          for (let day = new Date(rangeStartMs); day < new Date(rangeEndMs); day = addDays(day, 1)) {
            const dayKey = dateKey(day);
            const stored = window.localStorage.getItem(`${storageKey}-${dayKey}`);
            if (!stored) continue;
            try {
              const lessons = JSON.parse(stored) as Array<Record<string, unknown>>;
              localEvents.push(...lessons.map((lesson) => localEventFromLesson(lesson, dayKey)));
            } catch { }
          }
          const storedStudents = window.localStorage.getItem("daylight-students");
          if (storedStudents) {
            try {
              const directory = JSON.parse(storedStudents) as Student[];
              if (!cancelled) {
                const normalizedDirectory = directory.map((student) => ({ ...student, status: student.status === "archived" ? "archived" as const : "active" as const }));
                setStudentDirectory(normalizedDirectory);
                setStudents(normalizedDirectory.filter((student) => student.status === "active"));
              }
            } catch { window.localStorage.removeItem("daylight-students"); }
          }
          const storedWorkingPlaces = window.localStorage.getItem(workingPlaceStorageKey);
          if (storedWorkingPlaces) {
            try {
              const parsed = JSON.parse(storedWorkingPlaces) as Record<string, unknown>;
              const places = Object.entries(parsed).map(([weekday, place]) => ({ weekday: Number(weekday), place: String(place ?? "") }));
              if (!cancelled) setWorkingPlaces(workingPlacesToMap(normalizeWeeklyWorkingPlaces(places)));
            } catch { window.localStorage.removeItem(workingPlaceStorageKey); }
          }
          if (!cancelled) {
            setUserId("local");
            setEvents(localEvents);
            setExceptions([]);
            setLoading(false);
          }
          return;
        }
      const user = getFirebase().auth.currentUser;
      if (!user) {
        router.push("/login");
        return;
      }
      setUserId(user.uid);
      const eventResult = database.listEvents({ start: new Date(rangeStartMs), end: new Date(rangeEndMs) });
      if (!metadataLoaded.current) {
        const [profileResult, studentResult, workingPlaceResult] = await Promise.all([
          database.getProfile(),
          database.listStudents(),
          database.listWorkingPlaces(),
        ]);
        if (cancelled) return;
        const { data: profile, error: profileError } = profileResult;
        if (profileError && !cancelled) setError(profileError.message);
        if (!cancelled && profile) {
          if (profile.timezone) setProfileTimezone(profile.timezone);
          if (profile.default_lesson_rate !== null && profile.default_lesson_rate !== undefined) setDefaultLessonRate(Number(profile.default_lesson_rate));
          if (profile.default_travel_minutes !== null && profile.default_travel_minutes !== undefined) setDefaultTravelMinutes(Number(profile.default_travel_minutes));
          if (profile.default_lesson_tone) setDefaultLessonTone(profile.default_lesson_tone as EventTone);
          if (profile.default_personal_tone) setDefaultPersonalTone(profile.default_personal_tone as EventTone);
        }
        const { data: studentData, error: studentError } = studentResult;
        if (studentError && !cancelled) setError(studentError.message);
        if (!cancelled) {
          const directory = (studentData ?? []).map((row) => ({ id: String(row.id), userId: String(row.user_id), name: String(row.name), email: String(row.email ?? ""), phone: String(row.phone ?? ""), notes: String(row.notes ?? ""), status: row.status === "archived" ? "archived" as const : "active" as const }));
          setStudentDirectory(directory);
          setStudents(directory.filter((student) => student.status === "active"));
        }
        const { data: workingPlaceData, error: workingPlaceError } = workingPlaceResult;
        if (!cancelled) {
          if (workingPlaceError) {
            const storedWorkingPlaces = window.localStorage.getItem(workingPlaceStorageKey);
            if (storedWorkingPlaces) {
              try {
                const parsed = JSON.parse(storedWorkingPlaces) as Record<string, unknown>;
                const places = Object.entries(parsed).map(([weekday, place]) => ({ weekday: Number(weekday), place: String(place ?? "") }));
                setWorkingPlaces(workingPlacesToMap(normalizeWeeklyWorkingPlaces(places)));
              } catch { window.localStorage.removeItem(workingPlaceStorageKey); }
            }
          } else {
            const places = (workingPlaceData ?? []).map((row) => ({ id: String(row.id), weekday: Number(row.weekday), place: String(row.place ?? "") } satisfies WeeklyWorkingPlace));
            setWorkingPlaces(workingPlacesToMap(normalizeWeeklyWorkingPlaces(places)));
          }
        }
        metadataLoaded.current = true;
      }

      const { data, error: eventError } = await eventResult;
      if (cancelled) return;

      const canonicalRows = eventError ? [] : (data ?? []);
      if (!cancelled) {
        if (eventError) {
          setError(eventError.message);
          setEvents([]);
          setExceptions([]);
        } else {
          const canonicalEvents = canonicalRows.map((row) => eventFromRow(row, user.uid));
          setEvents(canonicalEvents);

          if (canonicalRows.length) {
            const { data: exceptionData, error: exceptionError } = await database.listExceptions(canonicalRows.map((row) => row.id));
            if (exceptionError && !cancelled) setError(exceptionError.message);
            if (!cancelled) setExceptions((exceptionData ?? []).map((row) => exceptionFromRow(row)));
          } else {
            setExceptions([]);
          }
        }
      }
      if (!cancelled) setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [activeAnchorKey, hydrated, rangeEndMs, rangeStartMs, router, view]);

  const shiftRange = (amount: number) => {
    setAnchorDate(view === "month"
      ? new Date(activeAnchorDate.getFullYear(), activeAnchorDate.getMonth() + amount, 1, 12)
      : addDays(activeAnchorDate, view === "day" ? amount : amount * 7));
  };

  const openEditor = (date = dateKey(activeAnchorDate)) => {
    if (mutationBusy.current) return;
    setEditingOccurrence(null);
    setForm({ ...emptyForm(date), tone: defaultLessonTone, travelMinutes: defaultTravelMinutes, hourlyRate: defaultLessonRate });
    setNotice("");
    setError("");
    setEditorOpen(true);
  };

  const openOccurrenceEditor = (occurrence: ScheduleOccurrence) => {
    if (mutationBusy.current) return;
    const start = new Date(occurrence.startsAt);
    const end = new Date(occurrence.endsAt);
    const displayStudent = occurrence.kind === "lesson" ? `Student: ${studentName(occurrence.studentId)}\n` : "";
    setEditingOccurrence(occurrence);
    setForm({
      title: occurrence.title,
      detail: occurrence.detail.startsWith(displayStudent) ? occurrence.detail.slice(displayStudent.length) : occurrence.detail,
      date: dateKeyInTimeZone(start, occurrence.timezone),
      starts: timeInTimeZone(start, occurrence.timezone),
      ends: timeInTimeZone(end, occurrence.timezone),
      kind: occurrence.kind,
      tone: occurrence.tone,
      travelMinutes: occurrence.travelMinutes,
      hourlyRate: occurrence.hourlyRate,
      status: occurrence.status,
      recurring: occurrence.isRecurring,
      weekdays: occurrence.recurrenceWeekdays,
      recurrenceUntil: occurrence.recurrenceUntil ?? "",
      studentId: occurrence.studentId ?? "",
    });
    setNotice("");
    setError("");
    setDetailsOpen(false);
    setEditorOpen(true);
  };

  const persistEvent = async (scope: EditScope | null, startsAt: Date, endsAt: Date) => {
    if (mutationBusy.current) return;
    mutationBusy.current = true;
    setSaving(true);
    try {
    const baseEvent = editingOccurrence ? events.find(event => event.id === editingOccurrence.id) : null;
    if (editingOccurrence && !baseEvent) throw new Error("The event is no longer loaded. Refresh your calendar and try again.");
    const payload = {
      user_id: userId,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      timezone: baseEvent?.timezone ?? timezone,
      title: form.title.trim(),
      detail: form.detail.trim(),
      kind: form.kind,
      tone: form.tone,
      travel_minutes: form.travelMinutes,
      hourly_rate: form.hourlyRate,
      intensity: baseEvent?.intensity ?? 2,
      prep_minutes: baseEvent?.prepMinutes ?? 0,
      fixed_fee: editingOccurrence?.fixedFee ?? baseEvent?.fixedFee ?? null,
      status: form.status,
      recurrence_weekdays: form.recurring ? form.weekdays : [],
      recurrence_until: form.recurring && form.recurrenceUntil ? form.recurrenceUntil : null,
      student_id: form.studentId || null,
    };

    if (!cloudConfigured) {
      if (form.recurring) {
        setError("Recurring events are available after connecting Firebase.");
        return;
      }
      const id = editingOccurrence?.id ?? crypto.randomUUID();
      const localLesson = { id, title: payload.title, detail: payload.detail, time: form.starts, end: form.ends, kind: form.kind, tone: form.tone, intensity: payload.intensity, prepMinutes: payload.prep_minutes, travelMinutes: form.travelMinutes, rate: form.hourlyRate, fixedFee: payload.fixed_fee, status: form.status, studentId: payload.student_id };
      const oldDate = editingOccurrence ? dateKey(new Date(editingOccurrence.startsAt)) : null;
      if (oldDate) {
        const oldStored = window.localStorage.getItem(`${storageKey}-${oldDate}`);
        if (oldStored) {
          try { window.localStorage.setItem(`${storageKey}-${oldDate}`, JSON.stringify((JSON.parse(oldStored) as Array<Record<string, unknown>>).filter((lesson) => String(lesson.id) !== id))); } catch { }
        }
      }
      const targetKey = dateKey(startsAt);
      const targetStored = window.localStorage.getItem(`${storageKey}-${targetKey}`);
      let targetLessons: Array<Record<string, unknown>> = [];
      if (targetStored) {
        try { targetLessons = JSON.parse(targetStored) as Array<Record<string, unknown>>; } catch { }
      }
      window.localStorage.setItem(`${storageKey}-${targetKey}`, JSON.stringify([...targetLessons.filter((lesson) => String(lesson.id) !== id), localLesson]));
      const savedLocalEvent = localEventFromLesson(localLesson, targetKey);
      setEvents((current) => [...current.filter((item) => item.id !== id), savedLocalEvent]);
      setNotice(editingOccurrence ? "Event updated." : "Event added to your calendar.");
      setEditorOpen(false);
      setEditScopeOpen(false);
      setEditingOccurrence(null);
      setAnchorDate(dateFromKey(form.date));
      notifyScheduleChanged();
      await syncSavedEvent(savedLocalEvent);
      return;
    }
    let savedEventForGoogle: ScheduleEvent | null = null;

    if (editingOccurrence && scope === "occurrence") {
      const { data, error: exceptionError } = await database.saveException({
        event_id: editingOccurrence.id,
        original_starts_at: editingOccurrence.originalStartsAt,
        starts_at: payload.starts_at,
        ends_at: payload.ends_at,
        title: payload.title,
        detail: payload.detail,
        kind: payload.kind,
        tone: payload.tone,
        travel_minutes: payload.travel_minutes,
        hourly_rate: payload.hourly_rate,
        fixed_fee: payload.fixed_fee,
          status: payload.status,
      });
      if (exceptionError) {
        throw new Error(exceptionError.message || "The occurrence could not be saved.");
      }
      setExceptions((current) => [...current.filter((item) => !(item.eventId === editingOccurrence.id && item.originalStartsAt === editingOccurrence.originalStartsAt)), exceptionFromRow(data)]);
      notifyScheduleChanged();
      setNotice("This occurrence was updated.");
      if (baseEvent) {
        try {
          const syncResult = await syncGoogleCalendarOccurrence(baseEvent, editingOccurrence.originalStartsAt, {
            startsAt: payload.starts_at,
            endsAt: payload.ends_at,
            title: payload.title,
            detail: payload.detail,
            kind: payload.kind,
            tone: payload.tone,
            travelMinutes: payload.travel_minutes,
            hourlyRate: payload.hourly_rate,
            fixedFee: payload.fixed_fee,
            status: payload.status,
          });
          if (syncResult === "synced") setNotice("This occurrence was updated. Google Calendar updated.");
        } catch (syncError) {
          setError(`The occurrence was updated, but Google Calendar sync failed: ${syncError instanceof Error ? syncError.message : "unknown error"}`);
        }
      }
    } else if (editingOccurrence) {
      const previous = exceptions.filter(exception => exception.eventId === editingOccurrence.id);
      const proposed = eventFromRow({ ...payload, id: editingOccurrence.id }, userId);
      const plan = editingOccurrence.isRecurring && baseEvent
        ? planSeriesEdit(baseEvent, editingOccurrence, proposed, previous)
        : { event: alignRecurringStart(proposed), exceptions: [] };
      const result = await database.updateEventSeries(baseEvent!, eventInput(plan.event), previous, plan.exceptions);
      if (result.error) throw result.error;
      const updatedEvent = eventFromRow(result.data.event, userId);
      setEvents((current) => current.map((item) => item.id === editingOccurrence.id ? updatedEvent : item));
      setExceptions(current => [...current.filter(exception => exception.eventId !== editingOccurrence.id), ...result.data.exceptions.map(exceptionFromRow)]);
      savedEventForGoogle = updatedEvent;
      setNotice(editingOccurrence.isRecurring ? "The recurring series was updated." : "Event updated.");
    } else {
      const aligned = alignRecurringStart(eventFromRow({ ...payload, id: crypto.randomUUID() }, userId));
      const { data: insertedRow, error: saveError } = await database.saveEvent(eventInput(aligned));
      if (saveError) {
        setError(saveError.message);
        return;
      }
      savedEventForGoogle = eventFromRow(insertedRow, userId);
      setEvents((current) => [...current, savedEventForGoogle as ScheduleEvent]);
      setNotice(form.recurring ? "Weekly event added to your calendar." : "Event added to your calendar.");
    }
    setEditorOpen(false);
    setEditScopeOpen(false);
    setEditingOccurrence(null);
    setAnchorDate(dateFromKey(form.date));
    notifyScheduleChanged();
    if (savedEventForGoogle) {
      if (editingOccurrence?.isRecurring && googleCalendarIsConnected(userId)) {
        try { await syncSavedScheduleToGoogleCalendar(userId); setNotice(current => `${current} Google Calendar updated.`); }
        catch (failure) { setError(`Your schedule was saved, but Google Calendar sync failed: ${failure instanceof Error ? failure.message : "Try Sync to Google Calendar again."}`); }
      } else await syncSavedEvent(savedEventForGoogle);
    }
    } catch (failure) {
      setEditScopeOpen(false);
      setError(failure instanceof Error ? failure.message : "The event could not be saved. Try again.");
    } finally {
      mutationBusy.current = false;
      setSaving(false);
    }
  };

  const saveEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (!form.title.trim()) {
      setError("Give the event a name first.");
      return;
    }
    if (form.recurring && !form.weekdays.length) {
      setError("Choose at least one repeat day.");
      return;
    }
    let startsAt: Date;
    let endsAt: Date;
    try {
      const zone = editingOccurrence?.timezone ?? timezone;
      startsAt = dateTimeInTimeZone(form.date, form.starts, zone);
      endsAt = dateTimeInTimeZone(form.date, form.ends, zone);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Choose a valid date and time."); return; }
    if (endsAt <= startsAt) {
      setError("End time must be after the start time.");
      return;
    }
    const busyOccurrences = editingOccurrence
      ? occurrences.filter((item) => editingOccurrence.isRecurring ? item.id !== editingOccurrence.id : item.occurrenceKey !== editingOccurrence.occurrenceKey)
      : occurrences;
    if (slotConflicts(startsAt, endsAt, busyOccurrences)) {
      setError("That time overlaps an existing event.");
      return;
    }
    if (editingOccurrence?.isRecurring) {
      setEditScopeOpen(true);
      return;
    }
    await persistEvent(editingOccurrence ? "all" : null, startsAt, endsAt);
  };

  const saveEditedScope = async (scope: EditScope) => {
    if (scope === "occurrence" && editingOccurrence && form.studentId !== (editingOccurrence.studentId ?? "")) {
      setEditScopeOpen(false);
      setError("To change the linked student, apply the edit to the entire series.");
      return;
    }
    let startsAt: Date;
    let endsAt: Date;
    try {
      const zone = editingOccurrence?.timezone ?? timezone;
      startsAt = dateTimeInTimeZone(form.date, form.starts, zone);
      endsAt = dateTimeInTimeZone(form.date, form.ends, zone);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Choose a valid date and time."); return; }
    const busyOccurrences = editingOccurrence
      ? occurrences.filter((item) => scope === "occurrence" ? item.occurrenceKey !== editingOccurrence.occurrenceKey : item.id !== editingOccurrence.id)
      : occurrences;
    if (slotConflicts(startsAt, endsAt, busyOccurrences)) {
      setEditScopeOpen(false);
      setError("That time overlaps an existing event.");
      return;
    }
    await persistEvent(scope, startsAt, endsAt);
  };

  const occurrencesForDay = (day: Date) => visibleOccurrences.filter((item) => occurrenceDay(item, timezone) === dateKey(day)).sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt));
  const timelineEventsForDay = (day: Date) => occurrencesForDay(day).filter(item => {
    const [hour, minute] = timeInTimeZone(item.startsAt, timezone).split(":").map(Number);
    const start = hour * 60 + minute;
    return start < CALENDAR_END_MINUTES && start + (Date.parse(item.endsAt) - Date.parse(item.startsAt)) / 60000 > CALENDAR_START_MINUTES;
  });

  const openOccurrenceDetails = (occurrence: ScheduleOccurrence) => {
    const displayStudent = occurrence.kind === "lesson" ? `Student: ${studentName(occurrence.studentId)}\n` : "";
    setSelectedOccurrence({ ...occurrence, detail: displayStudent + occurrence.detail });
    setNotice("");
    setDetailsOpen(true);
  };

  useEffect(() => {
    const requestedKey = `${requestedEvent}:${requestedOccurrence}`;
    if (loading || !requestedEvent || openedRequestedEvent.current === requestedKey) return;
    const occurrence = visibleOccurrences.find(item => item.id === requestedEvent && (!requestedOccurrence || Date.parse(item.originalStartsAt) === Date.parse(requestedOccurrence)));
    if (!occurrence) return;
    const timer = window.setTimeout(() => {
      openedRequestedEvent.current = requestedKey;
      const prefix = occurrence.kind === "lesson" ? `Student: ${studentDirectory.find(student => student.id === occurrence.studentId)?.name ?? "No student linked"}\n` : "";
      setSelectedOccurrence({ ...occurrence, detail: prefix + occurrence.detail });
      setDetailsOpen(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loading, requestedEvent, requestedOccurrence, visibleOccurrences, studentDirectory]);

  const requestDelete = () => {
    if (!selectedOccurrence) return;
    setDetailsOpen(false);
    setDeleteConfirmOpen(true);
  };

  const continueDelete = () => {
    setDeleteConfirmOpen(false);
    setDeleteScopeOpen(true);
  };

  const deleteSelectedOccurrence = async (scope: DeleteScope) => {
    if (!selectedOccurrence || mutationBusy.current) return;
    mutationBusy.current = true;
    setDeleting(true);
    setError("");
    try {
    if (!cloudConfigured) {
      const dayKey = dateKey(new Date(selectedOccurrence.startsAt));
      const stored = window.localStorage.getItem(`${storageKey}-${dayKey}`);
      if (stored) {
        try {
          const remaining = (JSON.parse(stored) as Array<Record<string, unknown>>).filter((lesson) => String(lesson.id) !== selectedOccurrence.id);
          window.localStorage.setItem(`${storageKey}-${dayKey}`, JSON.stringify(remaining));
        } catch { }
      }
      setEvents((current) => current.filter((event) => event.id !== selectedOccurrence.id));
      setDeleting(false);
      setDeleteScopeOpen(false);
      setDeleteConfirmOpen(false);
      setDetailsOpen(false);
      setSelectedOccurrence(null);
      setNotice("Event deleted.");
      notifyScheduleChanged();
      await syncDeletedEvent(selectedOccurrence);
      return;
    }
    const baseEvent = events.find((event) => event.id === selectedOccurrence.id);
    const isFirstOccurrence = Boolean(baseEvent && Date.parse(alignRecurringStart(baseEvent).startsAt) === Date.parse(selectedOccurrence.originalStartsAt));
    let deleteError: Error | null = null;
    let updatedFollowingEvent: ScheduleEvent | null = null;

    if (selectedOccurrence.isRecurring && scope === "occurrence") {
      const result = await database.saveException({
        event_id: selectedOccurrence.id,
        original_starts_at: selectedOccurrence.originalStartsAt,
        status: "cancelled",
      });
      deleteError = result.error;
      if (!deleteError && result.data) {
        setExceptions((current) => [...current.filter((item) => !(item.eventId === selectedOccurrence.id && item.originalStartsAt === selectedOccurrence.originalStartsAt)), exceptionFromRow(result.data)]);
      }
    } else if (selectedOccurrence.isRecurring && scope === "following" && !isFirstOccurrence) {
      const cutoff = addDateKeyDays(dateKeyInTimeZone(selectedOccurrence.originalStartsAt, baseEvent?.timezone ?? timezone), -1);
      const previous = exceptions.filter(exception => exception.eventId === selectedOccurrence.id);
      const retained = previous.filter(exception => dateKeyInTimeZone(exception.originalStartsAt, baseEvent?.timezone ?? timezone) <= cutoff);
      if (!baseEvent) throw new Error("The recurring event is no longer loaded. Refresh and try again.");
      const result = await database.updateEventSeries(baseEvent, { recurrence_until: cutoff }, previous, retained);
      deleteError = result.error;
      if (!deleteError) {
        setEvents((current) => current.map((event) => event.id === selectedOccurrence.id ? { ...event, recurrenceUntil: cutoff } : event));
        setExceptions((current) => [...current.filter(exception => exception.eventId !== selectedOccurrence.id), ...retained]);
        if (baseEvent) updatedFollowingEvent = { ...baseEvent, recurrenceUntil: cutoff };
      }
    } else {
      const result = await database.deleteEvent(selectedOccurrence.id);
      deleteError = result.error;
      if (!deleteError) {
        setEvents((current) => current.filter((event) => event.id !== selectedOccurrence.id));
        setExceptions((current) => current.filter((exception) => exception.eventId !== selectedOccurrence.id));
      }
    }
    setDeleting(false);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setDeleteScopeOpen(false);
    setDeleteConfirmOpen(false);
    setDetailsOpen(false);
    setSelectedOccurrence(null);
    setNotice(!selectedOccurrence.isRecurring ? "Event deleted." : scope === "occurrence" ? "This occurrence was removed." : scope === "following" ? "This and future occurrences were removed." : "The recurring event was deleted.");
    notifyScheduleChanged();
    if (scope === "following" && updatedFollowingEvent) {
      if (googleCalendarIsConnected(userId)) {
        try { await syncSavedScheduleToGoogleCalendar(userId); setNotice(current => `${current} Google Calendar updated.`); }
        catch (failure) { setError(`Your schedule was saved, but Google Calendar sync failed: ${failure instanceof Error ? failure.message : "Try Sync to Google Calendar again."}`); }
      } else await syncSavedEvent(updatedFollowingEvent);
    }
    else if (scope === "occurrence" && baseEvent) {
      try {
        const syncResult = await syncGoogleCalendarOccurrence(baseEvent, selectedOccurrence.originalStartsAt, {
          startsAt: null,
          endsAt: null,
          title: null,
          detail: null,
          kind: null,
          tone: null,
          travelMinutes: null,
          hourlyRate: null,
          fixedFee: null,
          status: "cancelled",
        });
        if (syncResult === "synced") setNotice("This occurrence was removed. Google Calendar updated.");
      } catch (syncError) {
        setError(`The occurrence was removed, but Google Calendar sync failed: ${syncError instanceof Error ? syncError.message : "unknown error"}`);
      }
    } else if (scope !== "occurrence") await syncDeletedEvent(baseEvent ?? selectedOccurrence);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The event could not be deleted. Try again.");
    } finally {
      mutationBusy.current = false;
      setDeleting(false);
    }
  };

  return (
    <main className="calendar-shell">
      <header className="calendar-topbar">
        <button className="back-link" onClick={() => router.push("/")}><ChevronLeft size={16} /> Overview</button>
        <div className="calendar-brand"><span className="brand-mark"><Sparkles size={15} /></span><strong>daylight</strong><span>My calendar</span></div>
        <button className="profile-mini" aria-label="Back to dashboard" onClick={() => router.push("/")}><CalendarDays size={17} /></button>
      </header>
      <div className="calendar-content">
        <div className="calendar-intro">
          <div><p className="section-kicker">Your time, in view</p><h1>My calendar</h1><p className="calendar-subtitle">Plan one-time blocks and weekly rhythms without losing the shape of your week.</p></div>
          <div className="calendar-intro-actions">
            <button className="primary-button" disabled={saving || deleting || loading} onClick={() => openEditor()}><Plus size={17} /> Add event</button>
          </div>
        </div>
        <section className="panel calendar-google-sync" aria-labelledby="google-calendar-heading">
          <div className="calendar-google-sync-main">
            <div className="calendar-google-sync-copy">
              <h2 id="google-calendar-heading"><CalendarDays size={18} /> Google Calendar</h2>
              <p className="google-calendar-status" role="status"><span className={googleCalendar.status === "connected" ? "google-status-dot google-status-connected" : "google-status-dot"} /> {googleCalendar.status === "checking" ? "Checking connection..." : googleCalendar.status === "connected" ? "Connected" : googleCalendar.status === "reconnect-required" ? "Reconnect required" : googleCalendar.status === "error" ? "Connection needs attention" : "Not connected"}</p>
              <p className="settings-help">Your connection is checked when you sign in. Use Sync to Google Calendar to resend saved changes after a connection problem.</p>
              {!googleCalendar.configured && <p className="settings-help">Google Calendar is not configured for this website yet.</p>}
              {googleCalendar.status === "reconnect-required" && <p className="settings-help">Google needs you to renew access. Reconnect here to sync your saved schedule.</p>}
            </div>
            <div className="google-calendar-actions calendar-google-sync-actions">
              {(googleCalendar.status === "not-connected" || googleCalendar.status === "reconnect-required" || googleCalendar.busy === "connect") && <button type="button" className="primary-button" disabled={!googleCalendar.configured || Boolean(googleCalendar.busy)} aria-busy={googleCalendar.busy === "connect"} onClick={() => void googleCalendar.connectAndSync()}><Link2 size={15} /> {googleCalendar.busy === "connect" ? "Connecting and syncing..." : googleCalendar.status === "reconnect-required" ? "Reconnect Google Calendar" : "Connect Google Calendar"}</button>}
              {googleCalendar.status === "error" && <button type="button" className="secondary-button" disabled={Boolean(googleCalendar.busy)} onClick={() => void googleCalendar.check()}><RotateCw size={15} /> Retry connection</button>}
              <button type="button" className={googleCalendar.status === "connected" ? "primary-button" : "secondary-button"} disabled={!googleCalendar.configured || googleCalendar.status !== "connected" || Boolean(googleCalendar.busy)} aria-busy={googleCalendar.busy === "sync"} onClick={() => void googleCalendar.sync()}><RotateCw size={15} className={googleCalendar.busy === "sync" ? "sync-spinning" : undefined} /> {googleCalendar.busy === "sync" ? "Syncing..." : "Sync to Google Calendar"}</button>
            </div>
          </div>
          {googleCalendar.notice && <p className="calendar-google-sync-notice" role="status"><Check size={14} /> {googleCalendar.notice}</p>}
          {googleCalendar.error && <p className="calendar-google-sync-error" role="alert">{googleCalendar.error}</p>}
        </section>
        {notice && <div className="data-success" role="status">{notice}</div>}
        {error && <div className="data-error" role="alert">{error}</div>}
        <section className="calendar-panel">
          <div className="calendar-toolbar">
            <div className="calendar-toolbar-left"><button className="round-button" aria-label="Previous range" onClick={() => shiftRange(-1)}><ChevronLeft size={17} /></button><button className="round-button" aria-label="Next range" onClick={() => shiftRange(1)}><ChevronRight size={17} /></button><button className="today-button" onClick={() => setAnchorDate(dateFromKey(todayKey))}>Today</button><strong>{formatRangeLabel(activeAnchorDate, view)}</strong></div>
              <div className="view-toggle"><button className={view === "day" ? "view-active" : ""} onClick={() => setView("day")}>Day</button><button className={view === "week" ? "view-active" : ""} onClick={() => setView("week")}>Week</button><button className={view === "month" ? "view-active" : ""} onClick={() => setView("month")}>Month</button></div><label className="calendar-student-filter"><span>Student</span><select value={effectiveStudentFilter} onChange={(event) => { const value = event.target.value; setStudentFilter(value); if (requestedStudent) router.replace("/calendar"); }}><option value="all">All students</option><option value="unlinked">Unlinked</option>{studentDirectory.map((student) => <option value={student.id} key={student.id}>{student.name}{student.status === "archived" ? " (archived)" : ""}</option>)}</select></label>
          </div>
          {!loading && <div className="calendar-range-meta"><span>{visibleOccurrences.length ? `${visibleOccurrences.length} event${visibleOccurrences.length === 1 ? "" : "s"} in this ${view}` : `No events in this ${view}`}{effectiveStudentFilter !== "all" ? " · Student filter applied" : ""}</span>{effectiveStudentFilter !== "all" && <button type="button" className="text-button" onClick={() => { setStudentFilter("all"); if (requestedStudent) router.replace("/calendar"); }}>Show all students</button>}</div>}
          <div className="calendar-grid-scroll">
            {loading ? <div className="calendar-empty" role="status">Loading your calendar...</div> : view === "day" || view === "week" ? <div className={`week-calendar ${view === "day" ? "day-calendar" : ""}`}>
              <div className="week-gutter" />
              <div className="week-day-heads">{days.map(day => <div className="calendar-day-head" key={dateKey(day)}><span>{day.toLocaleDateString("en-US", { weekday: "short" })}</span><strong className={dateKey(day) === todayKey ? "day-today" : ""}>{day.getDate()}</strong>{workingPlaceForWeekday(workingPlaces, day.getDay()) && <small className="calendar-day-place">{workingPlaceForWeekday(workingPlaces, day.getDay())}</small>}</div>)}</div>
              <div className="week-times">{calendarTimeLabels.map(label => <span key={label}>{label}</span>)}</div>
              <div className="week-grid">{days.map(day => <div className="week-day-column" key={dateKey(day)} onDoubleClick={() => { if (!saving && !deleting) openEditor(dateKey(day)); }}>
                <div className="calendar-hour-lines" />
                {calendarEventLanes(timelineEventsForDay(day)).map(({ event: item, lane, lanes }) => <button className={`calendar-event event-${item.tone}`} key={item.occurrenceKey} style={eventStyle(item, lane, lanes, timezone)} aria-label={`${item.title}, ${formatTime(item.startsAt, timezone)} to ${formatTime(item.endsAt, timezone)}`} onClick={() => openOccurrenceDetails(item)}><strong>{item.title}</strong><span>{formatTime(item.startsAt, timezone)} · {item.kind === "lesson" ? studentName(item.studentId) : "Personal"}</span></button>)}
              </div>)}</div>
            </div> : <div className="month-calendar">{days.map(day => {
              const dayEvents = occurrencesForDay(day);
              const outside = day.getMonth() !== activeAnchorDate.getMonth();
              const showDay = () => { setAnchorDate(day); setView("day"); };
              const visibleCount = isPhone ? 2 : 4;
              return <div className={`month-day ${outside ? "month-day-outside" : ""}`} key={dateKey(day)} onClick={() => { if (isPhone) showDay(); }} onDoubleClick={() => { if (!isPhone && !saving && !deleting) openEditor(dateKey(day)); }}>
                <div className="month-day-number"><span>{day.toLocaleDateString("en-US", { weekday: "short" })}</span><button type="button" className={`month-day-jump ${dateKey(day) === todayKey ? "day-today" : ""}`} aria-label={`View ${day.toLocaleDateString("en-US", { month: "long", day: "numeric" })}`} onClick={event => { event.stopPropagation(); showDay(); }}>{day.getDate()}</button></div>
                {workingPlaceForWeekday(workingPlaces, day.getDay()) && <small className="month-day-place">{workingPlaceForWeekday(workingPlaces, day.getDay())}</small>}
                {dayEvents.slice(0, visibleCount).map(item => <button className={`month-event event-${item.tone}`} key={item.occurrenceKey} title={`${formatTime(item.startsAt, timezone)} ${item.title}`} onClick={event => { event.stopPropagation(); openOccurrenceDetails(item); }}>{formatTime(item.startsAt, timezone)} {item.title}</button>)}
                {dayEvents.length > visibleCount && <button type="button" className="more-events" onClick={event => { event.stopPropagation(); showDay(); }}>+{dayEvents.length - visibleCount} more</button>}
              </div>;
            })}</div>}
          </div>
        </section>
        {view === "day" && !loading && <section className="panel calendar-day-agenda" aria-labelledby="day-agenda-heading"><h2 id="day-agenda-heading">All events for this day</h2>{occurrencesForDay(activeAnchorDate).length ? occurrencesForDay(activeAnchorDate).map(item => <button type="button" className={`calendar-agenda-event event-${item.tone}`} key={item.occurrenceKey} onClick={() => openOccurrenceDetails(item)}><span className="calendar-agenda-time">{formatTime(item.startsAt, timezone)}–{formatTime(item.endsAt, timezone)}</span><span><strong>{item.title}</strong><small>{item.kind === "lesson" ? studentName(item.studentId) : "Personal"}{item.isRecurring ? " · Weekly" : ""}</small></span><ChevronRight size={16} /></button>) : <p>No events planned. Use Add event to create one.</p>}</section>}
        <p className="calendar-footnote"><Clock3 size={14} /> {timezone} · {isPhone ? view === "week" ? "Swipe the week sideways, or choose Day for a closer view." : "Tap an event for details. Use Add event to plan your time." : "Double-click a day to add an event."}</p>
      </div>
      {editorOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !saving) setEditorOpen(false); }}><section className="lesson-modal calendar-editor" role="dialog" aria-modal="true" aria-labelledby="event-modal-title"><div className="modal-heading"><div><p className="section-kicker">Calendar event</p><h2 id="event-modal-title">{editingOccurrence ? "Edit event" : "Add to your time"}</h2></div><button className="modal-close" aria-label="Close event form" disabled={saving} onClick={() => setEditorOpen(false)}><X size={18} /></button></div><form onSubmit={saveEvent}><fieldset className="calendar-event-fields" disabled={saving}><div className="form-grid"><label className="form-field form-field-wide"><span>Name</span><input autoFocus value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="e.g. Biology · Alex" /></label><label className="form-field form-field-wide"><span>Notes</span><input value={form.detail} onChange={(event) => setForm({ ...form, detail: event.target.value })} placeholder="What is this block for?" /></label><label className="form-field"><span>Date</span><input type="date" value={form.date} onChange={(event) => { const date = event.target.value; setForm({ ...form, date, weekdays: form.recurring || !date ? form.weekdays : [dateFromKey(date).getDay()] }); }} /></label><label className="form-field"><span>Type</span><select value={form.kind} onChange={(event) => { const kind = event.target.value as EventKind; setForm({ ...form, kind, tone: kind === "lesson" ? defaultLessonTone : defaultPersonalTone, studentId: kind === "lesson" ? form.studentId : "" }); }}><option value="lesson">Lesson</option><option value="personal">Personal</option></select></label><label className="form-field"><span>Student</span><select value={form.studentId} disabled={form.kind === "personal"} onChange={(event) => setForm({ ...form, studentId: event.target.value })}><option value="">No student linked</option>{students.map((student) => <option value={student.id} key={student.id}>{student.name}</option>)}</select></label><label className="form-field"><span>Starts</span><input type="time" value={form.starts} onChange={(event) => setForm({ ...form, starts: event.target.value })} /></label><label className="form-field"><span>Ends</span><input type="time" value={form.ends} onChange={(event) => setForm({ ...form, ends: event.target.value })} /></label><label className="form-field"><span>Hourly rate</span><input type="number" min="0" step="0.5" value={form.hourlyRate} onChange={(event) => setForm({ ...form, hourlyRate: Number(event.target.value) })} /></label><label className="form-field"><span>Travel minutes</span><input type="number" min="0" value={form.travelMinutes} onChange={(event) => setForm({ ...form, travelMinutes: Number(event.target.value) })} /></label><div className="tone-picker form-field-wide"><span className="form-field-label">Color</span><div>{eventTones.map((tone) => <button type="button" key={tone} aria-label={`Use ${tone} color`} className={`tone-swatch tone-${tone} ${form.tone === tone ? "tone-selected" : ""}`} onClick={() => setForm({ ...form, tone })}></button>)}</div></div><label className="form-field"><span>Repeat</span><select value={form.recurring ? "weekly" : "once"} onChange={(event) => setForm({ ...form, recurring: event.target.value === "weekly" })}><option value="once">One time</option><option value="weekly">Weekly</option></select></label>{form.recurring && <label className="form-field"><span>Repeat until</span><input type="date" min={form.date} value={form.recurrenceUntil} onChange={(event) => setForm({ ...form, recurrenceUntil: event.target.value })} /> </label>}{form.recurring && <div className="weekday-picker form-field-wide"><span className="form-field-label">Days</span><div>{weekdayLabels.map((label, index) => <button type="button" className={form.weekdays.includes(index) ? "weekday-active" : ""} key={label} onClick={() => setForm({ ...form, weekdays: form.weekdays.includes(index) ? form.weekdays.filter((day) => day !== index) : [...form.weekdays, index] })}>{label}</button>)}</div></div>}</div></fieldset>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-footer"><span /><button type="button" className="secondary-button" disabled={saving} onClick={() => setEditorOpen(false)}>Cancel</button><button type="submit" className="primary-button" disabled={saving} aria-busy={saving}><Plus size={15} /> {saving ? "Saving..." : editingOccurrence ? "Save changes" : "Save event"}</button></div></form></section></div>}
      {editScopeOpen && editingOccurrence && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !saving) setEditScopeOpen(false); }}><section className="lesson-modal delete-scope-modal" role="dialog" aria-modal="true" aria-labelledby="edit-scope-title"><div className="modal-heading"><div><p className="section-kicker">Choose edit scope</p><h2 id="edit-scope-title">{editingOccurrence.title}</h2><p className="calendar-subtitle">Apply these changes to the selected occurrence or the full weekly series.</p></div><button className="modal-close" aria-label="Close edit scope" disabled={saving} onClick={() => setEditScopeOpen(false)}><X size={18} /></button></div><div className="delete-scope-options">{error && <p className="scope-error" role="alert">{error}</p>}<button className="secondary-button" disabled={saving} onClick={() => void saveEditedScope("occurrence")}>{saving ? "Saving..." : "This occurrence"}</button><button className="primary-button" disabled={saving} onClick={() => void saveEditedScope("all")}>{saving ? "Saving..." : "Entire series"}</button></div></section></div>}
      {detailsOpen && selectedOccurrence && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setDetailsOpen(false); }}><section className="lesson-modal event-details-modal" role="dialog" aria-modal="true" aria-labelledby="event-details-title"><div className="modal-heading"><div><p className="section-kicker">Event details</p><h2 id="event-details-title">{selectedOccurrence.title}</h2><p className="calendar-subtitle">{new Date(selectedOccurrence.startsAt).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p></div><button className="modal-close" aria-label="Close event details" onClick={() => setDetailsOpen(false)}><X size={18} /></button></div><div className="event-detail-grid"><div><span>Time</span><strong>{formatTime(selectedOccurrence.startsAt)}–{formatTime(selectedOccurrence.endsAt)}</strong></div><div><span>Type</span><strong>{selectedOccurrence.kind === "lesson" ? "Lesson" : "Personal"}</strong></div><div><span>Rate</span><strong>{selectedOccurrence.kind === "lesson" ? `$${selectedOccurrence.fixedFee ?? selectedOccurrence.hourlyRate}/h` : "Not applicable"}</strong></div><div><span>Travel</span><strong>{selectedOccurrence.travelMinutes} minutes</strong></div><div><span>Status</span><strong>{selectedOccurrence.status}</strong></div><div><span>Repeat</span><strong>{selectedOccurrence.isRecurring ? "Weekly series" : "One time"}</strong></div>{selectedOccurrence.detail && <div className="event-detail-wide"><span>Notes</span><strong>{selectedOccurrence.detail}</strong></div>}</div><div className="modal-footer"><button type="button" className="delete-button" onClick={requestDelete}>Delete event</button><span /><button type="button" className="secondary-button" onClick={() => openOccurrenceEditor(selectedOccurrence)}>Edit</button><button type="button" className="secondary-button" onClick={() => setDetailsOpen(false)}>Close</button></div></section></div>}
      {deleteConfirmOpen && selectedOccurrence && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !deleting) setDeleteConfirmOpen(false); }}><section className="lesson-modal delete-scope-modal" role="dialog" aria-modal="true" aria-labelledby="delete-warning-title"><div className="modal-heading"><div><p className="section-kicker">Remove event</p><h2 id="delete-warning-title">Delete {selectedOccurrence.title}?</h2></div><button className="modal-close" aria-label="Close delete warning" disabled={deleting} onClick={() => setDeleteConfirmOpen(false)}><X size={18} /></button></div><div className="delete-warning">{error && <p className="scope-error" role="alert">{error}</p>}<strong>This cannot be undone.</strong><p>{selectedOccurrence.isRecurring ? "The next step will let you choose whether to remove this occurrence, this and following occurrences, or the entire series." : "This event will be permanently removed from your calendar."}</p></div><div className="modal-footer"><button type="button" className="secondary-button" disabled={deleting} onClick={() => setDeleteConfirmOpen(false)}>Keep event</button><span />{selectedOccurrence.isRecurring ? <button type="button" className="delete-button" disabled={deleting} onClick={continueDelete}>Choose deletion scope</button> : <button type="button" className="delete-button" disabled={deleting} onClick={() => void deleteSelectedOccurrence("all")}>Delete event</button>}</div></section></div>}
      {deleteScopeOpen && selectedOccurrence && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !deleting) setDeleteScopeOpen(false); }}><section className="lesson-modal delete-scope-modal" role="dialog" aria-modal="true" aria-labelledby="delete-event-title"><div className="modal-heading"><div><p className="section-kicker">Choose deletion scope</p><h2 id="delete-event-title">{selectedOccurrence.title}</h2><p className="calendar-subtitle">{formatTime(selectedOccurrence.startsAt)} · {new Date(selectedOccurrence.startsAt).toLocaleDateString()}</p></div><button className="modal-close" aria-label="Close deletion scope" disabled={deleting} onClick={() => setDeleteScopeOpen(false)}><X size={18} /></button></div><div className="delete-scope-options">{error && <p className="scope-error" role="alert">{error}</p>}<button className="secondary-button" disabled={deleting} onClick={() => void deleteSelectedOccurrence("occurrence")}>This occurrence</button><button className="secondary-button" disabled={deleting} onClick={() => void deleteSelectedOccurrence("following")}>This and following</button><button className="delete-button" disabled={deleting} onClick={() => void deleteSelectedOccurrence("all")}>All events in series</button></div></section></div>}
    </main>
  );
}

function exceptionFromRow(row: Record<string, unknown>): ScheduleEventException {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    originalStartsAt: normalizedTimestamp(row.original_starts_at) ?? String(row.original_starts_at),
    startsAt: normalizedTimestamp(row.starts_at),
    endsAt: normalizedTimestamp(row.ends_at),
    status: (row.status as EventStatus) ?? "cancelled",
    title: row.title == null ? null : String(row.title),
    detail: row.detail == null ? null : String(row.detail),
    kind: row.kind === "personal" ? "personal" : row.kind === "lesson" ? "lesson" : null,
    tone: row.tone ? row.tone as EventTone : null,
    travelMinutes: row.travel_minutes === null || row.travel_minutes === undefined ? null : Number(row.travel_minutes),
    hourlyRate: row.hourly_rate === null || row.hourly_rate === undefined ? null : Number(row.hourly_rate),
    fixedFee: row.fixed_fee === null || row.fixed_fee === undefined ? null : Number(row.fixed_fee),
  };
}
