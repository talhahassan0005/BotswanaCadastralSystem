// All requests go through Next.js route handlers under app/api/** (in-process
// COGO / traverse / CRS / import / validation — no separate backend needed).

// A network-level fetch rejection (TypeError "Failed to fetch") means the
// request never reached the server — typically a transient blip (the dev
// server mid-recompile, a brief connection drop, the laptop waking from
// sleep). These are safe to retry. HTTP errors (4xx/5xx) carry a real
// response and are NOT retried here (except 502/503/504, which a proxy or a
// server mid-restart emits transiently).
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isNetworkError(e: unknown): boolean {
  // fetch() rejects with a TypeError on network failure across all browsers.
  return e instanceof TypeError;
}

const FRIENDLY_NETWORK_ERROR =
  "Could not reach the computation server. This is usually a brief connection hiccup — please wait a moment and click Run again.";

async function parseBody(res: Response): Promise<any> {
  // The server normally returns JSON. During a dev recompile or a crash it can
  // return an HTML error page; don't let that surface as a cryptic
  // "Unexpected token < in JSON" — fall back to text.
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

async function request<T>(path: string, init: RequestInit, label: string): Promise<T> {
  let lastNetworkError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(`/api${path}`, init);
    } catch (e) {
      // Network-level failure — retry transparently before giving up.
      if (isNetworkError(e) && attempt < MAX_ATTEMPTS) {
        lastNetworkError = e;
        await sleep(attempt * 400);
        continue;
      }
      throw new Error(FRIENDLY_NETWORK_ERROR);
    }

    if (res.ok) {
      const data = await parseBody(res);
      return data as T;
    }

    // Transient gateway/restart statuses — retry before surfacing.
    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
      await sleep(attempt * 400);
      continue;
    }

    const data = await parseBody(res);
    throw new Error(data?.error ?? `${label} failed (${res.status})`);
  }

  // Exhausted retries on a network error.
  throw new Error(lastNetworkError ? FRIENDLY_NETWORK_ERROR : `${label} failed`);
}

export async function apiJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    "Request",
  );
}

export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  return request<T>(path, { method: "POST", body: form }, "Upload");
}

export async function apiHealth(): Promise<{ status: string; db: boolean; engine: boolean; ai: boolean }> {
  const res = await fetch("/api/health");
  return res.json();
}
