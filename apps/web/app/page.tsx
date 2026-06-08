"use client";

import { Header } from "@/components/Header";
import { StoreProvider, useStore } from "@/lib/store";
import { DataImport } from "@/modules/DataImport";
import { CogoEngine } from "@/modules/CogoEngine";
import { Traverse } from "@/modules/Traverse";
import { Topographic } from "@/modules/Topographic";
import { Volume } from "@/modules/Volume";
import { AiValidate } from "@/modules/AiValidate";
import { Diagrams } from "@/modules/Diagrams";
import { Placeholder } from "@/modules/Placeholder";

function Workspace() {
  const { activeTab, setActiveTab } = useStore();

  return (
    <div className="min-h-screen">
      <Header activeTab={activeTab} onTab={setActiveTab} />
      <main className="mx-auto max-w-7xl px-3 py-4 sm:px-6 sm:py-6">
        {activeTab === "import" && <DataImport />}
        {activeTab === "cogo" && <CogoEngine />}
        {activeTab === "traverse" && <Traverse />}
        {activeTab === "topo" && <Topographic />}
        {activeTab === "volume" && <Volume />}
        {activeTab === "validate" && <AiValidate />}
        {activeTab === "diagrams" && <Diagrams />}
        {["parcels", "gis", "export"].includes(activeTab) && (
          <Placeholder tab={activeTab} />
        )}
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <StoreProvider>
      <Workspace />
    </StoreProvider>
  );
}
