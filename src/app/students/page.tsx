"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Archive, CalendarDays, Pencil, Plus, Search, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { addDays, dateKey } from "@/lib/schedule/dates";
import { expandEvents } from "@/lib/schedule/recurrence";
import type { EventKind, EventStatus, EventTone, ScheduleEvent, ScheduleEventException, Student, StudentStatus } from "@/lib/schedule/types";

const storageKey = "daylight-students";
const supabaseConfigured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);

type StudentForm = Pick<Student, "name" | "email" | "phone" | "notes">;
type SummaryOccurrence = { id: string; studentId: string | null; startsAt: string; status: EventStatus };
type StudentSummary = { upcomingCount: number; nextLesson: string | null; recentLesson: string | null; recentCount: number };

const emptyForm: StudentForm = { name: "", email: "", phone: "", notes: "" };

function studentFromRow(row: Record<string, unknown>, userId: string): Student {
  return {
    id: String(row.id),
    userId,
    name: String(row.name ?? ""),
    email: String(row.email ?? ""),
    phone: String(row.phone ?? ""),
    notes: String(row.notes ?? ""),
    status: row.status === "archived" ? "archived" : "active",
  };
}

function eventFromRow(row: Record<string, unknown>, userId: string): ScheduleEvent {
  return {
    id: String(row.id), userId, startsAt: String(row.starts_at), endsAt: String(row.ends_at), timezone: String(row.timezone ?? "Local time"),
    title: String(row.title ?? "Lesson"), detail: String(row.detail ?? ""), kind: row.kind === "personal" ? "personal" : "lesson",
    tone: (row.tone as EventTone) ?? "coral", intensity: Number(row.intensity ?? 2), prepMinutes: Number(row.prep_minutes ?? 0),
    travelMinutes: Number(row.travel_minutes ?? 0), hourlyRate: Number(row.hourly_rate ?? 0), fixedFee: row.fixed_fee == null ? null : Number(row.fixed_fee),
    status: (row.status as EventStatus) ?? "scheduled", recurrenceWeekdays: Array.isArray(row.recurrence_weekdays) ? row.recurrence_weekdays.map(Number) : [],
    recurrenceUntil: row.recurrence_until ? String(row.recurrence_until) : null, studentId: row.student_id ? String(row.student_id) : null,
  };
}

function exceptionFromRow(row: Record<string, unknown>): ScheduleEventException {
  return {
    id: String(row.id), eventId: String(row.event_id), originalStartsAt: String(row.original_starts_at), startsAt: row.starts_at ? String(row.starts_at) : null,
    endsAt: row.ends_at ? String(row.ends_at) : null, status: (row.status as EventStatus) ?? "cancelled", title: row.title ? String(row.title) : null,
    detail: row.detail ? String(row.detail) : null, kind: row.kind as EventKind | null, tone: row.tone as EventTone | null,
    travelMinutes: row.travel_minutes == null ? null : Number(row.travel_minutes), hourlyRate: row.hourly_rate == null ? null : Number(row.hourly_rate),
    fixedFee: row.fixed_fee == null ? null : Number(row.fixed_fee),
  };
}

function summarizeOccurrences(students: Student[], occurrences: SummaryOccurrence[], now = new Date()) {
  const summaries: Record<string, StudentSummary> = {};
  students.forEach((student) => { summaries[student.id] = { upcomingCount: 0, nextLesson: null, recentLesson: null, recentCount: 0 }; });
  occurrences.filter((item) => item.studentId && summaries[item.studentId] && item.status !== "cancelled" && item.status !== "skipped").forEach((item) => {
    const summary = summaries[item.studentId as string];
    const startsAt = new Date(item.startsAt);
    if (startsAt >= now) {
      summary.upcomingCount += 1;
      if (!summary.nextLesson || startsAt < new Date(summary.nextLesson)) summary.nextLesson = item.startsAt;
    } else {
      summary.recentCount += 1;
      if (!summary.recentLesson || startsAt > new Date(summary.recentLesson)) summary.recentLesson = item.startsAt;
    }
  });
  return summaries;
}

function formatLessonDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "None yet";
}

export default function StudentsPage() {
  const router = useRouter();
  const [students, setStudents] = useState<Student[]>([]);
  const [summaries, setSummaries] = useState<Record<string, StudentSummary>>({});
  const [userId, setUserId] = useState("local");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StudentStatus | "all">("active");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editingStudent, setEditingStudent] = useState<Student | null>(null);
  const [form, setForm] = useState<StudentForm>(emptyForm);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError("");
      if (!supabaseConfigured) {
        const stored = window.localStorage.getItem(storageKey);
        let localStudents: Student[] = [];
        if (stored) {
          try { localStudents = JSON.parse(stored) as Student[]; setStudents(localStudents); } catch { window.localStorage.removeItem(storageKey); }
        }
        const now = new Date();
        const localOccurrences: SummaryOccurrence[] = [];
        for (let offset = -90; offset <= 90; offset += 1) {
          const day = addDays(now, offset);
          const dayStorage = window.localStorage.getItem(`daylight-lessons-${dateKey(day)}`);
          if (!dayStorage) continue;
          try {
            const lessons = JSON.parse(dayStorage) as Array<{ studentId?: string | null; time: string; status?: EventStatus; kind?: string }>;
            lessons.forEach((lesson, lessonIndex) => { if (lesson.kind !== "personal" && lesson.studentId) localOccurrences.push({ id: `local-${dateKey(day)}-${lessonIndex}`, studentId: lesson.studentId, startsAt: new Date(`${dateKey(day)}T${lesson.time}:00`).toISOString(), status: lesson.status ?? "scheduled" }); });
          } catch { }
        }
        setSummaries(summarizeOccurrences(localStudents, localOccurrences, now));
        if (!cancelled) setLoading(false);
        return;
      }
      const supabase = createClient();
      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (cancelled) return;
      if (authError || !authData.user) {
        router.push("/login");
        return;
      }
      setUserId(authData.user.id);
      const { data, error: studentError } = await supabase.from("students").select("id, user_id, name, email, phone, notes, status").order("name");
      if (studentError) {
        const stored = window.localStorage.getItem(storageKey);
        if (stored) {
          try { setStudents(JSON.parse(stored) as Student[]); } catch { window.localStorage.removeItem(storageKey); }
        }
        setError("Students cloud storage is not ready yet; local student data is being used. Apply migration 005 to enable sync.");
      } else {
        const loadedStudents = (data ?? []).map((row) => studentFromRow(row, authData.user.id));
        setStudents(loadedStudents);
        const rangeStart = addDays(new Date(), -90);
        const rangeEnd = addDays(new Date(), 91);
        const range = { start: rangeStart, end: rangeEnd };
        const { data: eventData, error: eventError } = await supabase.from("schedule_events").select("id, user_id, starts_at, ends_at, timezone, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, fixed_fee, status, recurrence_weekdays, recurrence_until, student_id").lt("starts_at", rangeEnd.toISOString());
        const eventRows = eventError ? [] : (eventData ?? []);
        const eventIds = eventRows.map((row) => String(row.id));
        const exceptionResult = eventIds.length ? await supabase.from("schedule_event_exceptions").select("id, event_id, original_starts_at, starts_at, ends_at, status, title, detail, kind, tone, travel_minutes, hourly_rate, fixed_fee").in("event_id", eventIds) : { data: [], error: null };
        const canonicalOccurrences = expandEvents(eventRows.map((row) => eventFromRow(row, authData.user.id)), (exceptionResult.data ?? []).map((row) => exceptionFromRow(row)), range)
          .map((occurrence) => ({ id: occurrence.id, studentId: occurrence.studentId, startsAt: occurrence.startsAt, status: occurrence.status }));
        const legacy = await supabase.from("lessons").select("id, user_id, starts_at, ends_at, title, detail, kind, tone, intensity, prep_minutes, travel_minutes, hourly_rate, status, student_id").gte("starts_at", rangeStart.toISOString()).lt("starts_at", rangeEnd.toISOString());
        const legacyOccurrences = (legacy.data ?? [])
          .filter((row) => !eventIds.includes(String(row.id)))
          .map((row) => ({ id: String(row.id), studentId: row.student_id ? String(row.student_id) : null, startsAt: String(row.starts_at), status: (row.status as EventStatus) ?? "scheduled" }));
        setSummaries(summarizeOccurrences(loadedStudents, [...canonicalOccurrences, ...legacyOccurrences]));
      }
      if (!cancelled) setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [router]);

  useEffect(() => {
    if (!supabaseConfigured) window.localStorage.setItem(storageKey, JSON.stringify(students));
  }, [students]);

  const filteredStudents = useMemo(() => students
    .filter((student) => filter === "all" || student.status === filter)
    .filter((student) => `${student.name} ${student.email} ${student.phone} ${student.notes}`.toLowerCase().includes(query.toLowerCase().trim())), [filter, query, students]);

  const openNew = () => {
    setEditingStudent(null);
    setForm(emptyForm);
    setError("");
    setFormOpen(true);
  };

  const openEdit = (student: Student) => {
    setEditingStudent(student);
    setForm({ name: student.name, email: student.email, phone: student.phone, notes: student.notes });
    setError("");
    setFormOpen(true);
  };

  const saveStudent = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.name.trim()) {
      setError("Add the student's name first.");
      return;
    }
    setSaving(true);
    setError("");
    const id = editingStudent?.id ?? crypto.randomUUID();
    const status = editingStudent?.status ?? "active";
    const nextStudent: Student = { id, userId, ...form, name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim(), notes: form.notes.trim(), status };
    if (supabaseConfigured && userId !== "local") {
      const result = await createClient().from("students").upsert({ id, user_id: userId, name: nextStudent.name, email: nextStudent.email, phone: nextStudent.phone, notes: nextStudent.notes, status, updated_at: new Date().toISOString() });
      if (result.error) {
        setSaving(false);
        setError(result.error.message || "The student could not be saved.");
        return;
      }
    }
    setStudents((current) => current.some((student) => student.id === id) ? current.map((student) => student.id === id ? nextStudent : student) : [...current, nextStudent].sort((a, b) => a.name.localeCompare(b.name)));
    setSaving(false);
    setFormOpen(false);
    setNotice(editingStudent ? "Student updated." : "Student added.");
  };

  const toggleArchive = async (student: Student) => {
    const nextStatus: StudentStatus = student.status === "active" ? "archived" : "active";
    setSaving(true);
    setError("");
    if (supabaseConfigured && userId !== "local") {
      const result = await createClient().from("students").update({ status: nextStatus, updated_at: new Date().toISOString() }).eq("id", student.id);
      if (result.error) {
        setSaving(false);
        setError(result.error.message);
        return;
      }
    }
    setStudents((current) => current.map((item) => item.id === student.id ? { ...item, status: nextStatus } : item));
    setSaving(false);
    setNotice(nextStatus === "archived" ? "Student archived." : "Student restored.");
  };

  return (
    <main className="calendar-shell">
      <header className="calendar-topbar">
        <button className="back-link" onClick={() => router.push("/")}><ArrowLeft size={16} /> Overview</button>
        <div className="calendar-brand"><span className="brand-mark"><Sparkles size={15} /></span><strong>daylight</strong><span>Students</span></div>
        <button className="profile-mini" aria-label="Open settings" onClick={() => router.push("/settings")}><CalendarDays size={17} /></button>
      </header>
      <div className="calendar-content workspace-page">
        <div className="calendar-intro"><div><p className="section-kicker">People you teach</p><h1>Students</h1><p className="calendar-subtitle">Keep contact details and lesson relationships in one calm place.</p></div><button className="primary-button" onClick={openNew}><Plus size={17} /> Add student</button></div>
        {notice && <div className="data-success" role="status">{notice}</div>}
        {error && <div className="data-error" role="alert">{error}</div>}
        <section className="workspace-toolbar panel"><label className="workspace-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search students" aria-label="Search students" /></label><div className="view-toggle"><button className={filter === "active" ? "view-active" : ""} onClick={() => setFilter("active")}>Active</button><button className={filter === "archived" ? "view-active" : ""} onClick={() => setFilter("archived")}>Archived</button><button className={filter === "all" ? "view-active" : ""} onClick={() => setFilter("all")}>All</button></div></section>
        {loading ? <div className="calendar-empty">Loading students...</div> : filteredStudents.length ? <section className="student-grid">{filteredStudents.map((student) => { const summary = summaries[student.id] ?? { upcomingCount: 0, nextLesson: null, recentLesson: null, recentCount: 0 }; return <article className="student-card panel" key={student.id}><div className="student-card-heading"><div className="student-avatar">{student.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</div><div><h2>{student.name}</h2><span className={`status-pill status-${student.status}`}>{student.status}</span></div></div><div className="student-contact">{student.email && <span>{student.email}</span>}{student.phone && <span>{student.phone}</span>}{!student.email && !student.phone && <span>No contact details yet</span>}</div><div className="student-summary"><div><span>Upcoming</span><strong>{summary.upcomingCount}</strong></div><div><span>Next lesson</span><strong>{formatLessonDate(summary.nextLesson)}</strong></div><div><span>Recent</span><strong>{summary.recentCount} · {formatLessonDate(summary.recentLesson)}</strong></div></div>{student.notes && <p className="student-notes">{student.notes}</p>}<div className="student-card-footer"><button className="secondary-button" onClick={() => openEdit(student)}><Pencil size={14} /> Edit</button><button className="text-button" onClick={() => router.push(`/calendar?student=${encodeURIComponent(student.id)}`)}><CalendarDays size={14} /> Calendar</button><button className="text-button" onClick={() => void toggleArchive(student)} disabled={saving}><Archive size={14} /> {student.status === "active" ? "Archive" : "Restore"}</button></div></article>; })}</section> : <section className="empty-workspace panel"><div className="empty-workspace-icon"><CalendarDays size={20} /></div><h2>{query ? "No students found" : "Your student list is empty"}</h2><p>{query ? "Try a different search." : "Add your first student to keep lesson planning connected to the people you teach."}</p>{!query && <button className="primary-button" onClick={openNew}><Plus size={16} /> Add student</button>}</section>}
      </div>
      {formOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !saving) setFormOpen(false); }}><section className="lesson-modal" role="dialog" aria-modal="true" aria-labelledby="student-modal-title"><div className="modal-heading"><div><p className="section-kicker">Student record</p><h2 id="student-modal-title">{editingStudent ? "Edit student" : "Add student"}</h2></div><button className="modal-close" aria-label="Close student form" onClick={() => setFormOpen(false)}><X size={18} /></button></div><form onSubmit={saveStudent}><div className="form-grid"><label className="form-field form-field-wide"><span>Name</span><input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Alex Wong" /></label><label className="form-field"><span>Email</span><input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="alex@example.com" /></label><label className="form-field"><span>Phone</span><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="Optional" /></label><label className="form-field form-field-wide"><span>Notes</span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Learning goals, preferences, or context" rows={4} /></label></div>{error && <p className="form-error">{error}</p>}<div className="modal-footer"><span /><button type="button" className="secondary-button" onClick={() => setFormOpen(false)}>Cancel</button><button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save student"}</button></div></form></section></div>}
    </main>
  );
}
