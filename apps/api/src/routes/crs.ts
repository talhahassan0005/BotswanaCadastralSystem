import { Router } from "express";
import axios from "axios";
import { config } from "../config.js";
import { callEngine } from "../engineClient.js";

export const crsRouter = Router();

/** List supported coordinate systems (proxied from the engine). */
crsRouter.get("/list", async (_req, res) => {
  try {
    const { data } = await axios.get(`${config.engineUrl}/crs/list`, { timeout: 10000 });
    res.json(data);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

/** Transform a batch of coordinate pairs between coordinate systems. */
crsRouter.post("/transform", async (req, res) => {
  try {
    const data = await callEngine("/crs/transform", req.body);
    res.json(data);
  } catch (err: any) {
    res.status(err.status ?? 502).json({ error: err.message });
  }
});
