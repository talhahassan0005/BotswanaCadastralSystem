"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
// New-style "publishable" key (sb_publishable_…) — safe client-side; data is
// protected by Row-Level Security. Falls back to ANON_KEY name if present.
const key =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** True when Supabase credentials are present. When false the app runs fully
 *  anonymously (local/file save only) — nothing else is disturbed. */
export const supabaseConfigured = Boolean(url && key);

/** Browser Supabase client, or null when not configured. */
export const supabase: SupabaseClient | null = supabaseConfigured
  ? createClient(url!, key!, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;
