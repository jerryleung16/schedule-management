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
import { formatWeeklyAvailabilityMessage, lessonHours, normalizeWeeklyAvailability, slotConflicts, staminaState, validateWeeklyAvailability } from "@/lib/schedule/availability";
import { addDays, dateFromKey, dateKey, rangeForView } from "@/lib/schedule/dates";
import { expandEvents } from "@/lib/schedule/recurrence";
import type { EventStatus, EventTone, ScheduleEvent, ScheduleEventException, ScheduleOccurrence, WeeklyAvailability } from "@/lib/schedule/types";

type IconComponent = typeof LayoutDashboard;

type Lesson = {
  id: string;
  time: string;
  end: string;
  title: string;
  detail: string;
  kind: "lesson" | "personal";
  tone: "blue" | "coral" | "teal" | "yellow";
  intensity: number;
  prepMinutes: number;
  travelMinutes: number;
  rate: number;
  status: "scheduled" | "completed";
};

const storageKey = "daylight-lessons";
const availabilityStorageKey = "daylight-weekly-availability";
const scheduleDate = new Date().toISOString().slice(0, 10);
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
  status: Lesson["status"];
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
      const { data: profileData } = await supabase.from("profiles").select("display_name").eq("id", userData.user.id).maybeSingle();
      if (profileData?.display_name) setDisplayName(profileData.display_name);
      const selectedMonth = new Date(`${selectedDate}T12:00:00`);
      const monthStart = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth(), 1, 0);
      const monthEnd = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + 1, 1, 0);
      let { data: monthData, error: monthError } = await supabase
        .from("schedule_events")
        .select("starts_at, ends_at, hourly_rate, status")
        .gte("starts_at", monthStart.toISOString())
        .lt("starts_at", monthEnd.toISOString());
      if (monthError) {
        const fallbackMonth = await supabase.from("lessons").select("starts_at, ends_at, hourly_rate, status").gte("starts_at", monthStart.toISOString()).lt("starts_at", monthEnd.toISOString());
        monthData = fallbackMonth.data;
        monthError = fallbackMonth.error;
      }
      if (!monthError) {
        const completedMonth = (monthData ?? []).filter((row) => row.status === "completed");
        setMonthlyCompletedCount(completedMonth.length);
        setMonthlyCompletedEarnings(completedMonth.reduce((total, row) => total + ((new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()) / 3600000) * Number(row.hourly_rate), 0));
      }
      const weekRange = rangeForView(selectedMonth, "week");
      const weekStart = weekRange.start;
      const weekEnd = weekRange.end;
      const canonicalWeek = await supabase
        .from("schedule_events")
        .select("id, user_id, starts_at, ends_at, timezone, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, fixed_fee, status, recurrence_weekdays, recurrence_until")
        .lt("starts_at", weekEnd.toISOString())
        .order("starts_at", { ascending: true });
      let weekData = canonicalWeek.data as unknown as Record<string, unknown>[] | null;
      let weekError = canonicalWeek.error;
      if (weekError) {
        const fallbackWeek = await supabase.from("lessons").select("id, user_id, starts_at, ends_at, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, status").gte("starts_at", weekStart.toISOString()).lt("starts_at", weekEnd.toISOString());
        weekData = fallbackWeek.data as unknown as Record<string, unknown>[] | null;
        weekError = fallbackWeek.error;
      }
      if (!weekError) {
        const scheduleEvents = (weekData ?? []).map((row) => scheduleEventFromRow(row, userData.user.id));
        const eventIds = (weekData ?? []).map((row) => row.id);
        let exceptions: ScheduleEventException[] = [];
        if (eventIds.length) {
          const { data: exceptionData } = await supabase.from("schedule_event_exceptions").select("id, event_id, original_starts_at, starts_at, ends_at, status, title, detail, hourly_rate, fixed_fee").in("event_id", eventIds);
          exceptions = (exceptionData ?? []).map((row) => exceptionFromRow(row));
        }
        const expanded = expandEvents(scheduleEvents, exceptions, weekRange);
        setWeeklyOccurrences(expanded);
        setWeeklyLessonHours(lessonHours(expanded));
      }
      let { data, error } = await supabase
        .from("schedule_events")
        .select("id, starts_at, ends_at, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, status")
        .gte("starts_at", new Date(`${selectedDate}T00:00:00`).toISOString())
        .lt("starts_at", new Date(`${selectedDate}T23:59:59`).toISOString())
        .order("starts_at", { ascending: true });
      if (error) {
        const fallback = await supabase
          .from("lessons")
          .select("id, starts_at, ends_at, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, status")
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
        setAvailabilityMessage(formatWeeklyAvailabilityMessage(normalized, Intl.DateTimeFormat().resolvedOptions().timeZone));
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
    setAvailabilityMessage(formatWeeklyAvailabilityMessage(normalized, Intl.DateTimeFormat().resolvedOptions().timeZone));
    setAvailabilityError(validateWeeklyAvailability(normalized));
  };

  const addAvailabilityWindow = (weekday: number) => {
    updateAvailability([...availability, { weekday, starts: "10:00", ends: "11:00" }]);
  };

  const removeAvailabilityWindow = (index: number) => {
    updateAvailability(availability.filter((_, itemIndex) => itemIndex !== index));
  };

  const saveAvailability = async () => {
    const validationError = validateWeeklyAvailability(availability);
    if (validationError) {
      setAvailabilityError(validationError);
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
      tone: "coral",
      intensity: 2,
      prepMinutes: 15,
      travelMinutes: 0,
      rate: 35,
      status: "scheduled",
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
    if (!editingLesson.title.trim()) {
      setLessonFormError("Give this block a name first.");
      return;
    }
    if (minutesFromTime(editingLesson.end) <= minutesFromTime(editingLesson.time)) {
      setLessonFormError("End time must be after the start time.");
      return;
    }
    const proposedStart = new Date(`${lessonFormDate}T${editingLesson.time}:00`);
    const proposedEnd = new Date(`${lessonFormDate}T${editingLesson.end}:00`);
    const editingExisting = lessons.some((lesson) => lesson.id === editingLesson.id);
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
      const { error: scheduleError } = await supabase.from("schedule_events").upsert(lessonToScheduleRow(editingLesson, userId, lessonFormDate));
      const error = scheduleError
        ? (await supabase.from("lessons").upsert(lessonToRow(editingLesson, userId, lessonFormDate))).error
        : null;
      setIsCloudSaving(false);
      if (error) {
        setLessonFormError(error.message);
        return;
      }
    }
    setSelectedDate(lessonFormDate);
    setLessons((current) => current.some((lesson) => lesson.id === editingLesson.id)
      ? current.map((lesson) => lesson.id === editingLesson.id ? editingLesson : lesson)
      : [...current, editingLesson]);
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
  const completedLessons = lessons.filter((lesson) => lesson.kind === "lesson" && lesson.status === "completed");
  const currentEarnings = supabaseConfigured ? monthlyCompletedEarnings : completedLessons.reduce((total, lesson) => total + ((minutesFromTime(lesson.end) - minutesFromTime(lesson.time)) / 60) * lesson.rate, 0);
  const displayedCompletedCount = supabaseConfigured ? monthlyCompletedCount : completedLessons.length;

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
          <button className="nav-item" onClick={() => { setMobileMenuOpen(false); showNotice("Settings will be available in a future update."); }}><Settings2 size={18} /><span>Settings</span></button>
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
              <div className="metric-bottom"><span>{displayedCompletedCount} completed lessons</span><span className="trend-up">Live</span></div>
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
                <div className="time-column"><span>08:00</span><span>10:00</span><span>12:00</span><span>14:00</span><span>16:00</span><span>18:00</span></div>
                <div className="schedule-track">
                  <div className="schedule-line line-1" /><div className="schedule-line line-2" /><div className="schedule-line line-3" /><div className="schedule-line line-4" /><div className="schedule-line line-5" />
                  <div className="now-line"><span>NOW</span></div>
                  {lessons.map((item) => <button className={`schedule-event event-${item.tone}`} key={item.id} onClick={() => openLesson(item)} style={{ top: `${((minutesFromTime(item.time) - 480) / 600) * 100}%`, height: `${((minutesFromTime(item.end) - minutesFromTime(item.time)) / 600) * 100}%` }}>
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
              <p className="availability-intro">Keep your recurring teaching windows here, then send the pattern when a client asks what works.</p>
              <div className="availability-days">{[1, 2, 3, 4, 5, 6, 0].map((weekday) => <div className="availability-day" key={weekday}><div className="availability-day-heading"><strong>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday]}</strong><button type="button" className="text-button" onClick={() => addAvailabilityWindow(weekday)}><Plus size={13} /> Add window</button></div>{availability.map((interval, index) => interval.weekday === weekday && <div className="availability-window" key={`${interval.weekday}-${index}`}><input aria-label={`${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday]} start`} type="time" value={interval.starts} onChange={(event) => updateAvailability(availability.map((item, itemIndex) => itemIndex === index ? { ...item, starts: event.target.value } : item))} /><span>to</span><input aria-label={`${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][weekday]} end`} type="time" value={interval.ends} onChange={(event) => updateAvailability(availability.map((item, itemIndex) => itemIndex === index ? { ...item, ends: event.target.value } : item))} /><button type="button" className="icon-button availability-remove" aria-label="Remove availability window" onClick={() => removeAvailabilityWindow(index)}><X size={14} /></button></div>)}</div>)}</div>
              {availabilityError && <p className="form-error" role="alert">{availabilityError}</p>}
              <div className="availability-actions"><button type="button" className="primary-button" onClick={() => void saveAvailability()} disabled={availabilitySaving}><Save size={15} /> {availabilitySaving ? "Saving..." : "Save availability"}</button></div>
              <div className="availability-message-heading"><span className="form-field-label">Message to send</span><button type="button" className="secondary-button" onClick={() => void copyAvailabilityMessage()}><Copy size={14} /> Copy message</button></div>
              <textarea className="availability-message" value={availabilityMessage} onChange={(event) => setAvailabilityMessage(event.target.value)} rows={8} />
            </div>
          </section>
        </div>
      </section>

      {lessonDetailsOpen && editingLesson && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setLessonDetailsOpen(false); }}>
        <section className="lesson-modal event-details-modal" role="dialog" aria-modal="true" aria-labelledby="lesson-details-title">
          <div className="modal-heading"><div><p className="section-kicker">Schedule block</p><h2 id="lesson-details-title">{editingLesson.title}</h2><p className="calendar-subtitle">{new Date(`${lessonFormDate}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p></div><button className="modal-close" aria-label="Close schedule details" onClick={() => setLessonDetailsOpen(false)}><X size={18} /></button></div>
          <div className="event-detail-grid"><div><span>Time</span><strong>{editingLesson.time}–{editingLesson.end}</strong></div><div><span>Type</span><strong>{editingLesson.kind === "lesson" ? "Lesson" : "Personal"}</strong></div><div><span>Rate</span><strong>{editingLesson.kind === "lesson" ? `$${editingLesson.rate}/h` : "Not applicable"}</strong></div><div><span>Travel</span><strong>{editingLesson.travelMinutes} minutes</strong></div><div><span>Status</span><strong>{editingLesson.status}</strong></div>{editingLesson.detail && <div className="event-detail-wide"><span>Notes</span><strong>{editingLesson.detail}</strong></div>}</div>
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
              <label className="form-field"><span>Type</span><select value={editingLesson.kind} onChange={(event) => setEditingLesson({ ...editingLesson, kind: event.target.value as Lesson["kind"] })}><option value="lesson">Lesson</option><option value="personal">Personal</option></select></label>
              <label className="form-field"><span>Travel minutes</span><input type="number" min="0" value={editingLesson.travelMinutes} onChange={(event) => setEditingLesson({ ...editingLesson, travelMinutes: Number(event.target.value) })} /></label>
              <label className="form-field"><span>Hourly rate</span><input type="number" min="0" step="0.5" value={editingLesson.rate} onChange={(event) => setEditingLesson({ ...editingLesson, rate: Number(event.target.value) })} /></label>
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
