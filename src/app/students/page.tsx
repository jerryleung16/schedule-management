"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Archive, CalendarDays, Pencil, Plus, Search, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Student, StudentStatus } from "@/lib/schedule/types";

const storageKey = "daylight-students";
const supabaseConfigured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);

type StudentForm = Pick<Student, "name" | "email" | "phone" | "notes">;

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

export default function StudentsPage() {
  const router = useRouter();
  const [students, setStudents] = useState<Student[]>([]);
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
        if (stored) {
          try { setStudents(JSON.parse(stored) as Student[]); } catch { window.localStorage.removeItem(storageKey); }
        }
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
        setStudents((data ?? []).map((row) => studentFromRow(row, authData.user.id)));
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
        {loading ? <div className="calendar-empty">Loading students...</div> : filteredStudents.length ? <section className="student-grid">{filteredStudents.map((student) => <article className="student-card panel" key={student.id}><div className="student-card-heading"><div className="student-avatar">{student.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase()}</div><div><h2>{student.name}</h2><span className={`status-pill status-${student.status}`}>{student.status}</span></div></div><div className="student-contact">{student.email && <span>{student.email}</span>}{student.phone && <span>{student.phone}</span>}{!student.email && !student.phone && <span>No contact details yet</span>}</div>{student.notes && <p className="student-notes">{student.notes}</p>}<div className="student-card-footer"><button className="secondary-button" onClick={() => openEdit(student)}><Pencil size={14} /> Edit</button><button className="text-button" onClick={() => void toggleArchive(student)} disabled={saving}><Archive size={14} /> {student.status === "active" ? "Archive" : "Restore"}</button></div></article>)}</section> : <section className="empty-workspace panel"><div className="empty-workspace-icon"><CalendarDays size={20} /></div><h2>{query ? "No students found" : "Your student list is empty"}</h2><p>{query ? "Try a different search." : "Add your first student to keep lesson planning connected to the people you teach."}</p>{!query && <button className="primary-button" onClick={openNew}><Plus size={16} /> Add student</button>}</section>}
      </div>
      {formOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !saving) setFormOpen(false); }}><section className="lesson-modal" role="dialog" aria-modal="true" aria-labelledby="student-modal-title"><div className="modal-heading"><div><p className="section-kicker">Student record</p><h2 id="student-modal-title">{editingStudent ? "Edit student" : "Add student"}</h2></div><button className="modal-close" aria-label="Close student form" onClick={() => setFormOpen(false)}><X size={18} /></button></div><form onSubmit={saveStudent}><div className="form-grid"><label className="form-field form-field-wide"><span>Name</span><input autoFocus value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="e.g. Alex Wong" /></label><label className="form-field"><span>Email</span><input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="alex@example.com" /></label><label className="form-field"><span>Phone</span><input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder="Optional" /></label><label className="form-field form-field-wide"><span>Notes</span><textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder="Learning goals, preferences, or context" rows={4} /></label></div>{error && <p className="form-error">{error}</p>}<div className="modal-footer"><span /><button type="button" className="secondary-button" onClick={() => setFormOpen(false)}>Cancel</button><button type="submit" className="primary-button" disabled={saving}>{saving ? "Saving..." : "Save student"}</button></div></form></section></div>}
    </main>
  );
}
