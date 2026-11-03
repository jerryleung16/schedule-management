"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Link2, RotateCw } from "lucide-react";
import {
  checkGoogleCalendarConnection,
  connectGoogleCalendar,
  googleCalendarConfigured,
  googleCalendarConnectionChangedEvent,
  googleCalendarIsConnected,
  googleCalendarNeedsReconnect,
  googleCalendarTokenExpiresAt,
  prepareGoogleCalendar,
} from "@/lib/google-calendar/client";
import { syncSavedScheduleToGoogleCalendar } from "@/lib/google-calendar/sync";

type ConnectionStatus = "checking" | "connected" | "not-connected" | "reconnect-required" | "error";
type ConnectionBusy = "connect" | "sync" | null;
type ConnectionContext = {
  userId: string;
  configured: boolean;
  status: ConnectionStatus;
  busy: ConnectionBusy;
  error: string;
  notice: string;
  connectAndSync: () => Promise<void>;
  sync: () => Promise<void>;
  check: () => Promise<void>;
};

const GoogleCalendarContext = createContext<ConnectionContext | null>(null);

export function useGoogleCalendarConnection() {
  const connection = useContext(GoogleCalendarContext);
  if (!connection) throw new Error("Google Calendar connection is unavailable outside the signed-in workspace.");
  return connection;
}

export function GoogleCalendarConnection({ userId, children }: { userId: string; children: ReactNode }) {
  const pathname = usePathname();
  const configured = googleCalendarConfigured();
  const [status, setStatus] = useState<ConnectionStatus>(configured ? "checking" : "not-connected");
  const [busy, setBusy] = useState<ConnectionBusy>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const operation = useRef(0);
  const running = useRef(false);
  const syncedOnLogin = useRef(false);

  const run = useCallback(async (action: "check" | "connect" | "sync", syncAfterCheck = false) => {
    if (!configured || running.current) return;
    running.current = true;
    const current = ++operation.current;
    const active = () => mounted.current && operation.current === current;
    setError("");
    setNotice("");
    setBusy(action === "check" ? null : action);
    if (action !== "sync") setStatus("checking");
    try {
      if (!navigator.onLine) throw new Error("You are offline. Try again when your connection recovers.");
      if (action === "connect") {
        // Request authorization within the button gesture; login checks never open a popup.
        await connectGoogleCalendar(userId);
        if (!active()) return;
        setStatus("connected");
      } else if (action === "check") {
        let connection = await checkGoogleCalendarConnection(userId);
        if (!active()) return;
        if (connection === "connected" && !googleCalendarIsConnected(userId)) {
          connection = googleCalendarNeedsReconnect(userId) ? "reconnect-required" : "not-connected";
        }
        setStatus(connection);
        if (connection !== "connected" || !syncAfterCheck || syncedOnLogin.current) return;
      } else if (!googleCalendarIsConnected(userId)) {
        if (active()) {
          setStatus(googleCalendarNeedsReconnect(userId) ? "reconnect-required" : "not-connected");
          setError("Connect Google Calendar to sync your saved schedule.");
        }
        return;
      }
      if (!active()) return;
      setBusy("sync");
      await syncSavedScheduleToGoogleCalendar(userId);
      if (!active()) return;
      if (!googleCalendarIsConnected(userId)) {
        setStatus(googleCalendarNeedsReconnect(userId) ? "reconnect-required" : "not-connected");
        return;
      }
      syncedOnLogin.current = true;
      setStatus("connected");
      setNotice("Google Calendar is up to date with your saved schedule.");
    } catch (failure) {
      if (!active()) return;
      syncedOnLogin.current = false;
      setStatus(googleCalendarNeedsReconnect(userId) ? "reconnect-required" : googleCalendarIsConnected(userId) ? "error" : "not-connected");
      setError(failure instanceof Error ? failure.message : "Google Calendar could not be reached. Try again.");
    } finally {
      if (active()) {
        running.current = false;
        setBusy(null);
      }
    }
  }, [configured, userId]);

  const check = useCallback(() => run("check", true), [run]);
  const connectAndSync = useCallback(() => run("connect"), [run]);
  const sync = useCallback(() => run("sync"), [run]);

  useEffect(() => {
    mounted.current = true;
    const prepare = () => { void prepareGoogleCalendar().catch(() => {}); };
    const refresh = () => { void run("check"); };
    const recovered = () => { prepare(); void run("check", true); };
    const changed = (event: StorageEvent) => {
      if (event.key?.startsWith("daylight-google-calendar-")) refresh();
    };
    prepare();
    const initialOperation = operation.current;
    queueMicrotask(() => {
      if (mounted.current && operation.current === initialOperation) void run("check", true);
    });
    window.addEventListener("focus", refresh);
    window.addEventListener("online", recovered);
    window.addEventListener("storage", changed);
    window.addEventListener(googleCalendarConnectionChangedEvent, refresh);
    return () => {
      mounted.current = false;
      operation.current += 1;
      running.current = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", recovered);
      window.removeEventListener("storage", changed);
      window.removeEventListener(googleCalendarConnectionChangedEvent, refresh);
    };
  }, [run]);

  useEffect(() => {
    if (status !== "connected" || busy) return;
    const expiresAt = googleCalendarTokenExpiresAt(userId);
    if (expiresAt === null) return;
    const timer = window.setTimeout(() => { void run("check"); }, Math.max(0, expiresAt - Date.now() - 60_000));
    return () => window.clearTimeout(timer);
  }, [status, busy, run, userId]);

  const inCalendar = pathname === "/calendar" || pathname === "/calendar/";
  const showBanner = configured && !inCalendar && (status !== "connected" || Boolean(error));
  const label = status === "checking" ? "Checking Google Calendar connection..."
    : status === "reconnect-required" ? "Reconnect Google Calendar to keep your schedule synced."
      : status === "not-connected" ? "Connect Google Calendar to sync your schedule."
        : "Google Calendar needs attention.";

  return <GoogleCalendarContext.Provider value={{ userId, configured, status, busy, error, notice, connectAndSync, sync, check }}>
    {showBanner && <aside className="google-connection-banner" aria-label="Google Calendar connection">
      <div className="google-connection-copy"><strong>{label}</strong>{error && <p role="alert">{error}</p>}</div>
      <div className="google-connection-actions">
        {status === "error" ? <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void check()}><RotateCw size={15} /> Retry connection</button>
          : <button type="button" className="primary-button" disabled={Boolean(busy) || status === "checking"} onClick={() => void connectAndSync()}><Link2 size={15} /> {busy === "connect" ? "Connecting..." : busy === "sync" ? "Syncing..." : status === "reconnect-required" ? "Reconnect Google Calendar" : status === "checking" ? "Checking..." : "Connect Google Calendar"}</button>}
      </div>
    </aside>}
    {children}
  </GoogleCalendarContext.Provider>;
}
