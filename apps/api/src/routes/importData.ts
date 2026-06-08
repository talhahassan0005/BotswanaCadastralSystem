import { Router } from "express";
import multer from "multer";
import { parseSurveyCsv } from "../utils/csv.js";

export const importRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

/** Upload a CSV/TXT file -> parsed + validated preview rows. */
importRouter.post("/file", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file uploaded" });
  const text = req.file.buffer.toString("utf-8");
  const result = parseSurveyCsv(text);
  res.json({ filename: req.file.originalname, ...result });
});

/** Parse raw text pasted into the UI (no file upload). */
importRouter.post("/text", (req, res) => {
  const { text } = req.body ?? {};
  if (typeof text !== "string") return res.status(400).json({ error: "text required" });
  res.json({ filename: "pasted.csv", ...parseSurveyCsv(text) });
});
