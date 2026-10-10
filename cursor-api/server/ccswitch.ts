import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppMode, CcSwitchStatus } from "./config.ts";
import {
  anthropicToolsPayload,
  buildCcAgentSystem,
  executeCcTool,
  openaiToolsPayload,
  responsesToolsPayload,
  type CcToolCall,
} from "./cc-agent-tools.ts";

export type CcProtocol = "anthropic" | "openai" | "responses";

export type CcEndpoint = {
  baseUrl: string;
  apiKey: string;
  protocol: CcProtocol;
  providerHint?: string;
  /** When set, this endpoint is preferred for matching model ids. */
  modelIds?: string[];
  /** 来自明确选中的供应商：协议固定，不再按模型名猜测/跨协议回退。 */
  strict?: boolean;
};

export type CcChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type CcModelInfo = {
  id: string;
  displayName: string;
  description?: string;
  /** 供应商名称（如 TrueSOTA-Claude），模型下拉按它分组。 */
  provider?: string;
  /** CC Switch 应用分组（Claude Code / Codex / Grok Build …）。 */
  group?: string;
  /** 实际发给上游的模型名（id 为 `sourceKey::bare` 时使用）。 */
  bare?: string;
  parameters?: Array<{
    id: string;
    displayName?: string;
    values: Array<{ value: string; displayName?: string }>;
  }>;
  defaultParams?: Array<{ id: string; value: string }>;
};

const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const GROK_CONFIG = join(homedir(), ".grok", "config.toml");
const CC_SWITCH_DB = join(homedir(), ".cc-switch", "cc-switch.db");
const CC_SWITCH_SETTINGS = join(homedir(), ".cc-switch", "settings.json");

/** Cloudflare / 部分网关会拦默认 UA，需模拟浏览器。 */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const FALLBACK_CLAUDE_MODELS: CcModelInfo[] = [
  { id: "claude-opus-4-6", displayName: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
  { id: "claude-opus-4-5", displayName: "Claude Opus 4.5" },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
  { id: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
  { id: "claude-opus-4-20250514", displayName: "Claude Opus 4" },
  { id: "claude-opus-4-1-20250805", displayName: "Claude Opus 4.1" },
];

const FALLBACK_GROK_MODELS: CcModelInfo[] = [
  { id: "grok-4.7", displayName: "Grok 4.7" },
  { id: "grok-4.6", displayName: "Grok 4.6" },
  { id: "grok-4.5", displayName: "Grok 4.5" },
  { id: "grok-4.5-build", displayName: "Grok 4.5 Build" },
  { id: "grok-4.3", displayName: "Grok 4.3" },
  { id: "grok-4", displayName: "Grok 4" },
  { id: "grok-3", displayName: "Grok 3" },
];

/** 列表缓存，避免每次打开下拉都打上游。 */
let ccModelsCache: { at: number; key: string; list: CcModelInfo[] } | null = null;
const CC_MODELS_CACHE_MS = 60_000;

type CcProviderCred = {
  id: string;
  name: string;
  appType: string;
  baseUrl: string;
  apiKey: string;
};

function normalizeBaseUrl(url: string) {
  return String(url || "")
    .trim()
    .replace(/\/+$/, "");
}

function isProxyManagedKey(key?: string) {
  if (!key) return true;
  const v = key.trim();
  return !v || v === "PROXY_MANAGED" || v === "cc-switch";
}

/** Best-effort env extract — CC Switch sometimes leaves trailing comments / missing commas. */
function extractClaudeEnv(raw: string): { baseUrl?: string; apiKey?: string } {
  try {
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> };
    const env = parsed?.env || {};
    const baseUrl =
      typeof env.ANTHROPIC_BASE_URL === "string" ? normalizeBaseUrl(env.ANTHROPIC_BASE_URL) : undefined;
    const apiKey =
      (typeof env.ANTHROPIC_AUTH_TOKEN === "string" && env.ANTHROPIC_AUTH_TOKEN.trim()) ||
      (typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY.trim()) ||
      undefined;
    return { baseUrl, apiKey };
  } catch {
    const base =
      raw.match(/"ANTHROPIC_BASE_URL"\s*:\s*"([^"]+)"/)?.[1] ||
      raw.match(/ANTHROPIC_BASE_URL["\s:=]+["']?([^\s"',}]+)/)?.[1];
    const key =
      raw.match(/"ANTHROPIC_AUTH_TOKEN"\s*:\s*"([^"]+)"/)?.[1] ||
      raw.match(/"ANTHROPIC_API_KEY"\s*:\s*"([^"]+)"/)?.[1];
    return {
      baseUrl: base ? normalizeBaseUrl(base) : undefined,
      apiKey: key?.trim() || undefined,
    };
  }
}

async function readClaudeLiveEnv(): Promise<{ baseUrl?: string; apiKey?: string }> {
  try {
    const raw = await readFile(CLAUDE_SETTINGS, "utf8");
    return extractClaudeEnv(raw);
  } catch {
    return {};
  }
}

type GrokLive = {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  models: string[];
  apiBackend: "responses" | "openai";
  name?: string;
};

/** Minimal TOML reader for ~/.grok/config.toml shape written by CC Switch. */
function parseGrokToml(raw: string): GrokLive | null {
  const defaultModel = raw.match(/^\s*default\s*=\s*"([^"]+)"/m)?.[1]?.trim();
  const modelBlocks = [...raw.matchAll(/\[model\."([^"]+)"\]([\s\S]*?)(?=\n\[|\s*$)/g)];
  const models: Array<{
    id: string;
    baseUrl?: string;
    apiKey?: string;
    apiBackend?: string;
    name?: string;
  }> = [];
  for (const m of modelBlocks) {
    const id = m[1];
    const body = m[2] || "";
    models.push({
      id,
      baseUrl: body.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1],
      apiKey: body.match(/^\s*api_key\s*=\s*"([^"]+)"/m)?.[1],
      apiBackend: body.match(/^\s*api_backend\s*=\s*"([^"]+)"/m)?.[1],
      name: body.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1],
    });
  }
  if (!models.length && !defaultModel) return null;
  const preferred =
    models.find((x) => x.id === defaultModel) ||
    models[0] ||
    ({ id: defaultModel || "grok-4.5" } as (typeof models)[number]);
  const baseUrl = normalizeBaseUrl(preferred.baseUrl || "http://127.0.0.1:15721/grokbuild/v1");
  const backend = preferred.apiBackend === "openai" ? "openai" : "responses";
  const ids = [...new Set([defaultModel, ...models.map((x) => x.id)].filter(Boolean) as string[])];
  return {
    baseUrl,
    apiKey: preferred.apiKey || "PROXY_MANAGED",
    defaultModel: defaultModel || preferred.id || "grok-4.5",
    models: ids.length ? ids : [preferred.id],
    apiBackend: backend,
    name: preferred.name,
  };
}

async function readGrokLive(): Promise<GrokLive | null> {
  try {
    const raw = await readFile(GROK_CONFIG, "utf8");
    return parseGrokToml(raw);
  } catch {
    return null;
  }
}

/** 从 CC Switch 供应商 settings_config 抽出 baseUrl + apiKey（不落盘、不打日志）。 */
function extractProviderCred(
  id: string,
  appType: string,
  name: string,
  settingsConfig: string,
): CcProviderCred | null {
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(settingsConfig) as Record<string, unknown>;
  } catch {
    return null;
  }
  const env =
    cfg.env && typeof cfg.env === "object" ? (cfg.env as Record<string, unknown>) : {};
  const auth =
    cfg.auth && typeof cfg.auth === "object" ? (cfg.auth as Record<string, unknown>) : {};

  let baseUrl =
    (typeof env.ANTHROPIC_BASE_URL === "string" && env.ANTHROPIC_BASE_URL) ||
    (typeof env.OPENAI_BASE_URL === "string" && env.OPENAI_BASE_URL) ||
    (typeof env.BASE_URL === "string" && env.BASE_URL) ||
    "";
  let apiKey =
    (typeof env.ANTHROPIC_AUTH_TOKEN === "string" && env.ANTHROPIC_AUTH_TOKEN) ||
    (typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY) ||
    (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY) ||
    (typeof auth.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY) ||
    (typeof auth.api_key === "string" && auth.api_key) ||
    "";

  const confStr = typeof cfg.config === "string" ? cfg.config : "";
  if (confStr) {
    if (!baseUrl) {
      baseUrl =
        confStr.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1] ||
        confStr.match(/openai_base_url\s*=\s*"([^"]+)"/i)?.[1] ||
        "";
    }
    if (!apiKey) {
      apiKey =
        confStr.match(/^\s*api_key\s*=\s*"([^"]+)"/m)?.[1] ||
        confStr.match(/OPENAI_API_KEY\s*=\s*"([^"]+)"/)?.[1] ||
        "";
    }
  }

  baseUrl = normalizeBaseUrl(baseUrl);
  apiKey = String(apiKey || "").trim();
  if (!baseUrl || !apiKey || isProxyManagedKey(apiKey)) return null;
  // 跳过明显指向本地代理的「真 Key」配置（极少见）
  if (/127\.0\.0\.1|localhost/i.test(baseUrl)) return null;
  return { id, name, appType, baseUrl, apiKey };
}

type CcCurrentProvider = {
  id: string;
  appType: string;
  name: string;
};

type CcSwitchUiSettings = {
  visibleApps: Record<string, boolean>;
  currentProviderClaude?: string;
  currentProviderClaudeDesktop?: string;
  currentProviderGrokbuild?: string;
  currentProviderCodex?: string;
};

const APP_TYPE_LABEL: Record<string, string> = {
  claude: "Claude Code",
  "claude-desktop": "Claude Desktop",
  grokbuild: "Grok Build",
  codex: "Codex",
  gemini: "Gemini CLI",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  pi: "Pi",
  mcode: "MiniMax Code",
};

