"use client";

import { FormEvent, useState } from "react";
import { ArrowRight, LockKeyhole, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submitLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setIsSubmitting(true);

    const supabase = createClient();
    const { error: loginError } = await supabase.auth.signInWithPassword({ email, password });

    if (loginError) {
      setError(loginError.message);
      setIsSubmitting(false);
      return;
    }

    router.replace("/");
    router.refresh();
  };

  return (
    <main className="auth-shell">
      <section className="auth-art" aria-hidden="true">
        <div className="auth-art-mark"><Sparkles size={19} /></div>
        <p className="auth-art-brand">daylight</p>
        <div className="auth-art-copy"><span>Make room for</span><strong>the life around<br />your lessons.</strong></div>
        <div className="auth-orbit auth-orbit-one" /><div className="auth-orbit auth-orbit-two" /><div className="auth-art-footer">TIME · ENERGY · INTENTION</div>
      </section>
      <section className="auth-card-wrap">
        <div className="auth-card">
          <div className="auth-mobile-brand"><div className="brand-mark"><Sparkles size={18} /></div><span>daylight</span></div>
          <div className="auth-heading"><div className="auth-lock"><LockKeyhole size={17} /></div><p className="section-kicker">Private workspace</p><h1>Welcome back.</h1><p>Sign in to continue to your schedule.</p></div>
          <form className="auth-form" onSubmit={submitLogin}>
            <label className="form-field"><span>Email address</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /></label>
            <label className="form-field"><span>Password</span><input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" /></label>
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button className="auth-submit" type="submit" disabled={isSubmitting}>{isSubmitting ? "Signing in..." : "Sign in"}<ArrowRight size={17} /></button>
          </form>
          <p className="auth-note">Your schedule is private and protected by Supabase.</p>
        </div>
      </section>
    </main>
  );
}
