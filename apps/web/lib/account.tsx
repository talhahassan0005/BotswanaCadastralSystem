"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase, supabaseConfigured } from "./supabaseClient";

interface Account {
  user: User | null;
  ready: boolean;
  configured: boolean;
  /** True after the user clicks a password-reset link (show a "set new password" screen). */
  recovery: boolean;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error?: string; needsConfirm?: boolean }>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<{ error?: string }>;
  updatePassword: (password: string) => Promise<{ error?: string }>;
  resendConfirmation: (email: string) => Promise<{ error?: string }>;
  clearRecovery: () => void;
}

const Ctx = createContext<Account | null>(null);

// A network-level failure (e.g. the Supabase project is paused/offline so its
// host doesn't resolve) throws a TypeError before any Supabase error is returned.
// Turn that into a clear message instead of a cryptic "Failed to fetch".
const BACKEND_UNREACHABLE =
  "Can't reach the sign-in service right now. The server may be paused or offline — please try again in a few minutes, or contact support if it persists.";
function authError(e: unknown): string {
  const msg = String((e as { message?: string })?.message ?? e ?? "");
  if (e instanceof TypeError || /failed to fetch|networkerror|err_name_not_resolved|load failed|fetch failed/i.test(msg)) {
    return BACKEND_UNREACHABLE;
  }
  return msg || "Something went wrong. Please try again.";
}

// Where auth email links (recovery / confirmation) should land. Prefer the
// configured production domain so links never point at localhost; fall back to
// the current origin when the env var isn't set (e.g. pure local dev).
const origin = () => {
  const configured = process.env.NEXT_PUBLIC_WEBSITE_DOMAIN?.replace(/\/+$/, "");
  if (configured) return configured;
  return typeof window !== "undefined" ? window.location.origin : undefined;
};

export function AccountProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(!supabaseConfigured); // ready immediately if no backend
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    const sb = supabase;

    async function init() {
      // Email links (password recovery + confirmation) come back with the session
      // in the URL hash (#access_token=…&type=recovery). We handle it ourselves —
      // detectSessionInUrl is off — so there is no event-timing race and a reset
      // link reliably opens the "set new password" screen.
      if (typeof window !== "undefined" && window.location.hash.includes("access_token")) {
        const p = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        const access_token = p.get("access_token");
        const refresh_token = p.get("refresh_token");
        const type = p.get("type");
        // Strip the tokens from the address bar so a refresh can't replay them.
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
        if (access_token && refresh_token) {
          const { data } = await sb.auth.setSession({ access_token, refresh_token });
          setUser(data.session?.user ?? null);
          if (type === "recovery") setRecovery(true); // arrived via a reset link
          return;
        }
      }
      const { data } = await sb.auth.getSession();
      setUser(data.session?.user ?? null);
    }

    init()
      .catch(() => {})
      .finally(() => setReady(true)); // always become interactive, even if the network fails

    const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      if (event === "PASSWORD_RECOVERY") setRecovery(true); // belt-and-suspenders
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function signIn(email: string, password: string) {
    if (!supabase) return { error: "Backend not configured." };
    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      return { error: error?.message };
    } catch (e) {
      return { error: authError(e) };
    }
  }
  async function signUp(email: string, password: string, fullName: string) {
    if (!supabase) return { error: "Backend not configured." };
    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: fullName }, emailRedirectTo: origin() },
      });
      if (error) {
        // When email confirmation is OFF, Supabase returns an explicit error here.
        if (/already|registered|exists/i.test(error.message)) {
          return { error: "This email already has an account — please log in instead." };
        }
        return { error: error.message };
      }
      // When email confirmation is ON, Supabase obfuscates a duplicate signup for
      // anti-enumeration: it returns a user with an EMPTY identities array and no
      // session (no email is actually sent). Treat that as "already registered".
      if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
        return { error: "This email already has an account — please log in instead." };
      }
      // If email confirmation is disabled, signUp returns an active session (already signed in).
      return { needsConfirm: !data.session };
    } catch (e) {
      return { error: authError(e) };
    }
  }
  async function signOut() {
    try { await supabase?.auth.signOut(); } catch { /* offline — clear local session anyway */ }
  }
  async function resetPassword(email: string) {
    if (!supabase) return { error: "Backend not configured." };
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: origin() });
      return { error: error?.message };
    } catch (e) {
      return { error: authError(e) };
    }
  }
  async function updatePassword(password: string) {
    if (!supabase) return { error: "Backend not configured." };
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (!error) setRecovery(false);
      return { error: error?.message };
    } catch (e) {
      return { error: authError(e) };
    }
  }
  async function resendConfirmation(email: string) {
    if (!supabase) return { error: "Backend not configured." };
    try {
      const { error } = await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: origin() } });
      return { error: error?.message };
    } catch (e) {
      return { error: authError(e) };
    }
  }

  return (
    <Ctx.Provider
      value={{
        user, ready, configured: supabaseConfigured, recovery,
        signIn, signUp, signOut, resetPassword, updatePassword, resendConfirmation,
        clearRecovery: () => setRecovery(false),
      }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useAccount(): Account {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAccount must be used within AccountProvider");
  return c;
}
