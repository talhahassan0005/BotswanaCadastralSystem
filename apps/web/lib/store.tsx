"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { CogoResult, ImportResult, TopoResult, ValidationResult, VolumeResult } from "./types";

export type Discipline = "Cadastral" | "Engineering" | "Mining" | "GIS";

/** A numbered plot saved from the Cadastral work station (client req
 *  2026-08-21) — `fig` is the same closed-traverse shape the Diagrams tab
 *  already knows how to draw (points + legs + area), so loading one by
 *  number is a straight drop-in for `diagramFigure`. */
export interface CogoPlot {
  number: string;
  fig: CogoResult;
}

// The "cogo" tab is relabelled "Cadastral" for the Cadastral discipline (client
// req 2026-08-12); other disciplines still call it "COGO Engine". Use this
// wherever UI text refers users to that tab so both stay in sync.
export function cogoTabLabel(discipline: Discipline): string {
  return discipline === "Cadastral" ? "Cadastral" : "COGO Engine";
}

export interface ProjectConfig {
  name: string;
  surveyor: string;
  coordinateSystem: string; // e.g. "Lo 26 Botswana"
  discipline: Discipline; // Stage-3 project type
  traverseType: "closed" | "link" | "open";
  adjustment: "bowditch" | "transit" | "lsq" | "none";
  startBeacon: string;
  dsmLimit: number; // allowable closure denominator (1:N)
  /** Closure tolerance mode (client req 2026-08-21, Part 13c) — "ratio" checks
   *  against dsmLimit (1:N) as before; "absolute" checks the linear misclosure
   *  directly against dsmLimitAbsolute (metres). Optional/undefined = "ratio",
   *  so existing saved projects need no migration. */
  dsmLimitMode?: "ratio" | "absolute";
  dsmLimitAbsolute?: number; // allowable linear misclosure (m), used when dsmLimitMode === "absolute"
  /** Shared display-only rotation (degrees, 0-360; client req 2026-08-28) —
   *  a pure view rotation applied consistently across COGO, Diagrams,
   *  Working Plan and General Plan, like an image editor's rotate control.
   *  Never touches the underlying east/north survey coordinates; undefined
   *  = 0 (no existing saved project needs migration). Set from the COGO
   *  canvas's Rotate slider (CogoWorkspace.tsx), read everywhere the
   *  project's figure is drawn. */
  displayRotation?: number;
}

interface Store {
  config: ProjectConfig;
  setConfig: (c: Partial<ProjectConfig>) => void;
  importResult: ImportResult | null;
  setImportResult: (r: ImportResult | null) => void;
  cogoResult: CogoResult | null;
  setCogoResult: (r: CogoResult | null) => void;
  validation: ValidationResult | null;
  setValidation: (v: ValidationResult | null) => void;
  topoResult: TopoResult | null;
  setTopoResult: (r: TopoResult | null) => void;
  volumeResult: VolumeResult | null;
  setVolumeResult: (r: VolumeResult | null) => void;
  /** Editor drawing — kept here so a project bundle can save/restore it. */
  editorDoc: unknown;
  setEditorDoc: (d: unknown) => void;
  /** Parcel construction doc (beacons + parcels) — saved with the project. */
  parcelDoc: unknown;
  setParcelDoc: (d: unknown) => void;
  /** Sectional-title doc (building sections + quotas) — saved with the project. */
  sectionalDoc: unknown;
  setSectionalDoc: (d: unknown) => void;
  /** Cadastral work station's own drawn geometry — added points, lines,
   *  arcs, polygons, labels, and their attribute tables (client req
   *  2026-08-23: drawing a polygon must survive a refresh, not need
   *  redoing). Separate from `cogoResult` (the computed traverse), since
   *  this is the freehand canvas state CogoWorkspace builds up locally. */
  cogoWorkspaceDoc: unknown;
  setCogoWorkspaceDoc: (d: unknown) => void;
  /** Module input blobs (form state) so projects round-trip the inputs, not just results. */
  diagramInput: unknown;
  setDiagramInput: (d: unknown) => void;
  topoInput: unknown;
  setTopoInput: (d: unknown) => void;
  volumeInput: unknown;
  setVolumeInput: (d: unknown) => void;
  workingPlanInput: unknown;
  setWorkingPlanInput: (d: unknown) => void;
  generalPlanInput: unknown;
  setGeneralPlanInput: (d: unknown) => void;
  recordInput: unknown;
  setRecordInput: (d: unknown) => void;
  /** Parcel→diagram figure: kept SEPARATE so a parcel never clobbers the real COGO traverse. */
  diagramFigure: CogoResult | null;
  setDiagramFigure: (r: CogoResult | null) => void;
  /** Plots numbered in the Cadastral work station (client req 2026-08-21) —
   *  every time a polygon there gets a Lot/Erf number (Position field), it's
   *  saved here by that number so the Diagrams tab can pull it up just by
   *  typing the number, without re-navigating to Cadastral and clicking it
   *  on the canvas. Upserted by number; saved with the project. */
  cogoPlots: CogoPlot[];
  setCogoPlots: (p: CogoPlot[]) => void;
  activeTab: string;
  setActiveTab: (t: string) => void;
  /** Browser-like "back" to the previously-visited tab. */
  goBack: () => void;
  canGoBack: boolean;

