import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
};

export type CcChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type CcModelInfo = {
  id: string;
  displayName: string;
  description?: string;
  parameters?: Array<{
    id: string;
    displayName?: string;
    values: Array<{ value: string; displayName?: string }>;
  }>;
  defaultParams?: Array<{ id: string; value: string }>;
};

const CLAUDE_SETTINGS = join(homedir(), ".claude", "settings.json");
const GROK_CONFIG = join(homedir(), ".grok", "config.toml");

const FALLBACK_CLAUDE_MODELS: CcModelInfo[] = [
  { id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5" },
  { id: "claude-opus-4-5", displayName: "Claude Opus 4.5" },
  { id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5" },
  { id: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
];

const FALLBACK_GROK_MODELS: CcModelInfo[] = [
  { id: "grok-4.5", displayName: "Grok 4.5" },
  { id: "grok-4.6", displayName: "Grok 4.6" },
  { id: "grok-4", displayName: "Grok 4" },
  { id: "grok-3", displayName: "Grok 3" },
];

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

export async function resolveCcSwitchEndpoint(proxyUrl: string, model?: string): Promise<CcEndpoint> {
  const proxy = normalizeBaseUrl(proxyUrl) || "http://127.0.0.1:15721";
  const wantGrok = model ? isGrokModel(model) : false;

  if (wantGrok) {
    const grok = await readGrokLive();
    if (grok) {
      return {
        baseUrl: grok.baseUrl,
        apiKey: grok.apiKey,
        protocol: grok.apiBackend === "openai" ? "openai" : "responses",
        providerHint: grok.name ? `Grok Build · ${grok.name}` : "Grok Build",
        modelIds: grok.models,
      };
    }
    // Proxy path even without local toml.
    return {
      baseUrl: `${proxy}/grokbuild/v1`,
      apiKey: "PROXY_MANAGED",
      protocol: "responses",
      providerHint: "Grok Build",
      modelIds: FALLBACK_GROK_MODELS.map((m) => m.id),
    };
  }

  const live = await readClaudeLiveEnv();
  const baseUrl = live.baseUrl || proxy;
  const apiKey = live.apiKey || "PROXY_MANAGED";
  return {
    baseUrl,
    apiKey,
    protocol: "anthropic",
    providerHint:
      baseUrl.includes("127.0.0.1") || baseUrl.includes("localhost")
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
    if (!up && !live.baseUrl && !grok) {
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
          return { connected: true, baseUrl: live.baseUrl, providerHint: "Claude live 配置" };
        }
      }
      if (grok?.baseUrl) {
        try {
          await fetchWithTimeout(grok.baseUrl, { method: "GET", timeoutMs: 1200 });
          return {
            connected: true,
            baseUrl: grok.baseUrl,
            providerHint: grok.name ? `Grok Build · ${grok.name}` : "Grok Build",
          };
        } catch {
          /* fall through */
        }
      }
      return {
        connected: false,
        baseUrl: proxy,
        error: `无法连接 ${proxy}。请先打开 CC Switch 并启用本地代理。`,
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

function prettyModelName(id: string) {
  if (/^grok/i.test(id)) return id.replace(/^grok-?/i, "Grok ").replace(/-/g, " ");
  return id
    .replace(/^claude-/, "Claude ")
    .replace(/^gpt-/, "GPT-")
    .replace(/-/g, " ");
}

export async function listCcSwitchModels(endpoint: CcEndpoint): Promise<CcModelInfo[]> {
  const found = new Map<string, CcModelInfo>();
  const push = (id: string, displayName?: string) => {
    const key = id.trim();
    if (!key || found.has(key)) return;
    found.set(key, { id: key, displayName: displayName || prettyModelName(key) });
  };

  const grok = await readGrokLive();
  if (grok) {
    for (const id of grok.models) push(id);
    push(grok.defaultModel);
  } else {
    for (const m of FALLBACK_GROK_MODELS) push(m.id, m.displayName);
  }

  const bases = [
    endpoint.baseUrl,
    normalizeBaseUrl(endpoint.baseUrl.replace(/\/v1$/, "")),
    normalizeBaseUrl(endpoint.baseUrl.replace(/\/grokbuild\/v1$/, "")),
  ].filter((v, i, a) => v && a.indexOf(v) === i);

  for (const base of bases) {
    for (const path of ["/v1/models", "/models", "/grokbuild/v1/models"]) {
      try {
        const res = await fetchWithTimeout(`${base}${path}`, {
          method: "GET",
          headers: {
            Accept: "application/json",
            ...authHeaders(endpoint, "openai"),
          },
          timeoutMs: 3000,
        });
        if (!res.ok) continue;
        const data = (await res.json()) as {
          data?: Array<{ id?: string; name?: string }>;
          models?: Array<{ id?: string; name?: string }>;
        };
        const rows = data.data || data.models || [];
        for (const m of rows) {
          const id = String(m.id || m.name || "").trim();
          if (id) push(id);
        }
      } catch {
        /* try next */
      }
    }
  }

  if (![...found.keys()].some((id) => !isGrokModel(id))) {
    for (const m of FALLBACK_CLAUDE_MODELS) push(m.id, m.displayName);
  }

  // Prefer grok models first when grok live exists, else claude defaults on top.
  const list = [...found.values()];
  list.sort((a, b) => {
    const ag = isGrokModel(a.id) ? 0 : 1;
    const bg = isGrokModel(b.id) ? 0 : 1;
    if (ag !== bg) return grok ? ag - bg : bg - ag;
    return a.id.localeCompare(b.id);
  });
  return list.length ? list : [...FALLBACK_CLAUDE_MODELS, ...FALLBACK_GROK_MODELS];
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

  const res = await fetch(`${endpoint.baseUrl}/v1/messages`, {
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
  const base = endpoint.baseUrl.replace(/\/chat\/completions$/, "");
  const url = base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
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

  const base = endpoint.baseUrl.replace(/\/responses$/, "");
  const url = /\/v1$/.test(base) ? `${base}/responses` : `${base}/v1/responses`;

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
  const res = await fetch(`${opts.endpoint.baseUrl}/v1/messages`, {
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
    .map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));

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
  const res = await fetch(`${opts.endpoint.baseUrl}/v1/chat/completions`, {
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
  const base = endpoint.baseUrl.replace(/\/responses$/, "");
  return /\/v1$/.test(base) ? `${base}/responses` : `${base}/v1/responses`;
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
          const id = String(json.call_id || json.item_id || `call_${json.output_index ?? 0}`);
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
          const id = String(json.call_id || json.item_id || `call_${json.output_index ?? 0}`);
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

  if (isGrokModel(model) && endpoint.protocol !== "responses" && endpoint.protocol !== "openai") {
    endpoint = await resolveCcSwitchEndpoint(opts.proxyUrl || endpoint.baseUrl, model);
  }
  if (isGrokModel(model) && !/grokbuild/i.test(endpoint.baseUrl) && endpoint.protocol === "responses") {
    endpoint = await resolveCcSwitchEndpoint(opts.proxyUrl || "http://127.0.0.1:15721", model);
  }

  const system = buildCcAgentSystem(mode, opts.workspace);
  const collectedTools: CcAgentToolEvent[] = [];
  let fullText = "";

  const preferResponses =
    endpoint.protocol === "responses" ||
    (isGrokModel(model) && endpoint.protocol !== "openai");
  const preferOpenAI =
    !preferResponses &&
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

    let previousResponseId: string | undefined;
    let step = 0;
    let lastHadTools = false;

    // 一直跑到：模型不再调工具 / 用户 Abort / 极高安全上限
    while (!signal?.aborted && step < AGENT_SAFETY_MAX_STEPS) {
      emit({
        type: "status",
        message: step === 0 ? "Agent 思考中…" : `工具轮次 ${step + 1}…`,
      });

      // With previous_response_id: only new function_call_output items.
      // Without: full transcript (history + function_call + outputs).
      const outputsOnly = input.filter(
        (item) => "type" in item && item.type === "function_call_output",
      );
      const usePrevious = Boolean(previousResponseId) && step > 0 && outputsOnly.length > 0;

      let turn;
      try {
        turn = await responsesAgentTurn({
          endpoint,
          model,
          instructions: system,
          input: usePrevious ? outputsOnly : input,
          mode,
          signal,
          previousResponseId: usePrevious ? previousResponseId : undefined,
          onText: (t) => {
            fullText += t;
            emit({ type: "text-delta", text: t });
          },
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        // Gateway may not support previous_response_id — retry full transcript once.
        if (usePrevious && /previous_response|not found|unknown|400|404/i.test(msg)) {
          previousResponseId = undefined;
          turn = await responsesAgentTurn({
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
        } else {
          throw err;
        }
      }

      if (turn.responseId) previousResponseId = turn.responseId;

      // Append model function_call items into transcript for gateways that ignore previous_response_id.
      for (const item of turn.outputItems) {
        if ("type" in item && item.type === "function_call") input.push(item);
      }

      if (!turn.toolCalls.length) {
        lastHadTools = false;
        break;
      }
      lastHadTools = true;
      step += 1;

      // Clear pending outputs; push fresh results for next turn.
      // Remove prior function_call_output from input to avoid duplicates when not using previous_response_id.
      for (let i = input.length - 1; i >= 0; i--) {
        const it = input[i];
        if ("type" in it && it.type === "function_call_output") input.splice(i, 1);
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
        message: step === 0 ? "Agent 思考中…" : `工具轮次 ${step + 1}…`,
      });
      const turn = await anthropicAgentTurn({
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
        message: step === 0 ? "Agent 思考中…" : `工具轮次 ${step + 1}…`,
      });
      const turn = await openaiAgentTurn({
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
        // Some Grok relays expose OpenAI chat tools instead of Responses tools.
        if (/tools|tool_choice|function|400|404|422/i.test(msg)) {
          emit({ type: "status", message: "Responses tools 不可用，尝试 OpenAI 协议…" });
          try {
            await runOpenAILoop();
            return { text: fullText, tools: collectedTools, protocol: "openai" };
          } catch {
            /* fall through */
          }
        }
        return textFallback("Grok 工具调用失败，降级为纯文本…");
      }
    }

    if (preferOpenAI) {
      try {
        await runOpenAILoop();
        return { text: fullText, tools: collectedTools, protocol: "openai" };
      } catch (err) {
        if (signal?.aborted) throw err;
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
      if (/tools|tool_choice|400/i.test(msg)) {
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
