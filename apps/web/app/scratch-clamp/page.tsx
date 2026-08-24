"use client";

import { SgDiagram, type DiagramMeta, type DiagramPoint, type DiagramSide } from "@/components/SgDiagram";

const points: DiagramPoint[] = [
  { name: "A", east: 1000, north: 1000 },
  { name: "B", east: 1080, north: 1000 },
  { name: "C", east: 1080, north: 1080 },
  { name: "D", east: 1000, north: 1080 },
  { name: "E", east: 1120, north: 1040 },
  { name: "F", east: 1060, north: 1030 },
];
const sides: DiagramSide[] = [
  { from: "A", to: "B", bearing_dms: "272°36'20\"", distance: 408.24 },
  { from: "B", to: "C", bearing_dms: "0°00'00\"", distance: 831.43 },
  { from: "C", to: "D", bearing_dms: "60°00'00\"", distance: 383.80 },
  { from: "D", to: "E", bearing_dms: "122°13'20\"", distance: 137.81 },
  { from: "E", to: "F", bearing_dms: "212°13'20\"", distance: 138.22 },
  { from: "F", to: "A", bearing_dms: "180°04'30\"", distance: 668.48 },
];
const meta: DiagramMeta = {
  lotName: "Ut fugat consequat222222222222222222222222222",
  parent: "Officiis veniam et 233333333333333333333333333333333333333",
  parent2: "", parent3: "",
  location: "Amet debitis in ut 233333333333333333333333333333333333333",
  tribalArea: "Ea eaque omnis et se23333333333333333333333333333333333333333333333333333333",
  surveyor: "Beatae enim nesciunt2222222222222 quia dolor sit amet consectetur adipiscing",
  surveyedDate: "Non provident iure 2222222222222",
  coordinateSystem: "Lo 23",
  scale: 15000,
  dsmNo: "Sunt qui officia quiwebbbbbbbbbbbbbbbbbbbbbbbbbb",
  srNo: "Eveniet do sed possibkeeeeeeeeee",
  gpNo: "Sed voluptatibus wohkkkkkkkkkkkkl",
  degreeSquare: "Eius sit libero quiwehhhhhhhhhhh",
  dsmFile: "Recusandae Numquam wnnnnnnnnn",
  comp: "Eos voluptas ullamcojhdwwwwwwww",
  lirNo: "Cumque numquam quis",
  parentDiagramNo: "Sapiente magnam et d",
  annexedToNo: "Ex soluta quidem rem",
  annexedDate: "Quia natus aliquam s",
  annexedInFavourOf: "Error nulla culpa u",
  annexName: "xxcskbdkcbsjbdbcksdbcjskdbcckkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
  beaconDescription: "Ducimus nulla in sewebmmmmmmmm",
  areaHa: 35.9793,
  closed: true,
  kind: "compiled",
};

export default function ScratchClamp() {
  return (
    <div style={{ padding: 20, background: "#e2e8f0" }}>
      <SgDiagram meta={meta} points={points} sides={sides} />
    </div>
  );
}
