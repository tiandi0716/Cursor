import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".cursor-ui");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const SESSIONS_FILE = join(CONFIG_DIR, "sessions.json");
export const OPEN_TABS_FILE = join(CONFIG_DIR, "open-tabs.json");
export const DEFAULT_WORKSPACE = join(CONFIG_DIR, "workspace");

export type AppMode = "agent" | "plan";
export type AiSource = "apiKey" | "ccswitch";

export type CcSwitchStatus = {
  connected: boolean;
  baseUrl?: string;
  providerHint?: string;
  error?: string;
};

export type AppConfig = {
  apiKey: string;
  workspace: string;
  model: string;
  modelParams: Array<{ id: string; value: string }>;
  mode: AppMode;
  aiSource: AiSource;
  ccswitchProxyUrl: string;
};

export type StoredAttachment = { path: string; name: string; isDir: boolean };

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  draft?: string;
  attachments?: StoredAttachment[];
  thinking?: string;
  tools?: Array<{
    callId: string;
    name: string;
    status: string;
    args?: unknown;
    result?: unknown;
  }>;
};

export type StoredConversation = {
  id: string;
  title: string;
  agentId?: string;
  cwd: string;
  model: string;
  mode: AppMode;
  pinned?: boolean;
  messages: StoredMessage[];
  createdAt: number;
  updatedAt: number;
};

export const DEFAULT_CCSWITCH_PROXY_URL = "http://127.0.0.1:15721";

const defaultConfig = (): AppConfig => ({
  apiKey: "",
  workspace: DEFAULT_WORKSPACE,
  model: "composer-2.5",
  modelParams: [],
  mode: "agent",
  aiSource: "apiKey",
  ccswitchProxyUrl: DEFAULT_CCSWITCH_PROXY_URL,
});

export async function ensureConfigDir(): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true });
  await mkdir(DEFAULT_WORKSPACE, { recursive: true });
  const intro = join(DEFAULT_WORKSPACE, "README.md");
  try {
    await readFile(intro);
  } catch {
    await writeFile(
      intro,
      "# 本地工作区\n\n这是 Cursor 工作台的默认工作区。用左侧「打开文件夹」换成你的项目，然后在右侧向 Agent 发消息。\n",
    );
  }
}

export async function loadConfig(): Promise<AppConfig> {
  await ensureConfigDir();
  try {
    const raw = await readFile(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    return {
      ...defaultConfig(),
      ...parsed,
      apiKey: String(parsed.apiKey ?? "").trim(),
      workspace: parsed.workspace || DEFAULT_WORKSPACE,
      modelParams: Array.isArray(parsed.modelParams) ? parsed.modelParams : [],
      mode: parsed.mode === "plan" ? "plan" : "agent",
      aiSource: parsed.aiSource === "ccswitch" ? "ccswitch" : "apiKey",
      ccswitchProxyUrl:
        typeof parsed.ccswitchProxyUrl === "string" && parsed.ccswitchProxyUrl.trim()
          ? parsed.ccswitchProxyUrl.trim().replace(/\/$/, "")
          : DEFAULT_CCSWITCH_PROXY_URL,
    };
  } catch {
    const cfg = defaultConfig();
    await saveConfig(cfg);
    return cfg;
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await ensureConfigDir();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function loadConversations(): Promise<StoredConversation[]> {
  await ensureConfigDir();
  try {
    const raw = await readFile(SESSIONS_FILE, "utf8");
    const parsed = JSON.parse(raw) as StoredConversation[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveConversations(items: StoredConversation[]): Promise<void> {
  await ensureConfigDir();
  await writeFile(SESSIONS_FILE, JSON.stringify(items, null, 2), { mode: 0o600 });
}

export type OpenTabsState = {
  convIds: string[];
  activeConvId?: string;
};

export async function loadOpenTabs(): Promise<OpenTabsState> {
  await ensureConfigDir();
  try {
    const raw = await readFile(OPEN_TABS_FILE, "utf8");
    const parsed = JSON.parse(raw) as OpenTabsState;
    const convIds = Array.isArray(parsed?.convIds)
      ? parsed.convIds.filter((id): id is string => typeof id === "string" && Boolean(id))
      : [];
    return {
      convIds,
      activeConvId: typeof parsed?.activeConvId === "string" ? parsed.activeConvId : undefined,
    };
  } catch {
    return { convIds: [] };
  }
}

export async function saveOpenTabs(state: OpenTabsState): Promise<void> {
  await ensureConfigDir();
  const convIds = Array.isArray(state?.convIds)
    ? state.convIds.filter((id): id is string => typeof id === "string" && Boolean(id))
    : [];
  const active =
    typeof state?.activeConvId === "string" && convIds.includes(state.activeConvId)
      ? state.activeConvId
      : convIds[0];
  await writeFile(
    OPEN_TABS_FILE,
    JSON.stringify({ convIds, activeConvId: active }, null, 2),
    { mode: 0o600 },
  );
}

export function publicConfig(config: AppConfig, ccswitchStatus?: CcSwitchStatus) {
  const key = config.apiKey || "";
  const status = ccswitchStatus ?? { connected: false };
  const canChat =
    config.aiSource === "ccswitch" ? Boolean(status.connected) : key.length > 0;
  return {
    hasKey: key.length > 0,
    canChat,
    apiKey: key,
    keyHint: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : "",
    workspace: config.workspace,
    model: config.model,
    modelParams: config.modelParams,
    mode: config.mode,
    aiSource: config.aiSource,
    ccswitchProxyUrl: config.ccswitchProxyUrl || DEFAULT_CCSWITCH_PROXY_URL,
    ccswitchStatus: status,
  };
}
