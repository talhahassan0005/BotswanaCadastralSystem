import { NextResponse } from "next/server";
import { parseSurveyCsv } from "@/lib/server/csv";
import { parseDxf } from "@/lib/dxf";
import { parseShp } from "@/lib/shp";
import { drawingToParseResult } from "@/lib/server/drawing";

export const dynamic = "force-dynamic";

/** Upload a CSV/TXT coordinate file, or a DXF / Shapefile drawing (parent
 *  diagram) -> parsed + validated preview rows. */
export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file was uploaded." }, { status: 400 });
    }

    const ext = (file.name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();

    // CAD drawings we CAN read: pull beacon coordinates out of the drawing so a
    // parent diagram can be loaded straight into Data Import -> COGO / Parcels.
    if (ext === ".dxf") {
      const text = await file.text();
      return NextResponse.json({ filename: file.name, ...drawingToParseResult(parseDxf(text)) });
    }
    if (ext === ".shp") {
      const buf = await file.arrayBuffer();
      return NextResponse.json({ filename: file.name, ...drawingToParseResult(parseShp(buf)) });
    }

    // Drawing formats we cannot read directly (proprietary/binary) — give a
    // clear, actionable next step instead of a parse failure.
    const unreadableDrawings: Record<string, string> = { ".dwg": "DWG", ".dgn": "DGN" };
    if (ext in unreadableDrawings) {
      return NextResponse.json(
        {
          error:
            `${unreadableDrawings[ext]} drawings can't be read directly. In your CAD/survey software, export the ` +
            `drawing to DXF (or export the points to a CSV of Beacon, East, North) and upload that here.`,
        },
        { status: 400 }
      );
    }
    if (ext === ".zip" || ext === ".dbf" || ext === ".shx") {
      return NextResponse.json(
        {
          error:
            "For a Shapefile, unzip the archive and upload the .shp file itself (keep the .dbf / .shx in the same folder).",
        },
        { status: 400 }
      );
    }

    // Other non-coordinate formats.
    const otherFormats: Record<string, string> = {
      ".pdf": "PDF", ".png": "image", ".jpg": "image", ".jpeg": "image", ".tif": "image", ".tiff": "image",
      ".xlsx": "Excel workbook", ".xls": "Excel workbook", ".docx": "Word document", ".mpk": "ArcGIS map package",
    };
    if (ext in otherFormats) {
      return NextResponse.json(
        {
          error:
            `${otherFormats[ext]} files can't be imported here. Please export your points as a CSV or TXT file ` +
            `(columns: Beacon, East, North [, Bearing, Distance]) and upload that.`,
        },
        { status: 400 }
      );
    }

    const text = await file.text();
    return NextResponse.json({ filename: file.name, ...parseSurveyCsv(text) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
