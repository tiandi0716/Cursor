export type ModelParam = { id: string; value: string };

export type RequestLog = {
  at: number;
  requested: string;
  used: string;
  kind?: "ask" | "plan";
  reply?: "text" | "tool_calls";
  stream: boolean;
  ok: boolean;
  ms: number;
  error?: string;
};

export type Settings = {
  hasKey: boolean;
  apiKey: string;
  keyHint: string;
  keySource: "header" | "env" | "proxy" | "workbench" | "";
  host: string;
  port: number;
  baseUrl: string;
  localBaseUrl: string;
  accessToken: string;
  model: string;
  modelParams: ModelParam[];
  suggestedName: string;
  recent: RequestLog[];
  tunnelRunning: boolean;
  tunnelUrl: string;
  tunnelError: string;
  hasCloudflared: boolean;
};

export type ModelInfo = {
  id: string;
  displayName: string;
  description?: string;
  parameters?: Array<{
    id: string;
    displayName?: string;
    values: Array<{ value: string; displayName?: string }>;
  }>;
  variants?: Array<{
    params: ModelParam[];
    displayName: string;
    isDefault?: boolean;
  }>;
  defaultParams?: ModelParam[];
};

async function parseError(res: Response) {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error || res.statusText;
  } catch {
    return res.statusText;
  }
}

export async function getSettings(): Promise<Settings> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function saveSettings(
  body: Partial<Settings> & { apiKey?: string; clearApiKey?: boolean },
): Promise<Settings> {
  const res = await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function listModels(): Promise<ModelInfo[]> {
  const res = await fetch("/api/models");
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { models: ModelInfo[] };
  return data.models;
}

export async function startTunnel(): Promise<Settings> {
  const res = await fetch("/api/tunnel/start", { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function stopTunnel(): Promise<Settings> {
  const res = await fetch("/api/tunnel/stop", { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}
