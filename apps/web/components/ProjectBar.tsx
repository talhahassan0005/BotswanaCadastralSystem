"use client";

import { useEffect, useState } from "react";
import { useAccount } from "@/lib/account";
import { useStore } from "@/lib/store";
import { deleteProject, listProjects, loadProject, saveProject, type ProjectRow } from "@/lib/projects";
import { Button, Field, Input, Modal } from "@/components/ui";

export function ProjectBar() {
  const { user, ready, configured, signIn, signUp, signOut } = useAccount();
  const { config, snapshot, hydrate, currentProject, setCurrentProject, resetProject } = useStore();

  const [authOpen, setAuthOpen] = useState(false);
  const [openOpen, setOpenOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function doSave(asNew: boolean) {
    if (!user) return;
    const defaultName = currentProject?.name || config.name || "Untitled Survey";
    let name = defaultName;
    if (asNew || !currentProject) {
      const entered = window.prompt("Project name", defaultName);
      if (entered == null) return;
      name = entered.trim() || defaultName;
    }
    setBusy(true);
    setMsg(null);
    const { id, error } = await saveProject({
      id: asNew ? null : currentProject?.id ?? null,
      name,
      state: snapshot(),
      owner: user.id,
    });
    setBusy(false);
    if (error) { setMsg(error); return; }
    if (id) setCurrentProject({ id, name });
    setMsg(`Saved “${name}”.`);
    setTimeout(() => setMsg(null), 2500);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 text-sm sm:px-6">
      <span className="font-medium text-slate-700">
        ▦ {currentProject?.name ?? config.name}
        <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-500">{config.discipline}</span>
      </span>

      {!configured ? (
        <Button variant="ghost" onClick={() => resetProject()}>⌂ Projects</Button>
      ) : !ready ? (
        <span className="text-xs text-slate-400">…</span>
      ) : user ? (
        <>
          <Button variant="ghost" onClick={() => doSave(false)} disabled={busy}>💾 Save</Button>
          <Button variant="ghost" onClick={() => doSave(true)} disabled={busy}>Save as…</Button>
          <Button variant="ghost" onClick={() => setOpenOpen(true)}>📂 Open</Button>
          <Button variant="ghost" onClick={() => resetProject()}>⌂ Projects</Button>
          <span className="ml-auto flex items-center gap-2 text-xs text-slate-500">
            {user.email}
            <button onClick={signOut} className="text-slate-400 underline hover:text-slate-700">sign out</button>
          </span>
        </>
      ) : (
        <>
          <span className="text-xs text-slate-500">Sign in to save & revisit projects from any device.</span>
          <Button variant="ghost" onClick={() => setAuthOpen(true)}>🔑 Sign in</Button>
          <Button variant="ghost" onClick={() => resetProject()}>⌂ Projects</Button>
        </>
      )}

      {msg && <span className="text-xs text-brand-dark">{msg}</span>}

      <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} signIn={signIn} signUp={signUp} />
      <OpenModal
        open={openOpen}
        onClose={() => setOpenOpen(false)}
        onPick={async (id, name) => {
          setBusy(true);
          const { state, error } = await loadProject(id);
          setBusy(false);
          if (error || !state) { setMsg(error ?? "Load failed."); return; }
          hydrate(state);
          setCurrentProject({ id, name });
          setOpenOpen(false);
          setMsg(`Opened “${name}”.`);
        }}
      />
    </div>
  );
}

function AuthModal({
  open, onClose, signIn, signUp,
}: {
  open: boolean;
  onClose: () => void;
  signIn: (e: string, p: string) => Promise<{ error?: string }>;
  signUp: (e: string, p: string, n: string) => Promise<{ error?: string; needsConfirm?: boolean }>;
}) {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function submit() {
    setBusy(true); setError(null); setInfo(null);
    const res = mode === "in" ? await signIn(email, password) : await signUp(email, password, name);
    setBusy(false);
    if (res.error) { setError(res.error); return; }
    if (mode === "up" && (res as { needsConfirm?: boolean }).needsConfirm) {
      setInfo("Account created — check your email to confirm, then sign in.");
      setMode("in");
      return;
    }
    onClose(); // signed in (or auto-signed-in after sign-up when confirmation is off)
  }

  return (
    <Modal open={open} onClose={onClose} title={mode === "in" ? "Sign in" : "Create surveyor account"}>
      <div className="space-y-3">
        {mode === "up" && (
          <Field label="Full name"><Input value={name} onChange={setName} placeholder="e.g. G. G. Sesinyi" /></Field>
        )}
        <Field label="Email"><Input value={email} onChange={setEmail} placeholder="you@firm.co.bw" /></Field>
        <Field label="Password"><Input type="password" value={password} onChange={setPassword} placeholder="••••••••" /></Field>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {info && <p className="text-sm text-brand-dark">{info}</p>}
        <div className="flex items-center justify-between">
          <button className="text-xs text-slate-500 underline" onClick={() => setMode(mode === "in" ? "up" : "in")}>
            {mode === "in" ? "Need an account? Sign up" : "Have an account? Sign in"}
          </button>
          <Button onClick={submit} disabled={busy}>{busy ? "…" : mode === "in" ? "Sign in" : "Sign up"}</Button>
        </div>
      </div>
    </Modal>
  );
}

function OpenModal({
  open, onClose, onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (id: string, name: string) => void;
}) {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    const { data, error } = await listProjects();
    if (error) setError(error);
    setRows(data);
  }
  // Load the list whenever the modal opens.
  useEffect(() => {
    if (open) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <Modal open={open} onClose={onClose} title="Open project">
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      {rows && rows.length === 0 && <p className="text-sm text-slate-500">No saved projects yet.</p>}
      <div className="max-h-[50vh] space-y-1 overflow-y-auto">
        {(rows ?? []).map((r) => (
          <div key={r.id} className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2">
            <button className="flex-1 text-left font-medium text-slate-700" onClick={() => onPick(r.id, r.name)}>
              {r.name}
            </button>
            <span className="text-xs text-slate-400">{new Date(r.updated_at).toLocaleDateString()}</span>
            <button
              className="text-xs text-red-500 hover:text-red-700"
              onClick={async () => { await deleteProject(r.id); refresh(); }}
            >
              delete
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
