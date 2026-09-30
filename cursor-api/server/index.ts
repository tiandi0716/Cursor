import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { Agent, Cursor, CursorAgentError } from "@cursor/sdk";
import {
  loadConfig,
  saveConfig,
  loadConversations,
  saveConversations,
  publicConfig,
  DEFAULT_WORKSPACE,
  DEFAULT_CCSWITCH_PROXY_URL,
  type AppConfig,
  type AiSource,
  type StoredConversation,
} from "./config.ts";
import {
  getCcSwitchStatus,
  listCcSwitchModels,
  resolveCcSwitchEndpoint,
  runCcAgentLoop,
} from "./ccswitch.ts";
import {
  browse,
  createWorkspaceEntry,
  deleteWorkspaceEntry,
  importDroppedPaths,
  saveUploadedBytes,
  listTree,
  pasteWorkspaceEntry,
  readWorkspaceFile,
  readWorkspaceTextOptional,
  renameWorkspaceEntry,
  resolveUnder,
  resolveWorkspaceEntry,
  searchWorkspace,
  subscribeWorkspace,
  toWorkspaceRel,
  watchWorkspace,
  writeWorkspaceFile,
} from "./files.ts";
import {
  cachedBefore,
  isMutatingTool,
  listReviews,
  markPendingUndone,
  markReview,
  pathFromToolArgs,
  rememberBefore,
  upsertReview,
} from "./review.ts";

if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error("Cursor 工作台需要 Node.js 22.13+，当前是", process.version);
  console.error("请执行: source ~/.nvm/nvm.sh && nvm use 22");
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const HOST = "127.0.0.1";

type LiveAgent = Awaited<ReturnType<typeof Agent.create>>;
type LiveRun = Awaited<ReturnType<LiveAgent["send"]>>;
type ListedModel = Awaited<ReturnType<typeof Cursor.models.list>>[number];

const agents = new Map<string, LiveAgent>();
const runs = new Map<string, LiveRun>();
const chatAborts = new Map<string, AbortController>();
let modelCache: ListedModel[] | null = null;

async function disposeAllAgents() {
  for (const id of [...agents.keys()]) await disposeAgent(id);
}

async function settingsPayload(config: AppConfig) {
  const ccswitchStatus =
    config.aiSource === "ccswitch"
      ? await getCcSwitchStatus(config.ccswitchProxyUrl || DEFAULT_CCSWITCH_PROXY_URL)
      : { connected: false as const };
  return publicConfig(config, ccswitchStatus);
}

async function listedModels(apiKey: string) {
  if (!modelCache) modelCache = await Cursor.models.list({ apiKey });
  return modelCache;
}

function modelSelection(config: AppConfig, models: ListedModel[]) {
  const id = config.model || "composer-2.5";
  if (config.modelParams?.length) return { id, params: config.modelParams };
  const item = models.find((m) => m.id === id);
  const variant = item?.variants?.find((v) => v.isDefault) || item?.variants?.[0];
  return { id, params: variant?.params };
}

function send(res: Response, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  const flush = (res as unknown as { flush?: () => void }).flush;
  flush?.();
}

function errMessage(err: unknown) {
  if (err instanceof CursorAgentError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function normalizeAttachments(raw: unknown): Array<{ path: string; name: string; isDir: boolean }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ path: string; name: string; isDir: boolean }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const path = typeof o.path === "string" ? o.path.trim() : "";
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const name =
      typeof o.name === "string" && o.name.trim()
        ? o.name.trim()
        : path.split(/[/\\]/).pop() || path;
    out.push({ path, name, isDir: Boolean(o.isDir) });
  }
  return out;
}

function toolMeta(toolCall: unknown): { name: string; args?: unknown; result?: unknown } {
  if (!toolCall || typeof toolCall !== "object") return { name: "tool" };
  const o = toolCall as Record<string, unknown>;
  const type = typeof o.type === "string" ? o.type : "";
  const name =
    (typeof o.name === "string" && o.name) ||
    (typeof o.toolName === "string" && o.toolName) ||
    (typeof o.tool === "string" && o.tool) ||
    (type && type !== "toolCall" ? type : "") ||
    "tool";
  return {
    name,
    args: o.args ?? o.arguments ?? o.input ?? o.params,
    result: o.result ?? o.output,
  };
}

