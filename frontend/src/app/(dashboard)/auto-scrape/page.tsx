"use client";

import { useCallback, useEffect, useState } from "react";
import { StatusHeader } from "@/components/auto-scrape/StatusHeader";
import { CurrentCycle } from "@/components/auto-scrape/CurrentCycle";
import { CycleHistory } from "@/components/auto-scrape/CycleHistory";
import { SessionHealth } from "@/components/auto-scrape/SessionHealth";
import { ConfigEditor } from "@/components/auto-scrape/ConfigEditor";
import type {
  AutoScrapeState,
  AutoScrapeCycle,
  SessionState,
  AutoScrapeConfig,
  ConfigLimits,
} from "@/types/autoScrape";
import {
  fetchAutoScrapeState,
  fetchAutoScrapeCycles,
  fetchAutoScrapeSessions,
  fetchAutoScrapeConfig,
  fetchAutoScrapeConfigLimits,
} from "@/lib/api/autoScrape";

export default function AutoScrapePage() {
  const [state, setState] = useState<AutoScrapeState | null>(null);
  const [cycles, setCycles] = useState<AutoScrapeCycle[]>([]);
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [config, setConfig] = useState<AutoScrapeConfig | null>(null);
  const [limits, setLimits] = useState<ConfigLimits | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, c, sess, cfg, lim] = await Promise.all([
        fetchAutoScrapeState(),
        fetchAutoScrapeCycles(10),
        fetchAutoScrapeSessions(),
        fetchAutoScrapeConfig(),
        fetchAutoScrapeConfigLimits(),
      ]);
      setState(s);
      setCycles(c);
      setSessions(sess);
      setConfig(cfg);
      setLimits(lim);
      setError(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  if (error) {
    return (
      <div className="p-8 text-red-600">
        Error: {error}
      </div>
    );
  }
  if (!state) {
    return <div className="p-8 text-gray-500">Loading…</div>;
  }

  return (
    <div className="space-y-6 p-6 max-w-6xl mx-auto">
      <StatusHeader state={state} onAction={refresh} />
      <CurrentCycle state={state} cycles={cycles} />
      <CycleHistory cycles={cycles} />
      <SessionHealth sessions={sessions} onReset={refresh} />
      {config && limits && (
        <ConfigEditor
          config={config}
          limits={limits}
          state={state}
          onSave={refresh}
        />
      )}
      <div className="text-xs text-gray-500 border-t pt-4">
        Note: post-scrape pipeline (dedup + matching) is currently disabled.
        Cycles produce scraped jobs only. Re-enable when pipeline is redesigned.
      </div>
    </div>
  );
}
