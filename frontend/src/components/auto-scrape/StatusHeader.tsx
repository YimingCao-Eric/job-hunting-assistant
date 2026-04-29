"use client";

import { useEffect, useState } from "react";
import type { AutoScrapeState } from "@/types/autoScrape";
import {
  enableAutoScrape,
  pauseAutoScrape,
  shutdownAutoScrape,
  triggerTestCycle,
  fetchAutoScrapeInstances,
} from "@/lib/api/autoScrape";

export function StatusHeader({
  state,
  onAction,
}: {
  state: AutoScrapeState;
  onAction: () => void;
}) {
  const [tick, setTick] = useState(0);
  const [instanceCount, setInstanceCount] = useState(1);

  useEffect(() => {
    const i = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(i);
  }, []);

  useEffect(() => {
    const refresh = async () => {
      try {
        const data = await fetchAutoScrapeInstances();
        setInstanceCount(data.count ?? 1);
      } catch {
        /* best-effort */
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(interval);
  }, []);

  const isEnabled = state.state.enabled === true;
  const isTestPending = state.state.test_cycle_pending === true;
  const isExitRequested = state.state.exit_requested === true;

  let heartbeatAgeSec: number | null = null;
  let heartbeatColor = "bg-gray-400";
  let heartbeatLabel = "no heartbeat";
  if (state.last_sw_heartbeat_at) {
    heartbeatAgeSec = Math.floor(
      (Date.now() - new Date(state.last_sw_heartbeat_at).getTime()) / 1000
    );
    if (heartbeatAgeSec < 120) {
      heartbeatColor = "bg-green-500";
      heartbeatLabel = "live";
    } else if (heartbeatAgeSec < 300) {
      heartbeatColor = "bg-yellow-500";
      heartbeatLabel = "slow";
    } else {
      heartbeatColor = "bg-red-500";
      heartbeatLabel = "stale";
    }
  }

  const formatAge = (sec: number) => {
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  };

  const [busy, setBusy] = useState(false);
  const wrap =
    (fn: () => Promise<void>) =>
    async () => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
        onAction();
      } finally {
        setBusy(false);
      }
    };

  return (
    <div className="bg-white border rounded-lg p-6 shadow-sm">
      <span className="sr-only" aria-hidden="true">
        {tick}
      </span>
      {instanceCount > 1 && (
        <div className="mb-3 p-3 bg-yellow-50 border border-yellow-300 rounded text-sm text-yellow-900">
          Multiple extension instances detected ({instanceCount}). Disable
          auto-scrape in all but one Chrome profile to avoid conflicts.
        </div>
      )}
      <div className="flex justify-between items-start gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold mb-2">Auto-Scrape</h1>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                  isEnabled ? "bg-green-500" : "bg-gray-400"
                }`}
              />
              {isEnabled ? "Running" : "Disabled"}
              {isTestPending && " (test cycle pending)"}
              {isExitRequested && " (shutting down…)"}
            </div>
            {heartbeatAgeSec !== null && (isEnabled || isTestPending) && (
              <div className="flex items-center gap-2 text-gray-600">
                <span
                  className={`w-2.5 h-2.5 rounded-full shrink-0 ${heartbeatColor}`}
                />
                Heartbeat {formatAge(heartbeatAgeSec)} ago ({heartbeatLabel})
              </div>
            )}
            {!state.last_sw_heartbeat_at && (isEnabled || isTestPending) && (
              <div className="flex items-center gap-2 text-gray-500">
                <span className="w-2.5 h-2.5 rounded-full shrink-0 bg-gray-400" />
                {heartbeatLabel}
              </div>
            )}
          </div>
          {typeof state.state.min_cycle_interval_ms === "number" &&
            state.state.min_cycle_interval_ms > 0 && (
              <p className="text-xs text-gray-500 mt-2">
                Min cycle interval:{" "}
                {Math.round(state.state.min_cycle_interval_ms / 1000)}s
                (read-only)
              </p>
            )}
        </div>
        <div className="flex flex-wrap gap-2">
          {!isEnabled && !isTestPending ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={wrap(() => enableAutoScrape())}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                Enable
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={wrap(() => triggerTestCycle())}
                className="px-4 py-2 bg-gray-100 border rounded hover:bg-gray-200 disabled:opacity-50"
              >
                Run Test Cycle
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={wrap(() => pauseAutoScrape())}
                className="px-4 py-2 bg-gray-100 border rounded hover:bg-gray-200 disabled:opacity-50"
              >
                Pause
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={wrap(async () => {
                  if (confirm("Stop and exit auto-scrape?")) {
                    await shutdownAutoScrape();
                  }
                })}
                className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
              >
                Stop and Exit
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
