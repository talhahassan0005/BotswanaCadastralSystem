"use client";

// Root-layout-level error boundary — catches crashes that escape even the
// normal error.tsx (e.g. an error thrown by layout.tsx itself). Next.js
// requires this file to render its own <html>/<body> since it replaces the
// entire root layout when it fires. Same crash-reporting as error.tsx.

import { useEffect } from "react";

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
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
        scope: "global-error",
      }),
    }).catch(() => {});
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", padding: "1rem", fontFamily: "system-ui, sans-serif" }}>
          <div style={{ maxWidth: "28rem", textAlign: "center" }}>
            <h1 style={{ marginBottom: "0.5rem", fontSize: "1.125rem", fontWeight: 600 }}>Something went wrong</h1>
            <p style={{ marginBottom: "1.25rem", fontSize: "0.875rem", color: "#64748b" }}>
              An unexpected error occurred. It&apos;s been reported — please try again.
            </p>
            <button
              type="button"
              onClick={() => reset()}
              style={{ borderRadius: "0.375rem", background: "#0f766e", color: "#fff", padding: "0.5rem 1rem", fontSize: "0.875rem", fontWeight: 600, border: "none", cursor: "pointer" }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
