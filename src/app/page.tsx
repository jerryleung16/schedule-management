"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  Calculator,
  CalendarDays,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Command,
  Copy,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  Save,
  Settings2,
  Sparkles,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { availabilityConflicts, formatWeeklyAvailabilityMessage, lessonHours, normalizeWeeklyAvailability, occupiedAvailabilityByWeekday, practicalFreeSlots, slotConflicts, staminaState, validateWeeklyAvailability } from "@/lib/schedule/availability";
import { addDays, dateFromKey, dateKey, rangeForView } from "@/lib/schedule/dates";
import { expandEvents } from "@/lib/schedule/recurrence";
import type { EventStatus, EventTone, ScheduleEvent, ScheduleEventException, ScheduleOccurrence, Student, WeeklyAvailability } from "@/lib/schedule/types";

type IconComponent = typeof LayoutDashboard;

type Lesson = {
  id: string;
  time: string;
  end: string;
  title: string;
  detail: string;
  kind: "lesson" | "personal";
  tone: "blue" | "coral" | "teal" | "yellow" | "violet";
  intensity: number;
  prepMinutes: number;
  travelMinutes: number;
  rate: number;
  studentId: string | null;
  status: EventStatus;
};

const storageKey = "daylight-lessons";
const availabilityStorageKey = "daylight-weekly-availability";
const scheduleDate = new Date().toISOString().slice(0, 10);
const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const eventTones: EventTone[] = ["blue", "coral", "teal", "yellow", "violet"];
const supabaseConfigured = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
);

const navigation: { label: string; icon: IconComponent; active?: boolean }[] = [
  { label: "Overview", icon: LayoutDashboard, active: true },
  { label: "My calendar", icon: CalendarDays },
  { label: "Students", icon: UsersRound },
  { label: "Calculator", icon: Calculator },
];

function evaluateExpression(expression: string) {
  const tokens = expression.replace(/\s+/g, "").match(/(?:\d*\.?\d+)|[()+\-*/]/g);
  if (!tokens || tokens.join("") !== expression.replace(/\s+/g, "")) {
    throw new Error("Use numbers and + - × ÷ ( ) only");
  }

  let position = 0;
  const parseExpression = (): number => {
    let value = parseTerm();
    while (tokens[position] === "+" || tokens[position] === "-") {
      const operator = tokens[position++];
      const next = parseTerm();
      value = operator === "+" ? value + next : value - next;
    }
    return value;
  };
  const parseTerm = (): number => {
    let value = parseFactor();
    while (tokens[position] === "*" || tokens[position] === "/") {
      const operator = tokens[position++];
      const next = parseFactor();
      if (operator === "/" && next === 0) throw new Error("Cannot divide by zero");
      value = operator === "*" ? value * next : value / next;
    }
    return value;
  };
  const parseFactor = (): number => {
    if (tokens[position] === "-") {
      position++;
      return -parseFactor();
    }
    if (tokens[position] === "(") {
      position++;
      const value = parseExpression();
      if (tokens[position++] !== ")") throw new Error("Check your parentheses");
      return value;
    }
    const value = Number(tokens[position++]);
    if (!Number.isFinite(value)) throw new Error("Enter a valid number");
    return value;
  };

  const result = parseExpression();
  if (position !== tokens.length || !Number.isFinite(result)) throw new Error("Check the expression");
  return result;
}

function minutesFromTime(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

const HOMEPAGE_SCHEDULE_START_MINUTES = 8 * 60;
const HOMEPAGE_SCHEDULE_END_MINUTES = 22 * 60;
const HOMEPAGE_SCHEDULE_DURATION_MINUTES = HOMEPAGE_SCHEDULE_END_MINUTES - HOMEPAGE_SCHEDULE_START_MINUTES;

function homepageScheduleStyle(starts: string, ends: string) {
  const visibleStart = Math.max(HOMEPAGE_SCHEDULE_START_MINUTES, minutesFromTime(starts));
  const visibleEnd = Math.min(HOMEPAGE_SCHEDULE_END_MINUTES, minutesFromTime(ends));
  return {
    top: `${((visibleStart - HOMEPAGE_SCHEDULE_START_MINUTES) / HOMEPAGE_SCHEDULE_DURATION_MINUTES) * 100}%`,
    height: `${((visibleEnd - visibleStart) / HOMEPAGE_SCHEDULE_DURATION_MINUTES) * 100}%`,
  };
}

function formatResult(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function weekNumber(dateValue: string) {
  const date = new Date(`${dateValue}T12:00:00`);
  const firstDay = new Date(date.getFullYear(), 0, 1, 12);
  return Math.ceil((((date.getTime() - firstDay.getTime()) / 86400000) + firstDay.getDay() + 1) / 7);
}

function initials(value: string) {
  return value.split(/\s+/).filter(Boolean).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "ME";
}

function lessonFromRow(row: {
  id: string;
  starts_at: string;
  ends_at: string;
  title: string;
  detail: string;
  kind: Lesson["kind"];
  tone: Lesson["tone"];
  intensity: number;
  prep_minutes: number;
  travel_minutes: number;
  hourly_rate: number;
  student_id?: string | null;
  status: EventStatus;
}): Lesson {
  const start = new Date(row.starts_at);
  const end = new Date(row.ends_at);
  return {
    id: row.id,
    time: start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
    end: end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false }),
    title: row.title,
    detail: row.detail,
    kind: row.kind,
    tone: row.tone,
    intensity: Number(row.intensity),
    prepMinutes: row.prep_minutes,
    travelMinutes: row.travel_minutes,
    rate: Number(row.hourly_rate),
    studentId: row.student_id ? String(row.student_id) : null,
    status: row.status,
  };
}

function lessonToRow(lesson: Lesson, userId: string, date: string) {
  return {
    id: lesson.id,
    user_id: userId,
    starts_at: new Date(`${date}T${lesson.time}:00`).toISOString(),
    ends_at: new Date(`${date}T${lesson.end}:00`).toISOString(),
    title: lesson.title.trim(),
    detail: lesson.detail.trim(),
    kind: lesson.kind,
    tone: lesson.tone,
    intensity: lesson.intensity,
    prep_minutes: lesson.prepMinutes,
    travel_minutes: lesson.travelMinutes,
    hourly_rate: lesson.rate,
    student_id: lesson.studentId,
    status: lesson.status,
    updated_at: new Date().toISOString(),
  };
}

