import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowUp, Check, ChevronDown, ChevronRight, Copy, File, Folder, Loader2, Paperclip, Square, Undo2, X } from "lucide-react";
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  FILE_DRAG_TYPE,
  fileRawUrl,
  importAttachments,
  isImageAttachment,
  uploadAttachmentBlob,
  type ChatAttachment,
  type ChatMessage,
  type ConversationSummary,
  type FileReview,
  type ModelInfo,
  type ModelParam,
  type StreamEvent,
  type ToolEvent,
} from "../api";
import { ModelPicker } from "./ModelPicker";
import { ModeMenu } from "./ModeMenu";
import { ChatHeadActions, ChatHistoryList } from "./ChatHistory";

type Props = {
  messages: ChatMessage[];
  models: ModelInfo[];
  model: string;
  modelParams: ModelParam[];
  mode: "agent" | "plan";
  streaming: boolean;
  status?: string;
  disabled?: boolean;
  title: string;
  history: ConversationSummary[];
  activeId?: string;
  tabs: Array<{ key: string; title: string; streaming?: boolean; draft?: boolean }>;
  activeKey: string;
  reviews: FileReview[];
  onSelectTab: (key: string) => void;
  onCloseTab: (key: string) => void;
  onKeep: (path?: string) => void;
  onUndo: (path?: string) => void;
  onOpenReview: (path?: string) => void;
  onModelConfig: (model: string, params: ModelParam[]) => void;
  onMode: (mode: "agent" | "plan") => void;
  onSend: (text: string, draft?: string, attachments?: ChatAttachment[]) => void;
  onStop: () => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void> | void;
  onBuildPlan: (plan: string) => void;
  onResend: (messageId: string, text: string, draft?: string, attachments?: ChatAttachment[]) => void;
};