/** CC Switch 设置：可见 App 标签 + 各通道 currentProvider*。 */
function readCcSwitchUiSettings(): CcSwitchUiSettings {
  try {
    const raw = readFileSync(CC_SWITCH_SETTINGS, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const visible =
      parsed.visibleApps && typeof parsed.visibleApps === "object"
        ? (parsed.visibleApps as Record<string, boolean>)
        : {};
    return {
      visibleApps: visible,
      currentProviderClaude:
        typeof parsed.currentProviderClaude === "string"
          ? parsed.currentProviderClaude
          : undefined,
      currentProviderClaudeDesktop:
        typeof parsed.currentProviderClaudeDesktop === "string"
          ? parsed.currentProviderClaudeDesktop
          : undefined,
      currentProviderGrokbuild:
        typeof parsed.currentProviderGrokbuild === "string"
          ? parsed.currentProviderGrokbuild
          : undefined,
      currentProviderCodex:
        typeof parsed.currentProviderCodex === "string"
          ? parsed.currentProviderCodex
          : undefined,
    };
  } catch {
    return { visibleApps: {} };
  }
}

/**
 * 工作台该跟哪条「Claude 族」供应商：
 * - 你在 CC Switch 里关掉了 Claude、只开 Claude Desktop 时，必须跟 Desktop（TrueSOTA-THB）
 * - 否则优先跟可见的 Claude 通道
 * 本地 15721 的 /v1/messages 只注入 Claude 通道 key，跟 UI「使用中」可能不是同一把。
 */
function preferredClaudeAppTypes(ui: CcSwitchUiSettings): string[] {
  const v = ui.visibleApps || {};
  const deskOn = v["claude-desktop"] === true;
  const claudeOn = v.claude === true;
  if (deskOn && !claudeOn) return ["claude-desktop", "claude"];
  if (claudeOn && !deskOn) return ["claude", "claude-desktop"];
  if (deskOn && claudeOn) return ["claude", "claude-desktop"];
  // 都没显式开：仍优先 Desktop（多数用户只在 Desktop 页切换）
  return ["claude-desktop", "claude"];
}

/** 当前启用供应商的展示文案；Claude 族只展示工作台实际会用的那条。 */
function formatCurrentProviderHint(
  rows: CcCurrentProvider[],
  preferredClaudeTypes?: string[],
): string {
  if (!rows.length) return "";
  const order = preferredClaudeTypes?.length
    ? preferredClaudeTypes
    : ["claude", "claude-desktop"];
  const preferredClaude = order
    .map((t) => rows.find((r) => r.appType === t))
    .find(Boolean);
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (r?: CcCurrentProvider) => {
    if (!r) return;
    const label = APP_TYPE_LABEL[r.appType] || r.appType;
    const name = String(r.name || "").trim();
    const text = name ? `${label} · ${name}` : label;
    if (seen.has(text)) return;
    seen.add(text);
    parts.push(text);
  };
  push(preferredClaude);
  for (const r of rows) {
    if (r.appType === "claude" || r.appType === "claude-desktop") continue;
    push(r);
  }
  return parts.join(" / ");
}

/**
 * 读取 ~/.cc-switch/cc-switch.db 里 is_current=1 的供应商（仅 id/类型/名称，无密钥）。
 * CC Switch 切换代理后立刻写这里；工作台应以此为准展示「当前激活」。
 */
function readCcSwitchCurrentProviders(): CcCurrentProvider[] {
  try {
    const db = new DatabaseSync(CC_SWITCH_DB, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT id, app_type, name, is_current
           FROM providers
           WHERE is_current = 1
           ORDER BY
             CASE app_type
               WHEN 'claude-desktop' THEN 0
               WHEN 'claude' THEN 1
               WHEN 'grokbuild' THEN 2
               WHEN 'codex' THEN 3
               ELSE 9
             END`,
        )
        .all() as Array<{
        id: string;
        app_type: string;
        name: string;
        is_current: number | boolean;
      }>;
      return rows.map((r) => ({
        id: String(r.id || ""),
        appType: String(r.app_type || ""),
        name: String(r.name || "").trim() || String(r.id || ""),
      }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** 按 app 类型取当前启用供应商名（优先精确 appType，其次同族）。 */
function currentProviderNameFor(
  rows: CcCurrentProvider[],
  ...appTypes: string[]
): string | undefined {
  for (const t of appTypes) {
    const hit = rows.find((r) => r.appType === t);
    if (hit?.name) return hit.name;
  }
  return undefined;
}

/**
 * 读取指定供应商 id 的凭据；找不到再按 app_type + is_current 回退。
 * 仅本进程内存使用，不写入工作区、不输出到日志。
 */
function readProviderCredById(
  id: string | undefined,
  fallbackAppTypes: string[],
): CcProviderCred | null {
  try {
    const db = new DatabaseSync(CC_SWITCH_DB, { readOnly: true });
    try {
      if (id) {
        const row = db
          .prepare(
            `SELECT id, app_type, name, settings_config FROM providers WHERE id = ?`,
          )
          .get(id) as
          | {
              id: string;
              app_type: string;
              name: string;
              settings_config: string;
            }
          | undefined;
        if (row) {
          const cred = extractProviderCred(row.id, row.app_type, row.name, row.settings_config);
          if (cred) return cred;
        }
      }
      for (const appType of fallbackAppTypes) {
        const row = db
          .prepare(
            `SELECT id, app_type, name, settings_config
             FROM providers
             WHERE app_type = ? AND is_current = 1
             LIMIT 1`,
          )
          .get(appType) as
          | {
              id: string;
              app_type: string;
              name: string;
              settings_config: string;
            }
          | undefined;
        if (!row) continue;
        const cred = extractProviderCred(row.id, row.app_type, row.name, row.settings_config);
        if (cred) return cred;
      }
      return null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * 工作台 Claude 对话实际要用的供应商（跟 UI「使用中」对齐，而不是隐藏的 claude 通道）。
 */
function pickWorkbenchClaudeCred(): CcProviderCred | null {
  const ui = readCcSwitchUiSettings();
  const order = preferredClaudeAppTypes(ui);
  for (const appType of order) {
    const preferredId =
      appType === "claude-desktop"
        ? ui.currentProviderClaudeDesktop
        : appType === "claude"
          ? ui.currentProviderClaude
          : undefined;
    const cred = readProviderCredById(preferredId, [appType]);
    if (cred) return cred;
  }
  return null;
}

/**
 * 读取 ~/.cc-switch/cc-switch.db 里「当前启用」的上游供应商凭据。
 * 仅本进程内存使用，不写入工作区、不输出到日志。
 * Claude 族按 UI 可见性排序，优先 Desktop（若 Claude 标签被隐藏）。
 */
function readCcSwitchProviderCreds(): CcProviderCred[] {
  try {
    const ui = readCcSwitchUiSettings();
    const claudeOrder = preferredClaudeAppTypes(ui);
    const appRank = (app: string) => {
      const i = claudeOrder.indexOf(app);
      if (i >= 0) return i;
      if (app === "grokbuild") return 10;
      if (app === "codex") return 11;
      return 20;
    };
    const db = new DatabaseSync(CC_SWITCH_DB, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT id, app_type, name, settings_config, is_current
           FROM providers
           WHERE is_current = 1`,
        )
        .all() as Array<{
        id: string;
        app_type: string;
        name: string;
        settings_config: string;
        is_current: number | boolean;
      }>;
      rows.sort((a, b) => appRank(a.app_type) - appRank(b.app_type));
      const out: CcProviderCred[] = [];
      const seen = new Set<string>();
      // 先塞工作台优选 Claude 凭据，保证拉模型/展示优先它
      const preferred = pickWorkbenchClaudeCred();
      if (preferred) {
        const key = `${preferred.baseUrl}::${preferred.apiKey.slice(0, 12)}`;
        seen.add(key);
        out.push(preferred);
      }
      for (const r of rows) {
        const cred = extractProviderCred(r.id, r.app_type, r.name, r.settings_config);
        if (!cred) continue;
        const key = `${cred.baseUrl}::${cred.apiKey.slice(0, 12)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cred);
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** 可选：从 model_pricing 取展示名（CC Switch 本地价目表，非上游目录）。 */
function readCcSwitchPricingNames(): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const db = new DatabaseSync(CC_SWITCH_DB, { readOnly: true });
    try {
      const rows = db
        .prepare(`SELECT model_id, display_name FROM model_pricing`)
        .all() as Array<{ model_id: string; display_name: string }>;
      for (const r of rows) {
        if (r.model_id && r.display_name) map.set(r.model_id, r.display_name);
      }
    } finally {
      db.close();
    }
  } catch {
    /* ignore */
  }
  return map;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const { timeoutMs = 2500, signal, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    return await fetch(url, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

type RemoteModelRow = {
  id: string;
  displayName?: string;
  parameters?: CcModelInfo["parameters"];
  defaultParams?: CcModelInfo["defaultParams"];
};

function parseReasoningParams(m: Record<string, unknown>): {
  parameters?: CcModelInfo["parameters"];
  defaultParams?: CcModelInfo["defaultParams"];
} {
  const efforts = m.reasoningEfforts;
  if (!Array.isArray(efforts) || !efforts.length) {
    if (m.supportsReasoningEffort || m.reasoning_effort || m.reasoningEffort) {
      // 上游只声明支持，给常用档位
      return {
        parameters: [
          {
            id: "reasoningEffort",
            displayName: "推理强度",
            values: [
              { value: "low", displayName: "Low" },
              { value: "medium", displayName: "Medium" },
              { value: "high", displayName: "High" },
            ],
          },
        ],
        defaultParams: [
          {
            id: "reasoningEffort",
            value: String(m.reasoningEffort || m.reasoning_effort || "high"),
          },
        ],
      };
    }
    return {};
  }
  const values: Array<{ value: string; displayName?: string }> = [];
  let defaultValue: string | undefined;
  for (const item of efforts) {
    if (typeof item === "string" && item.trim()) {
      values.push({ value: item.trim(), displayName: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const value = String(row.value || row.id || row.name || "").trim();
    if (!value) continue;
    const label = String(row.label || row.display_name || row.displayName || value).trim();
    values.push({ value, displayName: label });
    if (row.default === true) defaultValue = value;
  }
  if (!values.length) return {};
  if (!defaultValue) {
    defaultValue = String(m.reasoningEffort || m.reasoning_effort || values[values.length - 1]?.value || "high");
  }
  return {
    parameters: [{ id: "reasoningEffort", displayName: "推理强度", values }],
    defaultParams: [{ id: "reasoningEffort", value: defaultValue }],
  };
}

function parseModelsPayload(data: unknown): RemoteModelRow[] {
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  const raw = obj.data ?? obj.models ?? obj.items;
  const rows = Array.isArray(raw) ? raw : [];
  const out: RemoteModelRow[] = [];
  for (const item of rows) {
    if (typeof item === "string" && item.trim()) {
      out.push({ id: item.trim() });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const m = item as Record<string, unknown>;
    const id = String(m.id || m.name || m.model || "").trim();
    if (!id) continue;
    const displayName = String(m.display_name || m.displayName || m.name || "").trim() || undefined;
    const reasoning = parseReasoningParams(m);
    out.push({
      id,
      displayName: displayName && displayName !== id ? displayName : undefined,
      ...reasoning,
    });
  }
  return out;
}

/**
 * 用供应商真 Key 直连上游 /v1/models（带浏览器 UA，绕过部分 Cloudflare 拦截）。
 * 本地 15721 代理的 /v1/models 常为空（catalog 未注入），不能只依赖代理。
 */
async function fetchUpstreamModels(cred: CcProviderCred): Promise<RemoteModelRow[]> {
  const base = normalizeBaseUrl(cred.baseUrl);
  const paths = ["/v1/models", "/models"];
  const headerVariants: Record<string, string>[] = [
    {
      Accept: "application/json",
      Authorization: `Bearer ${cred.apiKey}`,
      "User-Agent": BROWSER_UA,
    },
    {
      Accept: "application/json",
      "x-api-key": cred.apiKey,
      Authorization: `Bearer ${cred.apiKey}`,
      "anthropic-version": "2023-06-01",
      "User-Agent": BROWSER_UA,
    },
  ];

  for (const path of paths) {
    for (const headers of headerVariants) {
      try {
        const res = await fetchWithTimeout(`${base}${path}`, {
          method: "GET",
          headers,
          timeoutMs: 8000,
        });
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        const rows = parseModelsPayload(data);
        if (rows.length) return rows;
      } catch {
        /* try next */
      }
    }
  }
  return [];
}

/** 去掉 vendor 前缀重复项：优先保留无前缀的规范 id（grok-4.6 优于 xai/grok-4.6）。 */
function canonicalizeModelId(id: string): string {
  const s = id.trim();
  if (!s) return s;
  // x-ai/grok-4.6、xai/grok-4.6、grok/grok-4.6 → 仍保留原 id 供调用，
  // 去重时用「末段」判断姐妹重复。
  return s;
}

function modelDedupeKey(id: string): string {
  const s = id.trim().toLowerCase();
  // 同源别名：xai/grok-4.6、x-ai/grok-4.6、grok/grok-4.6 → grok-4.6
  const parts = s.split("/");
  const tail = parts[parts.length - 1] || s;
  if (parts.length > 1 && /^(x-?ai|grok|openai|anthropic|google)$/i.test(parts[0])) {
    return tail;
  }
  return s;
}

function modelSortTier(id: string): number {
  const s = id.toLowerCase();
  if (/^claude/.test(s)) return 0;
  if (/^grok/.test(s) || /\/grok/.test(s)) return 1;
  if (/^gpt-|^o[0-9]/.test(s)) return 2;
  if (/gemini|gemma/.test(s)) return 3;
  // 图片/视频类靠后
  if (/imagine|image|video|tts|whisper|embedding/.test(s)) return 9;
  return 5;
}

export async function probeCcSwitch(proxyUrl: string): Promise<boolean> {
  const base = normalizeBaseUrl(proxyUrl);
  if (!base) return false;
  const roots = [base, `${base}/grokbuild/v1`, `${base}/v1`];
  for (const root of roots) {
    try {
      await fetchWithTimeout(root, { method: "GET", timeoutMs: 1200 });
      return true;
    } catch {
      /* try next */
    }
  }
  try {
    await fetchWithTimeout(`${base}/v1/models`, { method: "GET", timeoutMs: 1200 });
    return true;
  } catch {
    return false;
  }
}

function isGrokModel(model: string) {
  return /^grok/i.test(String(model || "").trim());
}

function isGptModel(model: string) {
  const s = String(model || "").trim().toLowerCase().split("/").pop() || "";
  return /^(gpt-|o\d|codex|chatgpt)/.test(s);
}

export async function resolveCcSwitchEndpoint(proxyUrl: string, model?: string): Promise<CcEndpoint> {
  const proxy = normalizeBaseUrl(proxyUrl) || "http://127.0.0.1:15721";
  const wantGrok = model ? isGrokModel(model) : false;
  const ui = readCcSwitchUiSettings();
  const current = readCcSwitchCurrentProviders();
  const claudeTypes = preferredClaudeAppTypes(ui);

  if (wantGrok) {
    const grok = await readGrokLive();
    const grokName =
      currentProviderNameFor(current, "grokbuild") || grok?.name || undefined;
    if (grok) {
      return {
        baseUrl: grok.baseUrl,
        apiKey: grok.apiKey,
        protocol: grok.apiBackend === "openai" ? "openai" : "responses",
        providerHint: grokName ? `Grok Build · ${grokName}` : "Grok Build",
        modelIds: grok.models,
      };
    }
    // Proxy path even without local toml.
    return {
      baseUrl: `${proxy}/grokbuild/v1`,
      apiKey: "PROXY_MANAGED",
      protocol: "responses",
      providerHint: grokName ? `Grok Build · ${grokName}` : "Grok Build",
      modelIds: FALLBACK_GROK_MODELS.map((m) => m.id),
    };
  }

  // GPT / Codex 族：必须用 Codex 供应商那把 key（分组才有 gpt-*），走 Responses 协议。
  // 否则会拿 Claude Desktop 的 key 去请求 gpt-*，上游报 model_not_found。
  if (model && isGptModel(model)) {
    const codex = readProviderCredById(ui.currentProviderCodex, ["codex"]);
    if (codex) {
      return {
        baseUrl: codex.baseUrl,
        apiKey: codex.apiKey,
        protocol: "responses",
        providerHint: `Codex · ${codex.name}`,
      };
    }
  }

  // Claude 族：跟 UI「使用中」对齐。
  // 你只开了 Claude Desktop（TrueSOTA-THB）时，不能再走 15721 Claude 通道
  // （那条会注入隐藏的 Claude·TrueSOTA 另一把 key）。
  const preferred = pickWorkbenchClaudeCred();
  if (preferred) {
    const label = APP_TYPE_LABEL[preferred.appType] || preferred.appType;
    // Desktop 通道的本地 /claude-desktop 网关要专用 token，工作台拿不到；
    // 直接用该供应商真 Key + 上游 baseUrl（与 CC Switch 编辑页「获取模型」同一路径）。
    return {
      baseUrl: preferred.baseUrl,
      apiKey: preferred.apiKey,
      protocol: "anthropic",
      providerHint: `${label} · ${preferred.name}`,
    };
  }

  // 兜底：DB 读不到凭据时再走 live/proxy
  const live = await readClaudeLiveEnv();
  const baseUrl = live.baseUrl || proxy;
  const apiKey = live.apiKey || "PROXY_MANAGED";
  const claudeName = currentProviderNameFor(current, ...claudeTypes);
  const viaProxy = /127\.0\.0\.1|localhost/i.test(baseUrl);
  return {
    baseUrl,
    apiKey,
    protocol: "anthropic",
    providerHint: claudeName
      ? viaProxy
        ? `Claude · ${claudeName}`
        : `Claude · ${claudeName} · ${baseUrl}`
      : viaProxy
        ? "CC Switch 本地代理"
        : baseUrl,
  };
}

export async function getCcSwitchStatus(proxyUrl: string): Promise<CcSwitchStatus> {
  const proxy = normalizeBaseUrl(proxyUrl) || "http://127.0.0.1:15721";
  try {
    const up = await probeCcSwitch(proxy);
    const live = await readClaudeLiveEnv();
    const grok = await readGrokLive();
    const ui = readCcSwitchUiSettings();
    const current = readCcSwitchCurrentProviders();
    const claudeTypes = preferredClaudeAppTypes(ui);
    const preferred = pickWorkbenchClaudeCred();
    const activeHint = formatCurrentProviderHint(current, claudeTypes);

    // 读到了「应用」页已显示的供应商：直连上游对话，不依赖本地代理
    const sources = listCcSources();
    if (sources.length) {
      const apps = [...new Set(sources.map((s) => s.appLabel))];
      return {
        connected: true,
        baseUrl: proxy,
        providerHint: `${sources.length} 个供应商 · ${apps.join(" / ")}`,
      };
    }

    // 有 UI 对齐的 Claude 供应商凭据时，即使本地代理挂了也能对话（直连上游）
    if (preferred) {
      const label = APP_TYPE_LABEL[preferred.appType] || preferred.appType;
      const hint =
        activeHint ||
        `${label} · ${preferred.name}`;
      return {
        connected: true,
        baseUrl: preferred.baseUrl,
        providerHint: hint,
      };
    }

    if (!up && !live.baseUrl && !grok && !current.length) {
      return {
        connected: false,
        baseUrl: proxy,
        error: "未检测到 CC Switch。请先打开 CC Switch 并启用供应商（需要代理时先开代理）。",
      };
    }
    if (!up) {
      // Still report connected if live files point at a reachable host.
      if (live.baseUrl) {
        const liveUp = await probeCcSwitch(live.baseUrl);
        if (liveUp) {
          const name = currentProviderNameFor(current, ...claudeTypes);
          return {
            connected: true,
            baseUrl: live.baseUrl,
            providerHint: name
              ? `Claude · ${name}`
              : activeHint || "Claude live 配置",
          };
        }
      }
      if (grok?.baseUrl) {
        try {
          await fetchWithTimeout(grok.baseUrl, { method: "GET", timeoutMs: 1200 });
          const name =
            currentProviderNameFor(current, "grokbuild") || grok.name || undefined;
          return {
            connected: true,
            baseUrl: grok.baseUrl,
            providerHint: name
              ? `Grok Build · ${name}`
              : activeHint || "Grok Build",
          };
        } catch {
          /* fall through */
        }
      }
      // DB 里有当前供应商，但本地代理没起来 —— 仍提示名称，方便对照
      if (current.length) {
        return {
          connected: false,
          baseUrl: proxy,
          providerHint: activeHint,
          error: `无法连接 ${proxy}。CC Switch 当前启用：${activeHint}。请先打开 CC Switch 并启用本地代理。`,
        };
      }
      return {
        connected: false,
        baseUrl: proxy,
        error: `无法连接 ${proxy}。请先打开 CC Switch 并启用本地代理。`,
      };
    }

    // 代理在线：优先展示工作台实际会用的供应商
    if (activeHint) {
      return {
        connected: true,
        baseUrl: proxy,
        providerHint: activeHint,
      };
    }
    const hints = [
      live.baseUrl || proxy ? "Claude" : null,
      grok ? `Grok Build${grok.name ? ` · ${grok.name}` : ""}` : null,
    ].filter(Boolean);
    return {
      connected: true,
      baseUrl: proxy,
      providerHint: hints.length ? hints.join(" / ") : "CC Switch 本地代理",
    };
  } catch (err) {
    return {
      connected: false,
      baseUrl: proxy,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function authHeaders(endpoint: CcEndpoint, protocol: CcProtocol): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // CC Switch grokbuild path rejects bogus Bearer tokens; PROXY_MANAGED means proxy injects auth.
  if (isProxyManagedKey(endpoint.apiKey)) {
    if (protocol === "anthropic") {
      headers["anthropic-version"] = "2023-06-01";
      headers["x-api-key"] = "PROXY_MANAGED";
    }
    return headers;
  }
  if (protocol === "anthropic") {
    headers["x-api-key"] = endpoint.apiKey;
    headers.authorization = `Bearer ${endpoint.apiKey}`;
    headers["anthropic-version"] = "2023-06-01";
    return headers;
  }
  headers.authorization = `Bearer ${endpoint.apiKey}`;
  return headers;
}

/** claude-haiku-4-5 → Claude Haiku 4.5；grok-4.6-latest → Grok 4.6 Latest；日期后缀保持原样。 */
function prettyVersioned(bare: string) {
  const parts = bare.split("-").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (/^\d{1,2}$/.test(p) && /^\d{1,2}$/.test(parts[i + 1] || "") && out.length && !/^\d/.test(out[out.length - 1])) {
      out.push(`${p}.${parts[i + 1]}`);
      i++;
    } else if (/^[a-z]/i.test(p)) {
      out.push(p[0].toUpperCase() + p.slice(1));
    } else {
      out.push(p);
    }
  }
  return out.join(" ");
}

function prettyModelName(id: string) {
  const raw = id.trim();
  if (!raw) return raw;
  // 去掉 vendor 前缀再美化展示
  const bare = raw.includes("/") ? raw.split("/").pop() || raw : raw;
  if (/^(grok|claude)/i.test(bare)) return prettyVersioned(bare);
  if (/^gpt-/i.test(bare)) return bare.replace(/^gpt-/i, "GPT-");
  if (/^gemini/i.test(bare)) {
    return bare
      .replace(/^gemini-?/i, "Gemini ")
      .replace(/-/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (/^deepseek/i.test(bare)) return bare.replace(/^deepseek-?/i, "DeepSeek ").replace(/-/g, " ").trim();
  return bare
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** 是否像「聊天主模型」——列表里优先展示，图片/视频等靠后或可滤。 */
function isPrimaryChatModel(id: string) {
  const s = id.toLowerCase();
  if (/imagine|image|video|tts|whisper|embedding|moderation|transcribe/.test(s)) return false;
  return true;
}

function isVendorPrefixed(id: string) {
  return /^(x-?ai|grok|openai|anthropic|google)\//i.test(id.trim());
}

/**
 * 合并并去重模型。
 * - 同一逻辑模型（grok-4.6 / xai/grok-4.6）只保留一条
 * - 优先无 vendor 前缀的规范 id
 * - 上游 displayName / reasoning 参数一并保留
 */
function mergeModelRows(
  rows: RemoteModelRow[],
  pricingNames?: Map<string, string>,
): CcModelInfo[] {
  // dedupeKey → 选中的 row
  const best = new Map<string, RemoteModelRow>();
  for (const row of rows) {
    const id = canonicalizeModelId(row.id);
    if (!id) continue;
    const key = modelDedupeKey(id);
    const prev = best.get(key);
    if (!prev) {
      best.set(key, { ...row, id });
      continue;
    }
    const prevPref = isVendorPrefixed(prev.id);
    const curPref = isVendorPrefixed(id);
    // 优先无前缀
    if (prevPref && !curPref) {
      best.set(key, {
        ...row,
        id,
        displayName: row.displayName || prev.displayName,
        parameters: row.parameters || prev.parameters,
        defaultParams: row.defaultParams || prev.defaultParams,
      });
      continue;
    }
    // 同级：补齐展示名与参数
    if (!prev.displayName && row.displayName) prev.displayName = row.displayName;
    if (!prev.parameters && row.parameters) prev.parameters = row.parameters;
    if (!prev.defaultParams && row.defaultParams) prev.defaultParams = row.defaultParams;
    // 更短的规范 id 优先（grok-4.6 优于 grok-4.6-latest 仅当完全同 key；latest 是不同 key）
    if (!prevPref && !curPref && id.length < prev.id.length && !/-latest$/i.test(id)) {
      prev.id = id;
    }
  }

  const list: CcModelInfo[] = [];
  for (const row of best.values()) {
    const priced = pricingNames?.get(row.id);
    list.push({
      id: row.id,
      displayName: row.displayName || priced || prettyModelName(row.id),
      ...(row.parameters ? { parameters: row.parameters } : {}),
      ...(row.defaultParams ? { defaultParams: row.defaultParams } : {}),
    });
  }
  list.sort((a, b) => {
    const ap = isPrimaryChatModel(a.id) ? 0 : 1;
    const bp = isPrimaryChatModel(b.id) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const at = modelSortTier(a.id);
    const bt = modelSortTier(b.id);
    if (at !== bt) return at - bt;
    return a.id.localeCompare(b.id);
  });
  return list;
}

async function fetchProxyModelRows(endpoint: CcEndpoint): Promise<RemoteModelRow[]> {
  const bases = [
    endpoint.baseUrl,
    normalizeBaseUrl(endpoint.baseUrl.replace(/\/v1$/, "")),
    normalizeBaseUrl(endpoint.baseUrl.replace(/\/grokbuild\/v1$/, "")),
    "http://127.0.0.1:15721",
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  const out: RemoteModelRow[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    for (const path of ["/v1/models", "/models", "/grokbuild/v1/models"]) {
      try {
        const res = await fetchWithTimeout(`${base}${path}`, {
          method: "GET",
          headers: {
            Accept: "application/json",
            "User-Agent": BROWSER_UA,
            ...authHeaders(endpoint, "openai"),
          },
          timeoutMs: 3000,
        });
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        for (const row of parseModelsPayload(data)) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          out.push(row);
        }
      } catch {
        /* try next */
      }
    }
  }
  return out;
}

/**
 * CC Switch 模式模型列表：
 * 1. 读 ~/.cc-switch 当前供应商真 Key，直连上游 /v1/models（TrueSOTA 等会返回完整目录）
 * 2. 再合并本地代理 /v1/models（通常为空，兼容有 catalog 的代理）
 * 3. 合并 ~/.grok/config.toml 里已启用模型
 * 4. 仍没有非 Grok / 没有任何模型时，用内置 fallback
 *
 * 结果缓存 60s，避免每次打开下拉都打上游。
 */
export async function listCcSwitchModels(endpoint: CcEndpoint): Promise<CcModelInfo[]> {
  const creds = readCcSwitchProviderCreds();
  const cacheKey = [
    endpoint.baseUrl,
    ...creds.map((c) => `${c.id}@${c.baseUrl}`),
  ].join("|");

  if (ccModelsCache && ccModelsCache.key === cacheKey && Date.now() - ccModelsCache.at < CC_MODELS_CACHE_MS) {
    return ccModelsCache.list;
  }

  const remoteRows: RemoteModelRow[] = [];
  const pricingNames = readCcSwitchPricingNames();

  // 1) 上游真 Key（并行）
  if (creds.length) {
    const batches = await Promise.all(creds.map((c) => fetchUpstreamModels(c)));
    for (const batch of batches) remoteRows.push(...batch);
  }

  // 2) 本地代理（可能空）
  try {
    remoteRows.push(...(await fetchProxyModelRows(endpoint)));
  } catch {
    /* ignore */
  }

  // 3) grok live toml
  const grok = await readGrokLive();
  if (grok) {
    for (const id of grok.models) remoteRows.push({ id, displayName: prettyModelName(id) });
    if (grok.defaultModel) remoteRows.push({ id: grok.defaultModel, displayName: prettyModelName(grok.defaultModel) });
  }

  let list = mergeModelRows(remoteRows, pricingNames);

  // 4) fallback：上游全挂时保证下拉可用
  if (!list.length) {
    list = mergeModelRows(
      [...FALLBACK_CLAUDE_MODELS, ...FALLBACK_GROK_MODELS].map((m) => ({
        id: m.id,
        displayName: m.displayName,
      })),
      pricingNames,
    );
  } else {
    const hasClaude = list.some((m) => /^claude/i.test(m.id));
    const hasGrok = list.some((m) => isGrokModel(m.id) || /\/grok/i.test(m.id));
    // TrueSOTA 当前目录几乎全是 Grok 时，补一组常用 Claude，方便走同一代理打 Claude 协议
    if (!hasClaude) {
      const extra = mergeModelRows(
        FALLBACK_CLAUDE_MODELS.map((m) => ({ id: m.id, displayName: m.displayName })),
        pricingNames,
      );
      list = mergeModelRows(
        [...list, ...extra].map((m) => ({
          id: m.id,
          displayName: m.displayName,
          parameters: m.parameters,
          defaultParams: m.defaultParams,
        })),
        pricingNames,
      );
    }
    if (!hasGrok && !grok) {
      const extra = mergeModelRows(
        FALLBACK_GROK_MODELS.map((m) => ({ id: m.id, displayName: m.displayName })),
        pricingNames,
      );
      list = mergeModelRows(
        [...list, ...extra].map((m) => ({
          id: m.id,
          displayName: m.displayName,
          parameters: m.parameters,
          defaultParams: m.defaultParams,
        })),
        pricingNames,
      );
    }
  }

  // Grok 在前（若有 grok live / 上游以 Grok 为主），否则 Claude 优先——mergeModelRows 已按 tier 排
  // 若存在 grok live default，把它稳定提到同 tier 最前
  if (grok?.defaultModel) {
    const def = grok.defaultModel;
    list.sort((a, b) => {
      const ap = isPrimaryChatModel(a.id) ? 0 : 1;
      const bp = isPrimaryChatModel(b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      const aDef = modelDedupeKey(a.id) === modelDedupeKey(def) ? 0 : 1;
      const bDef = modelDedupeKey(b.id) === modelDedupeKey(def) ? 0 : 1;
      if (aDef !== bDef) return aDef - bDef;
      const at = modelSortTier(a.id);
      const bt = modelSortTier(b.id);
      if (at !== bt) return at - bt;
      return a.id.localeCompare(b.id);
    });
  }

  ccModelsCache = { at: Date.now(), key: cacheKey, list };
  return list;
}

// ── 全部供应商（CC Switch「应用」页已显示的应用下的所有供应商） ─────────────

export type CcSource = {
  /** `${appType}:${providerId}` */
  key: string;
  providerId: string;
  appType: string;
  appLabel: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  protocol: CcProtocol;
  /** 上游 /models 拿不到时的兜底模型（来自供应商自己的配置）。 */
  seedModels: string[];
  isCurrent: boolean;
};

export type CcSourceSummary = {
  key: string;
  name: string;
  appType: string;
  appLabel: string;
  host: string;
  protocol: CcProtocol;
  count: number;
  /** false 表示用的是配置里的兜底模型，没拿到上游真实目录 */
  live: boolean;
  isCurrent: boolean;
  error?: string;
};

const SOURCE_APP_ORDER = [
  "claude",
  "claude-desktop",
  "codex",
  "grokbuild",
  "gemini",
  "opencode",
  "openclaw",
  "hermes",
  "pi",
  "mcode",
];

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function strOf(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function deepFindString(obj: unknown, keys: string[], depth = 0): string {
  if (!obj || typeof obj !== "object" || depth > 4) return "";
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = strOf(rec[k]);
    if (v) return v;
  }
  for (const v of Object.values(rec)) {
    const found = deepFindString(v, keys, depth + 1);
    if (found) return found;
  }
  return "";
}

function deepFindModels(obj: unknown, depth = 0): string[] {
  if (!obj || typeof obj !== "object" || depth > 4) return [];
  const rec = obj as Record<string, unknown>;
  const m = rec.models;
  if (Array.isArray(m)) {
    const ids = m
      .map((x) => (typeof x === "string" ? x : strOf((x as Record<string, unknown>)?.id) || strOf((x as Record<string, unknown>)?.name)))
      .filter(Boolean);
    if (ids.length) return ids;
  } else if (m && typeof m === "object") {
    const ids = Object.keys(m as Record<string, unknown>).filter(Boolean);
    if (ids.length) return ids;
  }
  for (const v of Object.values(rec)) {
    const found = deepFindModels(v, depth + 1);
    if (found.length) return found;
  }
  return [];
}

function tomlValue(raw: string, key: string): string {
  return raw.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1]?.trim() || "";
}

function isOwnProxyUrl(url: string) {
  return /(127\.0\.0\.1|localhost):15721/i.test(url);
}

function sourceFromRow(row: {
  id: string;
  app_type: string;
  name: string;
  settings_config: string;
  meta?: string | null;
  is_current: number | boolean;
}): CcSource | null {
  const appType = String(row.app_type || "");
  const cfg = parseJsonObject(row.settings_config);
  const meta = parseJsonObject(row.meta);
  const env = parseJsonObject(cfg.env);
  const auth = parseJsonObject(cfg.auth);
  const conf = typeof cfg.config === "string" ? cfg.config : "";

  let baseUrl = "";
  let apiKey = "";
  let protocol: CcProtocol = "openai";
  let seeds: string[] = [];

  if (appType === "claude" || appType === "claude-desktop") {
    baseUrl = strOf(env.ANTHROPIC_BASE_URL);
    apiKey = strOf(env.ANTHROPIC_AUTH_TOKEN) || strOf(env.ANTHROPIC_API_KEY);
    const fmt = strOf(meta.apiFormat);
    protocol = fmt === "openai_chat" ? "openai" : fmt === "openai_responses" ? "responses" : "anthropic";
    seeds = [
      env.ANTHROPIC_MODEL,
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      env.ANTHROPIC_REASONING_MODEL,
    ]
      .map(strOf)
      .filter(Boolean);
  } else if (appType === "codex") {
    apiKey = strOf(auth.OPENAI_API_KEY) || strOf(env.OPENAI_API_KEY) || tomlValue(conf, "api_key");
    baseUrl = tomlValue(conf, "base_url") || strOf(env.OPENAI_BASE_URL);
    protocol = tomlValue(conf, "wire_api") === "chat" ? "openai" : "responses";
    const m = tomlValue(conf, "model");
    if (m) seeds = [m];
  } else if (appType === "grokbuild") {
    const grok = parseGrokToml(conf);
    baseUrl = grok?.baseUrl || "";
    apiKey = grok?.apiKey || "";
    const backend = tomlValue(conf, "api_backend");
    protocol =
      backend === "messages" ? "anthropic" : backend === "chat_completions" || backend === "openai" ? "openai" : "responses";
    seeds = grok?.models || [];
  } else if (appType === "gemini") {
    apiKey = strOf(env.GEMINI_API_KEY) || strOf(env.GOOGLE_API_KEY);
    const rawBase = strOf(env.GOOGLE_GEMINI_BASE_URL) || "https://generativelanguage.googleapis.com";
    baseUrl = /generativelanguage\.googleapis\.com/i.test(rawBase)
      ? `${normalizeBaseUrl(rawBase).replace(/\/v1beta(\/openai)?$/, "")}/v1beta/openai`
      : normalizeBaseUrl(rawBase);
    protocol = "openai";
    const m = strOf(env.GEMINI_MODEL);
    if (m) seeds = [m];
  } else {
    // OpenCode / OpenClaw / Hermes / Pi … 配置形态不一，尽力通用提取
    baseUrl = deepFindString(cfg, ["baseURL", "baseUrl", "base_url", "api_base", "apiBase", "endpoint"]);
    apiKey = deepFindString(cfg, ["apiKey", "api_key", "token", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);
    const hint = JSON.stringify(cfg).toLowerCase();
    protocol = /@ai-sdk\/anthropic|"api":"anthropic|anthropic-messages/.test(hint)
      ? "anthropic"
      : /openai-responses|"api":"responses/.test(hint)
        ? "responses"
        : "openai";
    seeds = deepFindModels(cfg);
  }

  baseUrl = normalizeBaseUrl(baseUrl);
  apiKey = apiKey.trim();
  if (!baseUrl || isOwnProxyUrl(baseUrl)) return null;
  const local = /127\.0\.0\.1|localhost/i.test(baseUrl);
  if (isProxyManagedKey(apiKey) && !local) return null;
  if (isProxyManagedKey(apiKey)) apiKey = "";

  return {
    key: `${appType}:${row.id}`,
    providerId: String(row.id),
    appType,
    appLabel: APP_TYPE_LABEL[appType] || appType,
    name: String(row.name || "").trim() || String(row.id),
    baseUrl,
    apiKey,
    protocol,
    seedModels: [...new Set(seeds)],
    isCurrent: Boolean(row.is_current),
  };
}

/** 读 CC Switch 数据库：只取「应用」页里打开显示的应用，其下所有供应商（含未启用的）。 */
export function listCcSources(): CcSource[] {
  try {
    const ui = readCcSwitchUiSettings();
    const hasVisible = Object.keys(ui.visibleApps || {}).length > 0;
    const isVisible = (app: string) => (hasVisible ? ui.visibleApps[app] === true : true);
    const db = new DatabaseSync(CC_SWITCH_DB, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT id, app_type, name, settings_config, meta, is_current, sort_index
           FROM providers
           ORDER BY app_type, is_current DESC, sort_index, name`,
        )
        .all() as Array<{
        id: string;
        app_type: string;
        name: string;
        settings_config: string;
        meta?: string | null;
        is_current: number | boolean;
      }>;
      const rank = (a: string) => {
        const i = SOURCE_APP_ORDER.indexOf(a);
        return i < 0 ? 99 : i;
      };
      const out: CcSource[] = [];
      const seen = new Set<string>();
      for (const row of rows.sort((a, b) => rank(a.app_type) - rank(b.app_type))) {
        if (!isVisible(row.app_type)) continue;
        const s = sourceFromRow(row);
        if (!s) continue;
        // 同 host + 同 key + 同协议只保留一个（Claude / Claude Desktop 常配同一把）
        const dup = `${s.baseUrl}|${s.apiKey}|${s.protocol}`;
        if (seen.has(dup)) continue;
        seen.add(dup);
        out.push(s);
      }
      return out;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

type SourceModelsEntry = { at: number; models: CcModelInfo[]; live: boolean; error?: string };
const sourceModelCache = new Map<string, SourceModelsEntry>();

async function loadSourceModels(
  src: CcSource,
  pricing: Map<string, string>,
  refresh: boolean,
): Promise<SourceModelsEntry> {
  const hit = sourceModelCache.get(src.key);
  if (!refresh && hit && Date.now() - hit.at < CC_MODELS_CACHE_MS) return hit;

  let rows: RemoteModelRow[] = [];
  let live = true;
  let error: string | undefined;
  try {
    rows = await fetchUpstreamModels({
      id: src.providerId,
      name: src.name,
      appType: src.appType,
      baseUrl: src.baseUrl,
      apiKey: src.apiKey,
    });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  if (!rows.length) {
    live = false;
    rows = src.seedModels.map((id) => ({ id }));
    if (!rows.length) error = error || "上游没有返回模型列表，且配置里没有指定模型";
  }
  rows = rows.map((r) => ({ ...r, id: r.id.replace(/^models\//, "") })).filter((r) => isPrimaryChatModel(r.id));

  const models = mergeModelRows(rows, pricing).map((m) => ({
    ...m,
    id: `${src.key}::${m.id}`,
    bare: m.id,
    provider: src.name,
    group: src.appLabel,
  }));
  const entry: SourceModelsEntry = { at: Date.now(), models, live, ...(error ? { error } : {}) };
  sourceModelCache.set(src.key, entry);
  return entry;
}

/** 所有供应商的模型（按 CC Switch 顺序分组）+ 每个供应商的状态摘要。 */
export async function listCcSwitchSourceModels(opts: { refresh?: boolean } = {}): Promise<{
  models: CcModelInfo[];
  sources: CcSourceSummary[];
}> {
  const sources = listCcSources();
  const pricing = readCcSwitchPricingNames();
  const entries = await Promise.all(sources.map((s) => loadSourceModels(s, pricing, Boolean(opts.refresh))));
  const models: CcModelInfo[] = [];
  const summaries: CcSourceSummary[] = [];
  sources.forEach((s, i) => {
    const e = entries[i];
    models.push(...e.models);
    let host = s.baseUrl;
    try {
      host = new URL(s.baseUrl).host;
    } catch {
      /* keep raw */
    }
    summaries.push({
      key: s.key,
      name: s.name,
      appType: s.appType,
      appLabel: s.appLabel,
      host,
      protocol: s.protocol,
      count: e.models.length,
      live: e.live,
      isCurrent: s.isCurrent,
      ...(e.error ? { error: e.error } : {}),
    });
  });
  return { models, sources: summaries };
}

export function parseCcModelId(selected: string): { sourceKey?: string; model: string } {
  const raw = String(selected || "").trim();
  const i = raw.indexOf("::");
  if (i > 0) return { sourceKey: raw.slice(0, i), model: raw.slice(i + 2) };
  return { model: raw };
}

function endpointFromSource(src: CcSource): CcEndpoint {
  return {
    baseUrl: src.baseUrl,
    apiKey: src.apiKey || "PROXY_MANAGED",
    protocol: src.protocol,
    providerHint: `${src.appLabel} · ${src.name}`,
    strict: true,
  };
}

/**
 * 把 UI 选中的模型解析成「供应商 + 上游模型名」。
 * - 新格式 `sourceKey::bare`：精确落到该供应商
 * - 旧的纯模型名：找缓存里拥有它的第一个供应商，找不到再走旧的按名字猜测逻辑
 */
export async function resolveCcTarget(
  proxyUrl: string,
  selected: string,
): Promise<{ endpoint: CcEndpoint; model: string }> {
  const { sourceKey, model } = parseCcModelId(selected);
  const sources = listCcSources();
  if (sourceKey) {
    const src = sources.find((s) => s.key === sourceKey);
    if (src) return { endpoint: endpointFromSource(src), model };
    throw new Error(`供应商不存在或已在 CC Switch 中隐藏/删除：${sourceKey}`);
  }
  for (const src of sources) {
    const cached = sourceModelCache.get(src.key);
    if (cached?.models.some((m) => m.bare === model)) {
      return { endpoint: endpointFromSource(src), model };
    }
  }
  return { endpoint: await resolveCcSwitchEndpoint(proxyUrl, model), model };
}

/** 构造各协议请求地址：兼容 base 已带 /v1、/v4、/openai 等情况。 */
function anthropicMessagesUrl(base: string) {
  const b = base.replace(/\/+$/, "").replace(/\/v1\/messages$/, "");
  return /\/v1$/.test(b) ? `${b}/messages` : `${b}/v1/messages`;
}

function openaiChatUrl(base: string) {
  const b = base.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  return /\/(v\d+[a-z0-9]*|openai)$/i.test(b) ? `${b}/chat/completions` : `${b}/v1/chat/completions`;
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: string) => void,
  signal?: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    if (signal?.aborted) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new DOMException("Aborted", "AbortError");
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const part of parts) {
      let event = "message";
      const dataLines: string[] = [];
      for (const line of part.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      const data = dataLines.join("\n");
      if (!data) continue;
      onEvent(event, data);
    }
  }
}

async function streamAnthropic(
  endpoint: CcEndpoint,
  model: string,
  messages: CcChatMessage[],
  onText: (text: string) => void,
  signal?: AbortSignal,
) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const converted = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));

  const res = await fetch(anthropicMessagesUrl(endpoint.baseUrl), {
    method: "POST",
    headers: authHeaders(endpoint, "anthropic"),
    body: JSON.stringify({
      model,
      max_tokens: 8192,
      stream: true,
      ...(system ? { system } : {}),
      messages: converted.length ? converted : [{ role: "user", content: "" }],
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!res.body) throw new Error("Anthropic 响应无正文");

  await readSseStream(
    res.body,
    (_event, data) => {
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data) as {
          type?: string;
          delta?: { type?: string; text?: string };
          error?: { message?: string };
        };
        if (json.type === "error") {
          throw new Error(json.error?.message || "上游错误");
        }
        if (json.type === "content_block_delta" && json.delta?.type === "text_delta" && json.delta.text) {
          onText(json.delta.text);
        } else if (json.delta?.text) {
          onText(json.delta.text);
        }
      } catch (err) {
        if (err instanceof SyntaxError) return;
        throw err;
      }
    },
    signal,
  );
}

async function streamOpenAI(
  endpoint: CcEndpoint,
  model: string,
  messages: CcChatMessage[],
  onText: (text: string) => void,
  signal?: AbortSignal,
) {
  const url = openaiChatUrl(endpoint.baseUrl);
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(endpoint, "openai"),
    body: JSON.stringify({
      model,
      stream: true,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!res.body) throw new Error("OpenAI 响应无正文");

  await readSseStream(
    res.body,
    (_event, data) => {
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string | null }; message?: { content?: string } }>;
          error?: { message?: string };
        };
        if (json.error?.message) throw new Error(json.error.message);
        const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.message?.content;
        if (typeof delta === "string" && delta) onText(delta);
      } catch (err) {
        if (err instanceof SyntaxError) return;
        throw err;
      }
    },
    signal,
  );
}

/** xAI / Grok Build Responses API (CC Switch: /grokbuild/v1/responses). */
async function streamResponses(
  endpoint: CcEndpoint,
  model: string,
  messages: CcChatMessage[],
  onText: (text: string) => void,
  signal?: AbortSignal,
) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const input = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));

  const url = responsesUrl(endpoint);

  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(endpoint, "responses"),
    body: JSON.stringify({
      model,
      stream: true,
      ...(system ? { instructions: system } : {}),
      input: input.length ? input : [{ role: "user", content: "" }],
    }),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Responses ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!res.body) throw new Error("Responses 响应无正文");

  await readSseStream(
    res.body,
    (event, data) => {
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data) as {
          type?: string;
          delta?: string | { text?: string; content?: string };
          error?: { message?: string } | string;
          response?: { error?: { message?: string } };
        };
        const type = json.type || event;
        if (type === "error" || type === "response.failed") {
          const msg =
            (typeof json.error === "string" ? json.error : json.error?.message) ||
            json.response?.error?.message ||
            "上游错误";
          throw new Error(msg);
        }
        if (type === "response.output_text.delta") {
          const delta =
            typeof json.delta === "string"
              ? json.delta
              : json.delta?.text || json.delta?.content || "";
          if (delta) onText(delta);
          return;
        }
        // Some gateways nest text under delta.text for generic events.
        if (typeof json.delta === "object" && json.delta?.text) onText(json.delta.text);
      } catch (err) {
        if (err instanceof SyntaxError) return;
        throw err;
      }
    },
    signal,
  );
}

