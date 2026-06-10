"use client";

import { supabase } from "./supabaseClient";
import type { ProjectState } from "./store";

export interface ProjectRow {
  id: string;
  name: string;
  updated_at: string;
}

/** List the signed-in surveyor's projects (most-recent first). */
export async function listProjects(): Promise<{ data: ProjectRow[]; error?: string }> {
  if (!supabase) return { data: [], error: "Backend not configured." };
  const { data, error } = await supabase
    .from("projects")
    .select("id,name,updated_at")
    .order("updated_at", { ascending: false });
  return { data: (data as ProjectRow[]) ?? [], error: error?.message };
}

/** Load a project's full state. */
export async function loadProject(id: string): Promise<{ name?: string; state?: ProjectState; error?: string }> {
  if (!supabase) return { error: "Backend not configured." };
  const { data, error } = await supabase.from("projects").select("name,state").eq("id", id).single();
  return { name: data?.name, state: data?.state as ProjectState, error: error?.message };
}

/** Create or update a project; returns its id. */
export async function saveProject(args: {
  id?: string | null;
  name: string;
  state: ProjectState;
  owner: string;
}): Promise<{ id?: string; error?: string }> {
  if (!supabase) return { error: "Backend not configured." };
  if (args.id) {
    const { data, error } = await supabase
      .from("projects")
      .update({ name: args.name, state: args.state, updated_at: new Date().toISOString() })
      .eq("id", args.id)
      .select("id")
      .maybeSingle();
    if (data?.id) return { id: data.id };
    if (error && error.code !== "PGRST116") return { error: error.message };
    // Row missing / not owned (stale id, deleted elsewhere, or a different user) → create fresh.
  }
  const { data, error } = await supabase
    .from("projects")
    .insert({ name: args.name, state: args.state, owner: args.owner })
    .select("id")
    .single();
  return { id: data?.id, error: error?.message };
}

export async function deleteProject(id: string): Promise<{ error?: string }> {
  if (!supabase) return { error: "Backend not configured." };
  const { error } = await supabase.from("projects").delete().eq("id", id);
  return { error: error?.message };
}
