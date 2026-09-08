"use client";

import { FormEvent, useEffect, useState } from "react";
import { ArrowLeft, Check, Clock3, Save, Sparkles, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { EventTone, SchedulePreferences } from "@/lib/schedule/types";

const storageKey = "daylight-settings";
const supabaseConfigured = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);
const tones: EventTone[] = ["blue", "coral", "teal", "yellow", "violet"];

const defaultPreferences: SchedulePreferences = {
  displayName: "Your day",
  timezone: "UTC",
  dailyStaminaLimit: 16,
  weeklyStaminaLimit: 40,
  defaultLessonRate: 35,
  defaultTravelMinutes: 0,
  defaultLessonTone: "coral",
  defaultPersonalTone: "teal",
};

function preferencesFromRow(row: Record<string, unknown>): SchedulePreferences {
  return {
    displayName: String(row.display_name ?? defaultPreferences.displayName),
    timezone: String(row.timezone ?? defaultPreferences.timezone),
    dailyStaminaLimit: Number(row.daily_stamina_limit ?? defaultPreferences.dailyStaminaLimit),
    weeklyStaminaLimit: Number(row.weekly_stamina_limit ?? defaultPreferences.weeklyStaminaLimit),
    defaultLessonRate: Number(row.default_lesson_rate ?? defaultPreferences.defaultLessonRate),
    defaultTravelMinutes: Number(row.default_travel_minutes ?? defaultPreferences.defaultTravelMinutes),
    defaultLessonTone: tones.includes(row.default_lesson_tone as EventTone) ? row.default_lesson_tone as EventTone : defaultPreferences.defaultLessonTone,
    defaultPersonalTone: tones.includes(row.default_personal_tone as EventTone) ? row.default_personal_tone as EventTone : defaultPreferences.defaultPersonalTone,
  };
}

