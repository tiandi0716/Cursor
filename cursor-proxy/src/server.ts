import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { Agent, Cursor, CursorAgentError, type InteractionUpdate } from "@cursor/sdk";
import {
  loadConfig,
  publicConfig,
  resolveApiKey,
  saveConfig,
  WORKSPACE,
  type ModelParam,
  type ProxyConfig,
} from "./config.ts";
import { hasCloudflared, startTunnel, stopTunnel, tunnelStatus } from "./tunnel.ts";

if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error("Cursor 代理需要 Node.js 22.13+，当前是", process.version);
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

type ListedModel = Awaited<ReturnType<typeof Cursor.models.list>>[number];
type ChatMessage = { role?: string; content?: unknown };
type ChatTool = { type?: string; function?: { name?: string }; name?: string };
type ChatBody = {
  model?: string;
  stream?: boolean;
  messages?: ChatMessage[];
  tools?: ChatTool[];
};

export type RequestKind = "ask" | "plan";

export type RequestLog = {
  at: number;
  requested: string;
  used: string;
  kind: RequestKind;
  reply?: "text" | "tool_calls";
  stream: boolean;
  ok: boolean;
  ms: number;
  error?: string;
};

const SUGGESTED_NAME = "cursor-proxy";
const PLAN_NAME = "cursor-proxy-plan";
const PLAN_MARKER = "You are in plan mode.";
const PLAN_HINT =
  "只输出实施方案和步骤，写成可读的规划。不要改任何文件，不要运行命令，不要假装已经执行。";
const logs: RequestLog[] = [];
let modelCache: { key: string; models: ListedModel[] } | null = null;
let bound = { host: "127.0.0.1", port: 8765 };

function pushLog(entry: RequestLog) {
  logs.unshift(entry);
  if (logs.length > 40) logs.length = 40;
}

async function listedModels(apiKey: string) {
  if (!modelCache || modelCache.key !== apiKey) {
    modelCache = { key: apiKey, models: await Cursor.models.list({ apiKey }) };
  }
  return modelCache.models;
}

function modelSelection(config: ProxyConfig, models: ListedModel[]) {
  const id = config.model || "composer-2.5";
  if (config.modelParams?.length) return { id, params: config.modelParams };
  const item = models.find((m) => m.id === id);
  const variant = item?.variants?.find((v) => v.isDefault) || item?.variants?.[0];
  return { id, params: variant?.params };
}

function bearerKey(req: Request) {
  const auth = String(req.headers.authorization || "");
  return auth.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: string }).text || "");
        }
        return "";
      })
      .join("");
  }
  return "";
}

function toolName(tool: ChatTool) {
  return String(tool.function?.name || tool.name || "").toLowerCase();
}

function isPlanRequest(body: ChatBody): boolean {
  const model = String(body.model || "").trim().toLowerCase();
  if (model === PLAN_NAME) return true;
  if ((body.tools || []).some((t) => /create_plan|createplan/.test(toolName(t)))) return true;
  return (body.messages || []).some((msg) => {
    const text = textOf(msg.content);
    return (
      text.includes(PLAN_MARKER) ||
      /you are in plan mode/i.test(text) ||
      (/plan mode/i.test(text) && /do not (?:edit|write|implement)/i.test(text))
    );
  });
}

function planToolName(body: ChatBody) {
  const hit = (body.tools || []).find((t) => /create_plan|createplan/.test(toolName(t)));
  return hit?.function?.name || hit?.name || "create_plan";
}

