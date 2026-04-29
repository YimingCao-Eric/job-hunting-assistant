import type {
  AutoScrapeState,
  AutoScrapeCycle,
  SessionState,
  AutoScrapeConfig,
  ConfigLimits,
  ConfigUpdateResponse,
} from "@/types/autoScrape";

const BASE = "/admin/auto-scrape";

function apiBase(): string {
  return (
    (import.meta.env.VITE_API_URL as string | undefined) ||
    (import.meta.env.NEXT_PUBLIC_API_BASE as string | undefined) ||
    "http://localhost:8000"
  );
}

function authToken(): string {
  return (
    (import.meta.env.VITE_AUTH_TOKEN as string | undefined) || "dev-token"
  );
}

function hdrs(): Record<string, string> {
  return {
    Authorization: `Bearer ${authToken()}`,
    "Content-Type": "application/json",
  };
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${apiBase()}${path}`, { headers: hdrs() });
  if (!r.ok) throw new Error(`GET ${path} failed: ${r.status}`);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: hdrs(),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${path} failed: ${r.status}`);
  return r.json() as Promise<T>;
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${apiBase()}${path}`, {
    method: "PUT",
    headers: hdrs(),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PUT ${path} failed: ${r.status}`);
  return r.json() as Promise<T>;
}

export const fetchAutoScrapeState = () =>
  get<AutoScrapeState>(`${BASE}/state`);

export const fetchAutoScrapeCycles = (limit = 10) =>
  get<AutoScrapeCycle[]>(`${BASE}/cycles?limit=${limit}`);

export const fetchAutoScrapeSessions = () =>
  get<SessionState[]>(`${BASE}/sessions`);

export const fetchAutoScrapeConfig = () =>
  get<AutoScrapeConfig>(`${BASE}/config`);

export const fetchAutoScrapeConfigLimits = () =>
  get<ConfigLimits>(`${BASE}/config/limits`);

export const saveConfig = (cfg: Record<string, unknown>) =>
  put<ConfigUpdateResponse>(`${BASE}/config`, cfg);

export const resetConfig = () => post<AutoScrapeConfig>(`${BASE}/config/reset`);

export const enableAutoScrape = () =>
  post<AutoScrapeState>(`${BASE}/enable`);

export const pauseAutoScrape = () =>
  post<AutoScrapeState>(`${BASE}/pause`);

export const shutdownAutoScrape = () =>
  post<AutoScrapeState>(`${BASE}/shutdown`);

export const triggerTestCycle = () =>
  post<AutoScrapeState>(`${BASE}/test-cycle`);

export const resetSession = (site: string) =>
  post<SessionState>(`${BASE}/reset-session/${site}`);

export async function fetchAutoScrapeInstances(): Promise<{
  count: number;
  instances: Array<{ instance_id: string; last_heartbeat_at: string }>;
}> {
  const r = await fetch(`${apiBase()}${BASE}/instances`, {
    headers: { Authorization: `Bearer ${authToken()}` },
  });
  if (!r.ok) return { count: 1, instances: [] };
  return r.json() as Promise<{
    count: number;
    instances: Array<{ instance_id: string; last_heartbeat_at: string }>;
  }>;
}
