"use client";

import { supabase } from "./supabaseClient";

export interface Profile {
  full_name: string;
  firm: string;
  phone: string;
  email: string;
}

export async function getProfile(id: string): Promise<{ profile?: Profile; error?: string }> {
  if (!supabase) return { error: "Backend not configured." };
  const { data, error } = await supabase
    .from("profiles")
    .select("full_name,firm,phone,email")
    .eq("id", id)
    .maybeSingle();
  return { profile: (data as Profile) ?? undefined, error: error?.message };
}

export async function upsertProfile(id: string, p: Partial<Profile>): Promise<{ error?: string }> {
  if (!supabase) return { error: "Backend not configured." };
  const { error } = await supabase.from("profiles").upsert({ id, ...p });
  return { error: error?.message };
}
