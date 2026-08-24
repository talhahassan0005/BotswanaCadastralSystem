"use client";

import { SgDiagram, type DiagramMeta, type DiagramPoint, type DiagramSide } from "@/components/SgDiagram";

const points: DiagramPoint[] = [
  { name: "P1", east: 1000, north: 1000 },
  { name: "P2", east: 1080, north: 1000 },
  { name: "P3", east: 1080, north: 1080 },
  { name: "P4", east: 1000, north: 1080 },
];
const sides: DiagramSide[] = [
  { from: "P1", to: "P2", bearing_dms: "90°00'00\"", distance: 80.0 },
  { from: "P2", to: "P3", bearing_dms: "0°00'00\"", distance: 80.0 },
  { from: "P3", to: "P4", bearing_dms: "270°00'00\"", distance: 80.0 },
  { from: "P4", to: "P1", bearing_dms: "180°00'00\"", distance: 80.0 },
];
const meta: DiagramMeta = {
  lotName: "LOT 1712", parent: "A PORTION OF LOT 322 METSIMOTLHABE",
  parent2: "A PORTION OF LOT 43 METSIMOTLHABE", parent3: "A PORTION OF CADASTRE 87",
  location: "METSIMOTLHABE", tribalArea: "BAKWENA TRIBAL TERRITORY",
  surveyor: "I.N. MULALU", surveyedDate: "MARCH 2022", coordinateSystem: "Lo 27", scale: 1250,
  dsmNo: "1831/94", srNo: "367/94", gpNo: "", degreeSquare: "", beaconDescription: "ALL : 12mm Iron peg",
  areaHa: 0.0877, closed: true, kind: "surveyed",
};

export default function ScratchNormal() {
  return (
    <div style={{ padding: 20, background: "#e2e8f0" }}>
      <SgDiagram meta={meta} points={points} sides={sides} />
    </div>
  );
}
