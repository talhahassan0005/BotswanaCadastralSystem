"use client";

import { useEffect, useRef } from "react";
import { Header } from "@/components/Header";
import { ProjectBar } from "@/components/ProjectBar";
import { ProjectGate } from "@/components/ProjectGate";
import { AccountProvider, useAccount } from "@/lib/account";
import { StoreProvider, useStore } from "@/lib/store";
import { DataImport } from "@/modules/DataImport";
import { CogoEngine } from "@/modules/CogoEngine";
import { Traverse } from "@/modules/Traverse";
import { Topographic } from "@/modules/Topographic";
import { Volume } from "@/modules/Volume";
import { Editor } from "@/modules/Editor";
import { RefMarks } from "@/modules/RefMarks";
import { GisMap } from "@/modules/GisMap";
import { Collaborate } from "@/modules/Collaborate";
import { AiValidate } from "@/modules/AiValidate";
import { Diagrams } from "@/modules/Diagrams";
import { Parcels } from "@/modules/Parcels";
import { WorkingPlanView } from "@/modules/WorkingPlanView";
import { GeneralPlanView } from "@/modules/GeneralPlanView";
import { SectionalTitle } from "@/modules/SectionalTitle";
import { SurveyRecord } from "@/modules/SurveyRecord";
import { Export } from "@/modules/Export";

function Workspace() {
  const { activeTab, setActiveTab, loadVersion, resetProject, started } = useStore();
  const { user, ready } = useAccount();

  // Clear the in-memory project when the signed-in surveyor changes or signs out,
  // so one user's data never lingers for the next (and a stale project id can't break Save).
  //
  // `ready` guards this: the initial session check is async, so on every
  // fresh page load `user` starts at its default (no session yet) and then
  // flips to the real signed-in user a moment later. Without this guard
  // that flip looked exactly like "a different surveyor signed in" and
  // called resetProject() on every refresh — wiping the just-restored
  // session (client req 2026-08-23: "refresh sends me back to New/Open
  // Project"). Only start comparing uid once the session check has
  // actually settled, so a real account switch still clears the project,
  // but a plain refresh of the same session never does.
  const prevUid = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!ready) return;
    const uid = user?.id ?? null;
    if (prevUid.current !== undefined && prevUid.current !== uid) resetProject();
    prevUid.current = uid;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, ready]);

  // Stage 1–3 setup gate runs before the working station.
  if (!started) return <ProjectGate />;

  return (
    <div className="min-h-screen">
      <Header activeTab={activeTab} onTab={setActiveTab}>
        <ProjectBar />
      </Header>
      <main className="mx-auto max-w-7xl px-3 py-4 sm:px-6 sm:py-6">
        {/* keyed by loadVersion so opening a project remounts modules with fresh state */}
        <div key={loadVersion}>
          {activeTab === "import" && <DataImport />}
          {activeTab === "cogo" && <CogoEngine />}
          {activeTab === "traverse" && <Traverse />}
          {activeTab === "topo" && <Topographic />}
          {activeTab === "volume" && <Volume />}
          {activeTab === "editor" && <Editor />}
          {activeTab === "gis" && (
            <div className="space-y-4">
              <GisMap />
              <RefMarks />
            </div>
          )}
          {activeTab === "collab" && <Collaborate />}
          {activeTab === "validate" && <AiValidate />}
          {activeTab === "diagrams" && <Diagrams />}
          {activeTab === "parcels" && <Parcels />}
          {activeTab === "workingplan" && <WorkingPlanView />}
          {activeTab === "generalplan" && <GeneralPlanView />}
          {activeTab === "sectional" && <SectionalTitle />}
          {activeTab === "records" && <SurveyRecord />}
          {activeTab === "export" && <Export />}
        </div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <AccountProvider>
      <StoreProvider>
        <Workspace />
      </StoreProvider>
    </AccountProvider>
  );
}
