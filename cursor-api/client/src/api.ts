export type ModelParam = { id: string; value: string };

export type AiSource = "apiKey" | "ccswitch";

export type CcSwitchStatus = {
  connected: boolean;
  baseUrl?: string;
  providerHint?: string;
  error?: string;
};

export type Settings = {
  hasKey: boolean;
  canChat?: boolean;
  apiKey: string;
  keyHint: string;
  workspace: string;
  model: string;
  modelParams: ModelParam[];
  mode: "agent" | "plan";
  aiSource?: AiSource;
  ccswitchProxyUrl?: string;
  ccswitchStatus?: CcSwitchStatus;
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

export type FsNode = { name: string; path: string; isDir: boolean };

export type ChatAttachment = { path: string; name: string; isDir: boolean };

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/** Word / Excel / PPT / PDF 等：文本编辑器打不开，改用系统应用 */
const EXTERNAL_OPEN_EXT =
  /\.(docx?|xlsx?|pptx?|pdf|rtf|odt|ods|odp|csv|pages|numbers|key|epub|dmg|pkg|zip|rar|7z|exe|msi|apk|ipa|woff2?|ttf|otf|eot|mp3|mp4|mov|avi|mkv|wav|flac|ico|psd|ai|sketch)$/i;

export function isImageAttachment(f: ChatAttachment | { path?: string; name?: string; isDir?: boolean }) {
  if (f.isDir) return false;
  const name = f.name || f.path || "";
  return IMAGE_EXT.test(name);
}

export function isExternalOpenablePath(path: string) {
  return EXTERNAL_OPEN_EXT.test(path || "");
}

/** 工作区内图片的预览 URL（同源 API） */
export function fileRawUrl(path: string) {
  return `/api/file/raw?path=${encodeURIComponent(path)}`;
}

/** 用本机默认应用打开工作区文件（Electron shell.openPath） */
export async function openPathInSystem(relPath: string): Promise<{ ok: boolean; error?: string; abs?: string }> {
  try {
    const resolved = await resolveEntry(relPath);
    const abs = resolved.abs;
    if (!window.desktop?.openPath) {
      return { ok: false, error: "当前环境不支持用系统应用打开", abs };
    }
    const result = await window.desktop.openPath(abs);
    return { ...result, abs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export const FILE_DRAG_TYPE = "application/x-workbench-file";

export type ToolEvent = {
  callId: string;
  name: string;
  status: string;
  args?: unknown;
  result?: unknown;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  draft?: string;
  attachments?: ChatAttachment[];
  thinking?: string;
  tools?: ToolEvent[];
  streaming?: boolean;
};

export type Conversation = {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  pinned?: boolean;
  model?: string;
};

export type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  pinned?: boolean;
  model?: string;
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
  body: Partial<Settings> & {
    apiKey?: string;
    clearApiKey?: boolean;
    aiSource?: AiSource;
    ccswitchProxyUrl?: string;
  },
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

export async function browse(path: string) {
  const res = await fetch(`/api/browse?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json() as Promise<{
    path: string;
    parent: string | null;
    entries: Array<{ name: string; path: string; isDir: boolean }>;
  }>;
}

export async function getTree(path = ""): Promise<{ root: string; children: FsNode[] }> {
  const res = await fetch(`/api/tree?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function importAttachments(paths: string[]): Promise<ChatAttachment[]> {
  const res = await fetch("/api/attachments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { files: ChatAttachment[] };
  return data.files || [];
}

/** 上传剪贴板/浏览器 File（无本地 path）到工作区 uploads/ */
export async function uploadAttachmentBlob(
  file: Blob,
  name?: string,
): Promise<ChatAttachment> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const data = btoa(binary);
  const res = await fetch("/api/attachments/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: name || (file instanceof File ? file.name : "paste.png"),
      mime: file.type || "application/octet-stream",
      data,
    }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const body = (await res.json()) as { file?: ChatAttachment; files?: ChatAttachment[] };
  const out = body.file || body.files?.[0];
  if (!out?.path) throw new Error("上传失败");
  return out;
}

export function watchWorkspace(onChange: () => void) {
  const es = new EventSource("/api/fs/watch");
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data) as { type?: string };
      if (data.type === "change") onChange();
    } catch {
      /* ignore */
    }
  };
  return () => es.close();
}

export async function getFile(path: string): Promise<{ path: string; content: string }> {
  const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function saveFile(path: string, content: string) {
  const res = await fetch("/api/file", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content }),
  });
  if (!res.ok) throw new Error(await parseError(res));
}

export async function createEntry(path: string, isDir: boolean): Promise<FsNode> {
  const res = await fetch("/api/fs/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, isDir }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function renameEntry(from: string, name: string): Promise<FsNode> {
  const res = await fetch("/api/fs/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, name }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function deleteEntry(path: string): Promise<void> {
  const res = await fetch("/api/fs/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(await parseError(res));
}

export async function pasteEntry(
  from: string,
  destDir: string,
  mode: "copy" | "cut",
): Promise<FsNode> {
  const res = await fetch("/api/fs/paste", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, destDir, mode }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export type ResolvedPath = { abs: string; dir: string; rel: string; name: string; isDir: boolean };

export async function resolveEntry(path: string): Promise<ResolvedPath> {
  const res = await fetch(`/api/fs/resolve?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export type SearchHit = {
  path: string;
  name: string;
  matches: Array<{ line: number; text: string }>;
};

export async function searchFiles(q: string): Promise<SearchHit[]> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { hits: SearchHit[] };
  return data.hits || [];
}

export type OpenTabsState = {
  convIds: string[];
  activeConvId?: string;
};

export async function getOpenTabs(): Promise<OpenTabsState> {
  const res = await fetch("/api/ui/open-tabs");
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as OpenTabsState;
  return {
    convIds: Array.isArray(data?.convIds) ? data.convIds.filter(Boolean) : [],
    activeConvId: typeof data?.activeConvId === "string" ? data.activeConvId : undefined,
  };
}

export async function saveOpenTabs(state: OpenTabsState): Promise<OpenTabsState> {
  const res = await fetch("/api/ui/open-tabs", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const res = await fetch("/api/conversations");
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { conversations: ConversationSummary[] };
  return data.conversations;
}

export async function getConversation(id: string): Promise<Conversation> {
  const res = await fetch(`/api/conversations/${id}`);
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function createConversation(): Promise<Conversation> {
  const res = await fetch("/api/conversations", { method: "POST" });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function deleteConversation(id: string) {
  const res = await fetch(`/api/conversations/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(await parseError(res));
}

export async function patchConversation(
  id: string,
  body: { title?: string; pinned?: boolean },
): Promise<ConversationSummary> {
  const res = await fetch(`/api/conversations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await parseError(res));
  return res.json();
}

export async function cancelChat(conversationId: string) {
  await fetch("/api/chat/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId }),
  });
}

export async function rewindChat(
  conversationId: string,
  messages: ChatMessage[],
  revertFiles = true,
): Promise<{ reviews: FileReview[] }> {
  const res = await fetch("/api/chat/rewind", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, messages, revertFiles }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { reviews?: FileReview[] };
  return { reviews: data.reviews || [] };
}

export type FileReview = {
  path: string;
  before: string | null;
  after: string | null;
  added: number;
  removed: number;
  status: "pending" | "kept" | "undone";
};

export async function listReviews(conversationId: string): Promise<FileReview[]> {
  const res = await fetch(`/api/review?conversationId=${encodeURIComponent(conversationId)}`);
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { reviews: FileReview[] };
  return data.reviews || [];
}

export async function keepReviews(conversationId: string, path?: string): Promise<FileReview[]> {
  const res = await fetch("/api/review/keep", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, path }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { reviews: FileReview[] };
  return data.reviews || [];
}

export async function undoReviews(conversationId: string, path?: string): Promise<FileReview[]> {
  const res = await fetch("/api/review/undo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, path }),
  });
  if (!res.ok) throw new Error(await parseError(res));
  const data = (await res.json()) as { reviews: FileReview[] };
  return data.reviews || [];
}

export type StreamEvent =
  | { type: "status"; message?: string; agentId?: string }
  | { type: "text-delta"; text: string }
  | { type: "thinking-delta"; text: string }
  | { type: "thinking-completed"; thinkingDurationMs?: number }
  | { type: "tool"; callId: string; name: string; status: string; args?: unknown; result?: unknown }
  | { type: "file-change"; path: string; before: string | null; after: string | null; added: number; removed: number }
  | { type: "usage"; usage?: unknown }
  | { type: "done"; status: string; result?: string; usage?: unknown; error?: { message?: string } }
  | { type: "error"; message: string };

export async function streamChat(
  conversationId: string,
  message: string,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
  extra?: { draft?: string; messageId?: string; attachments?: ChatAttachment[] },
) {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId,
      message,
      draft: extra?.draft,
      messageId: extra?.messageId,
      attachments: extra?.attachments,
    }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(await parseError(res));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() || "";
    for (const part of parts) {
      const line = part
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as StreamEvent);
      } catch {
        /* ignore malformed chunk */
      }
    }
  }
}
