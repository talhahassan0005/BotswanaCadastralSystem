import axios from "axios";
import { config } from "./config.js";

const client = axios.create({ baseURL: config.engineUrl, timeout: 20000 });

export async function engineHealth(): Promise<boolean> {
  try {
    const { data } = await client.get("/health");
    return data?.status === "ok";
  } catch {
    return false;
  }
}

/** Forward any COGO payload to the Python engine; surfaces engine 4xx detail. */
export async function callEngine(path: string, body: unknown): Promise<any> {
  try {
    const { data } = await client.post(path, body);
    return data;
  } catch (err: any) {
    const detail = err?.response?.data?.detail ?? err.message;
    const status = err?.response?.status ?? 502;
    const e = new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
    (e as any).status = status;
    throw e;
  }
}
