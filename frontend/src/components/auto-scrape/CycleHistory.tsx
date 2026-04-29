import type { AutoScrapeCycle } from "@/types/autoScrape";

export function CycleHistory({ cycles }: { cycles: AutoScrapeCycle[] }) {
  if (cycles.length === 0) {
    return (
      <div className="bg-white border rounded-lg p-6 shadow-sm text-gray-500">
        No cycle history yet.
      </div>
    );
  }

  return (
    <div className="bg-white border rounded-lg p-6 shadow-sm">
      <h2 className="text-lg font-semibold mb-3">Recent cycles</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[640px]">
          <thead>
            <tr className="border-b text-left text-gray-600">
              <th className="py-2 pr-2">#</th>
              <th className="pr-2">Status</th>
              <th className="pr-2">Started</th>
              <th className="pr-2">Duration</th>
              <th className="pr-2">Scans</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {cycles.map((c) => {
              const startedAt = new Date(c.started_at);
              const completedAt = c.completed_at
                ? new Date(c.completed_at)
                : null;
              const durationMs = completedAt
                ? completedAt.getTime() - startedAt.getTime()
                : null;
              const durationStr = durationMs
                ? `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`
                : "—";
              const icon =
                c.status === "post_scrape_complete"
                  ? "✓"
                  : c.status === "failed"
                    ? "✗"
                    : "…";
              const iconColor =
                c.status === "post_scrape_complete"
                  ? "text-green-600"
                  : c.status === "failed"
                    ? "text-red-600"
                    : "text-blue-600";

              return (
                <tr key={c.id} className="border-b">
                  <td className="py-2 pr-2">{c.cycle_id}</td>
                  <td className="pr-2">
                    <span className={iconColor}>{icon}</span> {c.status}
                  </td>
                  <td className="pr-2">{startedAt.toLocaleString()}</td>
                  <td className="pr-2">{durationStr}</td>
                  <td className="pr-2">
                    {c.scans_succeeded}/{c.scans_attempted}
                  </td>
                  <td className="text-gray-500 text-xs">
                    {c.error_message || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