  // --- project (cloud) persistence ---
  currentProject: { id: string; name: string } | null;
  setCurrentProject: (p: { id: string; name: string } | null) => void;
  /** Stage gate: false → project setup (Stage 1–3); true → working station. */
  started: boolean;
  setStarted: (v: boolean) => void;
  /** Bumped on hydrate so module subtrees remount and re-read state. */
  loadVersion: number;
  /** Full serialisable project state (for saving). */
  snapshot: () => ProjectState;
  /** Replace all module state from a loaded project (then remount). */
  hydrate: (state: ProjectState) => void;
  resetProject: () => void;
}

export interface ProjectState {
  config?: ProjectConfig;
  importResult?: ImportResult | null;
  cogoResult?: CogoResult | null;
  validation?: ValidationResult | null;
  topoResult?: TopoResult | null;
  volumeResult?: VolumeResult | null;
  editorDoc?: unknown;
  parcelDoc?: unknown;
  sectionalDoc?: unknown;
  cogoWorkspaceDoc?: unknown;
  diagramInput?: unknown;
  topoInput?: unknown;
  volumeInput?: unknown;
  workingPlanInput?: unknown;
  generalPlanInput?: unknown;
  recordInput?: unknown;
  cogoPlots?: CogoPlot[];
}

// Local-session autosave (client req 2026-08-22): a plain page refresh was
// throwing away whatever the user was doing, anywhere in the app — this is
// separate from the explicit cloud "Save Project" (Supabase) feature, which
// the user has to remember to trigger. This is unconditional crash/refresh
// insurance for whatever's currently open, restored silently on next load.
const AUTOSAVE_KEY = "bcs-session-autosave-v1";
interface AutosavedSession extends ProjectState {
  activeTab?: string;
  started?: boolean;
  currentProject?: { id: string; name: string } | null;
}