function lessonToScheduleRow(lesson: Lesson, userId: string, date: string) {
  return {
    id: lesson.id,
    user_id: userId,
    starts_at: new Date(`${date}T${lesson.time}:00`).toISOString(),
    ends_at: new Date(`${date}T${lesson.end}:00`).toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    title: lesson.title.trim(),
    detail: lesson.detail.trim(),
    kind: lesson.kind,
    tone: lesson.tone,
    intensity: lesson.intensity,
    prep_minutes: lesson.prepMinutes,
    travel_minutes: lesson.travelMinutes,
    hourly_rate: lesson.rate,
    student_id: lesson.studentId,
    fixed_fee: null,
    status: lesson.status,
    recurrence_weekdays: [],
    recurrence_until: null,
    updated_at: new Date().toISOString(),
  };
}

function scheduleEventFromRow(row: Record<string, unknown>, userId: string): ScheduleEvent {
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

function localLessonOccurrence(lesson: Lesson, date: string): ScheduleOccurrence {
  const startsAt = new Date(`${date}T${lesson.time}:00`);
  const endsAt = new Date(`${date}T${lesson.end}:00`);
  return {
    id: lesson.id,
    userId: "local",
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    title: lesson.title,
    detail: lesson.detail,
    kind: lesson.kind,
    tone: lesson.tone,
    intensity: lesson.intensity,
    prepMinutes: lesson.prepMinutes,
    travelMinutes: lesson.travelMinutes,
    hourlyRate: lesson.rate,
    fixedFee: null,
    status: lesson.status,
    recurrenceWeekdays: [],
    recurrenceUntil: null,
    studentId: lesson.studentId,
    occurrenceKey: `${lesson.id}:${date}`,
    originalStartsAt: startsAt.toISOString(),
    isRecurring: false,
  };
}

function exceptionFromRow(row: Record<string, unknown>): ScheduleEventException {
  return {
    id: String(row.id),
    eventId: String(row.event_id),
    originalStartsAt: String(row.original_starts_at),
    startsAt: row.starts_at ? String(row.starts_at) : null,
    endsAt: row.ends_at ? String(row.ends_at) : null,
    status: (row.status as EventStatus) ?? "cancelled",
    title: row.title ? String(row.title) : null,
    detail: row.detail ? String(row.detail) : null,
    kind: row.kind === "personal" ? "personal" : row.kind === "lesson" ? "lesson" : null,
    tone: row.tone ? row.tone as EventTone : null,
    travelMinutes: row.travel_minutes === null || row.travel_minutes === undefined ? null : Number(row.travel_minutes),
    hourlyRate: row.hourly_rate === null || row.hourly_rate === undefined ? null : Number(row.hourly_rate),
    fixedFee: row.fixed_fee === null || row.fixed_fee === undefined ? null : Number(row.fixed_fee),
  };
}

export default function Home() {
  const router = useRouter();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const hasLoadedLessons = useRef(false);
  const overviewRef = useRef<HTMLDivElement>(null);
  const scheduleRef = useRef<HTMLElement>(null);
  const calculatorRef = useRef<HTMLElement>(null);
  const [userId, setUserId] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [displayName, setDisplayName] = useState("Your day");
  const [defaultLessonRate, setDefaultLessonRate] = useState(35);
  const [defaultTravelMinutes, setDefaultTravelMinutes] = useState(0);
  const [defaultLessonTone, setDefaultLessonTone] = useState<EventTone>("coral");
    const [students, setStudents] = useState<Student[]>([]);
  const [dataError, setDataError] = useState("");
  const [notice, setNotice] = useState("");
  const [activeNav, setActiveNav] = useState("Overview");
  const [selectedDate, setSelectedDate] = useState(scheduleDate);
  const [isCloudSaving, setIsCloudSaving] = useState(false);
  const [monthlyCompletedEarnings, setMonthlyCompletedEarnings] = useState(0);
  const [monthlyCompletedCount, setMonthlyCompletedCount] = useState(0);
  const [weeklyLessonHours, setWeeklyLessonHours] = useState(0);
  const [weeklyOccurrences, setWeeklyOccurrences] = useState<ScheduleOccurrence[]>([]);
  const [editingLesson, setEditingLesson] = useState<Lesson | null>(null);
  const [lessonFormDate, setLessonFormDate] = useState(selectedDate);
  const [lessonModalOpen, setLessonModalOpen] = useState(false);
  const [lessonDetailsOpen, setLessonDetailsOpen] = useState(false);
  const [lessonDeleteConfirmOpen, setLessonDeleteConfirmOpen] = useState(false);
  const [lessonFormError, setLessonFormError] = useState("");
  const [availability, setAvailability] = useState<WeeklyAvailability[]>([]);
  const [availabilityMessage, setAvailabilityMessage] = useState("");
  const [availabilityError, setAvailabilityError] = useState("");
  const [availabilitySaving, setAvailabilitySaving] = useState(false);
  const [calculatorValue, setCalculatorValue] = useState("128 / 4");
  const [calculatorResult, setCalculatorResult] = useState("32");
  const [calculatorError, setCalculatorError] = useState("");

  useEffect(() => {
    const loadLessons = async () => {
      setDataError("");
      if (!supabaseConfigured) {
        const savedLessons = window.localStorage.getItem(`${storageKey}-${selectedDate}`);
        const savedSettings = window.localStorage.getItem("daylight-settings");
                const savedStudents = window.localStorage.getItem("daylight-students");
                if (savedStudents) {
                  try { setStudents(JSON.parse(savedStudents) as Student[]); } catch { window.localStorage.removeItem("daylight-students"); }
                }
        if (savedSettings) {
          try {
            const settings = JSON.parse(savedSettings) as { defaultLessonRate?: number; defaultTravelMinutes?: number; defaultLessonTone?: EventTone };
            if (settings.defaultLessonRate !== undefined) setDefaultLessonRate(settings.defaultLessonRate);
            if (settings.defaultTravelMinutes !== undefined) setDefaultTravelMinutes(settings.defaultTravelMinutes);
            if (settings.defaultLessonTone) setDefaultLessonTone(settings.defaultLessonTone);
          } catch { window.localStorage.removeItem("daylight-settings"); }
        }
        let selectedLessons: Lesson[] = [];
        if (savedLessons) {
          try {
            selectedLessons = JSON.parse(savedLessons) as Lesson[];
            setLessons(selectedLessons);
          } catch {
            window.localStorage.removeItem(`${storageKey}-${selectedDate}`);
          }
        } else if (selectedDate !== scheduleDate) {
          setLessons([]);
        }
        const localMonth = new Date(`${selectedDate}T12:00:00`);
        const localMonthStart = new Date(localMonth.getFullYear(), localMonth.getMonth(), 1, 12);
        const localMonthEnd = new Date(localMonth.getFullYear(), localMonth.getMonth() + 1, 1, 12);
        const monthLessons: Lesson[] = [];
        for (let day = new Date(localMonthStart); day < localMonthEnd; day = addDays(day, 1)) {
          const dayKey = dateKey(day);
          let dayLessons: Lesson[] = [];
          if (dayKey === selectedDate) {
            dayLessons = selectedLessons;
          } else {
            const stored = window.localStorage.getItem(`${storageKey}-${dayKey}`);
            if (!stored) continue;
            try { dayLessons = JSON.parse(stored) as Lesson[]; } catch { continue; }
          }
          monthLessons.push(...dayLessons);
        }
        const payableLessons = monthLessons.filter((lesson) => lesson.kind === "lesson" && lesson.status !== "cancelled" && lesson.status !== "skipped");
        setMonthlyCompletedCount(payableLessons.length);
        setMonthlyCompletedEarnings(payableLessons.reduce((total, lesson) => total + ((minutesFromTime(lesson.end) - minutesFromTime(lesson.time)) / 60) * lesson.rate, 0));
        const localRange = rangeForView(dateFromKey(selectedDate), "week");
        const localOccurrences: ScheduleOccurrence[] = [];
        for (let day = new Date(localRange.start); day < localRange.end; day = addDays(day, 1)) {
          const dayLessons = day.getTime() === dateFromKey(selectedDate).getTime()
            ? selectedLessons
            : (() => {
                const stored = window.localStorage.getItem(`${storageKey}-${dateKey(day)}`);
                if (!stored) return [];
                try { return JSON.parse(stored) as Lesson[]; } catch { return []; }
              })();
          localOccurrences.push(...dayLessons.map((lesson) => localLessonOccurrence(lesson, dateKey(day))));
        }
        setWeeklyOccurrences(localOccurrences);
        setWeeklyLessonHours(lessonHours(localOccurrences));
        hasLoadedLessons.current = true;
        return;
      }

      setLessons([]);
      const supabase = createClient();
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData.user) {
        setDataError(userError?.message ?? "Sign in to load your schedule.");
        return;
      }

      setUserId(userData.user.id);
      setUserEmail(userData.user.email ?? "");
      const { data: profileData } = await supabase.from("profiles").select("display_name, default_lesson_rate, default_travel_minutes, default_lesson_tone").eq("id", userData.user.id).maybeSingle();
      if (profileData?.display_name) setDisplayName(profileData.display_name);
      if (profileData?.default_lesson_rate !== null && profileData?.default_lesson_rate !== undefined) setDefaultLessonRate(Number(profileData.default_lesson_rate));
      if (profileData?.default_travel_minutes !== null && profileData?.default_travel_minutes !== undefined) setDefaultTravelMinutes(Number(profileData.default_travel_minutes));
      if (profileData?.default_lesson_tone) setDefaultLessonTone(profileData.default_lesson_tone as EventTone);
      const { data: studentData, error: studentError } = await supabase.from("students").select("id, user_id, name, email, phone, notes, status").eq("status", "active").order("name");
      if (studentError && /students|student_id|schema cache|column/i.test(studentError.message)) setDataError("Apply migration 005 to enable student-calendar sync.");
      if (studentData) setStudents(studentData.map((row) => ({ id: String(row.id), userId: String(row.user_id), name: String(row.name), email: String(row.email ?? ""), phone: String(row.phone ?? ""), notes: String(row.notes ?? ""), status: row.status === "archived" ? "archived" : "active" })));
      const selectedMonth = new Date(`${selectedDate}T12:00:00`);
      const monthStart = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth(), 1, 0);
      const monthEnd = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + 1, 1, 0);
      const monthRange = { start: monthStart, end: monthEnd };
      const canonicalMonth = await supabase
        .from("schedule_events")
        .select("id, user_id, starts_at, ends_at, timezone, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, fixed_fee, status, recurrence_weekdays, recurrence_until, student_id")
        .lt("starts_at", monthEnd.toISOString());
      if (!canonicalMonth.error) {
        const monthEvents = (canonicalMonth.data ?? []).map((row) => scheduleEventFromRow(row, userData.user.id));
        const monthIds = (canonicalMonth.data ?? []).map((row) => row.id);
        const monthExceptions = monthIds.length
          ? await supabase.from("schedule_event_exceptions").select("id, event_id, original_starts_at, starts_at, ends_at, status, title, detail, kind, tone, travel_minutes, hourly_rate, fixed_fee").in("event_id", monthIds)
          : { data: [], error: null };
        const monthOccurrences = expandEvents(monthEvents, (monthExceptions.data ?? []).map((row) => exceptionFromRow(row)), monthRange);
        const payableLessons = monthOccurrences.filter((occurrence) => occurrence.kind === "lesson" && occurrence.status !== "cancelled" && occurrence.status !== "skipped");
        setMonthlyCompletedCount(payableLessons.length);
        setMonthlyCompletedEarnings(payableLessons.reduce((total, occurrence) => total + ((new Date(occurrence.endsAt).getTime() - new Date(occurrence.startsAt).getTime()) / 3600000) * occurrence.hourlyRate, 0));
      } else {
        const fallbackMonth = await supabase.from("lessons").select("starts_at, ends_at, kind, hourly_rate, status").gte("starts_at", monthStart.toISOString()).lt("starts_at", monthEnd.toISOString());
        const payableLessons = (fallbackMonth.data ?? []).filter((row) => row.kind === "lesson" && row.status !== "cancelled" && row.status !== "skipped");
        setMonthlyCompletedCount(payableLessons.length);
        setMonthlyCompletedEarnings(payableLessons.reduce((total, row) => total + ((new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()) / 3600000) * Number(row.hourly_rate), 0));
      }
      const weekRange = rangeForView(selectedMonth, "week");
      const weekStart = weekRange.start;
      const weekEnd = weekRange.end;
      const canonicalWeek = await supabase
        .from("schedule_events")
        .select("id, user_id, starts_at, ends_at, timezone, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, fixed_fee, status, recurrence_weekdays, recurrence_until, student_id")
        .lt("starts_at", weekEnd.toISOString())
        .order("starts_at", { ascending: true });
      let weekData = canonicalWeek.data as unknown as Record<string, unknown>[] | null;
      let weekError = canonicalWeek.error;
      if (weekError) {
        const fallbackWeek = await supabase.from("lessons").select("id, user_id, starts_at, ends_at, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, status, student_id").gte("starts_at", weekStart.toISOString()).lt("starts_at", weekEnd.toISOString());
        weekData = fallbackWeek.data as unknown as Record<string, unknown>[] | null;
        weekError = fallbackWeek.error;
      }
      if (!weekError) {
        const scheduleEvents = (weekData ?? []).map((row) => scheduleEventFromRow(row, userData.user.id));
        const eventIds = (weekData ?? []).map((row) => row.id);
        let exceptions: ScheduleEventException[] = [];
        if (eventIds.length) {
          const { data: exceptionData } = await supabase.from("schedule_event_exceptions").select("id, event_id, original_starts_at, starts_at, ends_at, status, title, detail, kind, tone, travel_minutes, hourly_rate, fixed_fee").in("event_id", eventIds);
          exceptions = (exceptionData ?? []).map((row) => exceptionFromRow(row));
        }
        const expanded = expandEvents(scheduleEvents, exceptions, weekRange);
        setWeeklyOccurrences(expanded);
        setWeeklyLessonHours(lessonHours(expanded));
      }
      let { data, error } = await supabase
        .from("schedule_events")
        .select("id, starts_at, ends_at, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, status, student_id")
        .gte("starts_at", new Date(`${selectedDate}T00:00:00`).toISOString())
        .lt("starts_at", new Date(`${selectedDate}T23:59:59`).toISOString())
        .order("starts_at", { ascending: true });
      if (error) {
        const fallback = await supabase
          .from("lessons")
          .select("id, starts_at, ends_at, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, status, student_id")
          .gte("starts_at", new Date(`${selectedDate}T00:00:00`).toISOString())
          .lt("starts_at", new Date(`${selectedDate}T23:59:59`).toISOString())
          .order("starts_at", { ascending: true });
        data = fallback.data;
        error = fallback.error;
      }

      if (error) {
        setDataError(error.message);
      } else {
        setLessons((data ?? []).map((row) => lessonFromRow(row)));
        hasLoadedLessons.current = true;
      }
    };

    const loadTimer = window.setTimeout(() => { void loadLessons(); }, 0);
    return () => window.clearTimeout(loadTimer);
  }, [selectedDate]);

  useEffect(() => {
    if (supabaseConfigured && !userId) return;
    let cancelled = false;
    const loadAvailability = async () => {
      let loaded: WeeklyAvailability[] = [];
      if (!supabaseConfigured) {
        const stored = window.localStorage.getItem(availabilityStorageKey);
        if (stored) {
          try { loaded = JSON.parse(stored) as WeeklyAvailability[]; } catch { window.localStorage.removeItem(availabilityStorageKey); }
        }
      } else {
        const { data, error } = await createClient().from("weekly_availability").select("id, weekday, starts, ends").eq("user_id", userId).order("weekday").order("starts");
        if (error) {
          const stored = window.localStorage.getItem(availabilityStorageKey);
          if (stored) {
            try { loaded = JSON.parse(stored) as WeeklyAvailability[]; } catch { window.localStorage.removeItem(availabilityStorageKey); }
          }
          if (!cancelled) setAvailabilityError("Cloud availability is not ready yet; local availability is being used.");
        } else {
          loaded = (data ?? []).map((row) => ({ id: String(row.id), weekday: Number(row.weekday), starts: String(row.starts).slice(0, 5), ends: String(row.ends).slice(0, 5) }));
        }
      }
      if (!cancelled) {
        const normalized = normalizeWeeklyAvailability(loaded);
        setAvailability(normalized);
        setAvailabilityMessage(formatWeeklyAvailabilityMessage(normalized));
      }
    };
    void loadAvailability();
    return () => { cancelled = true; };
  }, [userId]);

  useEffect(() => {
    if (hasLoadedLessons.current && !supabaseConfigured) {
      window.localStorage.setItem(`${storageKey}-${selectedDate}`, JSON.stringify(lessons));
    }
  }, [lessons, selectedDate]);

  const showNotice = (message: string) => {
    setNotice(message);
  };

  const updateAvailability = (next: WeeklyAvailability[]) => {
    const normalized = normalizeWeeklyAvailability(next);
    setAvailability(normalized);
    setAvailabilityMessage(formatWeeklyAvailabilityMessage(normalized));
    setAvailabilityError(validateWeeklyAvailability(normalized));
  };

  const addAvailabilityWindow = (weekday: number) => {
    updateAvailability([...availability, { weekday, starts: "10:00", ends: "11:00" }]);
  };

  const removeAvailabilityWindow = (index: number) => {
    updateAvailability(availability.filter((_, itemIndex) => itemIndex !== index));
  };

  const addFreeAvailabilitySlot = (slot: { weekday: number; starts: string; ends: string }) => {
    updateAvailability([...availability, slot]);
  };

  const saveAvailability = async () => {
    const validationError = validateWeeklyAvailability(availability);
    if (validationError) {
      setAvailabilityError(validationError);
      return;
    }
    const conflicts = availabilityConflicts(availability, weeklyOccurrences);
    if (conflicts.length) {
      return;
    }
    setAvailabilitySaving(true);
    setAvailabilityError("");
    if (!supabaseConfigured) {
      window.localStorage.setItem(availabilityStorageKey, JSON.stringify(availability));
      setAvailabilitySaving(false);
      showNotice("Weekly availability saved in this browser.");
      return;
    }
    if (!userId) {
      setAvailabilitySaving(false);
      setAvailabilityError("Your session is still loading. Try again in a moment.");
      return;
    }
    const supabase = createClient();
    const { error: deleteError } = await supabase.from("weekly_availability").delete().eq("user_id", userId);
    const { error: insertError } = deleteError
      ? { error: deleteError }
      : availability.length
        ? await supabase.from("weekly_availability").insert(availability.map((interval) => ({ user_id: userId, weekday: interval.weekday, starts: interval.starts, ends: interval.ends })))
        : { error: null };
    setAvailabilitySaving(false);
    if (insertError) {
      window.localStorage.setItem(availabilityStorageKey, JSON.stringify(availability));
      setAvailabilityError("Cloud availability is not ready yet; your changes are saved in this browser.");
      return;
    }
    showNotice("Weekly availability saved to the cloud.");
  };

  const copyAvailabilityMessage = async () => {
    try {
      await navigator.clipboard.writeText(availabilityMessage);
      showNotice("Availability message copied.");
    } catch {
      setAvailabilityError("Clipboard access was unavailable. Select the message and copy it manually.");
    }
  };

  const availabilityConflictsList = availabilityConflicts(availability, weeklyOccurrences);
  const availabilityConflictsError = availabilityConflictsList.length
    ? `${availabilityConflictsList[0].eventTitle} overlaps ${availabilityConflictsList[0].starts}–${availabilityConflictsList[0].ends} on ${weekdayNames[availabilityConflictsList[0].weekday]}.`
    : "";

  const focusSection = (label: string, section: HTMLElement | null) => {
    setActiveNav(label);
    setMobileMenuOpen(false);
    section?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const handleNavigation = (label: string) => {
    if (label === "Overview") {
      focusSection(label, overviewRef.current);
    } else if (label === "My calendar") {
      router.push("/calendar");
    } else if (label === "Calculator") {
      focusSection(label, calculatorRef.current);
      window.setTimeout(() => calculatorRef.current?.querySelector<HTMLButtonElement>(".calc-key")?.focus(), 250);
    } else if (label === "Students") {
      router.push("/students");
    } else {
      setActiveNav(label);
      setMobileMenuOpen(false);
      showNotice(`${label} workspace is not available yet.`);
    }
  };

  const changeDate = (offset: number) => {
    const nextDate = new Date(`${selectedDate}T12:00:00`);
    nextDate.setDate(nextDate.getDate() + offset);
    hasLoadedLessons.current = false;
    setSelectedDate(nextDate.toISOString().slice(0, 10));
    setActiveNav("My calendar");
  };

  const goToToday = () => {
    hasLoadedLessons.current = false;
    setSelectedDate(new Date().toISOString().slice(0, 10));
    setActiveNav("My calendar");
  };

  const calculate = (value = calculatorValue) => {
    try {
      const result = evaluateExpression(value);
      setCalculatorResult(formatResult(result));
      setCalculatorError("");
    } catch (error) {
      setCalculatorError(error instanceof Error ? error.message : "Check the expression");
    }
  };

  const pressCalculatorKey = (key: string) => {
    if (key === "C") {
      setCalculatorValue("");
      setCalculatorResult("0");
      setCalculatorError("");
      return;
    }
    if (key === "backspace") {
      setCalculatorValue((value) => value.slice(0, -1));
      setCalculatorError("");
      return;
    }
    if (key === "=") {
      calculate();
      return;
    }
    const nextValue = calculatorValue + key;
    setCalculatorValue(nextValue);
    setCalculatorError("");
  };

  const openNewLesson = () => {
    setLessonFormDate(selectedDate);
    setEditingLesson({
      id: crypto.randomUUID(),
      time: "10:00",
      end: "11:00",
      title: "",
      detail: "",
      kind: "lesson",
      tone: defaultLessonTone,
      intensity: 2,
      prepMinutes: 15,
      travelMinutes: defaultTravelMinutes,
      rate: defaultLessonRate,
      status: "scheduled",
      studentId: null,
    });
    setLessonFormError("");
    setLessonModalOpen(true);
  };

  const openLessonEditor = (lesson: Lesson) => {
    setLessonFormDate(selectedDate);
    setEditingLesson({ ...lesson });
    setLessonFormError("");
    setLessonModalOpen(true);
  };

  const openLesson = (lesson: Lesson) => {
    setLessonFormDate(selectedDate);
    setEditingLesson({ ...lesson });
    setLessonFormError("");
    setLessonDetailsOpen(true);
  };

  const requestLessonDelete = () => {
    setLessonDetailsOpen(false);
    setLessonDeleteConfirmOpen(true);
  };

  const saveLesson = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingLesson) return;
    const lesson = editingLesson.kind === "lesson" ? editingLesson : { ...editingLesson, studentId: null };
    if (!lesson.title.trim()) {
      setLessonFormError("Give this block a name first.");
      return;
    }
    if (minutesFromTime(lesson.end) <= minutesFromTime(lesson.time)) {
      setLessonFormError("End time must be after the start time.");
      return;
    }
    const proposedStart = new Date(`${lessonFormDate}T${lesson.time}:00`);
    const proposedEnd = new Date(`${lessonFormDate}T${lesson.end}:00`);
    const editingExisting = lessons.some((item) => item.id === lesson.id);
    if (!editingExisting && slotConflicts(proposedStart, proposedEnd, weeklyOccurrences)) {
      setLessonFormError("That time overlaps an existing event.");
      return;
    }
    if (supabaseConfigured) {
      if (!userId) {
        setLessonFormError("Your session is still loading. Try again in a moment.");
        return;
      }
      setIsCloudSaving(true);
      const supabase = createClient();
      const { error: scheduleError } = await supabase.from("schedule_events").upsert(lessonToScheduleRow(lesson, userId, lessonFormDate));
      const error = scheduleError
        ? (await supabase.from("lessons").upsert(lessonToRow(lesson, userId, lessonFormDate))).error
        : null;
      setIsCloudSaving(false);
      if (error) {
        setLessonFormError(error.message);
        return;
      }
    }
    setSelectedDate(lessonFormDate);
    setLessons((current) => current.some((item) => item.id === lesson.id)
      ? current.map((item) => item.id === lesson.id ? lesson : item)
      : [...current, lesson]);
    setLessonModalOpen(false);
    setEditingLesson(null);
  };

  const deleteLesson = async () => {
    if (!editingLesson) return;
    if (supabaseConfigured) {
      setIsCloudSaving(true);
      const supabase = createClient();
      const canonical = await supabase.from("schedule_events").delete().eq("id", editingLesson.id);
      const error = canonical.error
        ? (await supabase.from("lessons").delete().eq("id", editingLesson.id)).error
        : null;
      setIsCloudSaving(false);
      if (error) {
        setLessonFormError(error.message);
        return;
      }
    }
    setLessons((current) => current.filter((lesson) => lesson.id !== editingLesson.id));
    setLessonModalOpen(false);
    setLessonDetailsOpen(false);
    setLessonDeleteConfirmOpen(false);
    setEditingLesson(null);
  };

  const signOut = async () => {
    if (supabaseConfigured) await createClient().auth.signOut();
    router.push("/login");
    router.refresh();
  };

  const localLessonHours = lessons.filter((lesson) => lesson.kind === "lesson").reduce((total, lesson) => total + (minutesFromTime(lesson.end) - minutesFromTime(lesson.time)) / 60, 0);
  const displayedWeeklyLessonHours = supabaseConfigured ? weeklyLessonHours : localLessonHours;
  const weeklyStamina = staminaState(displayedWeeklyLessonHours);
  const weeklyStaminaMeter = Math.min(100, Math.round((displayedWeeklyLessonHours / 25) * 100));
  const currentEarnings = monthlyCompletedEarnings;
  const displayedCompletedCount = monthlyCompletedCount;

  return (
    <main className="app-shell">
      <aside className={`sidebar ${mobileMenuOpen ? "sidebar-open" : ""}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><Sparkles size={18} strokeWidth={2.5} /></div>
          <span>daylight</span>
          <button className="mobile-close" aria-label="Close menu" onClick={() => setMobileMenuOpen(false)}><X size={19} /></button>
        </div>

        <div className="profile-switcher">
          <div className="avatar avatar-sage">{initials(displayName)}</div>
          <div><strong>{displayName}</strong><span>{supabaseConfigured ? userEmail || "Loading account..." : "Local workspace"}</span></div>
          <ChevronDown size={15} className="muted-icon" />
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          <p className="nav-label">Workspace</p>
          {navigation.map(({ label, icon: Icon }) => (
            <button className={`nav-item ${activeNav === label ? "nav-item-active" : ""}`} key={label} onClick={() => handleNavigation(label)}>
              <Icon size={18} strokeWidth={activeNav === label ? 2.4 : 2} />
              <span>{label}</span>
              {label === "Calculator" && <span className="nav-kbd">⌘ K</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <div className="tip-icon"><CircleHelp size={17} /></div>
            <div><strong>Protect your energy</strong><span>Keep an eye on your weekly load.</span></div>
          </div>
          <button className="nav-item" onClick={() => { setMobileMenuOpen(false); router.push("/settings"); }}><Settings2 size={18} /><span>Settings</span></button>
          {supabaseConfigured && <button className="nav-item" onClick={signOut}><LogOut size={18} /><span>Sign out</span></button>}
          <div className="sidebar-footer"><span className="status-dot" /> {isCloudSaving ? "Saving changes..." : supabaseConfigured ? "Synced to cloud" : "Saved in this browser"} <span>v0.2</span></div>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <button className="mobile-menu" aria-label="Open menu" onClick={() => setMobileMenuOpen(true)}><Menu size={21} /></button>
          <div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><strong>Overview</strong></div>
          <div className="topbar-actions">
            <button className="icon-button" aria-label="Open calculator" onClick={() => handleNavigation("Calculator")}><Command size={16} /><span>K</span></button>
            <button className="icon-button profile-mini" aria-label="Open profile" onClick={() => showNotice(userEmail ? `Signed in as ${userEmail}.` : "Your account is still loading.")}><UserRound size={17} /></button>
          </div>
        </header>

        <div className="page-content" ref={overviewRef}>
          {dataError && <div className="data-error" role="alert">{dataError}</div>}
          {notice && <div className="data-error" role="status">{notice}</div>}
          <section className="welcome-row">
            <div>
              <p className="eyebrow">{new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })} <span className="eyebrow-dot" /> Week {weekNumber(selectedDate)}</p>
              <h1>Good morning, {displayName}<span className="heading-period">.</span></h1>
              <p className="subheading">A clear view of your time, energy, and teaching week.</p>
            </div>
            <button className="primary-button" onClick={openNewLesson}><Plus size={17} /> Add to schedule</button>
          </section>

          <section className="metric-grid" aria-label="Weekly summary">
            <article className="metric-card metric-week">
              <div className="metric-top"><span className="metric-label">Weekly teaching</span><span className="metric-icon"><Clock3 size={16} /></span></div>
              <div className="metric-value">{formatResult(displayedWeeklyLessonHours)}<span className="metric-unit"> hrs</span></div>
              <div className={`meter meter-${weeklyStamina}`}><span style={{ width: `${weeklyStaminaMeter}%` }} /></div>
              <div className="metric-bottom"><span>Stamina: {weeklyStamina}</span><span className="metric-note">{displayedWeeklyLessonHours > 25 ? "Over capacity" : "On track"}</span></div>
            </article>
            <article className="metric-card metric-earnings">
              <div className="metric-top"><span className="metric-label">{new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-US", { month: "long" })} earnings</span><span className="metric-icon"><ArrowUpRight size={16} /></span></div>
              <div className="metric-value currency">${currentEarnings.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
              <div className="metric-bottom"><span>{displayedCompletedCount} scheduled lessons</span><span className="trend-up">Live</span></div>
              <div className="sparkline" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
            </article>
          </section>

          <div className="dashboard-grid">
            <section className="panel schedule-panel" ref={scheduleRef}>
              <div className="panel-heading">
                <div><p className="section-kicker">Your week</p><h2>{new Date(`${selectedDate}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</h2></div>
                <div className="panel-actions"><button className="round-button" aria-label="Previous day" onClick={() => changeDate(-1)}><ChevronLeft size={17} /></button><button className="round-button" aria-label="Next day" onClick={() => changeDate(1)}><ChevronRight size={17} /></button><button className="text-button" onClick={goToToday}>Today <ChevronDown size={14} /></button></div>
              </div>
              <div className="schedule-body">
                <div className="time-column"><span>08:00</span><span>10:00</span><span>12:00</span><span>14:00</span><span>16:00</span><span>18:00</span><span>20:00</span><span>22:00</span></div>
                <div className="schedule-track">
                  <div className="schedule-line line-1" /><div className="schedule-line line-2" /><div className="schedule-line line-3" /><div className="schedule-line line-4" /><div className="schedule-line line-5" /><div className="schedule-line line-6" /><div className="schedule-line line-7" />
                  <div className="now-line"><span>NOW</span></div>
                  {lessons.filter((item) => minutesFromTime(item.end) > HOMEPAGE_SCHEDULE_START_MINUTES && minutesFromTime(item.time) < HOMEPAGE_SCHEDULE_END_MINUTES).map((item) => <button className={`schedule-event event-${item.tone}`} key={item.id} onClick={() => openLesson(item)} style={homepageScheduleStyle(item.time, item.end)}>
                    <strong>{item.title}</strong><span>{item.detail}</span><small>{item.time} – {item.end}</small>
                  </button>)}
                </div>
              </div>
              <div className="schedule-footer"><span><span className="legend-dot legend-lesson" /> Lessons <span className="legend-dot legend-personal" /> Personal</span><button className="text-button" onClick={() => router.push("/calendar")}>Open calendar <ArrowUpRight size={14} /></button></div>
            </section>

            <section className="panel calculator-panel" ref={calculatorRef}>
              <div className="panel-heading calculator-heading"><div><p className="section-kicker">Quick tool</p><h2>Calculator</h2></div><Calculator size={20} className="panel-icon" /></div>
              <div className="calculator-display"><span className="calculation-input">{calculatorValue || "0"}</span><strong>{calculatorError || calculatorResult}</strong></div>
              <div className="calculator-keys">
                {[["C", "backspace", "(", ")"], ["7", "8", "9", "/"], ["4", "5", "6", "*"], ["1", "2", "3", "-"], ["0", ".", "=", "+"]].map((row) => row.map((key) => <button className={`calc-key ${key === "=" ? "calc-equals" : ""} ${["/", "*", "-", "+"].includes(key) ? "calc-operator" : ""}`} key={key} onClick={() => pressCalculatorKey(key)}>{key === "backspace" ? "⌫" : key === "*" ? "×" : key === "/" ? "÷" : key}</button>))}
              </div>
              <p className="calculator-hint">Use your keyboard for faster calculations <span>↵</span></p>
            </section>

          </div>
          <section className="panel availability-panel" aria-labelledby="availability-title">
            <div className="panel-heading"><div><p className="section-kicker">Client-ready rhythm</p><h2 id="availability-title">Weekly availability</h2></div><Clock3 size={20} className="panel-icon" /></div>
            <div className="availability-content">
              <p className="availability-intro">Set recurring teaching windows from the unoccupied periods in your selected week.</p>
              <div className="availability-days">{[1, 2, 3, 4, 5, 6, 0].map((weekday) => { const day = addDays(rangeForView(dateFromKey(selectedDate), "week").start, (weekday + 6) % 7); const dayKey = dateKey(day); const occupied = occupiedAvailabilityByWeekday(weeklyOccurrences).filter((item) => item.weekday === weekday && item.eventDate === dayKey); const freeSlots = practicalFreeSlots(weeklyOccurrences).filter((slot) => slot.weekday === weekday); return <div className="availability-day" key={weekday}><div className="availability-day-heading"><div><strong>{weekdayNames[weekday]}</strong><span className="availability-date">{day.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span></div><button type="button" className="text-button" onClick={() => addAvailabilityWindow(weekday)}><Plus size={13} /> Add window</button></div><div className="availability-occupied">{occupied.length ? occupied.map((item) => <span key={`${item.startsAt}-${item.endsAt}-${item.eventDate}`}>{item.title} · {String(Math.floor(item.starts / 60)).padStart(2, "0")}:{String(item.starts % 60).padStart(2, "0")}–{String(Math.floor(item.ends / 60)).padStart(2, "0")}:{String(item.ends % 60).padStart(2, "0")}</span>) : <span>No scheduled blocks</span>}</div><div className="availability-free-heading">Free time · 08:00–20:00</div>{freeSlots.length ? freeSlots.map((slot) => <div className="availability-free-slot" key={`${slot.starts}-${slot.ends}`}><span>{slot.starts}–{slot.ends}</span><button type="button" className="text-button" onClick={() => addFreeAvailabilitySlot(slot)}><Plus size={13} /> Use</button></div>) : <p className="availability-no-free">No free time in this range.</p>}{availability.map((interval, index) => interval.weekday === weekday && <div className="availability-window" key={`${interval.weekday}-${index}`}><input aria-label={`${weekdayNames[weekday]} start`} type="time" value={interval.starts} onChange={(event) => updateAvailability(availability.map((item, itemIndex) => itemIndex === index ? { ...item, starts: event.target.value } : item))} /><span>to</span><input aria-label={`${weekdayNames[weekday]} end`} type="time" value={interval.ends} onChange={(event) => updateAvailability(availability.map((item, itemIndex) => itemIndex === index ? { ...item, ends: event.target.value } : item))} /><button type="button" className="icon-button availability-remove" aria-label="Remove availability window" onClick={() => removeAvailabilityWindow(index)}><X size={14} /></button></div>)}</div>; })}</div>
              {availabilityError && <p className="form-error" role="alert">{availabilityError}</p>}
              {availabilityConflictsError && <p className="availability-conflict" role="alert">{availabilityConflictsError} Remove or adjust the window before saving.</p>}
              <div className="availability-actions"><button type="button" className="primary-button" onClick={() => void saveAvailability()} disabled={availabilitySaving || Boolean(validateWeeklyAvailability(availability)) || Boolean(availabilityConflictsError)}><Save size={15} /> {availabilitySaving ? "Saving..." : "Save availability"}</button></div>
              <div className="availability-message-heading"><span className="form-field-label">Message to send</span><button type="button" className="secondary-button" onClick={() => void copyAvailabilityMessage()}><Copy size={14} /> Copy message</button></div>
              <textarea className="availability-message" value={availabilityMessage} onChange={(event) => setAvailabilityMessage(event.target.value)} rows={8} />
            </div>
          </section>
        </div>
      </section>

      {lessonDetailsOpen && editingLesson && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setLessonDetailsOpen(false); }}>
        <section className="lesson-modal event-details-modal" role="dialog" aria-modal="true" aria-labelledby="lesson-details-title">
          <div className="modal-heading"><div><p className="section-kicker">Schedule block</p><h2 id="lesson-details-title">{editingLesson.title}</h2><p className="calendar-subtitle">{new Date(`${lessonFormDate}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p></div><button className="modal-close" aria-label="Close schedule details" onClick={() => setLessonDetailsOpen(false)}><X size={18} /></button></div>
          <div className="event-detail-grid"><div><span>Time</span><strong>{editingLesson.time}–{editingLesson.end}</strong></div><div><span>Type</span><strong>{editingLesson.kind === "lesson" ? "Lesson" : "Personal"}</strong></div>{editingLesson.kind === "lesson" && <div><span>Student</span><strong>{students.find((student) => student.id === editingLesson.studentId)?.name ?? "No student linked"}</strong></div>}<div><span>Rate</span><strong>{editingLesson.kind === "lesson" ? `$${editingLesson.rate}/h` : "Not applicable"}</strong></div><div><span>Travel</span><strong>{editingLesson.travelMinutes} minutes</strong></div><div><span>Status</span><strong>{editingLesson.status}</strong></div>{editingLesson.detail && <div className="event-detail-wide"><span>Notes</span><strong>{editingLesson.detail}</strong></div>}</div>
          <div className="modal-footer"><button type="button" className="delete-button" onClick={requestLessonDelete}>Delete block</button><span /><button type="button" className="secondary-button" onClick={() => { setLessonDetailsOpen(false); openLessonEditor(editingLesson); }}>Edit</button></div>
        </section>
      </div>}
      {lessonDeleteConfirmOpen && editingLesson && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !isCloudSaving) setLessonDeleteConfirmOpen(false); }}>
        <section className="lesson-modal delete-scope-modal" role="dialog" aria-modal="true" aria-labelledby="lesson-delete-title">
          <div className="modal-heading"><div><p className="section-kicker">Remove block</p><h2 id="lesson-delete-title">Delete {editingLesson.title}?</h2></div><button className="modal-close" aria-label="Close delete confirmation" disabled={isCloudSaving} onClick={() => setLessonDeleteConfirmOpen(false)}><X size={18} /></button></div>
          <div className="delete-warning"><strong>This cannot be undone.</strong><p>The block will be permanently removed from this schedule.</p></div>
          <div className="modal-footer"><button type="button" className="secondary-button" disabled={isCloudSaving} onClick={() => setLessonDeleteConfirmOpen(false)}>Keep block</button><span /><button type="button" className="delete-button" disabled={isCloudSaving} onClick={() => void deleteLesson()}>Delete block</button></div>
        </section>
      </div>}
      {lessonModalOpen && editingLesson && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setLessonModalOpen(false); }}>
        <section className="lesson-modal" role="dialog" aria-modal="true" aria-labelledby="lesson-modal-title">
          <div className="modal-heading"><div><p className="section-kicker">Schedule block</p><h2 id="lesson-modal-title">{lessons.some((lesson) => lesson.id === editingLesson.id) ? "Edit block" : "Add to your day"}</h2></div><button className="modal-close" aria-label="Close lesson form" onClick={() => setLessonModalOpen(false)}><X size={18} /></button></div>
          <form onSubmit={saveLesson}>
            <div className="form-grid">
              <label className="form-field form-field-wide"><span>Name</span><input autoFocus value={editingLesson.title} onChange={(event) => setEditingLesson({ ...editingLesson, title: event.target.value })} placeholder="e.g. Biology · Alex" /></label>
              <label className="form-field"><span>Date</span><input type="date" value={lessonFormDate} onChange={(event) => { setLessonFormDate(event.target.value); setSelectedDate(event.target.value); }} /></label>
              <label className="form-field"><span>Starts</span><input type="time" value={editingLesson.time} onChange={(event) => setEditingLesson({ ...editingLesson, time: event.target.value })} /></label>
              <label className="form-field"><span>Ends</span><input type="time" value={editingLesson.end} onChange={(event) => setEditingLesson({ ...editingLesson, end: event.target.value })} /></label>
              <label className="form-field form-field-wide"><span>Notes</span><input value={editingLesson.detail} onChange={(event) => setEditingLesson({ ...editingLesson, detail: event.target.value })} placeholder="What is this block for?" /></label>
              <label className="form-field"><span>Type</span><select value={editingLesson.kind} onChange={(event) => { const kind = event.target.value as Lesson["kind"]; setEditingLesson({ ...editingLesson, kind, tone: kind === "lesson" ? defaultLessonTone : "teal", studentId: kind === "lesson" ? editingLesson.studentId : null }); }}><option value="lesson">Lesson</option><option value="personal">Personal</option></select></label>
              <label className="form-field"><span>Student</span><select value={editingLesson.studentId ?? ""} disabled={editingLesson.kind === "personal"} onChange={(event) => setEditingLesson({ ...editingLesson, studentId: event.target.value || null })}><option value="">No student linked</option>{students.map((student) => <option value={student.id} key={student.id}>{student.name}</option>)}</select></label>
              <label className="form-field"><span>Travel minutes</span><input type="number" min="0" value={editingLesson.travelMinutes} onChange={(event) => setEditingLesson({ ...editingLesson, travelMinutes: Number(event.target.value) })} /></label>
              <label className="form-field"><span>Hourly rate</span><input type="number" min="0" step="0.5" value={editingLesson.rate} onChange={(event) => setEditingLesson({ ...editingLesson, rate: Number(event.target.value) })} /></label>
              <div className="tone-picker form-field-wide"><span className="form-field-label">Color</span><div>{eventTones.map((tone) => <button type="button" key={tone} aria-label={`Use ${tone} color`} className={`tone-swatch tone-${tone} ${editingLesson.tone === tone ? "tone-selected" : ""}`} onClick={() => setEditingLesson({ ...editingLesson, tone })}></button>)}</div></div>
              <label className="form-field"><span>Status</span><select value={editingLesson.status} onChange={(event) => setEditingLesson({ ...editingLesson, status: event.target.value as Lesson["status"] })}><option value="scheduled">Scheduled</option><option value="completed">Completed</option></select></label>
            </div>
            {lessonFormError && <p className="form-error">{lessonFormError}</p>}
            <div className="modal-footer"><span /><button type="button" className="secondary-button" onClick={() => setLessonModalOpen(false)}>Cancel</button><button type="submit" className="primary-button" disabled={isCloudSaving}><Save size={15} /> {isCloudSaving ? "Saving..." : "Save block"}</button></div>
          </form>
        </section>
      </div>}
    </main>
  );
}
