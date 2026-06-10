"use client";

import { supabase } from "./supabaseClient";

export interface CheckIn {
  id: string;
  surveyor: string; // auth user id
  surveyor_name: string | null;
  project_name: string | null;
  lat: number;
  lon: number;
  note: string | null;
  contact: string | null; // null unless share_contact
  share_contact: boolean;
  active: boolean;
  created_at: string;
}

/** Active check-ins (most recent first) — what other surveyors see for collaboration. */
export async function listActiveCheckIns(): Promise<{ data: CheckIn[]; error?: string }> {
  if (!supabase) return { data: [], error: "Backend not configured." };
  const { data, error } = await supabase
    .from("check_ins")
    .select("*")
    .eq("active", true)
    .order("created_at", { ascending: false });
  return { data: (data as CheckIn[]) ?? [], error: error?.message };
}

export interface CheckInArgs {
  surveyor: string;
  surveyor_name: string;
  project_name: string;
  lat: number;
  lon: number;
  note: string;
  contact: string;
  share_contact: boolean;
}

/** Check in at a location. Deactivates the surveyor's previous check-in (one active at a time). */
export async function checkIn(a: CheckInArgs): Promise<{ id?: string; error?: string }> {
  if (!supabase) return { error: "Backend not configured." };
  await supabase.from("check_ins").update({ active: false }).eq("surveyor", a.surveyor).eq("active", true);
  const row = {
    surveyor: a.surveyor,
    surveyor_name: a.surveyor_name || null,
    project_name: a.project_name || null,
    lat: a.lat,
    lon: a.lon,
    note: a.note || null,
    // DB CHECK enforces contact is null unless sharing — never store a non-sharer's contact.
    contact: a.share_contact ? a.contact || null : null,
    share_contact: a.share_contact,
    active: true,
  };
  const { data, error } = await supabase.from("check_ins").insert(row).select("id").single();
  return { id: data?.id, error: error?.message };
}

/** End the surveyor's active check-in(s). */
export async function checkOut(surveyor: string): Promise<{ error?: string }> {
  if (!supabase) return { error: "Backend not configured." };
  const { error } = await supabase.from("check_ins").update({ active: false }).eq("surveyor", surveyor).eq("active", true);
  return { error: error?.message };
}

/** Live updates: re-run `onChange` whenever any check-in changes. Returns an unsubscribe fn. */
export function subscribeCheckIns(onChange: () => void): () => void {
  if (!supabase) return () => {};
  const channel = supabase
    .channel("check_ins-realtime")
    .on("postgres_changes", { event: "*", schema: "public", table: "check_ins" }, onChange)
    .subscribe();
  return () => { supabase?.removeChannel(channel); };
}