export async function streamCcSwitchChat(opts: {
  endpoint: CcEndpoint;
  model: string;
  messages: CcChatMessage[];
  signal?: AbortSignal;
  onText: (text: string) => void;
  /** Optional proxy root used to re-resolve Grok when model is grok-*. */
  proxyUrl?: string;
}) {
  const { model, messages, signal, onText, proxyUrl } = opts;
  let endpoint = opts.endpoint;

  // 明确选中的供应商：协议固定，直接按它走，不再猜。
  if (endpoint.strict) {
    if (endpoint.protocol === "responses") {
      await streamResponses(endpoint, model, messages, onText, signal);
      return "responses" as const;
    }
    if (endpoint.protocol === "openai") {
      await streamOpenAI(endpoint, model, messages, onText, signal);
      return "openai" as const;
    }
    await streamAnthropic(endpoint, model, messages, onText, signal);
    return "anthropic" as const;
  }

  // Re-bind endpoint when the selected model is Grok Build.
  if (isGrokModel(model) && endpoint.protocol !== "responses") {
    endpoint = await resolveCcSwitchEndpoint(proxyUrl || endpoint.baseUrl, model);
  }

  if (endpoint.protocol === "responses" || isGrokModel(model)) {
    // Prefer dedicated grok endpoint if we only had a Claude base.
    if (!/grokbuild/i.test(endpoint.baseUrl) && isGrokModel(model)) {
      endpoint = await resolveCcSwitchEndpoint(proxyUrl || "http://127.0.0.1:15721", model);
    }
    try {
      await streamResponses(endpoint, model, messages, onText, signal);
      return "responses" as const;
    } catch (err) {
      if (signal?.aborted) throw err;
      // Last resort: some relays expose OpenAI chat under the same host.
      try {
        await streamOpenAI(endpoint, model, messages, onText, signal);
        return "openai" as const;
      } catch {
        throw err;
      }
    }
  }

  const preferOpenAI = /openai|chatgpt|gpt/i.test(model) && !/claude/i.test(model);

  if (preferOpenAI) {
    try {
      await streamOpenAI(endpoint, model, messages, onText, signal);
      return "openai" as const;
    } catch (err) {
      if (signal?.aborted) throw err;
      await streamAnthropic(endpoint, model, messages, onText, signal);
      return "anthropic" as const;
    }
  }

  try {
    await streamAnthropic(endpoint, model, messages, onText, signal);
    return "anthropic" as const;
  } catch (err) {
    if (signal?.aborted) throw err;
    await streamOpenAI(endpoint, model, messages, onText, signal);
    return "openai" as const;
  }
}