export function ChatPanel({
  messages,
  models,
  model,
  modelParams,
  mode,
  streaming,
  status,
  disabled,
  title,
  history,
  activeId,
  tabs,
  activeKey,
  reviews,
  onSelectTab,
  onCloseTab,
  onKeep,
  onUndo,
  onOpenReview,
  onModelConfig,
  onMode,
  onSend,
  onStop,
  onNew,
  onSelect,
  onDelete,
  onRename,
  onBuildPlan,
  onResend,
}: Props) {
  const [text, setText] = useState("");
  const [attached, setAttached] = useState<ChatAttachment[]>([]);
  const [dropOver, setDropOver] = useState(false);
  const [filesOpen, setFilesOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [histQuery, setHistQuery] = useState("");
  const [ctxOpen, setCtxOpen] = useState(false);
  const [viewingPlan, setViewingPlan] = useState<string | null>(null);
  const [reviewFilesOpen, setReviewFilesOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editAttachments, setEditAttachments] = useState<ChatAttachment[]>([]);
  const headRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);

  const addAttachments = (items: ChatAttachment[]) => {
    setAttached((prev) => {
      const next = new Map(prev.map((f) => [f.path, f]));
      for (const item of items) next.set(item.path, item);
      return [...next.values()];
    });
    setFilesOpen(true);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "i" && !e.shiftKey) {
        e.preventDefault();
        onMode("agent");
      }
      if (streaming && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        if (box.current?.contains(document.activeElement)) {
          e.preventDefault();
          onStop();
        }
      }
      if (e.key === "Escape") setViewingPlan(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onMode, onStop, streaming]);

  useEffect(() => {
    if (!historyOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (headRef.current?.contains(t)) return;
      if (t?.closest(".ctx-menu")) return;
      setHistoryOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistoryOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [historyOpen]);

  useEffect(() => {
    if (!ctxOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!ctxRef.current?.contains(e.target as Node)) setCtxOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxOpen]);

  const pickFiles = async (list: FileList | File[]) => {
    const files = Array.from(list);
    const withPath: string[] = [];
    const blobs: File[] = [];
    for (const f of files) {
      const p = filePathFromDropped(f);
      if (p) withPath.push(p);
      else blobs.push(f);
    }
    const out: ChatAttachment[] = [];
    if (withPath.length) {
      try {
        out.push(...(await importAttachments(withPath)));
      } catch {
        out.push(
          ...withPath.map((p) => ({ path: p, name: p.split(/[/\\]/).pop() || p, isDir: false })),
        );
      }
    }
    for (const f of blobs) {
      try {
        out.push(await uploadAttachmentBlob(f, f.name || guessPasteName(f.type)));
      } catch (err) {
        console.error(err);
        window.alert(err instanceof Error ? err.message : String(err));
      }
    }
    if (out.length) addAttachments(out);
  };

  const onPasteComposer = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items?.length) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== "file") continue;
      const f = item.getAsFile();
      if (!f) continue;
      // 图片 / 文件：优先当附件；纯文本仍走默认粘贴
      if (item.type.startsWith("image/") || f.type.startsWith("image/") || f.size > 0) {
        files.push(f);
      }
    }
    if (!files.length) return;
    // 有图片文件时拦截，避免浏览器把占位符文本粘进输入框
    const hasImage = files.some((f) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name));
    if (hasImage) e.preventDefault();
    void pickFiles(files);
  };

  const send = () => {
    const v = text.trim();
    if ((!v && !attached.length) || streaming || disabled) return;
    const files = [...attached];
    setEditingId(null);
    onSend(buildPrompt(v, files), v, files);
    setText("");
    setAttached([]);
    if (ta.current) ta.current.style.height = "44px";
  };

  const startEdit = (message: ChatMessage) => {
    if (disabled || streaming) return;
    setEditingId(message.id);
    setEditText(restoreDraft(message));
    setEditAttachments(messageAttachments(message));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText("");
    setEditAttachments([]);
  };

  const submitEdit = () => {
    const v = editText.trim();
    if ((!v && !editAttachments.length) || !editingId || streaming || disabled) return;
    const id = editingId;
    const files = [...editAttachments];
    setEditingId(null);
    setEditText("");
    setEditAttachments([]);
    onResend(id, buildPrompt(v, files), v, files);
  };

  const onDragOverComposer = (e: DragEvent) => {
    if (!canDropFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setDropOver(true);
  };

  const onDropComposer = (e: DragEvent) => {
    if (!canDropFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropOver(false);
    const snapshot = snapshotDrop(e);
    void (async () => {
      const items = await readDroppedFiles(snapshot);
      if (items.length) addAttachments(items);
    })();
  };

  const canSend = !disabled && !streaming && Boolean(text.trim() || attached.length);
  const ctx = estimateContext(messages, text, attached);
  const listed = (reviews || []).filter((r) => r && r.path);
  const pending = listed.filter((r) => r.status === "pending");
  const showReviewActions = pending.length > 0;
  const latestPlan = latestPlanText(messages);

  return (
    <aside className="chat">
      <div className="chat-head" ref={headRef}>
        <ChatHeadActions
          title={title}
          canEdit={Boolean(activeId)}
          historyOpen={historyOpen}
          tabs={tabs}
          activeKey={activeKey}
          onSelectTab={onSelectTab}
          onCloseTab={onCloseTab}
          onToggleHistory={() => setHistoryOpen((v) => !v)}
          onNew={() => {
            setHistoryOpen(false);
            onNew();
          }}
          onRename={(next) => (activeId ? onRename(activeId, next) : undefined)}
          onDelete={() => {
            if (activeId) onDelete(activeId);
          }}
        />
        {historyOpen ? (
          <div className="hist-pop">
            <input
              className="hist-search"
              value={histQuery}
              placeholder="搜索对话..."
              autoFocus
              onChange={(e) => setHistQuery(e.target.value)}
            />
            <ChatHistoryList
              items={history}
              activeId={activeId}
              query={histQuery}
              compact
              onSelect={(id) => {
                setHistoryOpen(false);
                onSelect(id);
              }}
              onDelete={onDelete}
              onRename={onRename}
            />
          </div>
        ) : null}
      </div>
      <div className="chat-body">
      <div className="messages" ref={scroller}>
        {messages.length === 0 ? (
          <div className="empty">
            描述你想改的代码或要查的问题。也可把左侧文件，或访达 / 资源管理器里的文件拖进下方输入框。
            <br />
            Agent 模式会在工作区内读文件、改文件、跑命令。
          </div>
        ) : (
          messages.map((m) => (
            <MessageView
              key={m.id}
              message={m}
              busy={streaming}
              editing={editingId === m.id}
              editText={editText}
              models={models}
              model={model}
              modelParams={modelParams}
              mode={mode}
              onModelConfig={onModelConfig}
              onMode={onMode}
              onEditText={setEditText}
              onViewPlan={setViewingPlan}
              onBuildPlan={onBuildPlan}
              onStartEdit={m.role === "user" ? () => startEdit(m) : undefined}
              onSubmitEdit={submitEdit}
              onCancelEdit={cancelEdit}
              editAttachments={editingId === m.id ? editAttachments : undefined}
              onRemoveEditAttachment={
                editingId === m.id
                  ? (path) => setEditAttachments((prev) => prev.filter((f) => f.path !== path))
                  : undefined
              }
            />
          ))
        )}
        {streaming && status ? <div className="faint">{status}</div> : null}
      </div>
      {viewingPlan ? (
        <div className="plan-overlay">
          <div className="plan-overlay-head">
            <span>Plan</span>
            <button type="button" className="icon-btn" title="关闭" onClick={() => setViewingPlan(null)}>
              <X size={14} />
            </button>
          </div>
          <div className="plan-overlay-body md">
            <MarkdownBlock text={viewingPlan} />
          </div>
          <div className="plan-overlay-foot">
            <button
              type="button"
              className="plan-build-main"
              disabled={streaming || disabled}
              onClick={() => {
                const plan = viewingPlan;
                setViewingPlan(null);
                onBuildPlan(plan);
              }}
            >
              Build <kbd>{modEnterHint()}</kbd>
            </button>
          </div>
        </div>
      ) : null}
      </div>
      <div className="composer">
          {listed.length ? (
            <div className="review-row">
              <div className="review-files-box">
                <button
                  type="button"
                  className="review-files-toggle"
                  onClick={() => setReviewFilesOpen((v) => !v)}
                >
                  {reviewFilesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  {listed.length} {listed.length === 1 ? "File" : "Files"}
                </button>
                {reviewFilesOpen ? (
                  <div className="review-file-list">
                    {listed.map((item) => (
                      <div
                        key={item.path}
                        className={`review-file-item${item.status === "kept" ? " is-kept" : ""}${item.status === "undone" ? " is-undone" : ""}`}
                        title={item.path}
                      >
                        <button type="button" className="review-file-name" onClick={() => onOpenReview(item.path)}>
                          <span>{item.path.split(/[/\\]/).pop()}</span>
                          {item.status === "kept" ? <em className="kept">Kept</em> : null}
                          {item.status === "undone" ? <em className="kept">Undone</em> : null}
                          <em className="add">+{item.added}</em>
                          <em className="del">-{item.removed}</em>
                        </button>
                        {showReviewActions && item.status === "pending" ? (
                          <>
                            <button type="button" className="review-text-btn compact" onClick={() => onUndo(item.path)}>
                              Undo
                            </button>
                            <button type="button" className="review-text-btn compact" onClick={() => onKeep(item.path)}>
                              Keep
                            </button>
                          </>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="review-actions">
                {showReviewActions ? (
                  <>
                    <button type="button" className="review-text-btn" onClick={() => onUndo()}>
                      Undo All
                    </button>
                    <button type="button" className="review-text-btn" onClick={() => onKeep()}>
                      Keep All
                    </button>
                  </>
                ) : null}
                <button type="button" className="review-btn" onClick={() => onOpenReview()}>
                  Review
                </button>
              </div>
            </div>
          ) : null}
        <div
          ref={box}
          className={`composer-box ${dropOver ? "drop-over" : ""}`}
          onDragOverCapture={onDragOverComposer}
          onDragEnterCapture={onDragOverComposer}
          onDragLeave={(e) => {
            const next = e.relatedTarget as Node | null;
            if (next && e.currentTarget.contains(next)) return;
            setDropOver(false);
          }}
          onDropCapture={onDropComposer}
        >
          {attached.length || streaming ? (
          <div className="composer-top">
            {attached.length ? (
              <button type="button" className="files-toggle" onClick={() => setFilesOpen((v) => !v)}>
                {filesOpen ? "▾" : "▸"} {attached.length} Files
              </button>
            ) : (
              <span />
            )}
            <div className="composer-top-right">
              {streaming ? (
                <button type="button" className="stop-hint" onClick={onStop} title="停止">
                  Stop <kbd>^C</kbd>
                </button>
              ) : null}
            </div>
          </div>
          ) : null}
          {attached.length > 0 && filesOpen ? (
            <AttachmentChips
              files={attached}
              onRemove={(path) => setAttached((prev) => prev.filter((x) => x.path !== path))}
            />
          ) : null}
          <textarea
            ref={ta}
            value={text}
            placeholder={disabled ? "请先在设置中保存 API Key" : "输入框"}
            disabled={disabled}
            onPaste={onPasteComposer}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = "44px";
              e.target.style.height = Math.min(e.target.scrollHeight, 200) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey) return;
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if ((e.metaKey || e.ctrlKey) && latestPlan && !streaming && !disabled) {
                e.preventDefault();
                onBuildPlan(latestPlan);
                return;
              }
              if (e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              send();
            }}
          />
          <div className="composer-bar">
            <ModeMenu mode={mode} onMode={onMode} />
            <ModelPicker
              models={models}
              model={model}
              modelParams={modelParams}
              onChange={onModelConfig}
            />
            <span className="spacer" />
            <div className="ctx-usage" ref={ctxRef}>
              <button
                type="button"
                className={`composer-icon ctx-ring-btn ${ctxOpen ? "on" : ""}`}
                title="上下文用量"
                onClick={() => setCtxOpen((v) => !v)}
              >
                <span
                  className="ctx-ring"
                  style={{ background: `conic-gradient(#c4b5fd ${ctx.pct}%, #3a3a3a 0)` }}
                />
              </button>
              {ctxOpen ? (
                <div className="ctx-pop">
                  <div className="ctx-pop-head">
                    <strong>Context Usage</strong>
                    <button type="button" className="icon-btn" title="关闭" onClick={() => setCtxOpen(false)}>
                      <X size={14} />
                    </button>
                  </div>
                  <div className="ctx-pop-meta">
                    <span>{ctx.pct}% Full</span>
                    <span>~{formatTokens(ctx.used)} / {formatTokens(ctx.limit)} Tokens</span>
                  </div>
                  <div className="ctx-pop-bar">
                    <i style={{ width: `${ctx.pct}%` }} />
                  </div>
                  <div className="ctx-pop-row">
                    <span>
                      <i className="swatch conv" />
                      Conversation
                    </span>
                    <em>{formatTokens(ctx.conversation)}</em>
                  </div>
                  {ctx.files > 0 ? (
                    <div className="ctx-pop-row">
                      <span>
                        <i className="swatch files" />
                        Files
                      </span>
                      <em>{formatTokens(ctx.files)}</em>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void pickFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button type="button" className="composer-icon" title="附加文件" onClick={() => fileRef.current?.click()}>
              <Paperclip size={16} />
            </button>
            {streaming ? (
              <button className="send-round stop" onClick={onStop} title="停止">
                <Square size={11} fill="currentColor" />
              </button>
            ) : (
              <button className="send-round" disabled={!canSend} onClick={send} title="发送">
                <ArrowUp size={16} strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

function estimateContext(messages: ChatMessage[], draft: string, files: ChatAttachment[]) {
  const limit = 300_000;
  const chars =
    messages.reduce((n, m) => n + (m.text?.length || 0) + (m.thinking?.length || 0), 0) + (draft?.length || 0);
  const conversation = Math.max(0, Math.round(chars / 4));
  const fileTokens = files.reduce((n, f) => n + Math.max(80, Math.round((f.path.length + f.name.length) / 2) + (f.isDir ? 400 : 800)), 0);
  const used = Math.min(limit, conversation + fileTokens);
  return {
    limit,
    conversation,
    files: fileTokens,
    used,
    pct: Math.min(100, Math.max(1, Math.round((used / limit) * 100))),
  };
}

function formatTokens(n: number) {
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 100 ? k.toFixed(0) : k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return String(n);
}

function canDropFiles(e: DragEvent) {
  const types = Array.from(e.dataTransfer.types);
  return (
    types.includes(FILE_DRAG_TYPE) ||
    types.includes("Files") ||
    types.includes("public.file-url") ||
    types.includes("text/uri-list") ||
    types.includes("text/plain")
  );
}

function filePathFromDropped(file: File) {
  const fromDesktop = window.desktop?.getPathForFile?.(file);
  if (fromDesktop) return fromDesktop;
  const legacy = (file as File & { path?: string }).path;
  return legacy || "";
}

function guessPasteName(mime: string) {
  const m = (mime || "").toLowerCase();
  if (m.includes("png")) return `paste-${Date.now()}.png`;
  if (m.includes("jpeg") || m.includes("jpg")) return `paste-${Date.now()}.jpg`;
  if (m.includes("gif")) return `paste-${Date.now()}.gif`;
  if (m.includes("webp")) return `paste-${Date.now()}.webp`;
  return `paste-${Date.now()}.png`;
}

function pathsFromUriList(text: string) {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#")) continue;
    if (raw.startsWith("file:")) {
      try {
        const url = new URL(raw);
        let p = decodeURIComponent(url.pathname);
        if (/^\/[a-zA-Z]:\//.test(p)) p = p.slice(1);
        out.push(p);
      } catch {
        /* ignore */
      }
      continue;
    }
    if (raw.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(raw)) out.push(raw);
  }
  return out;
}

type DropSnapshot = {
  custom: string;
  paths: string[];
  plain: string;
  blobs: File[];
};

function snapshotDrop(e: DragEvent): DropSnapshot {
  const paths: string[] = [];
  const blobs: File[] = [];
  for (const file of Array.from(e.dataTransfer.files || [])) {
    const p = filePathFromDropped(file);
    if (p) paths.push(p);
    else blobs.push(file);
  }
  paths.push(...pathsFromUriList(e.dataTransfer.getData("text/uri-list")));
  const plain = e.dataTransfer.getData("text/plain").trim();
  return {
    custom: e.dataTransfer.getData(FILE_DRAG_TYPE),
    paths,
    plain,
    blobs,
  };
}

async function readDroppedFiles(drop: DropSnapshot): Promise<ChatAttachment[]> {
  if (drop.custom) {
    try {
      return [JSON.parse(drop.custom) as ChatAttachment];
    } catch {
      /* ignore */
    }
  }

  const out: ChatAttachment[] = [];
  const paths = [...drop.paths];
  const plain = drop.plain;
  if (plain && !plain.includes("\n") && plain.length <= 500) {
    if (plain.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(plain) || plain.startsWith("file:")) {
      paths.push(...pathsFromUriList(plain.startsWith("file:") ? plain : `file://${plain}`));
      if (!plain.startsWith("file:")) paths.push(plain);
    }
  }

  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length) {
    try {
      out.push(...(await importAttachments(unique)));
    } catch {
      out.push(
        ...unique.map((p) => ({
          path: p,
          name: p.split(/[/\\]/).pop() || p,
          isDir: false,
        })),
      );
    }
  }

  for (const f of drop.blobs || []) {
    try {
      out.push(await uploadAttachmentBlob(f, f.name || guessPasteName(f.type)));
    } catch (err) {
      console.error(err);
    }
  }

  if (out.length) return out;

  if (plain && !plain.includes("\n") && plain.length <= 500) {
    return [{ path: plain, name: plain.split(/[/\\]/).pop() || plain, isDir: false }];
  }
  return [];
}

function buildPrompt(text: string, files: ChatAttachment[]) {
  if (!files.length) return text;
  const list = files.map((f) => `- \`${f.path}\`${f.isDir ? "（目录）" : ""}`).join("\n");
  const head = `请先读取并分析以下工作区路径：\n${list}`;
  return text ? `${head}\n\n${text}` : head;
}

function restoreDraft(message: ChatMessage) {
  if (message.draft?.trim()) return message.draft;
  const text = asText(message.text);
  const marker = "请先读取并分析以下工作区路径：";
  if (!text.startsWith(marker)) return text;
  const i = text.indexOf("\n\n");
  return i >= 0 ? text.slice(i + 2) : text;
}

function messageAttachments(message: ChatMessage): ChatAttachment[] {
  if (Array.isArray(message.attachments) && message.attachments.length) {
    return message.attachments.filter((f) => f?.path);
  }
  const text = asText(message.text);
  const marker = "请先读取并分析以下工作区路径：";
  if (!text.startsWith(marker)) return [];
  const body = text.slice(marker.length);
  const block = body.split("\n\n")[0] || body;
  const out: ChatAttachment[] = [];
  for (const line of block.split("\n")) {
    const m = line.match(/^- `([^`]+)`(（目录）)?/);
    if (!m) continue;
    const path = m[1];
    out.push({
      path,
      name: path.split(/[/\\]/).pop() || path,
      isDir: Boolean(m[2]),
    });
  }
  return out;
}

function AttachmentChips({
  files,
  onRemove,
}: {
  files: ChatAttachment[];
  onRemove?: (path: string) => void;
}) {
  const [preview, setPreview] = useState<ChatAttachment | null>(null);
  if (!files.length) return null;
  const images = files.filter((f) => isImageAttachment(f));
  const others = files.filter((f) => !isImageAttachment(f));
  return (
    <>
      <div className="attach-list bubble-attach-list">
        {images.map((f) => (
          <div key={f.path} className="attach-thumb-wrap" title={f.path}>
            <button
              type="button"
              className="attach-thumb"
              onClick={(e) => {
                e.stopPropagation();
                setPreview(f);
              }}
            >
              <img src={fileRawUrl(f.path)} alt={f.name} draggable={false} />
            </button>
            {onRemove ? (
              <button
                type="button"
                className="attach-thumb-x"
                title="移除"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(f.path);
                }}
              >
                <X size={11} />
              </button>
            ) : null}
          </div>
        ))}
        {others.map((f) => (
          <span key={f.path} className="attach-chip" title={f.path}>
            {f.isDir ? <Folder size={12} /> : <File size={12} />}
            <em>{f.name}</em>
            {onRemove ? (
              <button
                type="button"
                className="icon-btn"
                title="移除"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(f.path);
                }}
              >
                <X size={11} />
              </button>
            ) : null}
          </span>
        ))}
      </div>
      {preview ? (
        <ImageLightbox
          path={preview.path}
          name={preview.name}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </>
  );
}

function ImageLightbox({
  path,
  name,
  onClose,
}: {
  path: string;
  name: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="img-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <button
        type="button"
        className="img-lightbox-close"
        title="关闭"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <X size={18} />
      </button>
      <img
        src={fileRawUrl(path)}
        alt={name}
        className="img-lightbox-img"
        draggable={false}
        onClick={(e) => e.stopPropagation()}
      />
      <div className="img-lightbox-caption" onClick={(e) => e.stopPropagation()}>
        {name}
      </div>
    </div>
  );
}

function MessageView({
  message,
  busy,
  editing,
  editText,
  editAttachments,
  models,
  model,
  modelParams,
  mode,
  onModelConfig,
  onMode,
  onEditText,
  onRemoveEditAttachment,
  onViewPlan,
  onBuildPlan,
  onStartEdit,
  onSubmitEdit,
  onCancelEdit,
}: {
  message: ChatMessage;
  busy?: boolean;
  editing?: boolean;
  editText?: string;
  editAttachments?: ChatAttachment[];
  models: ModelInfo[];
  model: string;
  modelParams: ModelParam[];
  mode: "agent" | "plan";
  onModelConfig: (model: string, params: ModelParam[]) => void;
  onMode: (mode: "agent" | "plan") => void;
  onEditText?: (text: string) => void;
  onRemoveEditAttachment?: (path: string) => void;
  onViewPlan: (plan: string) => void;
  onBuildPlan: (plan: string) => void;
  onStartEdit?: () => void;
  onSubmitEdit?: () => void;
  onCancelEdit?: () => void;
}) {
  const text = asText(message.text);
  const thinking = asText(message.thinking);
  const files = editing ? editAttachments || [] : messageAttachments(message);
  if (message.role === "user") {
    if (editing) {
      return (
        <div className="bubble user is-editing">
          <AttachmentChips files={files} onRemove={onRemoveEditAttachment} />
          <textarea
            className="bubble-editor"
            value={editText}
            autoFocus
            onChange={(e) => {
              onEditText?.(e.target.value);
              e.target.style.height = "72px";
              e.target.style.height = Math.min(e.target.scrollHeight, 220) + "px";
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onCancelEdit?.();
                return;
              }
              if (e.key !== "Enter" || e.shiftKey) return;
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              onSubmitEdit?.();
            }}
          />
          <div className="composer-bar">
            <ModeMenu mode={mode} onMode={onMode} />
            <ModelPicker models={models} model={model} modelParams={modelParams} onChange={onModelConfig} />
            <span className="spacer" />
            <button type="button" className="review-text-btn" onClick={onCancelEdit}>
              取消
            </button>
            <button
              type="button"
              className="send-round"
              disabled={(!editText?.trim() && !files.length) || busy}
              title="发送"
              onClick={onSubmitEdit}
            >
              <ArrowUp size={16} strokeWidth={2.4} />
            </button>
          </div>
        </div>
      );
    }
    return (
      <div
        className="bubble user can-edit"
        title={onStartEdit && !busy ? "点击编辑并重新发送" : undefined}
        onClick={() => {
          if (busy) return;
          const sel = window.getSelection()?.toString();
          if (sel) return;
          onStartEdit?.();
        }}
      >
        <AttachmentChips files={files} />
        <div className="bubble-text">{restoreDraft(message) || text}</div>
        {onStartEdit && !busy ? (
          <button
            type="button"
            className="bubble-rewind"
            title="编辑并重新发送"
            onClick={(e) => {
              e.stopPropagation();
              onStartEdit();
            }}
          >
            <Undo2 size={13} />
          </button>
        ) : null}
      </div>
    );
  }
  const tools = (message.tools || []).filter((t) => t && t.callId);
  return (
    <div className="bubble assistant">
      {thinking ? (
        <details className="thinking" open={message.streaming && !text}>
          <summary>思考过程</summary>
          <pre>{thinking}</pre>
        </details>
      ) : null}
      {tools.map((t) =>
        isPlanTool(t.name) ? (
          <PlanCard
            key={t.callId}
            tool={t}
            busy={busy}
            onView={() => {
              const plan = planFromArgs(t.args);
              if (plan) onViewPlan(plan);
            }}
            onBuild={() => {
              const plan = planFromArgs(t.args);
              if (plan) onBuildPlan(plan);
            }}
          />
        ) : (
          <ToolCard key={t.callId} tool={t} />
        ),
      )}
      {text ? (
        <div className="md">
          <MarkdownBlock text={text} streaming={message.streaming} />
        </div>
      ) : message.streaming && !tools.some((t) => isPlanTool(t.name)) ? (
        <Loader2 className="spin" size={16} />
      ) : null}
    </div>
  );
}

function PlanCard({
  tool,
  busy,
  onView,
  onBuild,
}: {
  tool: ToolEvent;
  busy?: boolean;
  onView: () => void;
  onBuild: () => void;
}) {
  const [more, setMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const plan = planFromArgs(tool.args);
  const preview = useMemo(() => parsePlanPreview(plan), [plan]);
  const ready = Boolean(plan) && tool.status !== "running";

  useEffect(() => {
    if (!more) return;
    const onDoc = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMore(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [more]);

  return (
    <div className="plan-card">
      <div className="plan-kicker">{ready ? "Created Plan" : "Creating Plan"}</div>
      {preview.title ? <h3>{preview.title}</h3> : null}
      {preview.excerpt ? (
        <div className="plan-excerpt md">
          <MarkdownBlock text={preview.excerpt} />
        </div>
      ) : tool.status === "running" ? (
        <div className="plan-wait">
          <Loader2 className="spin" size={14} />
          正在生成计划…
        </div>
      ) : null}
      <div className="plan-actions">
        <button type="button" className="plan-view" disabled={!ready} onClick={onView}>
          View Plan
        </button>
        <div className="plan-build" ref={moreRef}>
          <button type="button" className="plan-build-main" disabled={!ready || busy} onClick={onBuild}>
            Build <kbd>{modEnterHint()}</kbd>
          </button>
          <button
            type="button"
            className="plan-build-more"
            disabled={!ready}
            title="更多"
            onClick={() => setMore((v) => !v)}
          >
            <ChevronDown size={14} />
          </button>
          {more ? (
            <div className="ctx-menu plan-build-pop">
              <button
                type="button"
                className="ctx-item"
                disabled={busy}
                onClick={() => {
                  setMore(false);
                  onBuild();
                }}
              >
                Build
              </button>
              <button
                type="button"
                className="ctx-item"
                onClick={() => {
                  setMore(false);
                  if (plan) void navigator.clipboard.writeText(plan);
                }}
              >
                复制计划
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ToolCard({ tool }: { tool: ToolEvent }) {
  const detail = useMemo(() => summarizeTool(tool), [tool]);
  return (
    <div className="tool">
      {tool.status === "running" ? <Loader2 className="spin" size={14} /> : null}
      <div className="body">
        <div>
          <span className="badge">{tool.name}</span>
          {tool.status === "completed" ? " 完成" : tool.status === "error" ? " 失败" : " 执行中"}
        </div>
        {detail ? <div className="name">{detail}</div> : null}
      </div>
    </div>
  );
}

function summarizeTool(tool: ToolEvent) {
  const args = tool.args;
  if (!args || typeof args !== "object") return "";
  const o = args as Record<string, unknown>;
  for (const key of ["path", "targetFile", "file", "command", "query", "pattern", "url", "plan"]) {
    if (typeof o[key] === "string") return String(o[key]).slice(0, 160);
  }
  try {
    return JSON.stringify(args).slice(0, 160);
  } catch {
    return "";
  }
}

function isPlanTool(name: unknown) {
  return typeof name === "string" && /createplan/i.test(name.replace(/[_-\s]/g, ""));
}

function asText(value: unknown) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function CodeBlock({ children, className }: { children?: ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const onCopy = useCallback(async () => {
    const text =
      preRef.current?.innerText ||
      (typeof children === "string" ? children : "") ||
      "";
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }, [children]);

  return (
    <div className="md-code">
      <button
        type="button"
        className="md-code-copy"
        title={copied ? "已复制" : "复制"}
        aria-label={copied ? "已复制" : "复制代码"}
        onClick={() => void onCopy()}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </button>
      <pre ref={preRef} className={className}>
        {children}
      </pre>
    </div>
  );
}

class MarkdownBlock extends Component<{ text: string; streaming?: boolean }, { error: boolean }> {
  state = { error: false };

  static getDerivedStateFromError() {
    return { error: true };
  }

  componentDidUpdate(prev: { text: string }) {
    if (prev.text !== this.props.text && this.state.error) this.setState({ error: false });
  }

  render() {
    const text = asText(this.props.text);
    if (this.state.error) return <pre>{text}</pre>;
    return (
      <Markdown
        remarkPlugins={this.props.streaming ? [] : [remarkGfm]}
        components={{
          pre: ({ children, className }) => <CodeBlock className={className}>{children}</CodeBlock>,
        }}
      >
        {text}
      </Markdown>
    );
  }
}

function planFromArgs(args: unknown) {
  if (typeof args === "string") return args.trim();
  if (!args || typeof args !== "object") return "";
  const o = args as Record<string, unknown>;
  for (const key of ["plan", "markdown", "content", "text"]) {
    if (typeof o[key] === "string" && o[key].trim()) return o[key].trim();
  }
  return "";
}

function parsePlanPreview(md: string) {
  const text = md.replace(/\r\n/g, "\n").trim();
  if (!text) return { title: "", excerpt: "" };
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length && /^(#{1,6}\s*)?(plan|计划)\s*$/i.test(lines[i].trim())) {
    i++;
    while (i < lines.length && !lines[i].trim()) i++;
  }
  const rawTitle = (lines[i] || "").replace(/^#{1,6}\s+/, "").replace(/^\*\*(.+)\*\*$/, "$1").trim();
  const title = rawTitle || "Plan";
  i++;
  while (i < lines.length && !lines[i].trim()) i++;
  const body: string[] = [];
  for (; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i]) && body.length) break;
    body.push(lines[i]);
    if (body.join("\n").length > 320) break;
  }
  return { title, excerpt: body.join("\n").trim() };
}

function latestPlanText(messages: ChatMessage[]) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tools = messages[i].tools || [];
    for (let j = tools.length - 1; j >= 0; j--) {
      if (!isPlanTool(tools[j].name) || tools[j].status === "running") continue;
      const plan = planFromArgs(tools[j].args);
      if (plan) return plan;
    }
  }
  return "";
}

function modEnterHint() {
  const mac =
    typeof window !== "undefined" &&
    (window.desktop?.platform === "darwin" || /mac/i.test(navigator.platform || ""));
  return mac ? "⌘↵" : "Ctrl+↵";
}

export function applyStreamEvent(prev: ChatMessage[], event: StreamEvent): ChatMessage[] {
  const last = prev[prev.length - 1];
  if (!last || last.role !== "assistant") return prev;
  if (event.type === "text-delta") {
    return [...prev.slice(0, -1), { ...last, text: last.text + asText(event.text) }];
  }
  if (event.type === "thinking-delta") {
    return [...prev.slice(0, -1), { ...last, thinking: (last.thinking || "") + asText(event.text) }];
  }
  if (event.type === "tool") {
    const tools = [...(last.tools || [])];
    const i = tools.findIndex((t) => t.callId === event.callId);
    const next: ToolEvent = {
      callId: event.callId || `tool-${tools.length}`,
      name: asText(event.name) || "tool",
      status: event.status || "running",
      args: event.args,
      result: event.result,
    };
    if (i >= 0) tools[i] = { ...tools[i], ...next };
    else tools.push(next);
    return [...prev.slice(0, -1), { ...last, tools }];
  }
  if (event.type === "done" || event.type === "error") {
    const extra = event.type === "done" ? asText(event.result) : asText(event.message);
    return [...prev.slice(0, -1), { ...last, streaming: false, text: last.text || extra }];
  }
  return prev;
}