function emitFileChange(
  emit: (payload: unknown) => void,
  item: { path: string; before: string | null; after: string | null; added: number; removed: number },
) {
  emit({
    type: "file-change",
    path: item.path,
    before: item.before,
    after: item.after,
    added: item.added,
    removed: item.removed,
  });
}

function trackMutatingTool(
  conversationId: string,
  workspace: string,
  name: string,
  args: unknown,
  result: unknown,
  phase: "start" | "done",
  emit: (payload: unknown) => void,
): Promise<void> {
  if (!isMutatingTool(name)) return Promise.resolve();
  const raw = pathFromToolArgs(args) || pathFromToolArgs(result);
  if (!raw) return Promise.resolve();
  const rel = toWorkspaceRel(workspace, raw);
  if (!rel) return Promise.resolve();
  if (phase === "start") {
    return rememberBefore(conversationId, rel, () => readWorkspaceTextOptional(workspace, rel)).then(() => {});
  }
  return (async () => {
    // done 阶段禁止再从磁盘读 before（文件已被改），只用 start 快照 / 已有 pending
    const before =
      cachedBefore(conversationId, rel) ??
      (await rememberBefore(conversationId, rel, async () => null)) ??
      null;
    const after = await readWorkspaceTextOptional(workspace, rel);
    if (before === after) return;
    const item = upsertReview(conversationId, { path: rel, before, after, added: 0, removed: 0 });
    emitFileChange(emit, item);
  })();
}

async function disposeAgent(id: string) {
  const agent = agents.get(id);
  if (!agent) return;
  agents.delete(id);
  try {
    agent.close();
  } catch {
    /* ignore */
  }
  try {
    await agent[Symbol.asyncDispose]();
  } catch {
    /* ignore */
  }
}

async function getOrCreateAgent(conv: StoredConversation, config: AppConfig) {
  const existing = agents.get(conv.id);
  if (existing) return { agent: existing, reused: true };

  const apiKey = config.apiKey;
  if (!apiKey) throw new Error("请先在设置中填写 Cursor API Key");
  const cwd = config.workspace || DEFAULT_WORKSPACE;
  const models = await listedModels(apiKey);
  const model = modelSelection(config, models);

  if (conv.agentId) {
    try {
      const resumed = await Agent.resume(conv.agentId, {
        apiKey,
        model,
        local: { cwd, settingSources: [] },
      });
      agents.set(conv.id, resumed);
      return { agent: resumed, reused: true };
    } catch {
      conv.agentId = undefined;
    }
  }

  const created = await Agent.create({
    apiKey,
    model,
    mode: config.mode,
    local: { cwd, settingSources: [] },
  });
  conv.agentId = created.agentId;
  agents.set(conv.id, created);
  return { agent: created, reused: false };
}