export function buildCcMessages(
  history: Array<{ role: "user" | "assistant"; text: string }>,
  latest: string,
  systemPrompt?: string,
): CcChatMessage[] {
  const out: CcChatMessage[] = [
    {
      role: "system",
      content:
        systemPrompt ||
        "你是 Cursor 工作台里的助手。当前走 CC Switch 供应商，只能纯文本对话，不能读写本地文件或执行命令。用简洁中文回答。",
    },
  ];
  for (const m of history) {
    const text = (m.text || "").trim();
    if (!text) continue;
    out.push({ role: m.role, content: text.slice(0, 8000) });
  }
  out.push({ role: "user", content: latest });
  return out;
}

// ── Agent loop (tool calling) ──────────────────────────────────────────────

// 与 Claude 一致：有工具就继续，模型自行收束或用户 Abort 才停。
// 此值仅作防死循环安全网（几乎触不到），不是日常任务上限。
const AGENT_SAFETY_MAX_STEPS = 500;

export type CcAgentToolEvent = {
  callId: string;
  name: string;
  status: "running" | "completed" | "error";
  args?: unknown;
  result?: unknown;
};

export type CcAgentEmit = (payload: {
  type: "status" | "text-delta" | "tool";
  message?: string;
  text?: string;
  callId?: string;
  name?: string;
  status?: string;
  args?: unknown;
  result?: unknown;
}) => void;

