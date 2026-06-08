"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { CogoResult, ImportResult, ValidationResult } from "./types";

export interface ProjectConfig {
  name: string;
  surveyor: string;
  coordinateSystem: string; // e.g. "Lo 26 Botswana"
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
  activeTab: string;
  setActiveTab: (t: string) => void;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<ProjectConfig>({
    name: "Untitled Survey",
    surveyor: "",
    coordinateSystem: "Lo 21 Botswana",
    traverseType: "closed",
    adjustment: "bowditch",
    startBeacon: "",
    dsmLimit: 3000,
  });
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [cogoResult, setCogoResult] = useState<CogoResult | null>(null);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [activeTab, setActiveTab] = useState("import");

  const setConfig = (c: Partial<ProjectConfig>) =>
    setConfigState((prev) => ({ ...prev, ...c }));

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
        activeTab,
        setActiveTab,
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
