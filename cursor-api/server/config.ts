import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".cursor-ui");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");
export const SESSIONS_FILE = join(CONFIG_DIR, "sessions.json");
export const DEFAULT_WORKSPACE = join(CONFIG_DIR, "workspace");

export type AppMode = "agent" | "plan";

export type AppConfig = {
  apiKey: string;
  workspace: string;
  model: string;
  modelParams: Array<{ id: string; value: string }>;
  mode: AppMode;
};

export type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  draft?: string;
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

const defaultConfig = (): AppConfig => ({
  apiKey: "",
  workspace: DEFAULT_WORKSPACE,
  model: "composer-2.5",
  modelParams: [],
  mode: "agent",
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

export function publicConfig(config: AppConfig) {
  const key = config.apiKey || "";
  return {
    hasKey: key.length > 0,
    apiKey: key,
    keyHint: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : "",
    workspace: config.workspace,
    model: config.model,
    modelParams: config.modelParams,
    mode: config.mode,
  };
}
