import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { connectDb, isDbConnected } from "./db.js";
import { engineHealth } from "./engineClient.js";
import { groqAvailable } from "./groqClient.js";
import { cogoRouter } from "./routes/cogo.js";
import { crsRouter } from "./routes/crs.js";
import { importRouter } from "./routes/importData.js";
import { projectsRouter } from "./routes/projects.js";
import { validateRouter } from "./routes/validate.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/api/health", async (_req, res) => {
  res.json({
    status: "ok",
    db: isDbConnected(),
    engine: await engineHealth(),
    ai: groqAvailable(),
  });
});

app.use("/api/projects", projectsRouter);
app.use("/api/import", importRouter);
app.use("/api/cogo", cogoRouter);
app.use("/api/crs", crsRouter);
app.use("/api/validate", validateRouter);

async function start() {
  await connectDb();
  app.listen(config.port, () => {
    console.log(`[api] listening on http://localhost:${config.port}`);
    console.log(`[api] engine: ${config.engineUrl}  ai: ${groqAvailable() ? "on" : "off"}`);
  });
}

start();