const DEFAULT_CONFIG: ProjectConfig = {
  name: "Untitled Survey",
  surveyor: "",
  coordinateSystem: "Lo 21 Botswana",
  discipline: "Cadastral",
  traverseType: "closed",
  adjustment: "bowditch",
  startBeacon: "",
  dsmLimit: 3000,
};

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<ProjectConfig>(DEFAULT_CONFIG);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [cogoResult, setCogoResult] = useState<CogoResult | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [topoResult, setTopoResult] = useState<TopoResult | null>(null);
  const [volumeResult, setVolumeResult] = useState<VolumeResult | null>(null);
  // Editor drawing is held in a ref (not state): the Editor writes it synchronously
  // so a Save always captures the latest drawing, and it never re-renders the tree.
  const editorDocRef = useRef<unknown>(null);
  const setEditorDoc = (d: unknown) => { editorDocRef.current = d; };
  const parcelDocRef = useRef<unknown>(null);
  const setParcelDoc = (d: unknown) => { parcelDocRef.current = d; };
  const sectionalDocRef = useRef<unknown>(null);
  const setSectionalDoc = (d: unknown) => { sectionalDocRef.current = d; };
  const cogoWorkspaceDocRef = useRef<unknown>(null);
  const setCogoWorkspaceDoc = (d: unknown) => { cogoWorkspaceDocRef.current = d; };
  // Module input blobs (also refs — synchronous, captured by Save, no re-render).
  const diagramInputRef = useRef<unknown>(null);
  const setDiagramInput = (d: unknown) => { diagramInputRef.current = d; };
  const topoInputRef = useRef<unknown>(null);
  const setTopoInput = (d: unknown) => { topoInputRef.current = d; };
  const volumeInputRef = useRef<unknown>(null);
  const setVolumeInput = (d: unknown) => { volumeInputRef.current = d; };
  const workingPlanInputRef = useRef<unknown>(null);
  const setWorkingPlanInput = (d: unknown) => { workingPlanInputRef.current = d; };
  const generalPlanInputRef = useRef<unknown>(null);
  const setGeneralPlanInput = (d: unknown) => { generalPlanInputRef.current = d; };
  const recordInputRef = useRef<unknown>(null);
  const setRecordInput = (d: unknown) => { recordInputRef.current = d; };
  const [diagramFigure, setDiagramFigure] = useState<CogoResult | null>(null);
  const [cogoPlots, setCogoPlots] = useState<CogoPlot[]>([]);
  const [activeTab, setActiveTabState] = useState("import");
  const [tabHistory, setTabHistory] = useState<string[]>([]);
  // Tab navigation with a simple back-history (so a "← Back" button can return
  // to the previous page/tab).
  const setActiveTab = (t: string) => {
    if (t !== activeTab) setTabHistory((h) => [...h, activeTab]);
    setActiveTabState(t);
  };
  const goBack = () => {
    if (tabHistory.length === 0) return;
    setActiveTabState(tabHistory[tabHistory.length - 1]);
    setTabHistory((h) => h.slice(0, -1));
  };
  const [currentProject, setCurrentProject] = useState<{ id: string; name: string } | null>(null);
  const [started, setStarted] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);

  const setConfig = (c: Partial<ProjectConfig>) =>
    setConfigState((prev) => ({ ...prev, ...c }));

  const snapshot = (): ProjectState => ({
    config,
    importResult,
    cogoResult,
    validation,
    topoResult,
    volumeResult,
    editorDoc: editorDocRef.current,
    parcelDoc: parcelDocRef.current,
    sectionalDoc: sectionalDocRef.current,
    cogoWorkspaceDoc: cogoWorkspaceDocRef.current,
    diagramInput: diagramInputRef.current,
    topoInput: topoInputRef.current,
    volumeInput: volumeInputRef.current,
    workingPlanInput: workingPlanInputRef.current,
    generalPlanInput: generalPlanInputRef.current,
    recordInput: recordInputRef.current,
    cogoPlots,
  });

  const hydrate = (s: ProjectState) => {
    setConfigState({ ...DEFAULT_CONFIG, ...(s.config ?? {}) });
    setImportResult(s.importResult ?? null);
    setCogoResult(s.cogoResult ?? null);
    setValidation(s.validation ?? null);
    setTopoResult(s.topoResult ?? null);
    setVolumeResult(s.volumeResult ?? null);
    editorDocRef.current = s.editorDoc ?? null;
    parcelDocRef.current = s.parcelDoc ?? null;
    sectionalDocRef.current = s.sectionalDoc ?? null;
    cogoWorkspaceDocRef.current = s.cogoWorkspaceDoc ?? null;
    diagramInputRef.current = s.diagramInput ?? null;
    topoInputRef.current = s.topoInput ?? null;
    volumeInputRef.current = s.volumeInput ?? null;
    workingPlanInputRef.current = s.workingPlanInput ?? null;
    generalPlanInputRef.current = s.generalPlanInput ?? null;
    recordInputRef.current = s.recordInput ?? null;
    setCogoPlots(s.cogoPlots ?? []);
    setDiagramFigure(null); // derived from a parcel; not persisted
    setActiveTabState("import"); // land on a tab present in every discipline
    setTabHistory([]); // fresh project → no back-history
    setStarted(true); // opening a project enters the working station
    setLoadVersion((v) => v + 1); // remount modules so they re-read state
  };

  const resetProject = () => {
    setConfigState(DEFAULT_CONFIG);
    setImportResult(null);
    setCogoResult(null);
    setValidation(null);
    setTopoResult(null);
    setVolumeResult(null);
    editorDocRef.current = null;
    parcelDocRef.current = null;
    sectionalDocRef.current = null;
    cogoWorkspaceDocRef.current = null;
    diagramInputRef.current = null;
    topoInputRef.current = null;
    volumeInputRef.current = null;
    workingPlanInputRef.current = null;
    generalPlanInputRef.current = null;
    recordInputRef.current = null;
    setCogoPlots([]);
    setDiagramFigure(null);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem("bcs-editor-v2");
        window.localStorage.removeItem(AUTOSAVE_KEY);
      } catch { /* ignore */ }
    }
    setCurrentProject(null);
    setActiveTabState("import");
    setTabHistory([]);
    setStarted(false); // return to the project-setup gate
    setLoadVersion((v) => v + 1);
  };

  // Restore, once on mount, whatever was last autosaved — unlike hydrate()
  // (used for explicitly opening a named cloud project, which deliberately
  // lands on "import"), this puts the user back exactly where a refresh
  // caught them: same tab, same "started" stage-gate state, everything.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (typeof window === "undefined" || restoredRef.current) return;
    restoredRef.current = true;
    try {
      const raw = window.localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return;
      const saved: AutosavedSession = JSON.parse(raw);
      setConfigState({ ...DEFAULT_CONFIG, ...(saved.config ?? {}) });
      setImportResult(saved.importResult ?? null);
      setCogoResult(saved.cogoResult ?? null);
      setValidation(saved.validation ?? null);
      setTopoResult(saved.topoResult ?? null);
      setVolumeResult(saved.volumeResult ?? null);
      editorDocRef.current = saved.editorDoc ?? null;
      parcelDocRef.current = saved.parcelDoc ?? null;
      sectionalDocRef.current = saved.sectionalDoc ?? null;
      cogoWorkspaceDocRef.current = saved.cogoWorkspaceDoc ?? null;
      diagramInputRef.current = saved.diagramInput ?? null;
      topoInputRef.current = saved.topoInput ?? null;
      volumeInputRef.current = saved.volumeInput ?? null;
      workingPlanInputRef.current = saved.workingPlanInput ?? null;
      generalPlanInputRef.current = saved.generalPlanInput ?? null;
      recordInputRef.current = saved.recordInput ?? null;
      setCogoPlots(saved.cogoPlots ?? []);
      if (saved.currentProject) setCurrentProject(saved.currentProject);
      if (typeof saved.started === "boolean") setStarted(saved.started);
      if (saved.activeTab) setActiveTabState(saved.activeTab);
      setLoadVersion((v) => v + 1); // remount modules so they re-read the restored state
    } catch {
      // Corrupt/blocked storage — start fresh rather than fail to load the app.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Snapshot everything (including the ref-held drawing blobs — snapshot()
  // reads their live .current value each call, so this catches those too,
  // not just the React-state fields in the dependency list below) on an
  // interval and right before the tab closes/refreshes.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const save = () => {
      try {
        const payload: AutosavedSession = { ...snapshot(), activeTab, started, currentProject };
        window.localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
      } catch {
        // Storage full/blocked (e.g. private browsing) — skip this cycle, non-fatal.
      }
    };
    const interval = setInterval(save, 4000);
    window.addEventListener("beforeunload", save);
    return () => {
      clearInterval(interval);
      window.removeEventListener("beforeunload", save);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, importResult, cogoResult, validation, topoResult, volumeResult, cogoPlots, activeTab, started, currentProject]);

  return (
    <StoreContext.Provider
      value={{
        config,
        setConfig,
        importResult,
        setImportResult,
        cogoResult,
        setCogoResult,
        validation,
        setValidation,
        topoResult,
        setTopoResult,
        volumeResult,
        setVolumeResult,
        editorDoc: editorDocRef.current,
        setEditorDoc,
        parcelDoc: parcelDocRef.current,
        setParcelDoc,
        sectionalDoc: sectionalDocRef.current,
        setSectionalDoc,
        cogoWorkspaceDoc: cogoWorkspaceDocRef.current,
        setCogoWorkspaceDoc,
        diagramInput: diagramInputRef.current,
        setDiagramInput,
        topoInput: topoInputRef.current,
        setTopoInput,
        volumeInput: volumeInputRef.current,
        setVolumeInput,
        workingPlanInput: workingPlanInputRef.current,
        setWorkingPlanInput,
        generalPlanInput: generalPlanInputRef.current,
        setGeneralPlanInput,
        recordInput: recordInputRef.current,
        setRecordInput,
        diagramFigure,
        setDiagramFigure,
        cogoPlots,
        setCogoPlots,
        activeTab,
        setActiveTab,
        goBack,
        canGoBack: tabHistory.length > 0,
        currentProject,
        setCurrentProject,
        started,
        setStarted,
        loadVersion,
        snapshot,
        hydrate,
        resetProject,
      }}
    >
      {children}
    </StoreContext.Provider>
  );
}

export function useStore(): Store {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used within StoreProvider");
  return ctx;
}