function planArgsFromText(text: string) {
  const raw = text.trim() || "（空计划）";
  const heading = raw.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
  const overview =
    raw
      .split(/\n\s*\n/)
      .map((p) => p.replace(/^#{1,3}\s+/, "").trim())
      .find((p) => p && !p.startsWith("#"))
      ?.slice(0, 240) || heading || "实施计划";
  const todos = raw
    .split("\n")
    .map((line) => line.match(/^\s*(?:\d+[\.)]\s*|[-*+]\s*(?:\[[ xX]\]\s*)?)(.+)$/)?.[1]?.trim() || "")
    .filter((line) => line.length > 0 && line.length < 200)
    .slice(0, 20)
    .map((content, i) => ({ id: `todo-${i + 1}`, content, status: "pending" }));
  return {
    name: heading || "实施计划",
    overview,
    plan: raw,
    isProject: true,
    todos: todos.length
      ? todos
      : [{ id: "todo-1", content: overview, status: "pending" }],
  };
}

function buildPrompt(messages: ChatMessage[], plan: boolean): string {
  const lines: string[] = [];
  if (plan) lines.push(`System:\n${PLAN_HINT}`);
  for (const msg of messages) {
    const role = msg.role || "user";
    const text = textOf(msg.content).trim();
    if (!text) continue;
    if (role === "system") lines.push(`System:\n${text}`);
    else if (role === "assistant") lines.push(`Assistant:\n${text}`);
    else lines.push(`User:\n${text}`);
  }
  if (!lines.length) throw new Error("messages 为空");
  return lines.join("\n\n");
}

function errMessage(err: unknown) {
  if (err instanceof CursorAgentError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function writeSse(res: Response, data: unknown) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isTunnelHost(req: Request) {
  const host = String(req.headers.host || "")
    .split(":")[0]
    .toLowerCase();
  return (
    host.endsWith(".trycloudflare.com") ||
    host.endsWith(".ngrok-free.app") ||
    host.endsWith(".ngrok.io") ||
    host.endsWith(".loca.lt")
  );
}

function cursorBaseUrl(configHost: string, configPort: number) {
  const tunnel = tunnelStatus();
  if (tunnel.url) return `${tunnel.url}/v1`;
  return `http://${configHost}:${configPort}/v1`;
}

async function settingsPayload() {
  const config = await loadConfig();
  const resolved = await resolveApiKey();
  const tunnel = tunnelStatus();
  return {
    ...publicConfig(config, {
      host: bound.host,
      port: bound.port,
      source: resolved.source,
      apiKey: resolved.apiKey,
    }),
    accessToken: config.accessToken,
    localBaseUrl: `http://${bound.host}:${bound.port}/v1`,
    baseUrl: cursorBaseUrl(bound.host, bound.port),
    suggestedName: SUGGESTED_NAME,
    recent: logs,
    tunnelRunning: tunnel.running,
    tunnelUrl: tunnel.url,
    tunnelError: tunnel.error,
    hasCloudflared: hasCloudflared(),
  };
}

export function createApp(distDir?: string) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8mb" }));
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    if (isTunnelHost(req)) {
      const path = req.path;
      if (!path.startsWith("/v1") && path !== "/health") {
        res.status(404).json({ error: { message: "not found" } });
        return;
      }
    }
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, baseUrl: `http://${bound.host}:${bound.port}/v1` });
  });

  app.get("/api/settings", async (_req, res) => {
    res.json(await settingsPayload());
  });

  app.put("/api/settings", async (req, res) => {
    try {
      const config = await loadConfig();
      const body = req.body as Partial<ProxyConfig> & { apiKey?: string; clearApiKey?: boolean };
      if (body.clearApiKey === true) {
        config.apiKey = "";
        modelCache = null;
      } else if (typeof body.apiKey === "string" && body.apiKey.trim()) {
        config.apiKey = body.apiKey.trim();
        modelCache = null;
      }
      if (typeof body.model === "string" && body.model.trim()) {
        config.model = body.model.trim();
      }
      if (Array.isArray(body.modelParams)) config.modelParams = body.modelParams as ModelParam[];
      await saveConfig(config);
      res.json(await settingsPayload());
    } catch (err) {
      res.status(400).json({ error: errMessage(err) });
    }
  });

  app.post("/api/tunnel/start", async (_req, res) => {
    try {
      const url = await startTunnel(bound.port);
      console.log(`公网隧道  ${url}/v1`);
      res.json(await settingsPayload());
    } catch (err) {
      res.status(400).json({ error: errMessage(err) });
    }
  });

  app.post("/api/tunnel/stop", async (_req, res) => {
    stopTunnel();
    res.json(await settingsPayload());
  });

  app.get("/api/models", async (_req, res) => {
    try {
      const resolved = await resolveApiKey();
      if (!resolved.apiKey) {
        res.status(400).json({ error: "未配置 API Key" });
        return;
      }
      const models = await listedModels(resolved.apiKey);
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

  app.get("/v1/models", async (req, res) => {
    try {
      const resolved = await resolveApiKey(bearerKey(req));
      if (!resolved.apiKey) {
        throw new Error("未找到 API Key。请把代理窗口里的访问令牌填进 Cursor 的 OpenAI API Key。");
      }
      const models = await listedModels(resolved.apiKey);
      const extra = new Set<string>([SUGGESTED_NAME, PLAN_NAME, (await loadConfig()).model]);
      for (const item of logs) {
        if (item.requested) extra.add(item.requested);
      }
      res.json({
        object: "list",
        data: [
          ...models.map((m) => ({
            id: m.id,
            object: "model",
            created: 0,
            owned_by: "cursor",
          })),
          ...[...extra]
            .filter((id) => id && !models.some((m) => m.id === id))
            .map((id) => ({
              id,
              object: "model",
              created: 0,
              owned_by: "cursor-proxy",
            })),
        ],
      });
    } catch (err) {
      res.status(401).json({ error: { message: errMessage(err), type: "invalid_request_error" } });
    }
  });

  app.post("/v1/chat/completions", async (req, res) => {
    let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;
    let run: Awaited<ReturnType<NonNullable<typeof agent>["send"]>> | undefined;
    let closed = false;
    const started = Date.now();
    const body = req.body as ChatBody;
    const requested = String(body.model || "").trim() || "(未传)";
    const kind: RequestKind = isPlanRequest(body) ? "plan" : "ask";
    let used = "";

    res.on("close", () => {
      closed = true;
      if (run?.supports("cancel")) void run.cancel();
    });

    try {
      const resolved = await resolveApiKey(bearerKey(req));
      if (!resolved.apiKey) {
        throw new Error("未找到 API Key。请把代理窗口里的访问令牌填进 Cursor 的 OpenAI API Key，并在代理里保存 crsr_…。");
      }
      const prompt = buildPrompt(body.messages || [], kind === "plan");
      const config = await loadConfig();
      const models = await listedModels(resolved.apiKey);
      const model = modelSelection(config, models);
      used = model.id;
      const mode = kind === "plan" ? "plan" : "agent";
      console.log(`[proxy] ${kind} ${requested} → ${used}${kind === "plan" ? " (create_plan)" : ""}`);

      agent = await Agent.create({
        apiKey: resolved.apiKey,
        model,
        mode,
        tools: [],
        local: { cwd: WORKSPACE, settingSources: [] },
      });

      const completionId = `chatcmpl-${crypto.randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const asTool = kind === "plan";
      const outModel = requested === "(未传)" ? used : requested;
      let text = "";

      const onDelta = ({ update }: { update: InteractionUpdate }) => {
        if (closed || update.type !== "text-delta" || !update.text) return;
        text += update.text;
        if (body.stream && !asTool) {
          writeSse(res, {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: outModel,
            choices: [{ index: 0, delta: { content: update.text }, finish_reason: null }],
          });
        }
      };

      if (body.stream) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders?.();
        writeSse(res, {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: outModel,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        });
      }

      const heartbeat = body.stream
        ? setInterval(() => {
            if (!closed) res.write(": keepalive\n\n");
          }, 12000)
        : undefined;

      let result: Awaited<ReturnType<NonNullable<typeof run>["wait"]>>;
      try {
        run = await agent.send(prompt, { model, mode, onDelta });
        result = await run.wait();
      } finally {
        if (heartbeat) clearInterval(heartbeat);
      }
      if (result.status === "error") {
        throw new Error(result.error?.message || "模型调用失败");
      }
      if (!text && result.result) text = result.result;

      if (closed) return;

      let reply: "text" | "tool_calls" = "text";
      if (asTool) {
        reply = "tool_calls";
        const callId = `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
        const name = planToolName(body);
        const args = JSON.stringify(planArgsFromText(text));
        if (body.stream) {
          writeSse(res, {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: outModel,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: callId, type: "function", function: { name, arguments: "" } },
                  ],
                },
                finish_reason: null,
              },
            ],
          });
          writeSse(res, {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: outModel,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: args } }],
                },
                finish_reason: null,
              },
            ],
          });
          writeSse(res, {
            id: completionId,
            object: "chat.completion.chunk",
            created,
            model: outModel,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          });
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.json({
            id: completionId,
            object: "chat.completion",
            created,
            model: outModel,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{ id: callId, type: "function", function: { name, arguments: args } }],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        }
      } else if (body.stream) {
        writeSse(res, {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: outModel,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        });
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.json({
          id: completionId,
          object: "chat.completion",
          created,
          model: outModel,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: text },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      }

      pushLog({
        at: Date.now(),
        requested,
        used,
        kind,
        reply,
        stream: Boolean(body.stream),
        ok: true,
        ms: Date.now() - started,
      });
    } catch (err) {
      const message = errMessage(err);
      pushLog({
        at: Date.now(),
        requested,
        used: used || "-",
        kind,
        stream: Boolean(body.stream),
        ok: false,
        ms: Date.now() - started,
        error: message,
      });
      if (res.headersSent) {
        writeSse(res, { error: { message } });
        res.end();
        return;
      }
      const status = /api key|未找到|未配置|401|unauth/i.test(message) ? 401 : 400;
      res.status(status).json({ error: { message, type: "invalid_request_error" } });
    } finally {
      try {
        agent?.close();
      } catch {
        /* ignore */
      }
      try {
        await agent?.[Symbol.asyncDispose]();
      } catch {
        /* ignore */
      }
    }
  });

  const dist = distDir || join(ROOT, "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/(?:api|v1|health)(?:\/|$)).*/, (_req, res) => {
      res.sendFile(join(dist, "index.html"));
    });
  }

  return app;
}

export async function startAppServer(opts?: {
  port?: number;
  host?: string;
  distDir?: string;
}): Promise<{ port: number; host: string; close: () => Promise<void>; server: Server }> {
  const config = await loadConfig();
  const host = opts?.host || process.env.HOST || config.host || "127.0.0.1";
  const port = opts?.port ?? Number(process.env.PORT || config.port || 8765);
  const app = createApp(opts?.distDir);
  const server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  bound = { host, port: actualPort };
  console.log(`Cursor OpenAI 兼容代理  http://${host}:${actualPort}/v1`);
  console.log(`桌面控制台              http://${host}:${actualPort}`);

  return {
    host,
    port: actualPort,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        stopTunnel();
        server.close(() => resolve());
      }),
  };
}
