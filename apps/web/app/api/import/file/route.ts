import { NextResponse } from "next/server";
import ExcelJS from "exceljs";
import { parseSurveyCsv } from "@/lib/server/csv";
import { parseDxf } from "@/lib/dxf";
import { parseShp } from "@/lib/shp";
import { drawingToParseResult } from "@/lib/server/drawing";

/** One CSV-safe cell: quoted (with embedded quotes doubled) only when it
 *  contains something that would otherwise break the delimiter/line. */
function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Excel workbook (client req 2026-08-26: "xcel file bi support karni
 *  chahiye") -> the same CSV text parseSurveyCsv already reads, so an
 *  Excel upload gets every column-detection/validation rule a CSV upload
 *  already has for free, instead of a second parallel parser to maintain.
 *  Reads every row's cells up to the WORKSHEET's own column count (not
 *  just the cells a given row happens to use) so a row that trails off
 *  early — e.g. the last leg of an open traverse with no bearing/distance —
 *  still lines up under the right header instead of shifting left. */
async function excelToCsvText(buf: ArrayBuffer): Promise<string> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const sheet = wb.worksheets[0];
  if (!sheet) throw new Error("This Excel workbook has no sheets.");
  const maxCol = sheet.columnCount;
  const lines: string[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    for (let c = 1; c <= maxCol; c++) {
      cells.push(csvCell((row.getCell(c).text ?? "").toString().trim()));
    }
    lines.push(cells.join(","));
  });
  return lines.join("\n");
}

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
    if (ext === ".xlsx") {
      const buf = await file.arrayBuffer();
      const csvText = await excelToCsvText(buf);
      return NextResponse.json({ filename: file.name, ...parseSurveyCsv(csvText) });
    }
    // The old binary .xls format isn't something exceljs (or any pure-JS
    // reader) can safely parse — point at the fix instead of failing oddly.
    if (ext === ".xls") {
      return NextResponse.json(
        {
          error:
            "The old .xls format can't be read directly. In Excel, use File ▸ Save As and choose " +
            "\"Excel Workbook (.xlsx)\" — or export as CSV — then upload that.",
        },
        { status: 400 }
      );
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
      ".docx": "Word document", ".mpk": "ArcGIS map package",
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
