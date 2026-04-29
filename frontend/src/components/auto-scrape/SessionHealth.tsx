"use client";

import { useState } from "react";
import type { SessionState } from "@/types/autoScrape";
import { resetSession } from "@/lib/api/autoScrape";

export function SessionHealth({
  sessions,
  onReset,
}: {
  sessions: SessionState[];
  onReset: () => void;
}) {
  const [busySite, setBusySite] = useState<string | null>(null);

  const handleReset = async (site: string) => {
    if (busySite) return;
    setBusySite(site);
    try {
      await resetSession(site);
      onReset();
    } finally {
      setBusySite(null);
    }
  };

  if (sessions.length === 0) {
    return null;
  }

  return (
    <div className="bg-white border rounded-lg p-6 shadow-sm">
      <h2 className="text-lg font-semibold mb-3">Session health</h2>
      <div className="space-y-2">
        {sessions.map((s) => {
          const dot =
            s.last_probe_status === "live"
              ? "bg-green-500"
              : s.last_probe_status === "rate_limited"
                ? "bg-yellow-500"
                : s.last_probe_status === "captcha"
                  ? "bg-red-500"
                  : s.last_probe_status === "expired"
                    ? "bg-red-600"
                    : "bg-gray-400";
          const ageMs = Date.now() - new Date(s.last_probe_at).getTime();
          const ageStr =
            ageMs < 60_000
              ? `${Math.floor(ageMs / 1000)}s`
              : `${Math.floor(ageMs / 60_000)}m`;

          const resolveCaptchaUrl: Record<string, string> = {
            linkedin: "https://www.linkedin.com/feed/",
            indeed: "https://ca.indeed.com/notifications",
            glassdoor: "https://www.glassdoor.ca/Job/index.htm",
          };

          return (
            <div
              key={s.site}
              className="flex flex-wrap items-center gap-3 text-sm"
            >
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${dot}`} />
              <span className="font-medium w-20 capitalize">{s.site}</span>
              <span className="text-gray-600">
                {s.last_probe_status}
                {s.last_probe_status === "captcha" && (
                  <span className="text-red-600"> (needs verification)</span>
                )}
              </span>
              <span className="text-gray-500 text-xs">
                (probed {ageStr} ago, backoff ×{s.backoff_multiplier})
              </span>
              {s.last_probe_status === "captcha" && (
                <button
                  type="button"
                  onClick={() => {
                    const url = resolveCaptchaUrl[s.site];
                    if (url) window.open(url, "_blank", "noopener,noreferrer");
                  }}
                  className="ml-auto px-3 py-1 text-xs bg-red-100 border border-red-300 rounded hover:bg-red-200"
                >
                  Resolve CAPTCHA
                </button>
              )}
              {s.last_probe_status !== "live" &&
                s.last_probe_status !== "captcha" && (
                  <button
                    type="button"
                    disabled={busySite === s.site}
                    onClick={() => handleReset(s.site)}
                    className="ml-auto px-3 py-1 text-xs bg-gray-100 border rounded hover:bg-gray-200 disabled:opacity-50"
                  >
                    Reset
                  </button>
                )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
