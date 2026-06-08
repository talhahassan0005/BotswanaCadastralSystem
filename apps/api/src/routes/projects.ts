import { Router } from "express";
import { isDbConnected } from "../db.js";
import { Project } from "../models/Project.js";
import { Beacon } from "../models/Beacon.js";
import { Parcel } from "../models/Parcel.js";

export const projectsRouter = Router();

function requireDb(res: any): boolean {
  if (!isDbConnected()) {
    res.status(503).json({ error: "database unavailable — persistence disabled" });
    return false;
  }
  return true;
}

projectsRouter.get("/", async (_req, res) => {
  if (!requireDb(res)) return;
  res.json(await Project.find().sort({ updatedAt: -1 }).lean());
});

projectsRouter.post("/", async (req, res) => {
  if (!requireDb(res)) return;
  const project = await Project.create(req.body);
  res.status(201).json(project);
});

projectsRouter.get("/:id", async (req, res) => {
  if (!requireDb(res)) return;
  const project = await Project.findById(req.params.id).lean();
  if (!project) return res.status(404).json({ error: "not found" });
  const [beacons, parcels] = await Promise.all([
    Beacon.find({ projectId: req.params.id }).lean(),
    Parcel.find({ projectId: req.params.id }).lean(),
  ]);
  res.json({ project, beacons, parcels });
});
