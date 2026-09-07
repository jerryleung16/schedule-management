"use client";

import { FormEvent, useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Plus, Sparkles, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { slotConflicts, suggestLessonSlots } from "@/lib/schedule/availability";
import { addDays, dateKey, dateFromKey, formatRangeLabel, rangeForView } from "@/lib/schedule/dates";
import { expandEvents } from "@/lib/schedule/recurrence";
import type { CalendarView, DeleteScope, EventKind, EventStatus, EventTone, ScheduleEvent, ScheduleEventException, ScheduleOccurrence } from "@/lib/schedule/types";

type EventForm = {
  title: string;
  detail: string;
  date: string;
  starts: string;
  ends: string;
  kind: EventKind;
  tone: EventTone;
  intensity: number;
  prepMinutes: number;
  travelMinutes: number;
  hourlyRate: number;
  fixedFee: string;
  status: EventStatus;
  recurring: boolean;
  weekdays: number[];
  recurrenceUntil: string;
};

const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const initialDateKey = "2000-01-01";
const subscribeToBrowser = () => () => {};
const getBrowserDateKey = () => dateKey(new Date());
const getBrowserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const getInitialDateKey = () => initialDateKey;
const getInitialTimezone = () => "Local time";

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
    intensity: 2,
    prepMinutes: 15,
    travelMinutes: 0,
    hourlyRate: 35,
    fixedFee: "",
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
  };
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function occurrenceDay(occurrence: ScheduleOccurrence) {
  return dateKey(new Date(occurrence.startsAt));
}

function eventStyle(occurrence: ScheduleOccurrence, lane: number, laneCount: number) {
  const start = new Date(occurrence.startsAt);
  const end = new Date(occurrence.endsAt);
  const startMinutes = start.getHours() * 60 + start.getMinutes();
  const duration = Math.max(30, (end.getTime() - start.getTime()) / 60000);
  const top = Math.max(0, ((startMinutes - 420) / 900) * 100);
  const height = Math.max(4.5, (duration / 900) * 100);
  return { top: `${top}%`, height: `${height}%`, left: `calc(${(lane / laneCount) * 100}% + 6px)`, width: `calc(${(100 / laneCount)}% - 12px)` };
}

