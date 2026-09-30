import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AppMode } from "./config.ts";
import {
  deleteWorkspaceEntry,
  listTree,
  readWorkspaceFile,
  resolveUnder,
  searchWorkspace,
  toWorkspaceRel,
  writeWorkspaceFile,
} from "./files.ts";

const execFileAsync = promisify(execFile);

export type CcToolDef = {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  modes: AppMode[];
};

export type CcToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type CcToolResult = {
  ok: boolean;
  content: string;
  /** For review tracking */
  mutating?: boolean;
  path?: string | null;
};

const RESULT_CAP = 100_000;
const READ_CAP = 80_000;

export const CC_TOOL_DEFS: CcToolDef[] = [
  {
    name: "listDir",
    description: "列出工作区内某目录的子项（文件/文件夹）。path 相对工作区根，空字符串表示根目录。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对路径，默认空=工作区根" },
      },
    },
    modes: ["agent", "plan"],
  },
  {
    name: "readFile",
    description: "读取工作区内文本文件内容。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作区的文件路径" },
      },
      required: ["path"],
    },
    modes: ["agent", "plan"],
  },
  {
    name: "searchWorkspace",
    description: "在工作区内按关键字搜索文件名与文本内容。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键字" },
      },
      required: ["query"],
    },
    modes: ["agent", "plan"],
  },
  {
    name: "writeFile",
    description: "写入（创建或覆盖）工作区内文本文件。优先用此工具改文件以便 Review。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string", description: "完整文件内容" },
      },
      required: ["path", "content"],
    },
    modes: ["agent"],
  },
  {
    name: "editFile",
    description: "在工作区文件中做一次精确字符串替换（oldString → newString）。oldString 必须在文件中唯一出现。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
      },
      required: ["path", "oldString", "newString"],
    },
    modes: ["agent"],
  },
  {
    name: "deleteFile",
    description: "删除工作区内的文件或空目录项。",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string" },
      },
      required: ["path"],
    },
    modes: ["agent"],
  },
  {
    name: "createPlan",
    description:
      "输出一份可执行的实施计划（Markdown）。Plan 模式结束前应调用本工具；内容放在 plan 字段。",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "计划标题" },
        plan: { type: "string", description: "完整 Markdown 计划正文" },
      },
      required: ["plan"],
    },
    modes: ["agent", "plan"],
  },
  {
    name: "runShell",
    description:
      "在工作区根目录执行 shell 命令（超时 120s）。改文件请优先 writeFile/editFile，以便 Review 跟踪。",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令行" },
      },
      required: ["command"],
    },
    modes: ["agent"],
  },
];

export function toolsForMode(mode: AppMode): CcToolDef[] {
  return CC_TOOL_DEFS.filter((t) => t.modes.includes(mode));
}

