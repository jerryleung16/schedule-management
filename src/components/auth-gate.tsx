"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { onAuthStateChanged } from "firebase/auth";
import { database } from "@/lib/data/client";
import { cloudConfigured, firebaseConfigurationError, getFirebase } from "@/lib/firebase/client";

export function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [session, setSession] = useState<{ ready: boolean; approved: boolean; error: string }>({ ready: false, approved: false, error: "" });
  const login = pathname === "/login" || pathname === "/login/";
  useEffect(() => {
    if (!cloudConfigured || firebaseConfigurationError) return;
    let generation = 0;
    const unsubscribe = onAuthStateChanged(getFirebase().auth, async user => {
      const current = ++generation;
      setSession({ ready: false, approved: false, error: "" });
      if (!user) { setSession({ ready: true, approved: false, error: "" }); return; }
      const result = await database.auth.getUser();
      if (current === generation) setSession({ ready: true, approved: Boolean(result.data.user), error: result.error?.message ?? "" });
    }, error => setSession({ ready: true, approved: false, error: error.message }));
    return () => { generation++; unsubscribe(); };
  }, []);
  useEffect(() => {
    if (!cloudConfigured || !session.ready || session.error) return;
    if (!session.approved && !login) router.replace("/login");
    if (session.approved && login) router.replace("/");
  }, [session, login, router]);
  if (!cloudConfigured) return children;
  const message = firebaseConfigurationError || session.error;
  if (message) return <main className="auth-card-wrap"><section className="auth-card"><h1>Workspace unavailable</h1><p role="alert">{message}</p>{!firebaseConfigurationError && <button className="auth-submit" onClick={() => { void database.auth.signOut(); }}>Sign out</button>}</section></main>;
  if (!session.ready || (!session.approved && !login) || (session.approved && login)) return <main className="auth-card-wrap"><p role="status">Loading your workspace…</p></main>;
  return children;
}
