"use client";

import { useEffect, useState } from "react";
import { useAccount } from "@/lib/account";
import { useStore } from "@/lib/store";
import { deleteProject, listProjects, loadProject, saveProject, type ProjectRow } from "@/lib/projects";
import { getProfile, upsertProfile } from "@/lib/profile";
import { Button, Field, Input, Modal } from "@/components/ui";

export function ProjectBar() {
  const { user, ready, configured, signIn, signUp, signOut } = useAccount();
  const { config, snapshot, hydrate, currentProject, setCurrentProject, resetProject } = useStore();

  const [authOpen, setAuthOpen] = useState(false);
  const [openOpen, setOpenOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
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
        {currentProject?.name ?? config.name}
        <span className="ml-2 rounded bg-slate-100 px-2 py-0.5 text-xs font-normal text-slate-500">{config.discipline}</span>
      </span>

      {!configured ? (
        <FileMenu items={[{ label: "Projects (home)", onClick: () => resetProject() }]} />
      ) : !ready ? (
        <span className="text-xs text-slate-400">…</span>
      ) : user ? (
        <>
          <FileMenu
            items={[
              { label: "Save", onClick: () => doSave(false), disabled: busy },
              { label: "Save as…", onClick: () => doSave(true), disabled: busy },
              { label: "Open…", onClick: () => setOpenOpen(true) },
              { label: "Projects (home)", onClick: () => resetProject() },
            ]}
          />
          <span className="ml-auto flex items-center gap-2 text-xs text-slate-500">
            {user.email}
            <button onClick={() => setProfileOpen(true)} className="text-slate-400 underline hover:text-slate-700">profile</button>
            <button onClick={signOut} className="text-slate-400 underline hover:text-slate-700">sign out</button>
          </span>
        </>
      ) : (
        <>
          <FileMenu
            items={[
              { label: "Sign in", onClick: () => setAuthOpen(true) },
              { label: "Projects (home)", onClick: () => resetProject() },
            ]}
          />
          <span className="text-xs text-slate-500">Sign in to save &amp; revisit projects from any device.</span>
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
      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} userId={user?.id ?? ""} email={user?.email ?? ""} />
    </div>
  );
}

/** Desktop-style "File" menu — groups Save / Save as / Open / Projects (client request). */
function FileMenu({ items }: { items: { label: string; onClick: () => void; disabled?: boolean }[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button variant="ghost" onClick={() => setOpen((o) => !o)}>File ▾</Button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 min-w-[170px] rounded-md border border-slate-200 bg-white py-1 shadow-lg">
            {items.map((it) => (
              <button
                key={it.label}
                disabled={it.disabled}
                onClick={() => { setOpen(false); it.onClick(); }}
                className="block w-full px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ProfileModal({ open, onClose, userId, email }: { open: boolean; onClose: () => void; userId: string; email: string }) {
  const [fullName, setFullName] = useState("");
  const [firm, setFirm] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !userId) return;
    setMsg(null);
    getProfile(userId).then(({ profile }) => {
      if (profile) { setFullName(profile.full_name ?? ""); setFirm(profile.firm ?? ""); setPhone(profile.phone ?? ""); }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, userId]);

  async function save() {
    setBusy(true); setMsg(null);
    const { error } = await upsertProfile(userId, { full_name: fullName, firm, phone, email });
    setBusy(false);
    setMsg(error ?? "Saved.");
    if (!error) setTimeout(onClose, 700);
  }

  return (
    <Modal open={open} onClose={onClose} title="Surveyor profile">
      <div className="space-y-3">
        <Field label="Full name"><Input value={fullName} onChange={setFullName} placeholder="e.g. G. G. Sesinyi" /></Field>
        <Field label="Firm"><Input value={firm} onChange={setFirm} placeholder="e.g. Sesinyi Surveys (Pty) Ltd" /></Field>
        <Field label="Phone"><Input value={phone} onChange={setPhone} placeholder="+267 …" /></Field>
        <p className="text-xs text-slate-400">Email: {email}</p>
        {msg && <p className="text-sm text-brand-dark">{msg}</p>}
        <div className="flex justify-end"><Button onClick={save} disabled={busy}>{busy ? "…" : "Save profile"}</Button></div>
      </div>
    </Modal>
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
