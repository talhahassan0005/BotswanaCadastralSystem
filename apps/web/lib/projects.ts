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

export interface ProjectSummary extends ProjectRow {
  /** The lot name entered under Diagrams for this project, if any — pulled
   *  straight out of the saved state's diagramInput (no separate "lot name"
   *  column to keep in sync), falling back to the project's own name. */
  lotName: string;
}

/** Reports tab Statistics view (client req 2026-08-26, Part 32b): total
 *  processed files + their lot numbers. Pulls the full `state` column
 *  (already on this table for loadProject) rather than adding a dedicated
 *  lot-name column — one extra JSON field read is cheap at the project
 *  counts a solo surveyor actually has. */
export async function listProjectSummaries(): Promise<{ data: ProjectSummary[]; error?: string }> {
  if (!supabase) return { data: [], error: "Backend not configured." };
  const { data, error } = await supabase
    .from("projects")
    .select("id,name,updated_at,state")
    .order("updated_at", { ascending: false });
  const rows = ((data as { id: string; name: string; updated_at: string; state?: ProjectState }[]) ?? []).map((r) => {
    const lotName = (r.state?.diagramInput as { meta?: { lotName?: string } } | undefined)?.meta?.lotName;
    return { id: r.id, name: r.name, updated_at: r.updated_at, lotName: lotName || r.name };
  });
  return { data: rows, error: error?.message };
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
  let targetId = args.id;
  if (!targetId) {
    // No known row yet — if this owner already has a project with this exact
    // name, update that one instead of inserting a duplicate (Save behaves
    // like a normal desktop app: same name = same file, not a new copy).
    const { data: existing } = await supabase
      .from("projects")
      .select("id")
      .eq("owner", args.owner)
      .eq("name", args.name)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    targetId = existing?.id ?? null;
  }
  if (targetId) {
    const { data, error } = await supabase
      .from("projects")
      .update({ name: args.name, state: args.state, updated_at: new Date().toISOString() })
      .eq("id", targetId)
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
