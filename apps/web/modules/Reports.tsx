"use client";

import { useEffect, useState } from "react";
import { useAccount } from "@/lib/account";
import { Card } from "@/components/ui";
import { listProjectSummaries, type ProjectSummary } from "@/lib/projects";

/** Reports hub (client req 2026-08-26, Part 32b) — Statistics only here now:
 *  Data Consistency and Coordinate List moved to Survey Record (Part 32a),
 *  which is their single home, so they aren't maintained/shown in two
 *  places. */
export function Reports() {
  const { user, ready } = useAccount();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ready || !user) return;
    listProjectSummaries().then((r) => {
      if (r.error) setError(r.error);
      else setProjects(r.data);
    });
  }, [ready, user]);

  return (
    <div className="space-y-5">
      <h2 className="text-lg font-semibold text-slate-700">Reports</h2>

      <Card title="Statistics">
        {!ready ? (
          <p className="py-8 text-center text-sm text-slate-400">Loading…</p>
        ) : !user ? (
          <p className="py-8 text-center text-sm text-slate-400">Sign in to see statistics across your saved projects.</p>
        ) : error ? (
          <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
        ) : !projects ? (
          <p className="py-8 text-center text-sm text-slate-400">Loading…</p>
        ) : (
          <>
            <p className="mb-4 text-sm text-slate-600">
              <span className="text-2xl font-bold text-slate-800">{projects.length}</span> processed file
              {projects.length === 1 ? "" : "s"} in the system.
            </p>
            {projects.length > 0 && (
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-3">#</th>
                    <th className="py-2 pr-3">Lot number</th>
                    <th className="py-2">Last updated</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p, i) => (
                    <tr key={p.id} className="border-b border-slate-100">
                      <td className="py-2 pr-3 text-slate-400">{i + 1}</td>
                      <td className="py-2 pr-3 font-medium text-slate-700">{p.lotName}</td>
                      <td className="py-2 text-slate-500">{new Date(p.updated_at).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
