"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase, supabaseConfigured } from "./supabaseClient";

interface Account {
  user: User | null;
  ready: boolean;
  configured: boolean;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error?: string; needsConfirm?: boolean }>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<Account | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(!supabaseConfigured); // ready immediately if no backend

  useEffect(() => {
    if (!supabase) return;
    supabase.auth
      .getSession()
      .then(({ data }) => setUser(data.session?.user ?? null))
      .catch(() => {})
      .finally(() => setReady(true)); // always become interactive, even if the network fails
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => setUser(session?.user ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  async function signIn(email: string, password: string) {
    if (!supabase) return { error: "Backend not configured." };
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message };
  }
  async function signUp(email: string, password: string, fullName: string) {
    if (!supabase) return { error: "Backend not configured." };
    const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName } } });
    // If email confirmation is disabled, signUp returns an active session (already signed in).
    return { error: error?.message, needsConfirm: !error && !data.session };
  }
  async function signOut() {
    await supabase?.auth.signOut();
  }

  return (
    <Ctx.Provider value={{ user, ready, configured: supabaseConfigured, signIn, signUp, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAccount(): Account {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAccount must be used within AccountProvider");
  return c;
}