export default function CalendarPage() {
  const router = useRouter();
  const [view, setView] = useState<CalendarView>("week");
  const todayKey = useSyncExternalStore(subscribeToBrowser, getBrowserDateKey, getInitialDateKey);
  const [anchorDate, setAnchorDate] = useState(dateFromKey(initialDateKey));
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [exceptions, setExceptions] = useState<ScheduleEventException[]>([]);
  const [userId, setUserId] = useState("");
  const [profileTimezone, setProfileTimezone] = useState<string | null>(null);
  const browserTimezone = useSyncExternalStore(subscribeToBrowser, getBrowserTimezone, getInitialTimezone);
  const timezone = profileTimezone ?? browserTimezone;
  const hydrated = todayKey !== initialDateKey;
  const activeAnchorDate = anchorDate.getTime() === dateFromKey(initialDateKey).getTime() ? dateFromKey(todayKey) : anchorDate;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [form, setForm] = useState<EventForm>(emptyForm());
  const [selectedOccurrence, setSelectedOccurrence] = useState<ScheduleOccurrence | null>(null);
  const [deleteScopeOpen, setDeleteScopeOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const range = rangeForView(activeAnchorDate, view);
  const rangeEndMs = range.end.getTime();
  const occurrences = expandEvents(events, exceptions, range);
  const suggestionRange = rangeForView(activeAnchorDate, "week");
  const suggestionOccurrences = expandEvents(events, exceptions, suggestionRange);
  const lessonSuggestions = suggestLessonSlots(suggestionRange, suggestionOccurrences);
  const days = Array.from({ length: view === "week" ? 7 : Math.round((range.end.getTime() - range.start.getTime()) / 86400000) }, (_, index) => addDays(range.start, index));

  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError("");
      const supabase = createClient();
      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (cancelled) return;
      if (authError || !authData.user) {
        router.push("/login");
        return;
      }
      setUserId(authData.user.id);
      const { data: profile } = await supabase.from("profiles").select("timezone").eq("id", authData.user.id).maybeSingle();
      if (!cancelled && profile?.timezone) setProfileTimezone(profile.timezone);

      const { data, error: eventError } = await supabase
        .from("schedule_events")
        .select("id, user_id, starts_at, ends_at, timezone, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, fixed_fee, status, recurrence_weekdays, recurrence_until")
        .lt("starts_at", new Date(rangeEndMs).toISOString())
        .order("starts_at", { ascending: true });

      if (!cancelled && !eventError) {
        setEvents((data ?? []).map((row) => eventFromRow(row, authData.user.id)));
        const eventIds = (data ?? []).map((row) => row.id);
        if (eventIds.length) {
          const { data: exceptionData } = await supabase
            .from("schedule_event_exceptions")
            .select("id, event_id, original_starts_at, starts_at, ends_at, status, title, detail, hourly_rate, fixed_fee")
            .in("event_id", eventIds);
          if (!cancelled) setExceptions((exceptionData ?? []).map((row) => exceptionFromRow(row)));
        } else {
          setExceptions([]);
        }
      } else if (!cancelled) {
        const fallback = await supabase.from("lessons").select("id, user_id, starts_at, ends_at, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, status").lt("starts_at", new Date(rangeEndMs).toISOString()).order("starts_at", { ascending: true });
        if (fallback.error) setError("Apply migration 002 to enable the calendar event store.");
        else {
          setEvents((fallback.data ?? []).map((row) => eventFromRow(row, authData.user.id)));
          setExceptions([]);
        }
      }
      if (!cancelled) setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [activeAnchorDate, hydrated, rangeEndMs, router, view]);

  const shiftRange = (amount: number) => {
    setAnchorDate(view === "month" ? new Date(activeAnchorDate.getFullYear(), activeAnchorDate.getMonth() + amount, 1, 12) : addDays(activeAnchorDate, amount * 7));
  };

  const openEditor = (date = dateKey(activeAnchorDate)) => {
    setForm(emptyForm(date));
    setNotice("");
    setEditorOpen(true);
  };

  const saveEvent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    if (!form.title.trim()) {
      setError("Give the event a name first.");
      return;
    }
    const startsAt = new Date(`${form.date}T${form.starts}:00`);
    const endsAt = new Date(`${form.date}T${form.ends}:00`);
    if (endsAt <= startsAt) {
      setError("End time must be after the start time.");
      return;
    }
    if (slotConflicts(startsAt, endsAt, occurrences)) {
      setError("That time overlaps an existing event.");
      return;
    }
    const supabase = createClient();
    const payload = {
      user_id: userId,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      timezone,
      title: form.title.trim(),
      detail: form.detail.trim(),
      kind: form.kind,
      tone: form.tone,
      intensity: form.intensity,
      prep_minutes: form.prepMinutes,
      travel_minutes: form.travelMinutes,
      hourly_rate: form.hourlyRate,
      fixed_fee: form.fixedFee ? Number(form.fixedFee) : null,
      status: form.status,
      recurrence_weekdays: form.recurring ? form.weekdays : [],
      recurrence_until: form.recurring && form.recurrenceUntil ? form.recurrenceUntil : null,
    };
    const { error: saveError } = await supabase.from("schedule_events").insert(payload);
    let fallbackRow: Record<string, unknown> | null = null;
    if (saveError) {
      if (form.recurring) {
        setError("Recurring events need migration 002 applied in Supabase.");
        return;
      }
      const fallback = await supabase.from("lessons").insert({
        id: crypto.randomUUID(),
        user_id: userId,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        title: payload.title,
        detail: payload.detail,
        kind: payload.kind,
        tone: payload.tone,
        intensity: payload.intensity,
        prep_minutes: payload.prep_minutes,
        travel_minutes: payload.travel_minutes,
        hourly_rate: payload.hourly_rate,
        status: payload.status === "completed" ? "completed" : "scheduled",
      }).select("id, user_id, starts_at, ends_at, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, status").single();
      if (fallback.error) {
        setError(fallback.error.message || saveError.message);
        return;
      }
      fallbackRow = fallback.data;
    }
    setEditorOpen(false);
    setNotice(form.recurring ? "Weekly event added to your calendar." : "Event added to your calendar.");
    setAnchorDate(dateFromKey(form.date));
    if (fallbackRow) {
      setEvents((current) => [...current, eventFromRow(fallbackRow, userId)]);
    } else {
      const { data } = await supabase.from("schedule_events").select("id, user_id, starts_at, ends_at, timezone, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, fixed_fee, status, recurrence_weekdays, recurrence_until").lt("starts_at", new Date(rangeEndMs).toISOString()).order("starts_at", { ascending: true });
      if (data) setEvents(data.map((row) => eventFromRow(row, userId)));
    }
  };

  const occurrencesForDay = (day: Date) => occurrences.filter((item) => occurrenceDay(item) === dateKey(day));

  const deleteSelectedOccurrence = async (scope: DeleteScope) => {
    if (!selectedOccurrence) return;
    setDeleting(true);
    setError("");
    const supabase = createClient();
    let deleteError = null;
    if (!selectedOccurrence.isRecurring || scope === "all") {
      const result = await supabase.from("schedule_events").delete().eq("id", selectedOccurrence.id);
      deleteError = result.error;
    } else if (scope === "following" && dateKey(new Date(selectedOccurrence.originalStartsAt)) > dateKey(new Date(selectedOccurrence.startsAt))) {
      const cutoff = new Date(selectedOccurrence.originalStartsAt);
      cutoff.setDate(cutoff.getDate() - 1);
      const result = await supabase.from("schedule_events").update({ recurrence_until: dateKey(cutoff) }).eq("id", selectedOccurrence.id);
      deleteError = result.error;
    } else {
      const result = scope === "following"
        ? await supabase.from("schedule_events").delete().eq("id", selectedOccurrence.id)
        : await supabase.from("schedule_event_exceptions").upsert({ event_id: selectedOccurrence.id, original_starts_at: selectedOccurrence.originalStartsAt, status: "cancelled" }, { onConflict: "event_id,original_starts_at" });
      deleteError = result.error;
    }
    setDeleting(false);
    if (deleteError) {
      setError(deleteError.message);
      return;
    }
    setDeleteScopeOpen(false);
    setSelectedOccurrence(null);
    setNotice(scope === "occurrence" ? "This occurrence was removed." : scope === "following" ? "This and future occurrences were removed." : "The recurring event was deleted.");
    setAnchorDate((current) => new Date(current));
  };

  return (
    <main className="calendar-shell">
      <header className="calendar-topbar">
        <button className="back-link" onClick={() => router.push("/")}><ChevronLeft size={16} /> Overview</button>
        <div className="calendar-brand"><span className="brand-mark"><Sparkles size={15} /></span><strong>daylight</strong><span>Calendar</span></div>
        <button className="profile-mini" aria-label="Back to dashboard" onClick={() => router.push("/")}><CalendarDays size={17} /></button>
      </header>
      <div className="calendar-content">
        <div className="calendar-intro">
          <div><p className="section-kicker">Your time, in view</p><h1>Calendar</h1><p className="calendar-subtitle">Plan one-time blocks and weekly rhythms without losing the shape of your week.</p></div>
          <button className="primary-button" onClick={() => openEditor()}><Plus size={17} /> Add event</button>
        </div>
        {notice && <div className="data-success" role="status">{notice}</div>}
        {error && <div className="data-error" role="alert">{error}</div>}
        <section className="calendar-panel">
          <div className="calendar-toolbar">
            <div className="calendar-toolbar-left"><button className="round-button" aria-label="Previous range" onClick={() => shiftRange(-1)}><ChevronLeft size={17} /></button><button className="round-button" aria-label="Next range" onClick={() => shiftRange(1)}><ChevronRight size={17} /></button><button className="today-button" onClick={() => setAnchorDate(dateFromKey(todayKey))}>Today</button><strong>{formatRangeLabel(activeAnchorDate, view)}</strong></div>
            <div className="view-toggle"><button className={view === "week" ? "view-active" : ""} onClick={() => setView("week")}>Week</button><button className={view === "month" ? "view-active" : ""} onClick={() => setView("month")}>Month</button></div>
          </div>
          {loading ? <div className="calendar-empty">Loading your calendar...</div> : view === "week" ? <div className="week-calendar"><div className="week-gutter" /><div className="week-day-heads">{days.map((day) => <div className="calendar-day-head" key={dateKey(day)}><span>{day.toLocaleDateString("en-US", { weekday: "short" })}</span><strong className={dateKey(day) === todayKey ? "day-today" : ""}>{day.getDate()}</strong></div>)}</div><div className="week-times"><span>07:00</span><span>10:00</span><span>13:00</span><span>16:00</span><span>19:00</span><span>22:00</span></div><div className="week-grid">{days.map((day) => { const dayEvents = occurrencesForDay(day); return <div className="week-day-column" key={dateKey(day)} onDoubleClick={() => openEditor(dateKey(day))}><div className="calendar-hour-lines" />{dayEvents.map((item, index) => <button className={`calendar-event event-${item.tone}`} key={item.occurrenceKey} style={eventStyle(item, index, Math.max(1, dayEvents.length))} onClick={() => { setSelectedOccurrence(item); setNotice(""); setDeleteScopeOpen(true); }}><strong>{item.title}</strong><span>{formatTime(item.startsAt)} · {item.kind === "lesson" ? `$${item.fixedFee ?? item.hourlyRate}/h` : "Personal"}</span></button>)}</div>; })}</div></div> : <div className="month-calendar">{days.map((day) => { const dayEvents = occurrencesForDay(day); const outside = day.getMonth() !== activeAnchorDate.getMonth(); return <div className={`month-day ${outside ? "month-day-outside" : ""}`} key={dateKey(day)} onDoubleClick={() => openEditor(dateKey(day))}><div className="month-day-number"><span>{day.toLocaleDateString("en-US", { weekday: "short" })}</span><strong className={dateKey(day) === todayKey ? "day-today" : ""}>{day.getDate()}</strong></div>{dayEvents.slice(0, 4).map((item) => <button className={`month-event event-${item.tone}`} key={item.occurrenceKey} onClick={() => { setSelectedOccurrence(item); setNotice(""); setDeleteScopeOpen(true); }}>{formatTime(item.startsAt)} {item.title}</button>)}{dayEvents.length > 4 && <span className="more-events">+{dayEvents.length - 4} more</span>}</div>; })}</div>}
        </section>
        <p className="calendar-footnote"><Clock3 size={14} /> {timezone} · Double-click a day to add an event.</p>
      </div>
      {editorOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setEditorOpen(false); }}><section className="lesson-modal calendar-editor" role="dialog" aria-modal="true" aria-labelledby="event-modal-title"><div className="modal-heading"><div><p className="section-kicker">Calendar event</p><h2 id="event-modal-title">Add to your time</h2></div><button className="modal-close" aria-label="Close event form" onClick={() => setEditorOpen(false)}><X size={18} /></button></div><form onSubmit={saveEvent}><div className="form-grid"><label className="form-field form-field-wide"><span>Name</span><input autoFocus value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} placeholder="e.g. Biology · Alex" /></label><label className="form-field form-field-wide"><span>Notes</span><input value={form.detail} onChange={(event) => setForm({ ...form, detail: event.target.value })} placeholder="What is this block for?" /></label><label className="form-field"><span>Date</span><input type="date" value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} /></label><label className="form-field"><span>Type</span><select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as EventKind })}><option value="lesson">Lesson</option><option value="personal">Personal</option></select></label><label className="form-field"><span>Starts</span><input type="time" value={form.starts} onChange={(event) => setForm({ ...form, starts: event.target.value })} /></label><label className="form-field"><span>Ends</span><input type="time" value={form.ends} onChange={(event) => setForm({ ...form, ends: event.target.value })} /></label><label className="form-field"><span>Hourly rate</span><input type="number" min="0" step="0.5" value={form.hourlyRate} onChange={(event) => setForm({ ...form, hourlyRate: Number(event.target.value) })} /></label><label className="form-field"><span>Fixed fee</span><input type="number" min="0" step="0.5" value={form.fixedFee} onChange={(event) => setForm({ ...form, fixedFee: event.target.value })} placeholder="Optional" /></label><label className="form-field"><span>Repeat</span><select value={form.recurring ? "weekly" : "once"} onChange={(event) => setForm({ ...form, recurring: event.target.value === "weekly" })}><option value="once">One time</option><option value="weekly">Weekly</option></select></label>{form.recurring && <label className="form-field"><span>Repeat until</span><input type="date" min={form.date} value={form.recurrenceUntil} onChange={(event) => setForm({ ...form, recurrenceUntil: event.target.value })} /> </label>}{form.recurring && <div className="weekday-picker form-field-wide"><span className="form-field-label">Days</span><div>{weekdayLabels.map((label, index) => <button type="button" className={form.weekdays.includes(index) ? "weekday-active" : ""} key={label} onClick={() => setForm({ ...form, weekdays: form.weekdays.includes(index) ? form.weekdays.filter((day) => day !== index) : [...form.weekdays, index] })}>{label}</button>)}</div></div>}<label className="form-field"><span>Intensity</span><input type="number" min="0" max="10" step="0.5" value={form.intensity} onChange={(event) => setForm({ ...form, intensity: Number(event.target.value) })} /></label><label className="form-field"><span>Prep minutes</span><input type="number" min="0" value={form.prepMinutes} onChange={(event) => setForm({ ...form, prepMinutes: Number(event.target.value) })} /></label></div>{form.kind === "lesson" && <div className="suggested-slots"><span className="form-field-label">Suggested openings</span><div className="suggested-slot-list">{lessonSuggestions.map((slot) => <button type="button" className="suggested-slot" key={`${slot.date}-${slot.starts}-${slot.ends}`} onClick={() => { setForm({ ...form, date: slot.date, starts: slot.starts, ends: slot.ends }); setAnchorDate(dateFromKey(slot.date)); }}>{dateFromKey(slot.date).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} · {slot.starts}–{slot.ends} · {slot.durationMinutes === 60 ? "1 hr" : "1.5 hrs"}</button>)}{lessonSuggestions.length === 0 && <p className="suggested-slot-empty">No open slots found this week.</p>}</div></div>}{error && <p className="form-error">{error}</p>}<div className="modal-footer"><span /><button type="button" className="secondary-button" onClick={() => setEditorOpen(false)}>Cancel</button><button type="submit" className="primary-button"><Plus size={15} /> Save event</button></div></form></section></div>}
      {deleteScopeOpen && selectedOccurrence && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !deleting) setDeleteScopeOpen(false); }}><section className="lesson-modal delete-scope-modal" role="dialog" aria-modal="true" aria-labelledby="delete-event-title"><div className="modal-heading"><div><p className="section-kicker">Remove event</p><h2 id="delete-event-title">{selectedOccurrence.title}</h2><p className="calendar-subtitle">{formatTime(selectedOccurrence.startsAt)} · {new Date(selectedOccurrence.startsAt).toLocaleDateString()}</p></div><button className="modal-close" aria-label="Close delete dialog" disabled={deleting} onClick={() => setDeleteScopeOpen(false)}><X size={18} /></button></div>{selectedOccurrence.isRecurring ? <div className="delete-scope-options"><button className="secondary-button" disabled={deleting} onClick={() => void deleteSelectedOccurrence("occurrence")}>This occurrence</button><button className="secondary-button" disabled={deleting} onClick={() => void deleteSelectedOccurrence("following")}>This and following</button><button className="primary-button" disabled={deleting} onClick={() => void deleteSelectedOccurrence("all")}>All events in series</button></div> : <div className="modal-footer"><span>Delete this event?</span><button className="secondary-button" disabled={deleting} onClick={() => setDeleteScopeOpen(false)}>Keep it</button><button className="primary-button" disabled={deleting} onClick={() => void deleteSelectedOccurrence("all")}>Delete event</button></div>}</section></div>}
    </main>
  );
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