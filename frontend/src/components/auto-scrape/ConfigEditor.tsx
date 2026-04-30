"use client";

import { useEffect, useState } from "react";
import type {
  AutoScrapeConfig,
  ConfigLimits,
  AutoScrapeState,
} from "@/types/autoScrape";
import { saveConfig, resetConfig } from "@/lib/api/autoScrape";

export function ConfigEditor({
  config,
  limits,
  state,
  onSave,
}: {
  config: AutoScrapeConfig;
  limits: ConfigLimits;
  state: AutoScrapeState;
  onSave: () => void;
}) {
  const [draft, setDraft] = useState(() => ({ ...config.config }));
  const [busy, setBusy] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    setDraft({ ...config.config });
  }, [config]);

  const sites = (draft.enabled_sites as string[] | undefined) || [];
  const keywords = (draft.keywords as string[] | undefined) || [];
  const scansPerCycle = sites.length * keywords.length;
  const maxKeywords = limits.derived_limits?.max_keywords ?? 10;
  const maxScansHard =
    limits.derived_limits?.max_scans_per_cycle_hard ?? 30;
  const maxScansSoft =
    limits.derived_limits?.max_scans_per_cycle_warn ?? 12;

  const exceedsHardCap = scansPerCycle > maxScansHard;
  const exceedsKeywordMax = keywords.length > maxKeywords;
  const exceedsSoftWarn =
    scansPerCycle >= maxScansSoft && !exceedsHardCap;

  const toggleSite = (site: string) => {
    const next = sites.includes(site)
      ? sites.filter((x) => x !== site)
      : [...sites, site];
    setDraft({ ...draft, enabled_sites: next });
  };

  const updateKeyword = (idx: number, val: string) => {
    const next = [...keywords];
    next[idx] = val;
    setDraft({ ...draft, keywords: next });
  };

  const addKeyword = () => {
    if (keywords.length >= maxKeywords) return;
    setDraft({ ...draft, keywords: [...keywords, ""] });
  };

  const removeKeyword = (idx: number) => {
    setDraft({
      ...draft,
      keywords: keywords.filter((_, i) => i !== idx),
    });
  };

  const handleSave = async () => {
    if (exceedsHardCap || exceedsKeywordMax || busy) return;
    setBusy(true);
    setWarnings([]);
    try {
      const filtered = {
        ...draft,
        keywords: keywords.map((k) => k.trim()).filter((k) => k.length > 0),
      };
      const resp = await saveConfig(filtered);
      if (resp.warnings?.length) setWarnings(resp.warnings);
      onSave();
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (busy) return;
    if (!confirm("Reset configuration to defaults?")) return;
    setBusy(true);
    try {
      const fresh = await resetConfig();
      setDraft({ ...fresh.config });
      onSave();
    } finally {
      setBusy(false);
    }
  };

  const phase = String(state.state.cycle_phase || "").toLowerCase();
  const isRunning =
    state.state.enabled === true ||
    phase === "scrape_running" ||
    phase === "postscrape_running";

  return (
    <div className="bg-white border rounded-lg p-6 shadow-sm">
      <h2 className="text-lg font-semibold mb-3">Configuration</h2>

      <div className="mb-4">
        <div className="text-sm font-medium mb-2">Sites</div>
        <div className="flex gap-3 flex-wrap">
          {(["linkedin", "indeed", "glassdoor"] as const).map((site) => (
            <label key={site} className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={sites.includes(site)}
                onChange={() => toggleSite(site)}
              />
              {site}
            </label>
          ))}
        </div>
      </div>

      <div className="mb-4">
        <div className="text-sm font-medium mb-2">
          Keywords ({keywords.length}/{maxKeywords})
        </div>
        <div className="space-y-2">
          {keywords.map((kw, idx) => (
            <div key={idx} className="flex gap-2">
              <input
                type="text"
                value={kw}
                onChange={(e) => updateKeyword(idx, e.target.value)}
                className="flex-1 border rounded px-2 py-1 text-sm"
                placeholder="e.g. software engineer"
              />
              <button
                type="button"
                onClick={() => removeKeyword(idx)}
                className="px-2 py-1 text-xs bg-gray-100 border rounded hover:bg-gray-200"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addKeyword}
            disabled={keywords.length >= maxKeywords}
            className="px-3 py-1 text-sm bg-gray-100 border rounded hover:bg-gray-200 disabled:opacity-50"
          >
            + Add keyword
          </button>
        </div>
      </div>

      <div className="text-sm mb-4 p-3 bg-gray-50 rounded">
        {keywords.length} keyword(s) × {sites.length} site(s) ={" "}
        <strong>{scansPerCycle} scans/cycle</strong>
        {scansPerCycle > 0 && (
          <span className="text-gray-500">
            {" "}
            (estimated ~{scansPerCycle * 4} min)
          </span>
        )}
        {exceedsSoftWarn && (
          <span className="text-yellow-700 ml-2">
            Long cycle. Consider reducing.
          </span>
        )}
        {exceedsHardCap && (
          <span className="text-red-600 ml-2">
            Exceeds hard cap of {maxScansHard}.
          </span>
        )}
        {exceedsKeywordMax && (
          <span className="text-red-600 ml-2">
            Too many keywords (max {maxKeywords}).
          </span>
        )}
      </div>

      {warnings.length > 0 && (
        <div className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm">
          <ul className="list-disc list-inside">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        <button
          type="button"
          disabled={busy || exceedsHardCap || exceedsKeywordMax}
          onClick={handleSave}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={handleReset}
          className="px-4 py-2 bg-gray-100 border rounded hover:bg-gray-200 disabled:opacity-50"
        >
          Reset to Defaults
        </button>
        {isRunning && (
          <span className="text-xs text-gray-500">
            Configuration changes take effect at the next cycle.
          </span>
        )}
      </div>
    </div>
  );
}