export type CcHistoryItem = {
  role: "user" | "assistant";
  text: string;
  tools?: Array<{ callId: string; name: string; status: string; args?: unknown; result?: unknown }>;
};

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

type AnthropicMsg = {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
};

type OpenAIMsg =
  | { role: "system" | "user" | "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

function summarizeToolsForHistory(tools?: CcHistoryItem["tools"]) {
  if (!tools?.length) return "";
  const lines = tools.slice(0, 12).map((t) => {
    const args = t.args && typeof t.args === "object" ? t.args as Record<string, unknown> : {};
    const path = typeof args.path === "string" ? args.path : "";
    const detail = path || t.name;
    return `- ${t.name}${detail && detail !== t.name ? `(${detail})` : ""} → ${t.status}`;
  });
  return `\n[工具]\n${lines.join("\n")}`;
}

function historyToTextPairs(history: CcHistoryItem[]): Array<{ role: "user" | "assistant"; text: string }> {
  return history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role,
      text: `${(m.text || "").trim()}${m.role === "assistant" ? summarizeToolsForHistory(m.tools) : ""}`.slice(0, 8000),
    }))
    .filter((m) => m.text.trim());
}

async function anthropicAgentTurn(opts: {
  endpoint: CcEndpoint;
  model: string;
  system: string;
  messages: AnthropicMsg[];
  mode: AppMode;
  signal?: AbortSignal;
  onText: (t: string) => void;
}): Promise<{ text: string; toolCalls: CcToolCall[]; rawContent: AnthropicBlock[]; stopReason: string }> {
  const tools = anthropicToolsPayload(opts.mode);
  const res = await fetch(anthropicMessagesUrl(opts.endpoint.baseUrl), {
    method: "POST",
    headers: authHeaders(opts.endpoint, "anthropic"),
    body: JSON.stringify({
      model: opts.model,
      max_tokens: 8192,
      stream: true,
      system: opts.system,
      tools,
      tool_choice: { type: "auto" },
      messages: opts.messages.length ? opts.messages : [{ role: "user", content: "" }],
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!res.body) throw new Error("Anthropic 响应无正文");

  let text = "";
  let stopReason = "end_turn";
  const blocks: AnthropicBlock[] = [];
  let cur:
    | { kind: "text"; text: string }
    | { kind: "tool"; id: string; name: string; json: string }
    | null = null;

  const flush = () => {
    if (!cur) return;
    if (cur.kind === "text") {
      if (cur.text) blocks.push({ type: "text", text: cur.text });
    } else {
      let input: Record<string, unknown> = {};
      try {
        input = cur.json ? (JSON.parse(cur.json) as Record<string, unknown>) : {};
      } catch {
        input = { _raw: cur.json };
      }
      blocks.push({ type: "tool_use", id: cur.id, name: cur.name, input });
    }
    cur = null;
  };

  await readSseStream(
    res.body,
    (_event, data) => {
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data) as {
          type?: string;
          index?: number;
          content_block?: { type?: string; text?: string; id?: string; name?: string; input?: unknown };
          delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
          stop_reason?: string;
          error?: { message?: string };
        };
        if (json.type === "error") throw new Error(json.error?.message || "上游错误");
        if (json.type === "content_block_start" && json.content_block) {
          flush();
          const b = json.content_block;
          if (b.type === "tool_use") {
            cur = { kind: "tool", id: String(b.id || `tool_${blocks.length}`), name: String(b.name || "tool"), json: "" };
          } else {
            cur = { kind: "text", text: typeof b.text === "string" ? b.text : "" };
            if (cur.kind === "text" && cur.text) {
              text += cur.text;
              opts.onText(cur.text);
            }
          }
        } else if (json.type === "content_block_delta" && json.delta) {
          if (json.delta.type === "text_delta" && json.delta.text) {
            if (!cur || cur.kind !== "text") {
              flush();
              cur = { kind: "text", text: "" };
            }
            if (cur.kind === "text") {
              cur.text += json.delta.text;
              text += json.delta.text;
              opts.onText(json.delta.text);
            }
          } else if (json.delta.type === "input_json_delta" && json.delta.partial_json != null) {
            if (cur?.kind === "tool") cur.json += json.delta.partial_json;
          }
        } else if (json.type === "content_block_stop") {
          flush();
        } else if (json.type === "message_delta") {
          if (json.delta?.stop_reason) stopReason = json.delta.stop_reason;
          if (json.stop_reason) stopReason = json.stop_reason;
        } else if (json.type === "message_stop") {
          flush();
        }
      } catch (err) {
        if (err instanceof SyntaxError) return;
        throw err;
      }
    },
    opts.signal,
  );
  flush();

  const toolCalls: CcToolCall[] = blocks
    .filter((b): b is Extract<AnthropicBlock, { type: "tool_use" }> => b.type === "tool_use")
    .map((b, i) => ({
      id: String(b.id || "").trim() || `tool_${i}_${b.name || "call"}`,
      name: b.name,
      input: b.input || {},
    }));

  return { text, toolCalls, rawContent: blocks, stopReason };
}

async function openaiAgentTurn(opts: {
  endpoint: CcEndpoint;
  model: string;
  messages: OpenAIMsg[];
  mode: AppMode;
  signal?: AbortSignal;
  onText: (t: string) => void;
}): Promise<{ text: string; toolCalls: CcToolCall[]; assistantMsg: OpenAIMsg }> {
  const tools = openaiToolsPayload(opts.mode);
  const res = await fetch(openaiChatUrl(opts.endpoint.baseUrl), {
    method: "POST",
    headers: authHeaders(opts.endpoint, "openai"),
    body: JSON.stringify({
      model: opts.model,
      stream: true,
      messages: opts.messages,
      tools,
      tool_choice: "auto",
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`OpenAI ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!res.body) throw new Error("OpenAI 响应无正文");

  let text = "";
  const toolMap = new Map<number, { id: string; name: string; args: string }>();

  await readSseStream(
    res.body,
    (_event, data) => {
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data) as {
          choices?: Array<{
            delta?: {
              content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
          error?: { message?: string };
        };
        if (json.error?.message) throw new Error(json.error.message);
        const delta = json.choices?.[0]?.delta;
        if (!delta) return;
        if (typeof delta.content === "string" && delta.content) {
          text += delta.content;
          opts.onText(delta.content);
        }
        for (const tc of delta.tool_calls || []) {
          const idx = tc.index ?? 0;
          let slot = toolMap.get(idx);
          if (!slot) {
            slot = { id: tc.id || `call_${idx}`, name: tc.function?.name || "", args: "" };
            toolMap.set(idx, slot);
          }
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
        }
      } catch (err) {
        if (err instanceof SyntaxError) return;
        throw err;
      }
    },
    opts.signal,
  );

  const toolCalls: CcToolCall[] = [...toolMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, t]) => {
      let input: Record<string, unknown> = {};
      try {
        input = t.args ? (JSON.parse(t.args) as Record<string, unknown>) : {};
      } catch {
        input = { _raw: t.args };
      }
      return { id: t.id, name: t.name || "tool", input };
    });

  const assistantMsg: OpenAIMsg = {
    role: "assistant",
    content: text || null,
    ...(toolCalls.length
      ? {
          tool_calls: toolCalls.map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
          })),
        }
      : {}),
  };

  return { text, toolCalls, assistantMsg };
}

/** Responses API input/output items (xAI / OpenAI-compatible). */
type ResponsesInputItem =
  | { role: "user" | "assistant" | "system"; content: string }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string }
  | { type: "message"; role: "user" | "assistant"; content: string };

function responsesUrl(endpoint: CcEndpoint) {
  const base = endpoint.baseUrl.replace(/\/+$/, "").replace(/\/responses$/, "");
  return /\/(v\d+[a-z0-9]*|openai)$/i.test(base) ? `${base}/responses` : `${base}/v1/responses`;
}

async function responsesAgentTurn(opts: {
  endpoint: CcEndpoint;
  model: string;
  instructions: string;
  input: ResponsesInputItem[];
  mode: AppMode;
  signal?: AbortSignal;
  onText: (t: string) => void;
  previousResponseId?: string;
}): Promise<{
  text: string;
  toolCalls: CcToolCall[];
  /** Items to append to next-turn input (function_call items as returned). */
  outputItems: ResponsesInputItem[];
  responseId?: string;
}> {
  const tools = responsesToolsPayload(opts.mode);
  const body: Record<string, unknown> = {
    model: opts.model,
    stream: true,
    tools,
    tool_choice: "auto",
    parallel_tool_calls: true,
    instructions: opts.instructions,
    input: opts.input.length ? opts.input : [{ role: "user", content: "" }],
  };
  if (opts.previousResponseId) body.previous_response_id = opts.previousResponseId;

  const res = await fetch(responsesUrl(opts.endpoint), {
    method: "POST",
    headers: authHeaders(opts.endpoint, "responses"),
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Responses ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!res.body) throw new Error("Responses 响应无正文");

  let text = "";
  let responseId: string | undefined;
  const toolMap = new Map<string, { id: string; name: string; args: string }>();
  /** Responses 的 function_call 有两个 id：item.id(fc_…) 与 call_id(call_…)；增量事件只带前者，必须归并到后者。 */
  const itemToCall = new Map<string, string>();
  const outputItems: ResponsesInputItem[] = [];

  const upsertTool = (raw: {
    call_id?: string;
    id?: string;
    name?: string;
    arguments?: string | Record<string, unknown>;
  }) => {
    const id = String(raw.call_id || raw.id || `call_${toolMap.size}`);
    let slot = toolMap.get(id);
    if (!slot) {
      slot = { id, name: "", args: "" };
      toolMap.set(id, slot);
    }
    if (raw.name) slot.name = raw.name;
    if (raw.arguments != null) {
      const argStr =
        typeof raw.arguments === "string" ? raw.arguments : JSON.stringify(raw.arguments);
      // Prefer full snapshot when longer (Responses often sends whole call at once).
      if (argStr.length >= slot.args.length) slot.args = argStr;
      else slot.args += argStr;
    }
    return slot;
  };

  const ingestOutputItem = (item: Record<string, unknown> | null | undefined) => {
    if (!item || typeof item !== "object") return;
    const type = String(item.type || "");
    if (type === "function_call" || type === "tool_call" || type === "custom_tool_call") {
      if (typeof item.id === "string" && typeof item.call_id === "string") {
        const fc = item.id;
        const call = item.call_id;
        itemToCall.set(fc, call);
        // 若此前已按 fc_ 建过空槽位（事件乱序），并入 call_ 槽位
        const stray = toolMap.get(fc);
        if (stray && fc !== call) {
          toolMap.delete(fc);
          const real = toolMap.get(call) || { id: call, name: "", args: "" };
          if (!real.name && stray.name) real.name = stray.name;
          if (stray.args.length > real.args.length) real.args = stray.args;
          toolMap.set(call, real);
        }
      }
      const slot = upsertTool({
        call_id: typeof item.call_id === "string" ? item.call_id : undefined,
        id: typeof item.id === "string" ? item.id : undefined,
        name: typeof item.name === "string" ? item.name : undefined,
        arguments:
          typeof item.arguments === "string" || (item.arguments && typeof item.arguments === "object")
            ? (item.arguments as string | Record<string, unknown>)
            : typeof item.input === "string" || (item.input && typeof item.input === "object")
              ? (item.input as string | Record<string, unknown>)
              : undefined,
      });
      // Keep latest snapshot in outputItems (replace same call_id).
      const idx = outputItems.findIndex(
        (o) => "type" in o && o.type === "function_call" && o.call_id === slot.id,
      );
      const entry: ResponsesInputItem = {
        type: "function_call",
        call_id: slot.id,
        name: slot.name || "tool",
        arguments: slot.args || "{}",
      };
      if (idx >= 0) outputItems[idx] = entry;
      else outputItems.push(entry);
      return;
    }
    if (type === "message" || type === "output_text") {
      // text already streamed via deltas
      return;
    }
  };

  await readSseStream(
    res.body,
    (event, data) => {
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data) as {
          type?: string;
          item_id?: string;
          output_index?: number;
          delta?: string | { text?: string; content?: string; arguments?: string; name?: string };
          arguments?: string;
          name?: string;
          call_id?: string;
          item?: Record<string, unknown>;
          response?: {
            id?: string;
            error?: { message?: string };
            output?: Array<Record<string, unknown>>;
          };
          error?: { message?: string } | string;
        };
        const type = json.type || event || "";

        if (json.response?.id) responseId = json.response.id;

        if (type === "error" || type === "response.failed") {
          const msg =
            (typeof json.error === "string" ? json.error : json.error?.message) ||
            json.response?.error?.message ||
            "上游错误";
          throw new Error(msg);
        }

        // Text deltas
        if (
          type === "response.output_text.delta" ||
          type === "response.text.delta" ||
          type === "content.delta"
        ) {
          const delta =
            typeof json.delta === "string"
              ? json.delta
              : json.delta?.text || json.delta?.content || "";
          if (delta) {
            text += delta;
            opts.onText(delta);
          }
          return;
        }
        if (typeof json.delta === "object" && json.delta?.text) {
          text += json.delta.text;
          opts.onText(json.delta.text);
        }

        // Function-call argument deltas (if gateway streams them)
        if (
          type === "response.function_call_arguments.delta" ||
          type === "response.custom_tool_call_input.delta"
        ) {
          const id = String(
            json.call_id ||
              itemToCall.get(String(json.item_id || "")) ||
              json.item_id ||
              `call_${json.output_index ?? 0}`,
          );
          const argDelta =
            (typeof json.delta === "string" ? json.delta : json.delta?.arguments) ||
            json.arguments ||
            "";
          upsertTool({
            call_id: id,
            name: json.name || (typeof json.delta === "object" ? json.delta?.name : undefined),
            arguments: argDelta,
          });
          return;
        }

        if (
          type === "response.function_call_arguments.done" ||
          type === "response.custom_tool_call_input.done"
        ) {
          const id = String(
            json.call_id ||
              itemToCall.get(String(json.item_id || "")) ||
              json.item_id ||
              `call_${json.output_index ?? 0}`,
          );
          upsertTool({
            call_id: id,
            name: json.name,
            arguments: typeof json.arguments === "string" ? json.arguments : undefined,
          });
          return;
        }

        // Whole output item added
        if (
          type === "response.output_item.added" ||
          type === "response.output_item.done" ||
          type === "response.content_part.added" ||
          type === "response.content_part.done"
        ) {
          ingestOutputItem(json.item);
          return;
        }

        if (type === "response.completed" || type === "response.done") {
          for (const item of json.response?.output || []) ingestOutputItem(item);
          return;
        }

        // Non-stream style payload nested in an event
        if (json.item) ingestOutputItem(json.item);
        if (json.response?.output) {
          for (const item of json.response.output) ingestOutputItem(item);
        }
      } catch (err) {
        if (err instanceof SyntaxError) return;
        throw err;
      }
    },
    opts.signal,
  );

  // Sync toolMap → ensure outputItems have final args/names
  for (const slot of toolMap.values()) {
    // 没有函数名的槽位是事件拼接残留，回传会让上游报「No tool output found」
    if (!slot.name) {
      const stray = outputItems.findIndex(
        (o) => "type" in o && o.type === "function_call" && o.call_id === slot.id,
      );
      if (stray >= 0) outputItems.splice(stray, 1);
      continue;
    }
    const idx = outputItems.findIndex(
      (o) => "type" in o && o.type === "function_call" && o.call_id === slot.id,
    );
    const entry: ResponsesInputItem = {
      type: "function_call",
      call_id: slot.id,
      name: slot.name || "tool",
      arguments: slot.args || "{}",
    };
    if (idx >= 0) outputItems[idx] = entry;
    else outputItems.push(entry);
  }

  const toolCalls: CcToolCall[] = [...toolMap.values()]
    .filter((t) => t.name)
    .map((t) => {
      let input: Record<string, unknown> = {};
      try {
        input = t.args ? (JSON.parse(t.args) as Record<string, unknown>) : {};
      } catch {
        input = { _raw: t.args };
      }
      return { id: t.id, name: t.name, input };
    });

  // If we only got text via completed output without deltas, nothing else to do.
  return { text, toolCalls, outputItems, responseId };
}

const CC_RETRY_MAX = 4;

const TRANSIENT_ERR =
  /overloaded|rate.?limit|too many requests|error occurred while processing|you can retry|server_error|internal (server )?error|bad gateway|service unavailable|\b(429|500|502|503|504|529)\b|exhausted|temporar|time(d)? ?out|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|terminated/i;

/** 临时性上游错误：值得重试，且「降级纯文本」只会再撞一次同样的错。 */
function isTransientUpstreamError(msg: string) {
  return TRANSIENT_ERR.test(msg);
}

function sleepAbortable(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function upstreamBusyError(err: unknown, hint?: string) {
  const msg = err instanceof Error ? err.message : String(err);
  return new Error(
    `上游供应商${hint ? `（${hint}）` : ""}暂时繁忙或限流，已自动重试 ${CC_RETRY_MAX} 次仍失败。稍后再试，或在模型下拉里换一个模型/供应商。\n原始错误：${msg.slice(0, 300)}`,
  );
}

export async function runCcAgentLoop(opts: {
  endpoint: CcEndpoint;
  model: string;
  mode: AppMode;
  workspace: string;
  history: CcHistoryItem[];
  latest: string;
  proxyUrl?: string;
  signal?: AbortSignal;
  emit: CcAgentEmit;
  /** start/done for mutating tools — host wires Review */
  onToolLifecycle?: (info: {
    phase: "start" | "done";
    callId: string;
    name: string;
    args: unknown;
    result?: unknown;
  }) => void | Promise<void>;
}): Promise<{ text: string; tools: CcAgentToolEvent[]; protocol: CcProtocol | "text-fallback" }> {
  let endpoint = opts.endpoint;
  const model = opts.model;
  const mode = opts.mode;
  const signal = opts.signal;
  const emit = opts.emit;

  const strict = Boolean(endpoint.strict);
  if (!strict) {
    if (isGrokModel(model) && endpoint.protocol !== "responses" && endpoint.protocol !== "openai") {
      endpoint = await resolveCcSwitchEndpoint(opts.proxyUrl || endpoint.baseUrl, model);
    }
    if (isGrokModel(model) && !/grokbuild/i.test(endpoint.baseUrl) && endpoint.protocol === "responses") {
      endpoint = await resolveCcSwitchEndpoint(opts.proxyUrl || "http://127.0.0.1:15721", model);
    }
  }

  /** 上游临时繁忙（overloaded / 429 / 5xx / 账号池耗尽）时，对「单轮请求」自动退避重试；已经流出文字的不重试，避免重复。 */
  const withRetry = async <A extends { onText: (t: string) => void }, R>(
    fn: (a: A) => Promise<R>,
    args: A,
  ): Promise<R> => {
    for (let attempt = 0; ; attempt++) {
      let emitted = false;
      try {
        return await fn({
          ...args,
          onText: (t: string) => {
            emitted = true;
            args.onText(t);
          },
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (emitted || attempt >= CC_RETRY_MAX || !isTransientUpstreamError(msg)) throw err;
        const wait = 1500 * 2 ** attempt;
        console.warn(`[cc-agent] transient upstream error, retry ${attempt + 1}/${CC_RETRY_MAX} in ${wait}ms:`, msg.slice(0, 200));
        emit({
          type: "status",
          message: `上游供应商繁忙，${Math.round(wait / 1000)} 秒后重试（${attempt + 1}/${CC_RETRY_MAX}）…`,
        });
        await sleepAbortable(wait, signal);
      }
    }
  };

  const system = buildCcAgentSystem(mode, opts.workspace);
  const collectedTools: CcAgentToolEvent[] = [];
  let fullText = "";

  const preferResponses = strict
    ? endpoint.protocol === "responses"
    : endpoint.protocol === "responses" || (isGrokModel(model) && endpoint.protocol !== "openai");
  const preferOpenAI = strict
    ? endpoint.protocol === "openai"
    : !preferResponses &&
      (endpoint.protocol === "openai" ||
        (/openai|chatgpt|gpt/i.test(model) && !/claude/i.test(model)));

  /** 仅在撞上防死循环安全网时提示；日常任务不会触发 */
  const noteSafetyStop = (step: number, stillHadTools: boolean) => {
    if (!stillHadTools || signal?.aborted) return;
    const note = `\n\n（已连续运行 ${step} 轮工具，触发安全上限以防死循环。发送「继续」可接着做，或点停止。）`;
    fullText += note;
    emit({ type: "text-delta", text: note });
    emit({
      type: "status",
      message: `已运行 ${step} 轮，触发安全上限；可「继续」或停止`,
    });
  };

  const runResponsesLoop = async () => {
    const input: ResponsesInputItem[] = [];
    for (const m of historyToTextPairs(opts.history)) {
      input.push({ role: m.role, content: m.text });
    }
    input.push({ role: "user", content: opts.latest });

    let step = 0;
    let lastHadTools = false;

    // 一直跑到：模型不再调工具 / 用户 Abort / 极高安全上限
    // 无状态：每轮都发完整、按时间顺序累积的 transcript（history + 每次 function_call + 对应 output）。
    // 不用 previous_response_id：Codex 类网关常配「不保存响应」，带它会 400，且回退路径极易丢输出。
    while (!signal?.aborted && step < AGENT_SAFETY_MAX_STEPS) {
      emit({
        type: "status",
        message: step === 0 ? "思考中…" : `正在调用工具 · 第 ${step + 1} 轮`,
      });

      const turn = await withRetry(responsesAgentTurn, {
        endpoint,
        model,
        instructions: system,
        input,
        mode,
        signal,
        onText: (t) => {
          fullText += t;
          emit({ type: "text-delta", text: t });
        },
      });

      if (!turn.toolCalls.length) {
        lastHadTools = false;
        break;
      }
      lastHadTools = true;
      step += 1;

      // 把本轮模型发出的 function_call 追加进 transcript，随后紧跟各自的 output
      for (const item of turn.outputItems) {
        if ("type" in item && item.type === "function_call") input.push(item);
      }

      for (const call of turn.toolCalls) {
        if (signal?.aborted) break;
        const ev: CcAgentToolEvent = {
          callId: call.id,
          name: call.name,
          status: "running",
          args: call.name === "createPlan" ? call.input : sanitizeArgs(call.name, call.input),
        };
        collectedTools.push(ev);
        emit({ type: "tool", callId: ev.callId, name: ev.name, status: "running", args: ev.args });
        await opts.onToolLifecycle?.({ phase: "start", callId: call.id, name: call.name, args: call.input });

        const result = await executeCcTool(opts.workspace, mode, call);
        ev.status = result.ok ? "completed" : "error";
        ev.result = clipResult(result.content);
        emit({
          type: "tool",
          callId: ev.callId,
          name: ev.name,
          status: ev.status,
          args: ev.args,
          result: ev.result,
        });
        await opts.onToolLifecycle?.({
          phase: "done",
          callId: call.id,
          name: call.name,
          args: call.input,
          result: result.content,
        });

        const outItem: ResponsesInputItem = {
          type: "function_call_output",
          call_id: call.id,
          output: result.content,
        };
        input.push(outItem);
      }
    }
    noteSafetyStop(step, lastHadTools && step >= AGENT_SAFETY_MAX_STEPS);
  };

  const runAnthropicLoop = async () => {
    const messages: AnthropicMsg[] = historyToTextPairs(opts.history).map((m) => ({
      role: m.role,
      content: m.text,
    }));
    messages.push({ role: "user", content: opts.latest });
    let step = 0;
    let lastHadTools = false;

    while (!signal?.aborted && step < AGENT_SAFETY_MAX_STEPS) {
      emit({
        type: "status",
        message: step === 0 ? "思考中…" : `正在调用工具 · 第 ${step + 1} 轮`,
      });
      const turn = await withRetry(anthropicAgentTurn, {
        endpoint,
        model,
        system,
        messages,
        mode,
        signal,
        onText: (t) => {
          fullText += t;
          emit({ type: "text-delta", text: t });
        },
      });

      if (!turn.toolCalls.length) {
        lastHadTools = false;
        break;
      }
      lastHadTools = true;
      step += 1;

      messages.push({ role: "assistant", content: turn.rawContent.length ? turn.rawContent : turn.text || "" });

      const resultBlocks: AnthropicBlock[] = [];
      for (const call of turn.toolCalls) {
        if (signal?.aborted) break;
        const ev: CcAgentToolEvent = {
          callId: call.id,
          name: call.name,
          status: "running",
          args: call.name === "createPlan" ? call.input : sanitizeArgs(call.name, call.input),
        };
        collectedTools.push(ev);
        emit({ type: "tool", callId: ev.callId, name: ev.name, status: "running", args: ev.args });
        await opts.onToolLifecycle?.({ phase: "start", callId: call.id, name: call.name, args: call.input });

        const result = await executeCcTool(opts.workspace, mode, call);
        ev.status = result.ok ? "completed" : "error";
        ev.result = clipResult(result.content);
        emit({
          type: "tool",
          callId: ev.callId,
          name: ev.name,
          status: ev.status,
          args: ev.args,
          result: ev.result,
        });
        await opts.onToolLifecycle?.({
          phase: "done",
          callId: call.id,
          name: call.name,
          args: call.input,
          result: result.content,
        });

        resultBlocks.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: result.content,
          is_error: !result.ok,
        });
      }
      messages.push({ role: "user", content: resultBlocks });
    }
    noteSafetyStop(step, lastHadTools && step >= AGENT_SAFETY_MAX_STEPS);
  };

  const runOpenAILoop = async () => {
    const messages: OpenAIMsg[] = [{ role: "system", content: system }];
    for (const m of historyToTextPairs(opts.history)) {
      messages.push({ role: m.role, content: m.text });
    }
    messages.push({ role: "user", content: opts.latest });
    let step = 0;
    let lastHadTools = false;

    while (!signal?.aborted && step < AGENT_SAFETY_MAX_STEPS) {
      emit({
        type: "status",
        message: step === 0 ? "思考中…" : `正在调用工具 · 第 ${step + 1} 轮`,
      });
      const turn = await withRetry(openaiAgentTurn, {
        endpoint,
        model,
        messages,
        mode,
        signal,
        onText: (t) => {
          fullText += t;
          emit({ type: "text-delta", text: t });
        },
      });
      messages.push(turn.assistantMsg);
      if (!turn.toolCalls.length) {
        lastHadTools = false;
        break;
      }
      lastHadTools = true;
      step += 1;

      for (const call of turn.toolCalls) {
        if (signal?.aborted) break;
        const ev: CcAgentToolEvent = {
          callId: call.id,
          name: call.name,
          status: "running",
          args: call.name === "createPlan" ? call.input : sanitizeArgs(call.name, call.input),
        };
        collectedTools.push(ev);
        emit({ type: "tool", callId: ev.callId, name: ev.name, status: "running", args: ev.args });
        await opts.onToolLifecycle?.({ phase: "start", callId: call.id, name: call.name, args: call.input });

        const result = await executeCcTool(opts.workspace, mode, call);
        ev.status = result.ok ? "completed" : "error";
        ev.result = clipResult(result.content);
        emit({
          type: "tool",
          callId: ev.callId,
          name: ev.name,
          status: ev.status,
          args: ev.args,
          result: ev.result,
        });
        await opts.onToolLifecycle?.({
          phase: "done",
          callId: call.id,
          name: call.name,
          args: call.input,
          result: result.content,
        });

        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result.content,
        });
      }
    }
    noteSafetyStop(step, lastHadTools && step >= AGENT_SAFETY_MAX_STEPS);
  };

  const textFallback = async (reason: string) => {
    emit({ type: "status", message: reason });
    const messages = buildCcMessages(
      historyToTextPairs(opts.history),
      opts.latest,
      "你是 Cursor 工作台助手。用简洁中文回答。",
    );
    await streamCcSwitchChat({
      endpoint,
      model,
      messages,
      signal,
      proxyUrl: opts.proxyUrl,
      onText: (t) => {
        fullText += t;
        emit({ type: "text-delta", text: t });
      },
    });
    return { text: fullText, tools: collectedTools, protocol: "text-fallback" as const };
  };

  try {
    if (preferResponses) {
      try {
        await runResponsesLoop();
        return { text: fullText, tools: collectedTools, protocol: "responses" };
      } catch (err) {
        if (signal?.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn("[cc-agent] responses loop failed:", model, msg.slice(0, 600));
        if (isTransientUpstreamError(msg)) throw upstreamBusyError(err, endpoint.providerHint);
        // Some Grok relays expose OpenAI chat tools instead of Responses tools.
        if (!strict && /tools|tool_choice|function|400|404|422/i.test(msg)) {
          emit({ type: "status", message: "Responses tools 不可用，尝试 OpenAI 协议…" });
          try {
            await runOpenAILoop();
            return { text: fullText, tools: collectedTools, protocol: "openai" };
          } catch {
            /* fall through */
          }
        }
        return textFallback("Responses 工具调用失败，降级为纯文本…");
      }
    }

    if (preferOpenAI) {
      try {
        await runOpenAILoop();
        return { text: fullText, tools: collectedTools, protocol: "openai" };
      } catch (err) {
        if (signal?.aborted) throw err;
        if (isTransientUpstreamError(err instanceof Error ? err.message : String(err))) {
          throw upstreamBusyError(err, endpoint.providerHint);
        }
        if (strict) return textFallback("工具调用失败，降级为纯文本…");
        emit({ type: "status", message: "改用 Anthropic 协议…" });
        await runAnthropicLoop();
        return { text: fullText, tools: collectedTools, protocol: "anthropic" };
      }
    }

    try {
      await runAnthropicLoop();
      return { text: fullText, tools: collectedTools, protocol: "anthropic" };
    } catch (err) {
      if (signal?.aborted) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[cc-agent] anthropic loop failed:", model, msg.slice(0, 600));
      if (isTransientUpstreamError(msg)) throw upstreamBusyError(err, endpoint.providerHint);
      if (!strict && /tools|tool_choice|400/i.test(msg)) {
        emit({ type: "status", message: "上游可能不支持 tools，尝试 OpenAI 协议…" });
        try {
          await runOpenAILoop();
          return { text: fullText, tools: collectedTools, protocol: "openai" };
        } catch {
          /* text fallback */
        }
      }
      return textFallback("工具调用失败，降级为纯文本…");
    }
  } catch (err) {
    throw err;
  }
}

function sanitizeArgs(name: string, input: Record<string, unknown>) {
  if (name === "writeFile" && typeof input.content === "string") {
    return {
      ...input,
      content:
        input.content.length > 400
          ? `${input.content.slice(0, 400)}…(${input.content.length} chars)`
          : input.content,
    };
  }
  if (name === "runShell" && typeof input.command === "string") {
    return { command: input.command.slice(0, 500) };
  }
  return input;
}

function clipResult(s: string) {
  if (s.length <= 8000) return s;
  return `${s.slice(0, 8000)}…`;
}
