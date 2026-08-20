"use client";

// Route-level error boundary (client req 2026-08-20): replaces Next.js's bare
// "Application error: a client-side exception has occurred" screen — which
// gave the client no way to recover and no way for us to see what broke —
// with a friendly retry screen. It also reports the real error + stack to
// /api/log-error so it shows up in Vercel's logs the next time this fires,
// instead of vanishing with the tab.

import { useEffect } from "react";

export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
    fetch("/api/log-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: error.message,
        stack: error.stack,
        digest: error.digest,
        url: typeof window !== "undefined" ? window.location.href : undefined,
        time: new Date().toISOString(),
      }),
    }).catch(() => {});
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <h1 className="mb-2 text-lg font-semibold text-slate-800">Something went wrong</h1>
        <p className="mb-5 text-sm text-slate-500">
          An unexpected error occurred. It's been reported — please try again, or reload the page if it keeps happening.
        </p>
        <div className="flex justify-center gap-2">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50"
          >
            Reload page
          </button>
        </div>
      </div>
    </div>
  );
}
