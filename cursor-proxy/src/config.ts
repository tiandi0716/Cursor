import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".cursor-ui");
export const PROXY_FILE = join(CONFIG_DIR, "proxy.json");
export const WORKBENCH_FILE = join(CONFIG_DIR, "config.json");
export const WORKSPACE = join(CONFIG_DIR, "proxy-workspace");

export type ModelParam = { id: string; value: string };

export type ProxyConfig = {
  apiKey: string;
  accessToken: string;
  host: string;
  port: number;
  model: string;
  modelParams: ModelParam[];
};

function newAccessToken() {
  return `cpx_${randomBytes(24).toString("hex")}`;
}

const defaults = (): ProxyConfig => ({
  apiKey: "",
  accessToken: newAccessToken(),
  host: "127.0.0.1",
  port: 8765,
  model: "composer-2.5",
  modelParams: [],
});

export async function ensureDirs() {
  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(WORKSPACE, { recursive: true });
}

export async function loadConfig(): Promise<ProxyConfig> {
  await ensureDirs();
  try {
    const raw = await readFile(PROXY_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<ProxyConfig>;
    const cfg: ProxyConfig = {
      ...defaults(),
      ...parsed,
      apiKey: String(parsed.apiKey ?? "").trim(),
      accessToken: String(parsed.accessToken || "").trim() || newAccessToken(),
      host: String(parsed.host || "127.0.0.1"),
      port: Number(parsed.port || 8765),
      model: String(parsed.model || "composer-2.5"),
      modelParams: Array.isArray(parsed.modelParams) ? parsed.modelParams : [],
    };
    if (!String(parsed.accessToken || "").trim()) await saveConfig(cfg);
    return cfg;
  } catch {
    const cfg = defaults();
    await saveConfig(cfg);
    return cfg;
  }
}

export async function saveConfig(config: ProxyConfig): Promise<void> {
  await ensureDirs();
  await writeFile(PROXY_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function workbenchApiKey(): Promise<string> {
  try {
    const raw = await readFile(WORKBENCH_FILE, "utf8");
    return String((JSON.parse(raw) as { apiKey?: string }).apiKey || "").trim();
  } catch {
    return "";
  }
}

export type KeySource = "header" | "env" | "proxy" | "workbench" | "";

function sameToken(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (!left.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

async function storedApiKey(): Promise<{ apiKey: string; source: KeySource }> {
  const env = String(process.env.CURSOR_API_KEY || "").trim();
  if (env) return { apiKey: env, source: "env" };
  const cfg = await loadConfig();
  if (cfg.apiKey) return { apiKey: cfg.apiKey, source: "proxy" };
  const wb = await workbenchApiKey();
  if (wb) return { apiKey: wb, source: "workbench" };
  return { apiKey: "", source: "" };
}

export async function resolveApiKey(reqKey?: string): Promise<{ apiKey: string; source: KeySource }> {
  const header = String(reqKey || "").trim();
  if (!header) return storedApiKey();
  if (header.startsWith("crsr_")) return { apiKey: header, source: "header" };
  const cfg = await loadConfig();
  if (cfg.accessToken && sameToken(header, cfg.accessToken)) return storedApiKey();
  return { apiKey: "", source: "" };
}

export function publicConfig(
  config: ProxyConfig,
  extra: { host: string; port: number; source: KeySource; apiKey: string },
) {
  const key = extra.apiKey || "";
  return {
    hasKey: key.length > 0,
    apiKey: key,
    keyHint: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : "",
    keySource: extra.source,
    host: extra.host,
    port: extra.port,
    baseUrl: `http://${extra.host}:${extra.port}/v1`,
    model: config.model,
    modelParams: config.modelParams,
  };
}
