import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load the repo-root .env (two levels up from apps/api/src).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

export const config = {
  port: Number(process.env.API_PORT ?? 4000),
  mongoUri: process.env.MONGO_URI ?? "mongodb://localhost:27017/botswana_cadastral",
  engineUrl: process.env.ENGINE_URL ?? "http://localhost:8000",
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  groqModel: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
  jwtSecret: process.env.JWT_SECRET ?? "change-me",
};
