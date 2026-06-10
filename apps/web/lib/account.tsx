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

const origin = () => (typeof window !== "undefined" ? window.location.origin : undefined);

export function AccountProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(!supabaseConfigured); // ready immediately if no backend
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth
      .getSession()
      .then(({ data }) => setUser(data.session?.user ?? null))
      .catch(() => {})
      .finally(() => setReady(true)); // always become interactive, even if the network fails
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      if (event === "PASSWORD_RECOVERY") setRecovery(true); // arrived via a reset link
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  async function signIn(email: string, password: string) {
    if (!supabase) return { error: "Backend not configured." };
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message };
  }
  async function signUp(email: string, password: string, fullName: string) {
    if (!supabase) return { error: "Backend not configured." };
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName }, emailRedirectTo: origin() },
    });
    // If email confirmation is disabled, signUp returns an active session (already signed in).
    return { error: error?.message, needsConfirm: !error && !data.session };
  }
  async function signOut() {
    await supabase?.auth.signOut();
  }
  async function resetPassword(email: string) {
    if (!supabase) return { error: "Backend not configured." };
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: origin() });
    return { error: error?.message };
  }
  async function updatePassword(password: string) {
    if (!supabase) return { error: "Backend not configured." };
    const { error } = await supabase.auth.updateUser({ password });
    if (!error) setRecovery(false);
    return { error: error?.message };
  }
  async function resendConfirmation(email: string) {
    if (!supabase) return { error: "Backend not configured." };
    const { error } = await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: origin() } });
    return { error: error?.message };
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