export function anthropicToolsPayload(mode: AppMode) {
  return toolsForMode(mode).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

export function openaiToolsPayload(mode: AppMode) {
  return toolsForMode(mode).map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

/** xAI / OpenAI Responses API: flat function tools */
export function responsesToolsPayload(mode: AppMode) {
  return toolsForMode(mode).map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

function clip(s: string, max = RESULT_CAP) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(truncated ${s.length - max} chars)`;
}

function str(v: unknown, fallback = "") {
  return typeof v === "string" ? v : fallback;
}

function relPath(workspace: string, raw: unknown): string {
  const p = str(raw).trim();
  if (!p || p === "." || p === "/") return "";
  const rel = toWorkspaceRel(workspace, p);
  if (rel == null) throw new Error(`路径超出工作区: ${p}`);
  // ensure resolve works
  resolveUnder(workspace, rel);
  return rel;
}

export async function executeCcTool(
  workspace: string,
  mode: AppMode,
  call: CcToolCall,
): Promise<CcToolResult> {
  const allowed = toolsForMode(mode).some((t) => t.name === call.name);
  if (!allowed) {
    return { ok: false, content: `工具 ${call.name} 在 ${mode} 模式下不可用` };
  }

  const input = call.input || {};

  try {
    switch (call.name) {
      case "listDir": {
        const path = relPath(workspace, input.path ?? "");
        const children = await listTree(workspace, path);
        return {
          ok: true,
          content: clip(JSON.stringify({ path: path || ".", children }, null, 2)),
        };
      }
      case "readFile": {
        const path = relPath(workspace, input.path);
        if (!path) throw new Error("path 必填");
        const file = await readWorkspaceFile(workspace, path);
        return {
          ok: true,
          content: clip(
            JSON.stringify({ path: file.path, size: file.size, content: clip(file.content, READ_CAP) }, null, 2),
          ),
        };
      }
      case "searchWorkspace": {
        const query = str(input.query).trim();
        if (!query) throw new Error("query 必填");
        const hits = await searchWorkspace(workspace, query);
        return { ok: true, content: clip(JSON.stringify({ query, hits }, null, 2)) };
      }
      case "writeFile": {
        const path = relPath(workspace, input.path);
        if (!path) throw new Error("path 必填");
        const content = str(input.content);
        await writeWorkspaceFile(workspace, path, content);
        return {
          ok: true,
          content: JSON.stringify({ path, bytes: content.length, status: "written" }),
          mutating: true,
          path,
        };
      }
      case "editFile": {
        const path = relPath(workspace, input.path);
        if (!path) throw new Error("path 必填");
        const oldString = str(input.oldString);
        const newString = str(input.newString);
        if (!oldString) throw new Error("oldString 必填");
        const file = await readWorkspaceFile(workspace, path);
        const parts = file.content.split(oldString);
        if (parts.length === 1) throw new Error("oldString 未在文件中找到");
        if (parts.length > 2) throw new Error("oldString 在文件中出现多次，请提供更唯一的片段");
        const next = parts[0] + newString + parts[1];
        await writeWorkspaceFile(workspace, path, next);
        return {
          ok: true,
          content: JSON.stringify({ path, status: "edited", beforeLen: file.content.length, afterLen: next.length }),
          mutating: true,
          path,
        };
      }
      case "deleteFile": {
        const path = relPath(workspace, input.path);
        if (!path) throw new Error("path 必填");
        await deleteWorkspaceEntry(workspace, path);
        return {
          ok: true,
          content: JSON.stringify({ path, status: "deleted" }),
          mutating: true,
          path,
        };
      }
      case "createPlan": {
        const title = str(input.title) || "Plan";
        const plan = str(input.plan);
        if (!plan.trim()) throw new Error("plan 正文不能为空");
        return {
          ok: true,
          content: JSON.stringify({ title, status: "created", chars: plan.length }),
        };
      }
      case "runShell": {
        const command = str(input.command).trim();
        if (!command) throw new Error("command 必填");
        if (command.length > 4000) throw new Error("command 过长");
        try {
          const { stdout, stderr } = await execFileAsync("/bin/zsh", ["-c", command], {
            cwd: resolveUnder(workspace, ""),
            timeout: 120_000,
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, HOME: process.env.HOME },
          });
          return {
            ok: true,
            content: clip(
              JSON.stringify({
                exitCode: 0,
                stdout: clip(String(stdout || ""), 40_000),
                stderr: clip(String(stderr || ""), 10_000),
              }),
            ),
          };
        } catch (err) {
          const e = err as {
            code?: number | string;
            stdout?: string;
            stderr?: string;
            message?: string;
            killed?: boolean;
          };
          return {
            ok: false,
            content: clip(
              JSON.stringify({
                exitCode: typeof e.code === "number" ? e.code : 1,
                killed: Boolean(e.killed),
                stdout: clip(String(e.stdout || ""), 20_000),
                stderr: clip(String(e.stderr || e.message || ""), 20_000),
              }),
            ),
          };
        }
      }
      default:
        return { ok: false, content: `未知工具: ${call.name}` };
    }
  } catch (err) {
    return {
      ok: false,
      content: err instanceof Error ? err.message : String(err),
    };
  }
}

export function buildCcAgentSystem(mode: AppMode, workspace: string): string {
  const toolNames = toolsForMode(mode)
    .map((t) => t.name)
    .join(", ");
  if (mode === "plan") {
    return [
      "你是 Cursor 工作台里的规划助手（Plan 模式），通过 CC Switch 连接模型。",
      `工作区根目录：${workspace}`,
      "你可以使用只读工具了解代码，最后必须调用 createPlan 输出 Markdown 实施计划。",
      "禁止修改、删除文件或执行会改盘的 shell。",
      `可用工具：${toolNames}`,
      "用简洁中文沟通；计划正文写在 createPlan 的 plan 字段。",
    ].join("\n");
  }
  return [
    "你是 Cursor 工作台里的编码 Agent，通过 CC Switch 连接模型。",
    `工作区根目录：${workspace}`,
    "你可以列出目录、读写/编辑/删除文件、搜索、执行 shell，并可用 createPlan 整理方案。",
    "改文件请优先 writeFile / editFile（便于用户 Review）；runShell 改盘不会进入 Review。",
    "路径一律相对工作区，禁止访问工作区外路径。",
    "效率：同一文件/命令不要反复调用；读够信息后尽快 writeFile/editFile 落地，避免只探索不改。",
    "若任务较大，分步完成但每轮都要有实质进展；结束前用简短中文说明已完成与未完成项。",
    `可用工具：${toolNames}`,
    "用简洁中文说明进展；真正改代码时直接调用工具。",
  ].join("\n");
}
