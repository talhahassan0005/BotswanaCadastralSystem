"use client";

import { useEffect, useState } from "react";
import { useAccount } from "@/lib/account";
import { useStore, type Discipline } from "@/lib/store";
import { listProjects, loadProject, type ProjectRow } from "@/lib/projects";
import { Button, Field, Input, Select } from "@/components/ui";

const COORD_SYSTEMS = [
  "Lo 21 Botswana", "Lo 23 Botswana", "Lo 25 Botswana", "Lo 27 Botswana", "Lo 29 Botswana",
  "UTM 34S", "UTM 35S", "WGS84",
].map((v) => ({ value: v, label: v }));

const DISCIPLINES: { id: Discipline; blurb: string }[] = [
  { id: "Cadastral", blurb: "Parcels, beacons, SG diagrams, lease sketches." },
  { id: "Engineering", blurb: "Topographic surfaces, volumes, set-out." },
  { id: "Mining", blurb: "Pit surveys, stockpile & excavation volumes." },
  { id: "GIS", blurb: "Reference marks, mapping & spatial data." },
];

/**
 * Stage 1 (Log in) → Stage 2 (New / Open project) → Stage 3 (discipline) → working station.
 * Shown until `started` is true; the workstation (full tabbed app) renders after.
 */
export function ProjectGate() {
  const { user, ready, configured, recovery, signIn, signUp, resetPassword, updatePassword, resendConfirmation } = useAccount();
  const { setConfig, setStarted, resetProject, hydrate } = useStore();

  // Online-only for now: if a backend is configured, sign-in is required (no offline bypass).
  const needAuth = configured && !user;

  return (
    <div className="min-h-screen bg-navy-900 text-white">
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-4 py-10">
        <div className="mb-6 flex items-center gap-2 text-2xl font-semibold">
          <span className="grid h-8 w-8 place-items-center rounded bg-brand text-xs font-bold text-white">BC</span>
          <span>Botswana</span><span className="text-brand">Cadastral</span><span>System</span>
        </div>

        {!ready ? (
          <Card><p className="text-slate-300">Loading…</p></Card>
        ) : recovery ? (
          <SetPasswordStage updatePassword={updatePassword} />
        ) : needAuth ? (
          <AuthStage signIn={signIn} signUp={signUp} resetPassword={resetPassword} resendConfirmation={resendConfirmation} />
        ) : (
          <ChooseStage
            loggedIn={!!user}
            onNew={(cfg) => { resetProject(); setConfig(cfg); setStarted(true); }}
            onOpen={async (id) => {
              const { state } = await loadProject(id);
              if (state) hydrate(state); // sets started=true + remounts
            }}
          />
        )}
      </div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl bg-white p-6 text-slate-800 shadow-xl">{children}</div>;
}

// --- Stage 1 ---------------------------------------------------------------
function AuthStage({
  signIn, signUp, resetPassword, resendConfirmation,
}: {
  signIn: (e: string, p: string) => Promise<{ error?: string }>;
  signUp: (e: string, p: string, n: string) => Promise<{ error?: string; needsConfirm?: boolean }>;
  resetPassword: (e: string) => Promise<{ error?: string }>;
  resendConfirmation: (e: string) => Promise<{ error?: string }>;
}) {
  const [mode, setMode] = useState<"in" | "up" | "reset">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const [cooldown, setCooldown] = useState(0); // seconds until an email can be re-sent

  // Tick the resend cooldown down to zero.
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const mmss = `${Math.floor(cooldown / 60)}:${String(cooldown % 60).padStart(2, "0")}`;

  function go(m: "in" | "up" | "reset") { setMode(m); setError(null); setInfo(null); }

  async function submit() {
    setBusy(true); setError(null); setInfo(null);
    if (mode === "reset") {
      const res = await resetPassword(email);
      setBusy(false);
      if (res.error) {
        // Supabase enforces its own email send-rate limit. Don't show a scary
        // error — start the visible countdown so the user simply waits and retries.
        if (/rate limit/i.test(res.error)) {
          setInfo("Too many requests just now — you can send another reset link when the timer ends.");
          setCooldown(120);
        } else {
          setError(res.error);
        }
        return;
      }
      setInfo("If that email has an account, a password-reset link is on its way — check your inbox (and spam).");
      setCooldown(120); // 2-minute visible resend countdown
      return;
    }
    const res = mode === "in" ? await signIn(email, password) : await signUp(email, password, name);
    setBusy(false);
    if (res.error) { setError(res.error); return; }
    if (mode === "up" && (res as { needsConfirm?: boolean }).needsConfirm) {
      setInfo("Account created — check your email to confirm, then log in.");
      setPendingConfirm(true);
      setCooldown(120);
      setMode("in");
    }
    // on success the gate re-renders (user set) and advances to Stage 2 automatically
  }

  async function resend() {
    setBusy(true); setError(null);
    const res = await resendConfirmation(email);
    setBusy(false);
    if (res.error && /rate limit/i.test(res.error)) {
      setInfo("Too many requests just now — you can resend when the timer ends.");
      setCooldown(120);
    } else {
      setInfo(res.error ?? "Confirmation email re-sent — check your inbox (and spam).");
      if (!res.error) setCooldown(120);
    }
  }

  const title = mode === "in" ? "Log in" : mode === "up" ? "Create surveyor account" : "Reset password";
  const onCooldown = cooldown > 0;
  return (
    <Card>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-brand-dark">Stage 1</div>
      <h2 className="mb-4 text-xl font-bold">{title}</h2>
      <div className="space-y-3">
        {mode === "up" && <Field label="Full name"><Input value={name} onChange={setName} placeholder="e.g. G. G. Sesinyi" /></Field>}
        <Field label="Email"><Input value={email} onChange={setEmail} placeholder="you@firm.co.bw" /></Field>
        {mode !== "reset" && <Field label="Password"><Input type="password" value={password} onChange={setPassword} placeholder="••••••••" /></Field>}
        {mode === "in" && (
          <button className="text-xs text-slate-500 underline" onClick={() => go("reset")}>Forgot password?</button>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
        {info && <p className="text-sm text-brand-dark">{info}</p>}
        {pendingConfirm && mode === "in" && (
          <button
            className="block text-xs text-slate-500 underline disabled:no-underline disabled:text-slate-400"
            onClick={resend}
            disabled={busy || onCooldown}
          >
            {onCooldown ? `Resend confirmation email in ${mmss}` : "Resend confirmation email"}
          </button>
        )}
        <div className="flex items-center justify-between">
          <button className="text-xs text-slate-500 underline" onClick={() => go(mode === "in" ? "up" : "in")}>
            {mode === "in" ? "Need an account? Sign up" : "← Back to log in"}
          </button>
          <Button onClick={submit} disabled={busy || (mode === "reset" && onCooldown)}>
            {busy
              ? "…"
              : mode === "in"
              ? "Log in"
              : mode === "up"
              ? "Sign up"
              : onCooldown
              ? `Resend in ${mmss}`
              : "Send reset link"}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function SetPasswordStage({ updatePassword }: { updatePassword: (p: string) => Promise<{ error?: string }> }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setBusy(true); setError(null);
    const res = await updatePassword(password);
    setBusy(false);
    if (res.error) setError(res.error);
    // on success updatePassword clears recovery → gate advances (user is signed in)
  }

  return (
    <Card>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-brand-dark">Reset password</div>
      <h2 className="mb-4 text-xl font-bold">Set a new password</h2>
      <div className="space-y-3">
        <Field label="New password"><Input type="password" value={password} onChange={setPassword} placeholder="••••••••" /></Field>
        <Field label="Confirm password"><Input type="password" value={confirm} onChange={setConfirm} placeholder="••••••••" /></Field>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex justify-end"><Button onClick={submit} disabled={busy}>{busy ? "…" : "Update password"}</Button></div>
      </div>
    </Card>
  );
}

// --- Stage 2 + 3 -----------------------------------------------------------
function ChooseStage({
  loggedIn, onNew, onOpen,
}: {
  loggedIn: boolean;
  onNew: (cfg: { name: string; coordinateSystem: string; surveyor: string; discipline: Discipline }) => void;
  onOpen: (id: string) => void;
}) {
  const [view, setView] = useState<"choose" | "new" | "open">("choose");

  if (view === "new") return <NewProject loggedIn={loggedIn} onBack={() => setView("choose")} onCreate={onNew} />;
  if (view === "open") return <OpenProject loggedIn={loggedIn} onBack={() => setView("choose")} onOpen={onOpen} />;

  return (
    <Card>
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-brand-dark">Stage 2</div>
      <h2 className="mb-4 text-xl font-bold">Start a project</h2>
      <div className="grid gap-3 sm:grid-cols-2">
        <button onClick={() => setView("new")} className="rounded-xl border-2 border-brand/40 bg-brand-light/20 p-6 text-left transition hover:border-brand">
          <div className="text-lg font-semibold text-brand-dark">New Project</div>
          <div className="mt-1 text-sm text-slate-500">Enter project parameters (name, coordinate system) and choose a discipline.</div>
        </button>
        <button onClick={() => setView("open")} className="rounded-xl border-2 border-slate-200 p-6 text-left transition hover:border-slate-400">
          <div className="text-lg font-semibold text-slate-700">Open Project</div>
          <div className="mt-1 text-sm text-slate-500">{loggedIn ? "Select a saved project to continue." : "Sign in to open saved projects."}</div>
        </button>
      </div>
    </Card>
  );
}

function NewProject({
  loggedIn, onBack, onCreate,
}: {
  loggedIn: boolean;
  onBack: () => void;
  onCreate: (cfg: { name: string; coordinateSystem: string; surveyor: string; discipline: Discipline }) => void;
}) {
  const [name, setName] = useState("");
  const [coordinateSystem, setCoord] = useState("Lo 21 Botswana");
  const [surveyor, setSurveyor] = useState("");
  const [discipline, setDiscipline] = useState<Discipline | null>(null);

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-brand-dark">Stage 2 — New Project</span>
        <button onClick={onBack} className="text-xs text-slate-400 underline">← Back</button>
      </div>
      <h2 className="mb-4 text-xl font-bold">Project parameters</h2>
      <div className="space-y-3">
        <Field label="Project name"><Input value={name} onChange={setName} placeholder="e.g. Subdivision of Lot 14182" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Coordinate system"><Select value={coordinateSystem} onChange={setCoord} options={COORD_SYSTEMS} /></Field>
          <Field label="Surveyor (optional)"><Input value={surveyor} onChange={setSurveyor} placeholder="e.g. G. G. Sesinyi" /></Field>
        </div>
      </div>

      <div className="mt-5 mb-1 text-xs font-semibold uppercase tracking-wide text-brand-dark">Stage 3 — Discipline</div>
      <div className="grid gap-2 sm:grid-cols-2">
        {DISCIPLINES.map((d) => (
          <button key={d.id} onClick={() => setDiscipline(d.id)}
            className={`rounded-lg border p-3 text-left transition ${discipline === d.id ? "border-brand bg-brand-light/40" : "border-slate-200 hover:bg-slate-50"}`}>
            <div className="font-semibold text-slate-700">{d.id}</div>
            <div className="text-xs text-slate-500">{d.blurb}</div>
          </button>
        ))}
      </div>

      <div className="mt-5 flex justify-end">
        <Button
          disabled={!name.trim() || !discipline}
          onClick={() => onCreate({ name: name.trim(), coordinateSystem, surveyor: surveyor.trim(), discipline: discipline! })}
        >
          Create project →
        </Button>
      </div>
      {!loggedIn && <p className="mt-2 text-right text-xs text-slate-400">Working offline — use Save in the workstation to keep a local/file copy.</p>}
    </Card>
  );
}

function OpenProject({
  loggedIn, onBack, onOpen,
}: {
  loggedIn: boolean;
  onBack: () => void;
  onOpen: (id: string) => void;
}) {
  const [rows, setRows] = useState<ProjectRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loggedIn) return;
    listProjects().then(({ data, error }) => { setRows(data); if (error) setError(error); });
  }, [loggedIn]);

  return (
    <Card>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-brand-dark">Stage 2 — Open Project</span>
        <button onClick={onBack} className="text-xs text-slate-400 underline">← Back</button>
      </div>
      <h2 className="mb-4 text-xl font-bold">Select a project</h2>
      {!loggedIn && <p className="text-sm text-slate-500">You need to sign in to open saved cloud projects. Go back and create a new project, or sign in.</p>}
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}
      {loggedIn && rows && rows.length === 0 && <p className="text-sm text-slate-500">No saved projects yet — create a new one.</p>}
      <div className="max-h-[50vh] space-y-1 overflow-y-auto">
        {(rows ?? []).map((r) => (
          <button key={r.id} onClick={() => onOpen(r.id)}
            className="flex w-full items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-left hover:bg-slate-50">
            <span className="font-medium text-slate-700">{r.name}</span>
            <span className="text-xs text-slate-400">{new Date(r.updated_at).toLocaleDateString()}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}
