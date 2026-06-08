// All requests go through Next.js route handlers under app/api/** (in-process
// COGO / traverse / CRS / import / validation — no separate backend needed).

export async function apiJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `request failed (${res.status})`);
  return data as T;
}

export async function apiUpload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api${path}`, { method: "POST", body: form });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error ?? `upload failed (${res.status})`);
  return data as T;
}

export async function apiHealth(): Promise<{ status: string; db: boolean; engine: boolean; ai: boolean }> {
  const res = await fetch("/api/health");
  return res.json();
}