function priorContext(messages: StoredConversation["messages"]) {
  const prior = messages.filter((m) => (m.text || "").trim());
  if (!prior.length) return "";
  const body = prior
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.text.slice(0, 2000)}`)
    .join("\n\n");
  return `此前对话已被回退到这一步。下面是仍需保留的上文，请据此继续，不要重复已经完成的工作。\n\n${body}\n\n---\n\n`;
}

async function persist(conversations: StoredConversation[]) {
  await saveConversations(conversations);
}

const app = express();
app.use(express.json({ limit: "32mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/settings", async (_req, res) => {
  try {
    const config = await loadConfig();
    res.json(await settingsPayload(config));
  } catch (err) {
    res.status(500).json({ error: errMessage(err) });
  }
});

app.put("/api/settings", async (req, res) => {
  try {
    const config = await loadConfig();
    const body = req.body as Partial<AppConfig> & {
      apiKey?: string;
      clearApiKey?: boolean;
      aiSource?: AiSource;
      ccswitchProxyUrl?: string;
    };
    const prevSource = config.aiSource;
    if (body.clearApiKey === true) {
      config.apiKey = "";
      modelCache = null;
      await disposeAllAgents();
    } else if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      config.apiKey = body.apiKey.trim();
      modelCache = null;
    }
    if (typeof body.workspace === "string" && body.workspace.trim()) {
      config.workspace = body.workspace.trim();
      watchWorkspace(config.workspace);
    }
    if (typeof body.model === "string" && body.model.trim()) {
      config.model = body.model.trim();
    }
    if (Array.isArray(body.modelParams)) config.modelParams = body.modelParams;
    if (body.mode === "agent" || body.mode === "plan") config.mode = body.mode;
    if (body.aiSource === "apiKey" || body.aiSource === "ccswitch") {
      config.aiSource = body.aiSource;
    }
    if (typeof body.ccswitchProxyUrl === "string" && body.ccswitchProxyUrl.trim()) {
      config.ccswitchProxyUrl = body.ccswitchProxyUrl.trim().replace(/\/$/, "");
    }
    if (config.aiSource !== prevSource) {
      modelCache = null;
      await disposeAllAgents();
      // Cursor SDK model ids won't work on CC Switch; pick a safe default.
      if (
        config.aiSource === "ccswitch" &&
        (!config.model || /composer|cursor|gpt-5-codex|gemini/i.test(config.model))
      ) {
        config.model = "claude-sonnet-4-5";
        config.modelParams = [];
      }
    }
    await saveConfig(config);
    res.json(await settingsPayload(config));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

app.get("/api/models", async (_req, res) => {
  try {
    const config = await loadConfig();
    if (config.aiSource === "ccswitch") {
      const endpoint = await resolveCcSwitchEndpoint(config.ccswitchProxyUrl || DEFAULT_CCSWITCH_PROXY_URL);
      const models = await listCcSwitchModels(endpoint);
      res.json({ models });
      return;
    }
    if (!config.apiKey) {
      res.status(400).json({ error: "未配置 API Key" });
      return;
    }
    const models = await listedModels(config.apiKey);
    res.json({
      models: models.map((m) => ({
        id: m.id,
        displayName: m.displayName,
        description: m.description,
        parameters: m.parameters,
        defaultParams: (m.variants?.find((v) => v.isDefault) || m.variants?.[0])?.params ?? [],
      })),
    });
  } catch (err) {
    res.status(401).json({ error: errMessage(err) });
  }
});

app.get("/api/browse", async (req, res) => {
  try {
    const path = String(req.query.path || "");
    res.json(await browse(path));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

app.get("/api/tree", async (req, res) => {
  try {
    const config = await loadConfig();
    const rel = String(req.query.path || "");
    const children = await listTree(config.workspace, rel);
    res.json({ root: config.workspace, children });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

app.get("/api/file", async (req, res) => {
  try {
    const config = await loadConfig();
    const rel = String(req.query.path || "");
    res.json(await readWorkspaceFile(config.workspace, rel));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

/** 二进制预览（图片等）：给 <img src> 用 */
app.get("/api/file/raw", async (req, res) => {
  try {
    const config = await loadConfig();
    const rel = String(req.query.path || "");
    const abs = resolveUnder(config.workspace, rel);
    const { readFile, stat } = await import("node:fs/promises");
    const info = await stat(abs);
    if (info.isDirectory()) throw new Error("是目录");
    if (info.size > 25 * 1024 * 1024) throw new Error("文件过大");
    const buf = await readFile(abs);
    const lower = rel.toLowerCase();
    const mime =
      lower.endsWith(".png")
        ? "image/png"
        : lower.endsWith(".jpg") || lower.endsWith(".jpeg")
          ? "image/jpeg"
          : lower.endsWith(".gif")
            ? "image/gif"
            : lower.endsWith(".webp")
              ? "image/webp"
              : lower.endsWith(".bmp")
                ? "image/bmp"
                : lower.endsWith(".svg")
                  ? "image/svg+xml"
                  : "application/octet-stream";
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "private, max-age=60");
    res.send(buf);
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

app.put("/api/file", async (req, res) => {
  try {
    const config = await loadConfig();
    const path = String(req.body?.path || "");
    const content = String(req.body?.content ?? "");
    res.json(await writeWorkspaceFile(config.workspace, path, content));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

app.post("/api/fs/create", async (req, res) => {
  try {
    const config = await loadConfig();
    const path = String(req.body?.path || "").trim();
    const isDir = Boolean(req.body?.isDir);
    if (!path) {
      res.status(400).json({ error: "缺少路径" });
      return;
    }
    res.json(await createWorkspaceEntry(config.workspace, path, isDir));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

app.post("/api/fs/rename", async (req, res) => {
  try {
    const config = await loadConfig();
    const from = String(req.body?.from || "").trim();
    const name = String(req.body?.name || "").trim();
    if (!from || !name) {
      res.status(400).json({ error: "缺少路径或名称" });
      return;
    }
    res.json(await renameWorkspaceEntry(config.workspace, from, name));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

app.post("/api/fs/delete", async (req, res) => {
  try {
    const config = await loadConfig();
    const path = String(req.body?.path || "").trim();
    if (!path) {
      res.status(400).json({ error: "缺少路径" });
      return;
    }
    res.json(await deleteWorkspaceEntry(config.workspace, path));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

app.post("/api/fs/paste", async (req, res) => {
  try {
    const config = await loadConfig();
    const from = String(req.body?.from || "").trim();
    const destDir = String(req.body?.destDir || "").trim();
    const mode = req.body?.mode === "cut" ? "cut" : "copy";
    if (!from) {
      res.status(400).json({ error: "缺少源路径" });
      return;
    }
    res.json(await pasteWorkspaceEntry(config.workspace, from, destDir, mode));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

app.get("/api/fs/resolve", async (req, res) => {
  try {
    const config = await loadConfig();
    const path = String(req.query.path || "");
    res.json(await resolveWorkspaceEntry(config.workspace, path));
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const config = await loadConfig();
    const q = String(req.query.q || "");
    const hits = await searchWorkspace(config.workspace, q);
    res.json({ hits });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

app.get("/api/fs/watch", async (_req, res) => {
  const config = await loadConfig();
  watchWorkspace(config.workspace);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.socket?.setNoDelay?.(true);
  res.write(": connected\n\n");
  send(res, { type: "ready" });
  const ping = setInterval(() => {
    res.write(": ping\n\n");
    const flush = (res as unknown as { flush?: () => void }).flush;
    flush?.();
  }, 15000);
  const unsub = subscribeWorkspace(() => {
    send(res, { type: "change" });
  });
  res.on("close", () => {
    clearInterval(ping);
    unsub();
  });
});

app.post("/api/attachments", async (req, res) => {
  try {
    const config = await loadConfig();
    const paths = Array.isArray(req.body?.paths)
      ? (req.body.paths as unknown[]).map((p) => String(p || "").trim()).filter(Boolean)
      : [];
    if (!paths.length) {
      res.status(400).json({ error: "没有可导入的文件" });
      return;
    }
    const files = await importDroppedPaths(config.workspace, paths);
    res.json({ files });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

/** 剪贴板图片 / 无本地路径的 File → 写入 uploads/ */
app.post("/api/attachments/upload", async (req, res) => {
  try {
    const config = await loadConfig();
    const name = typeof req.body?.name === "string" ? req.body.name : undefined;
    const mime = typeof req.body?.mime === "string" ? req.body.mime : undefined;
    const raw = typeof req.body?.data === "string" ? req.body.data : "";
    // 允许 data URL 或纯 base64
    const b64 = raw.includes("base64,") ? raw.split("base64,").pop() || "" : raw;
    if (!b64.trim()) {
      res.status(400).json({ error: "没有可上传的数据" });
      return;
    }
    const buf = Buffer.from(b64, "base64");
    const file = await saveUploadedBytes(config.workspace, { name, mime, data: buf });
    res.json({ file, files: [file] });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

function summarizeConv(c: StoredConversation) {
  return {
    id: c.id,
    title: c.title,
    updatedAt: c.updatedAt,
    createdAt: c.createdAt,
    pinned: Boolean(c.pinned),
    model: c.model,
  };
}

function sortConversations(list: StoredConversation[]) {
  return list.slice().sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

app.get("/api/conversations", async (_req, res) => {
  const list = await loadConversations();
  res.json({
    conversations: sortConversations(list).map(summarizeConv),
  });
});

app.get("/api/conversations/:id", async (req, res) => {
  const list = await loadConversations();
  const conv = list.find((c) => c.id === req.params.id);
  if (!conv) {
    res.status(404).json({ error: "对话不存在" });
    return;
  }
  res.json(conv);
});

app.post("/api/conversations", async (_req, res) => {
  const config = await loadConfig();
  const list = await loadConversations();
  const conv: StoredConversation = {
    id: crypto.randomUUID(),
    title: "新对话",
    cwd: config.workspace,
    model: config.model,
    mode: config.mode,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  list.unshift(conv);
  await persist(list);
  res.json(conv);
});

app.patch("/api/conversations/:id", async (req, res) => {
  const list = await loadConversations();
  const conv = list.find((c) => c.id === req.params.id);
  if (!conv) {
    res.status(404).json({ error: "对话不存在" });
    return;
  }
  if (typeof req.body?.title === "string") {
    const title = String(req.body.title).trim();
    if (!title) {
      res.status(400).json({ error: "标题不能为空" });
      return;
    }
    conv.title = title.slice(0, 80);
  }
  if (typeof req.body?.pinned === "boolean") conv.pinned = req.body.pinned;
  await persist(list);
  res.json(summarizeConv(conv));
});

app.delete("/api/conversations/:id", async (req, res) => {
  const list = await loadConversations();
  const id = req.params.id;
  await disposeAgent(id);
  const next = list.filter((c) => c.id !== id);
  await persist(next);
  res.json({ ok: true });
});

app.get("/api/review", async (req, res) => {
  const id = String(req.query.conversationId || "");
  if (!id) {
    res.status(400).json({ error: "缺少 conversationId" });
    return;
  }
  res.json({ reviews: listReviews(id) });
});

app.post("/api/review/keep", async (req, res) => {
  const conversationId = String(req.body?.conversationId || "");
  const path = typeof req.body?.path === "string" ? req.body.path : undefined;
  if (!conversationId) {
    res.status(400).json({ error: "缺少 conversationId" });
    return;
  }
  res.json({ reviews: markReview(conversationId, path, "kept") });
});

app.post("/api/review/undo", async (req, res) => {
  try {
    const config = await loadConfig();
    const conversationId = String(req.body?.conversationId || "");
    const path = typeof req.body?.path === "string" ? req.body.path : undefined;
    if (!conversationId) {
      res.status(400).json({ error: "缺少 conversationId" });
      return;
    }
    const targets = listReviews(conversationId).filter((r) => r.status !== "undone" && (!path || r.path === path));
    if (!targets.length) {
      res.json({ reviews: listReviews(conversationId) });
      return;
    }
    const errors: string[] = [];
    for (const item of targets) {
      try {
        if (item.before == null) {
          // 原本不存在的文件：删掉 Agent 新建的
          try {
            await deleteWorkspaceEntry(config.workspace, item.path);
          } catch (err) {
            // 已不存在则视为成功
            if (!/enoent|不存在|no such file/i.test(errMessage(err))) throw err;
          }
        } else {
          await writeWorkspaceFile(config.workspace, item.path, item.before);
        }
      } catch (err) {
        errors.push(`${item.path}: ${errMessage(err)}`);
      }
    }
    if (errors.length) {
      res.status(400).json({ error: `回退失败：${errors.join("；")}`, reviews: listReviews(conversationId) });
      return;
    }
    res.json({ reviews: markReview(conversationId, path, "undone") });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

app.post("/api/chat/rewind", async (req, res) => {
  try {
    const config = await loadConfig();
    const conversationId = String(req.body?.conversationId || "");
    const raw = Array.isArray(req.body?.messages) ? (req.body.messages as Record<string, unknown>[]) : null;
    if (!conversationId || !raw) {
      res.status(400).json({ error: "缺少 conversationId 或 messages" });
      return;
    }
    const list = await loadConversations();
    const conv = list.find((c) => c.id === conversationId);
    if (!conv) {
      res.status(404).json({ error: "对话不存在" });
      return;
    }
    const run = runs.get(conversationId);
    if (run?.supports?.("cancel")) {
      try {
        await run.cancel();
      } catch {
        /* ignore */
      }
    }
    runs.delete(conversationId);
    await disposeAgent(conversationId);
    conv.agentId = undefined;
    conv.messages = raw.map((item, i) => ({
      id: String(item?.id || `msg-${i}`),
      role: item?.role === "assistant" ? "assistant" : "user",
      text: typeof item?.text === "string" ? item.text : "",
      draft: typeof item?.draft === "string" ? item.draft : undefined,
      attachments: normalizeAttachments(item?.attachments),
      thinking: typeof item?.thinking === "string" ? item.thinking : undefined,
      tools: Array.isArray(item?.tools) ? (item.tools as StoredConversation["messages"][number]["tools"]) : undefined,
    }));
    conv.updatedAt = Date.now();
    await persist(list);

    if (req.body?.revertFiles === false) {
      res.json({ ok: true, reviews: listReviews(conversationId) });
      return;
    }

    const pending = listReviews(conversationId).filter((r) => r.status === "pending");
    for (const item of pending) {
      if (item.before == null) await deleteWorkspaceEntry(config.workspace, item.path);
      else await writeWorkspaceFile(config.workspace, item.path, item.before);
    }
    res.json({ ok: true, reviews: markPendingUndone(conversationId) });
  } catch (err) {
    res.status(400).json({ error: errMessage(err) });
  }
});

app.post("/api/chat/cancel", async (req, res) => {
  const id = String(req.body?.conversationId || "");
  const abort = chatAborts.get(id);
  if (abort) {
    abort.abort();
    chatAborts.delete(id);
  }
  const run = runs.get(id);
  if (run?.supports?.("cancel")) {
    try {
      await run.cancel();
    } catch {
      /* ignore */
    }
  }
  res.json({ ok: true });
});

app.post("/api/chat", async (req: Request, res: Response) => {
  const conversationId = String(req.body?.conversationId || "");
  const message = String(req.body?.message || "").trim();
  const draft = typeof req.body?.draft === "string" ? req.body.draft : undefined;
  const attachments = normalizeAttachments(req.body?.attachments);
  const messageId =
    typeof req.body?.messageId === "string" && req.body.messageId.trim()
      ? String(req.body.messageId).trim()
      : crypto.randomUUID();
  if (!conversationId || !message) {
    res.status(400).json({ error: "缺少 conversationId 或 message" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  res.write(": connected\n\n");

  let closed = false;
  const abortCtrl = new AbortController();
  chatAborts.set(conversationId, abortCtrl);
  res.on("close", () => {
    if (res.writableEnded) return;
    closed = true;
    abortCtrl.abort();
    const run = runs.get(conversationId);
    if (run?.supports("cancel")) void run.cancel();
  });

  try {
    const config = await loadConfig();
    const list = await loadConversations();
    const conv = list.find((c) => c.id === conversationId);
    if (!conv) throw new Error("对话不存在");

    conv.messages.push({
      id: messageId,
      role: "user",
      text: message,
      draft,
      attachments: attachments.length ? attachments : undefined,
    });
    if (conv.title === "新对话") conv.title = message.slice(0, 36);
    conv.updatedAt = Date.now();
    await persist(list);

    const assistantId = crypto.randomUUID();
    const assistant: StoredConversation["messages"][number] = {
      id: assistantId,
      role: "assistant",
      text: "",
      thinking: "",
      tools: [],
    };
    conv.messages.push(assistant);

    if (config.aiSource === "ccswitch") {
      send(res, { type: "status", message: "连接 CC Switch…" });
      const proxyUrl = config.ccswitchProxyUrl || DEFAULT_CCSWITCH_PROXY_URL;
      const status = await getCcSwitchStatus(proxyUrl);
      if (!status.connected) {
        throw new Error(status.error || "CC Switch 未连接");
      }
      const model = config.model || "claude-sonnet-4-5";
      const endpoint = await resolveCcSwitchEndpoint(proxyUrl, model);
      send(res, {
        type: "status",
        message: `CC Switch · ${endpoint.providerHint || status.providerHint || endpoint.baseUrl} · ${config.mode}`,
      });
      const history = conv.messages
        .slice(0, -2)
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          text: m.text || "",
          tools: m.tools,
        }));
      const fileJobs: Promise<void>[] = [];
      const emitFile = (payload: unknown) => {
        if (!closed) send(res, payload);
      };
      console.log(
        "[chat] ccswitch agent",
        conversationId,
        model,
        endpoint.protocol,
        config.mode,
        endpoint.baseUrl,
      );
      const result = await runCcAgentLoop({
        endpoint,
        model,
        mode: config.mode,
        workspace: config.workspace || DEFAULT_WORKSPACE,
        history,
        latest: message,
        proxyUrl,
        signal: abortCtrl.signal,
        emit: (payload) => {
          if (closed || abortCtrl.signal.aborted) return;
          if (payload.type === "text-delta" && payload.text) {
            assistant.text += payload.text;
            send(res, { type: "text-delta", text: payload.text });
            return;
          }
          if (payload.type === "tool" && payload.callId) {
            const existing = assistant.tools?.find((t) => t.callId === payload.callId);
            if (existing) {
              existing.name = payload.name || existing.name;
              existing.status = payload.status || existing.status;
              if (payload.args !== undefined) existing.args = payload.args;
              if (payload.result !== undefined) existing.result = payload.result;
            } else {
              assistant.tools?.push({
                callId: payload.callId,
                name: payload.name || "tool",
                status: payload.status || "running",
                args: payload.args,
                result: payload.result,
              });
            }
            send(res, {
              type: "tool",
              callId: payload.callId,
              name: payload.name,
              status: payload.status,
              args: payload.args,
              result: payload.result,
            });
            return;
          }
          if (payload.type === "status" && payload.message) {
            send(res, { type: "status", message: payload.message });
          }
        },
        onToolLifecycle: async ({ phase, name, args, result: toolResult }) => {
          // 必须 await：start 阶段要在 writeFile 前拿到 before，否则 Undo 无法回退
          const job = trackMutatingTool(
            conversationId,
            config.workspace || DEFAULT_WORKSPACE,
            name,
            args,
            toolResult,
            phase,
            emitFile,
          ).catch((err) => {
            console.warn("[review] ccswitch track failed", err);
          });
          fileJobs.push(job);
          await job;
        },
      });
      assistant.text = result.text || assistant.text;
      if (result.tools.length && assistant.tools) {
        // ensure final tool snapshot from loop
        for (const t of result.tools) {
          const existing = assistant.tools.find((x) => x.callId === t.callId);
          if (existing) {
            existing.status = t.status;
            existing.args = t.args ?? existing.args;
            existing.result = t.result ?? existing.result;
          } else {
            assistant.tools.push({ ...t });
          }
        }
      }
      await Promise.allSettled(fileJobs);
      conv.updatedAt = Date.now();
      await persist(list);
      if (!closed && !abortCtrl.signal.aborted) {
        send(res, { type: "done", status: "completed", result: assistant.text });
      } else if (!closed) {
        send(res, { type: "done", status: "cancelled", result: assistant.text });
      }
      return;
    }

    send(res, { type: "status", message: "正在启动 Agent…" });
    console.log("[chat] creating agent for", conversationId);
    const { agent, reused } = await getOrCreateAgent(conv, config);
    console.log("[chat] agent ready", agent.agentId);
    send(res, { type: "status", message: "Agent 已就绪", agentId: agent.agentId });
    const history = reused ? "" : priorContext(conv.messages.slice(0, -1));

    console.log("[chat] sending", conversationId);
    const models = await listedModels(config.apiKey);
    const outgoing = `${history}${message}`;
    const fileJobs: Promise<void>[] = [];
    const emitFile = (payload: unknown) => {
      if (!closed) send(res, payload);
    };
    const queueTrack = (name: string, args: unknown, result: unknown, phase: "start" | "done") => {
      fileJobs.push(
        trackMutatingTool(conversationId, config.workspace, name, args, result, phase, emitFile).catch((err) => {
          console.warn("[review] track failed", err);
        }),
      );
    };
    const run = await agent.send(outgoing, {
      model: modelSelection(config, models),
      mode: config.mode,
      onDelta: ({ update }) => {
        if (closed) return;
        if (update.type === "text-delta") {
          assistant.text += update.text;
          send(res, { type: "text-delta", text: update.text });
        } else if (update.type === "thinking-delta") {
          assistant.thinking = (assistant.thinking || "") + update.text;
          send(res, { type: "thinking-delta", text: update.text });
        } else if (update.type === "thinking-completed") {
          send(res, { type: "thinking-completed", thinkingDurationMs: update.thinkingDurationMs });
        } else if (update.type === "tool-call-started" || update.type === "partial-tool-call") {
          const meta = toolMeta(update.toolCall);
          const existing = assistant.tools?.find((t) => t.callId === update.callId);
          if (existing) {
            existing.name = meta.name;
            existing.args = meta.args;
            existing.status = "running";
          } else {
            assistant.tools?.push({
              callId: update.callId,
              name: meta.name,
              status: "running",
              args: meta.args,
            });
          }
          send(res, {
            type: "tool",
            callId: update.callId,
            name: meta.name,
            status: "running",
            args: meta.args,
          });
          queueTrack(meta.name, meta.args, undefined, "start");
        } else if (update.type === "tool-call-completed") {
          const meta = toolMeta(update.toolCall);
          const existing = assistant.tools?.find((t) => t.callId === update.callId);
          if (existing) {
            existing.status = "completed";
            existing.result = meta.result;
            existing.args = meta.args ?? existing.args;
          }
          send(res, {
            type: "tool",
            callId: update.callId,
            name: meta.name,
            status: "completed",
            args: meta.args,
            result: meta.result,
          });
          queueTrack(meta.name, meta.args ?? existing?.args, meta.result, "done");
        } else if (update.type === "turn-ended") {
          send(res, { type: "usage", usage: update.usage });
        }
      },
    });
    console.log("[chat] run started", run.id);

    runs.set(conversationId, run);
    const result = await run.wait();
    runs.delete(conversationId);
    await Promise.all(fileJobs);

    if (!assistant.text && result.result) assistant.text = result.result;
    conv.updatedAt = Date.now();
    await persist(list);

    if (!closed) {
      for (const item of listReviews(conversationId).filter((r) => r.status === "pending")) {
        emitFileChange(emitFile, item);
      }
      send(res, {
        type: "done",
        status: result.status,
        result: result.result,
        usage: result.usage,
        error: result.error,
        agentId: agent.agentId,
      });
    }
  } catch (err) {
    const aborted =
      abortCtrl.signal.aborted ||
      (err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message)));
    if (!closed) {
      if (aborted) send(res, { type: "done", status: "cancelled" });
      else send(res, { type: "error", message: errMessage(err) });
    }
  } finally {
    chatAborts.delete(conversationId);
    if (!closed) res.end();
  }
});

const distDefault = join(ROOT, "dist");

export async function startAppServer(opts?: {
  port?: number;
  host?: string;
  distDir?: string;
}): Promise<{ port: number; host: string; close: () => Promise<void> }> {
  const dist = opts?.distDir || distDefault;
  const host = opts?.host || HOST;
  const port = opts?.port ?? Number(process.env.PORT || 8788);

  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.sendFile(join(dist, "index.html"));
    });
  }

  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const config = await loadConfig();
  watchWorkspace(config.workspace);
  console.log(`Cursor 工作台 API  http://${host}:${actualPort}`);

  async function close() {
    for (const id of [...agents.keys()]) await disposeAgent(id);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return { port: actualPort, host, close };
}

const isElectron = Boolean(process.versions.electron);
if (!isElectron) {
  const running = await startAppServer();
  async function shutdown() {
    await running.close();
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
