"use client";

import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import type { CogoResult, ImportResult, TopoResult, ValidationResult, VolumeResult } from "./types";

export type Discipline = "Cadastral" | "Engineering" | "Mining" | "GIS";

export interface ProjectConfig {
  name: string;
  surveyor: string;
  coordinateSystem: string; // e.g. "Lo 26 Botswana"
  discipline: Discipline; // Stage-3 project type
  traverseType: "closed" | "link" | "open";
  adjustment: "bowditch" | "transit" | "lsq" | "none";
  startBeacon: string;
  dsmLimit: number; // allowable closure denominator (1:N)
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
  diagramInput?: unknown;
  topoInput?: unknown;
  volumeInput?: unknown;
  workingPlanInput?: unknown;
  generalPlanInput?: unknown;
  recordInput?: unknown;
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
    diagramInput: diagramInputRef.current,
    topoInput: topoInputRef.current,
    volumeInput: volumeInputRef.current,
    workingPlanInput: workingPlanInputRef.current,
    generalPlanInput: generalPlanInputRef.current,
    recordInput: recordInputRef.current,
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
    diagramInputRef.current = s.diagramInput ?? null;
    topoInputRef.current = s.topoInput ?? null;
    volumeInputRef.current = s.volumeInput ?? null;
    workingPlanInputRef.current = s.workingPlanInput ?? null;
    generalPlanInputRef.current = s.generalPlanInput ?? null;
    recordInputRef.current = s.recordInput ?? null;
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
    diagramInputRef.current = null;
    topoInputRef.current = null;
    volumeInputRef.current = null;
    workingPlanInputRef.current = null;
    generalPlanInputRef.current = null;
    recordInputRef.current = null;
    setDiagramFigure(null);
    if (typeof window !== "undefined") {
      try { window.localStorage.removeItem("bcs-editor-v2"); } catch { /* ignore */ }
    }
    setCurrentProject(null);
    setActiveTabState("import");
    setTabHistory([]);
    setStarted(false); // return to the project-setup gate
    setLoadVersion((v) => v + 1);
  };

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
