import mongoose from "mongoose";
import { config } from "./config.js";

let connected = false;

/**
 * Connect to MongoDB. Non-fatal: if Mongo is unavailable the API still runs so
 * the stateless COGO / import / validate flows work for demos and development.
 */
export async function connectDb(): Promise<boolean> {
  try {
    await mongoose.connect(config.mongoUri, { serverSelectionTimeoutMS: 3000 });
    connected = true;
    console.log("[db] connected to MongoDB");
  } catch (err) {
    connected = false;
    console.warn(
      "[db] MongoDB unavailable — running in stateless mode. " +
        "Project/parcel persistence is disabled until Mongo is reachable."
    );
  }
  return connected;
}

export function isDbConnected(): boolean {
  return connected && mongoose.connection.readyState === 1;
}
