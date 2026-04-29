import type { AutoScrapeState, AutoScrapeCycle } from "@/types/autoScrape";

export function CurrentCycle({
  state,
  cycles,
}: {
  state: AutoScrapeState;
  cycles: AutoScrapeCycle[];
}) {
  const running = cycles.find(
    (c) =>
      c.status === "scrape_running" || c.status === "postscrape_running"
  );

  if (!running) {
    return (
      <div className="bg-white border rounded-lg p-6 shadow-sm text-gray-500">
        No active cycle.
      </div>
    );
  }

  const totalScans = running.scans_attempted || 0;
  const pos = state.state.matrix_position;

  return (
    <div className="bg-white border rounded-lg p-6 shadow-sm">
      <h2 className="text-lg font-semibold mb-3">
        Current cycle #{running.cycle_id}
      </h2>
      <div className="grid grid-cols-2 gap-y-2 text-sm">
        <div className="text-gray-500">Phase</div>
        <div>{running.status}</div>
        <div className="text-gray-500">Scans</div>
        <div>
          {running.scans_succeeded}/{totalScans} succeeded
        </div>
        {pos &&
          typeof pos.site_index === "number" &&
          typeof pos.keyword_index === "number" && (
            <>
              <div className="text-gray-500">Matrix</div>
              <div>
                site {pos.site_index + 1}, keyword {pos.keyword_index + 1}{" "}
                (from state)
              </div>
            </>
          )}
        <div className="text-gray-500">Started</div>
        <div>{new Date(running.started_at).toLocaleTimeString()}</div>
      </div>
    </div>
  );
}
