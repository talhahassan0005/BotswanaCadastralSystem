"use client";

import { useRef } from "react";
import { Button } from "@/components/ui";
import type { Beacon, Parcel } from "@/lib/types";
import { beaconMap, parcelMetrics, ringPoints } from "@/lib/server/parcel";
import { SgDiagram, type DiagramMeta, type DiagramPoint, type DiagramSide } from "@/components/SgDiagram";

export interface MutationMeta {
  title: string;
  surveyor: string;
  date: string;
  coordinateSystem: string;
}

/**
 * Diagram of Mutation (Module D output): the parent figure with all mutated
 * parcels — rendered on the SAME Botswana SG template as the Diagrams tab so
 * every diagram in the app shares one design (client request). Each parcel is a
 * coloured ring; the table lists every side and coordinate.
 */
export function MutationDiagram({
  beacons,
  parcels,
  meta,
}: {
  beacons: Beacon[];
  parcels: Parcel[];
  meta: MutationMeta;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const by = beaconMap(beacons);

  const drawable = parcels.filter((p) => ringPoints(p.beaconIds, by).length >= 3);
  if (drawable.length === 0) {
    return <p className="text-sm text-slate-500">Create at least one parcel (3+ beacons) to produce a mutation diagram.</p>;
  }

  // SG-template inputs, built per parcel ring so each side lines up with its point.
  const parcelRings = drawable.map((p) => ({
    number: p.number || "(unnumbered)",
    points: ringPoints(p.beaconIds, by).map((pp) => ({ name: pp.name ?? null, east: pp.east, north: pp.north })) as DiagramPoint[],
  }));
  const points: DiagramPoint[] = parcelRings.flatMap((r) => r.points);
  const sides: DiagramSide[] = drawable.flatMap((p) =>
    parcelMetrics(p.beaconIds, by).sides.map((s) => ({ from: s.from, to: s.to, bearing_dms: s.bearing_dms, distance: s.distance }))
  );
  const totalHa = drawable.reduce((sum, p) => sum + parcelMetrics(p.beaconIds, by).area_ha, 0);

  const sgMeta: DiagramMeta = {
    lotName: meta.title || drawable.map((p) => p.number).filter(Boolean).join(", ") || "MUTATION",
    parent: "DIAGRAM OF MUTATION",
    location: "",
    tribalArea: "",
    surveyor: meta.surveyor,
    surveyedDate: meta.date,
    coordinateSystem: meta.coordinateSystem,
    scale: 0, // a mutation overview is not to a fixed scale (figure auto-fits)
    dsmNo: "",
    srNo: "",
    gpNo: "",
    degreeSquare: "",
    beaconDescription: "All Beacons: 12mm Iron Peg",
    areaHa: Math.round(totalHa * 1e4) / 1e4,
    closed: true,
    kind: "surveyed",
  };

  function serialize(): string | null {
    if (!svgRef.current) return null;
    const clone = svgRef.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(clone);
  }
  function download() {
    const svg = serialize();
    if (!svg) return;
    const blob = new Blob([`<?xml version="1.0" encoding="UTF-8"?>\n${svg}`], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mutation-diagram-${(meta.title || "parcels").replace(/\s+/g, "_")}.svg`;
    a.click();
    URL.revokeObjectURL(url);
  }
  function print() {
    const svg = serialize();
    if (!svg) return;
    const w = window.open("", "_blank", "width=900,height=1200");
    if (!w) {
      alert("Pop-up blocked. Please allow pop-ups for this site in your browser, then click Print again.");
      return;
    }
    w.document.write(
      `<html><head><title>Mutation diagram — ${meta.title}</title>` +
        `<style>@page{size:A4 portrait;margin:8mm}body{margin:0}svg{width:100%;height:auto}</style></head>` +
        `<body onload="window.print()">${svg}</body></html>`
    );
    w.document.close();
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button onClick={download}>⬇ Download SVG</Button>
        <Button variant="ghost" onClick={print}>Print / Save PDF</Button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <SgDiagram ref={svgRef} meta={sgMeta} points={points} sides={sides} parcels={parcelRings} />
      </div>
    </div>
  );
}
