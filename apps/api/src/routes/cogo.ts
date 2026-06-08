import { Router } from "express";
import { callEngine } from "../engineClient.js";

export const cogoRouter = Router();

/** Thin proxy to the Python compute engine. Express owns orchestration; the
 *  engine owns the math. Each route maps 1:1 to an engine endpoint. */
const map: Record<string, string> = {
  traverse: "/cogo/traverse",
  inverse: "/cogo/inverse",
  area: "/cogo/area",
  intersection: "/cogo/intersection",
  curve: "/cogo/curve",
};

for (const [name, path] of Object.entries(map)) {
  cogoRouter.post(`/${name}`, async (req, res) => {
    try {
      const data = await callEngine(path, req.body);
      res.json(data);
    } catch (err: any) {
      res.status(err.status ?? 502).json({ error: err.message });
    }
  });
}