export default function SettingsPage() {
  const router = useRouter();
  const [userId, setUserId] = useState("local");
  const [form, setForm] = useState<SchedulePreferences>(defaultPreferences);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      setError("");
      if (!supabaseConfigured) {
        const stored = window.localStorage.getItem(storageKey);
        if (stored) {
          try { setForm({ ...defaultPreferences, ...(JSON.parse(stored) as Partial<SchedulePreferences>) }); } catch { window.localStorage.removeItem(storageKey); }
        } else {
          setForm({ ...defaultPreferences, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
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
      const { data, error: profileError } = await supabase.from("profiles").select("display_name, timezone, daily_stamina_limit, weekly_stamina_limit, default_lesson_rate, default_travel_minutes, default_lesson_tone, default_personal_tone").eq("id", authData.user.id).maybeSingle();
      if (profileError || !data) {
        const stored = window.localStorage.getItem(storageKey);
        if (stored) {
          try { setForm({ ...defaultPreferences, ...(JSON.parse(stored) as Partial<SchedulePreferences>) }); } catch { window.localStorage.removeItem(storageKey); }
        }
        setError("Cloud preferences are not ready yet; local settings are being used. Apply migration 005 to enable sync.");
      } else {
        setForm(preferencesFromRow(data));
      }
      if (!cancelled) setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [router]);

  useEffect(() => {
    if (!supabaseConfigured) window.localStorage.setItem(storageKey, JSON.stringify(form));
  }, [form]);

  const update = <K extends keyof SchedulePreferences>(key: K, value: SchedulePreferences[K]) => setForm((current) => ({ ...current, [key]: value }));

  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.displayName.trim()) {
      setError("Add a display name first.");
      return;
    }
    if (form.dailyStaminaLimit < 0 || form.weeklyStaminaLimit < 0 || form.defaultLessonRate < 0 || form.defaultTravelMinutes < 0) {
      setError("Numbers cannot be negative.");
      return;
    }
    setSaving(true);
    setError("");
    const nextForm = { ...form, displayName: form.displayName.trim() };
    if (supabaseConfigured && userId !== "local") {
      const result = await createClient().from("profiles").upsert({
        id: userId,
        display_name: nextForm.displayName,
        timezone: nextForm.timezone,
        daily_stamina_limit: nextForm.dailyStaminaLimit,
        weekly_stamina_limit: nextForm.weeklyStaminaLimit,
        default_lesson_rate: nextForm.defaultLessonRate,
        default_travel_minutes: nextForm.defaultTravelMinutes,
        default_lesson_tone: nextForm.defaultLessonTone,
        default_personal_tone: nextForm.defaultPersonalTone,
      });
      if (result.error) {
        setSaving(false);
        setError(result.error.message || "Settings could not be saved.");
        return;
      }
    }
    setForm(nextForm);
    setSaving(false);
    setNotice(supabaseConfigured && userId !== "local" ? "Settings saved to the cloud." : "Settings saved in this browser.");
  };

  return (
    <main className="calendar-shell">
      <header className="calendar-topbar">
        <button className="back-link" onClick={() => router.push("/")}><ArrowLeft size={16} /> Overview</button>
        <div className="calendar-brand"><span className="brand-mark"><Sparkles size={15} /></span><strong>daylight</strong><span>Settings</span></div>
        <button className="profile-mini" aria-label="Open profile" onClick={() => router.push("/")}><UserRound size={17} /></button>
      </header>
      <div className="calendar-content workspace-page settings-page">
        <div className="calendar-intro"><div><p className="section-kicker">Make it yours</p><h1>Settings</h1><p className="calendar-subtitle">Set the defaults that make planning feel like your own rhythm.</p></div></div>
        {notice && <div className="data-success" role="status"><Check size={14} /> {notice}</div>}
        {error && <div className="data-error" role="alert">{error}</div>}
        {loading ? <div className="calendar-empty">Loading settings...</div> : <form onSubmit={saveSettings} className="settings-grid">
          <section className="panel settings-card"><div className="panel-heading"><div><p className="section-kicker">Profile</p><h2>Your details</h2></div><UserRound size={20} className="panel-icon" /></div><div className="settings-card-body"><label className="form-field"><span>Display name</span><input value={form.displayName} onChange={(event) => update("displayName", event.target.value)} /></label><label className="form-field"><span>Timezone</span><input value={form.timezone} onChange={(event) => update("timezone", event.target.value)} placeholder="e.g. Asia/Hong_Kong" /></label></div></section>
          <section className="panel settings-card"><div className="panel-heading"><div><p className="section-kicker">Energy</p><h2>Workload limits</h2></div><Clock3 size={20} className="panel-icon" /></div><div className="settings-card-body settings-two-column"><label className="form-field"><span>Daily stamina limit</span><input type="number" min="0" step="0.5" value={form.dailyStaminaLimit} onChange={(event) => update("dailyStaminaLimit", Number(event.target.value))} /></label><label className="form-field"><span>Weekly stamina limit</span><input type="number" min="0" step="0.5" value={form.weeklyStaminaLimit} onChange={(event) => update("weeklyStaminaLimit", Number(event.target.value))} /></label></div></section>
          <section className="panel settings-card settings-card-wide"><div className="panel-heading"><div><p className="section-kicker">New event defaults</p><h2>Start with less setup</h2></div><Sparkles size={20} className="panel-icon" /></div><div className="settings-card-body settings-two-column"><label className="form-field"><span>Default lesson rate</span><input type="number" min="0" step="0.5" value={form.defaultLessonRate} onChange={(event) => update("defaultLessonRate", Number(event.target.value))} /></label><label className="form-field"><span>Default travel minutes</span><input type="number" min="0" value={form.defaultTravelMinutes} onChange={(event) => update("defaultTravelMinutes", Number(event.target.value))} /></label><div className="tone-picker form-field"><span className="form-field-label">Lesson color</span><div>{tones.map((tone) => <button type="button" key={tone} aria-label={`Use ${tone} for lessons`} className={`tone-swatch tone-${tone} ${form.defaultLessonTone === tone ? "tone-selected" : ""}`} onClick={() => update("defaultLessonTone", tone)} />)}</div></div><div className="tone-picker form-field"><span className="form-field-label">Personal color</span><div>{tones.map((tone) => <button type="button" key={tone} aria-label={`Use ${tone} for personal events`} className={`tone-swatch tone-${tone} ${form.defaultPersonalTone === tone ? "tone-selected" : ""}`} onClick={() => update("defaultPersonalTone", tone)} />)}</div></div></div></section>
          <div className="settings-actions"><span /><button type="submit" className="primary-button" disabled={saving}><Save size={15} /> {saving ? "Saving..." : "Save settings"}</button></div>
        </form>}
      </div>
    </main>
  );
}
