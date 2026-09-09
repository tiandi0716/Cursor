import { useCallback, useEffect, useRef, useState } from "react";
import {
  FilePlus,
  Files,
  FolderOpen,
  FolderPlus,
  FoldVertical,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  cancelChat,
  createConversation,
  deleteConversation,
  getConversation,
  getSettings,
  keepReviews,
  listConversations,
  listModels,
  listReviews,
  patchConversation,
  saveSettings,
  streamChat,
  undoReviews,
  rewindChat,
  watchWorkspace,
  type ChatMessage,
  type ConversationSummary,
  type FileReview,
  type ModelInfo,
  type Settings,
} from "./api";
import { FileTree, type FileTreeHandle } from "./components/FileTree";
import { EditorPane } from "./components/EditorPane";
import { ChatPanel, applyStreamEvent } from "./components/ChatPanel";
import { SettingsPage } from "./components/SettingsModal";
import { FolderPicker } from "./components/FolderPicker";
import { SearchPanel } from "./components/SearchPanel";
import { formatModelLabel } from "./components/ModelPicker";
import { ErrorBoundary } from "./components/ErrorBoundary";

type ChatSession = {
  key: string;
  convId?: string;
  title: string;
  messages: ChatMessage[];
  streaming: boolean;
  status: string;
  reviews: FileReview[];
};

function blankSession(): ChatSession {
  return {
    key: crypto.randomUUID(),
    title: "New Agent",
    messages: [],
    streaming: false,
    status: "",
    reviews: [],
  };
}

function displayTitle(title?: string) {
  return !title || title === "新对话" ? "New Agent" : title;
}

const REVIEW_TEXT_LIMIT = 400_000;

function clipReviewText(value: string | null | undefined) {
  if (value == null) return null;
  if (value.length <= REVIEW_TEXT_LIMIT) return value;
  return `${value.slice(0, REVIEW_TEXT_LIMIT)}\n\n…(内容过长，已截断)`;
}

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [sidebar, setSidebar] = useState<"files" | "search">("files");
  const [openPath, setOpenPath] = useState<string>();
  const [treeKey, setTreeKey] = useState(0);
  const treeRef = useRef<FileTreeHandle>(null);
  const [editorTick, setEditorTick] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [boot] = useState(() => {
    const s = blankSession();
    return { sessions: [s] as ChatSession[], key: s.key };
  });
  const [sessions, setSessions] = useState<ChatSession[]>(boot.sessions);
  const [activeKey, setActiveKey] = useState(boot.key);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewFocus, setReviewFocus] = useState<string>();
  const [chatW, setChatW] = useState(420);
  const abortsRef = useRef(new Map<string, AbortController>());
  const streamGenRef = useRef(new Map<string, number>());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const patchSession = useCallback((key: string, patch: Partial<ChatSession> | ((s: ChatSession) => ChatSession)) => {
    setSessions((list) =>
      list.map((s) => {
        if (s.key !== key) return s;
        return typeof patch === "function" ? patch(s) : { ...s, ...patch };
      }),
    );
  }, []);

  const active = sessions.find((s) => s.key === activeKey) || sessions[0];

  const refreshModels = useCallback(async () => {
    try {
      setModels(await listModels());
    } catch {
      setModels([]);
    }
  }, []);

  const refreshHist = useCallback(async () => {
    setHistory(await listConversations());
  }, []);

  useEffect(() => {
    setSessions((list) =>
      list.map((s) => {
        if (!s.convId) return s;
        const item = history.find((h) => h.id === s.convId);
        if (!item) return s;
        const title = displayTitle(item.title);
        return title === s.title ? s : { ...s, title };
      }),
    );
  }, [history]);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setSettings(s);
      if (!s.hasKey) setShowSettings(true);
      else await refreshModels();
      await refreshHist();
    })();
  }, [refreshHist, refreshModels]);

  useEffect(() => {
    let timer = 0;
    const stop = watchWorkspace(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setTreeKey((n) => n + 1);
        setEditorTick((n) => n + 1);
      }, 80);
    });
    return () => {
      window.clearTimeout(timer);
      stop();
    };
  }, []);

  useEffect(() => {
    const over = (e: globalThis.DragEvent) => {
      if (Array.from(e.dataTransfer?.types || []).includes("Files")) e.preventDefault();
    };
    const drop = (e: globalThis.DragEvent) => {
      if (Array.from(e.dataTransfer?.types || []).includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const pickFolder = useCallback(async () => {
    if (window.desktop?.openFolder) {
      const path = await window.desktop.openFolder();
      if (!path) return;
      const next = await saveSettings({ workspace: path });
      setSettings(next);
      setTreeKey((n) => n + 1);
      setOpenPath(undefined);
      return;
    }
    setShowPicker(true);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setShowSettings((v) => !v);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setShowSettings(false);
        setSidebar("search");
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setShowSettings(false);
        setSidebar("files");
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void pickFolder();
      }
      if (e.key === "F5" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r")) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    const offSettings = window.desktop?.onOpenSettings?.(() => setShowSettings(true));
    const offFolder = window.desktop?.onOpenFolder?.(() => void pickFolder());
    return () => {
      window.removeEventListener("keydown", onKey);
      offSettings?.();
      offFolder?.();
    };
  }, [pickFolder]);

  const ensureConv = async (key: string) => {
    const current = sessionsRef.current.find((s) => s.key === key);
    if (current?.convId) return current.convId;
    const c = await createConversation();
    patchSession(key, { convId: c.id, title: displayTitle(c.title) });
    await refreshHist();
    return c.id;
  };

  const stopSession = async (key: string) => {
    streamGenRef.current.set(key, (streamGenRef.current.get(key) || 0) + 1);
    abortsRef.current.get(key)?.abort();
    abortsRef.current.delete(key);
    const s = sessionsRef.current.find((x) => x.key === key);
    if (s?.convId) await cancelChat(s.convId);
    patchSession(key, { streaming: false, status: "" });
  };

  const loadConv = async (id: string) => {
    const existing = sessionsRef.current.find((s) => s.convId === id);
    if (existing) {
      setActiveKey(existing.key);
      return;
    }
    const c = await getConversation(id);
    const reviews = await listReviews(id).catch(() => [] as FileReview[]);
    const next: ChatSession = {
      key: crypto.randomUUID(),
      convId: c.id,
      title: displayTitle(c.title),
      messages: c.messages || [],
      streaming: false,
      status: "",
      reviews,
    };
    setSessions((list) => {
      const blank = list.find((s) => !s.convId && !s.messages.length && !s.streaming);
      if (blank && list.length === 1) return [next];
      return [...list, next];
    });
    setActiveKey(next.key);
  };

  const newChat = () => {
    const s = blankSession();
    setSessions((list) => [...list, s]);
    setActiveKey(s.key);
  };

  const closeTab = (key: string) => {
    const list = sessionsRef.current;
    const s = list.find((x) => x.key === key);
    if (s?.streaming) void stopSession(key);
    const remaining = list.filter((x) => x.key !== key);
    if (!remaining.length) {
      const blank = blankSession();
      setSessions([blank]);
      setActiveKey(blank.key);
      return;
    }
    setSessions(remaining);
    if (activeKey === key) {
      const i = list.findIndex((x) => x.key === key);
      setActiveKey((remaining[i] || remaining[i - 1] || remaining[0]).key);
    }
  };

  const removeChat = async (id: string) => {
    const item = history.find((h) => h.id === id);
    const label = displayTitle(item?.title);
    if (!window.confirm(`确定删除对话「${label}」？`)) return;
    const open = sessionsRef.current.find((s) => s.convId === id);
    if (open) {
      abortsRef.current.get(open.key)?.abort();
      abortsRef.current.delete(open.key);
      await cancelChat(id);
    }
    await deleteConversation(id);
    const list = sessionsRef.current.filter((s) => s.convId !== id);
    if (!list.length) {
      const blank = blankSession();
      setSessions([blank]);
      setActiveKey(blank.key);
    } else {
      setSessions(list);
      if (open && activeKey === open.key) setActiveKey(list[0].key);
    }
    await refreshHist();
  };

  const renameChat = async (id: string, title: string) => {
    const next = await patchConversation(id, { title });
    setHistory((list) => list.map((h) => (h.id === id ? { ...h, ...next } : h)));
    setSessions((list) =>
      list.map((s) => (s.convId === id ? { ...s, title: displayTitle(next.title) } : s)),
    );
  };

  const send = async (text: string, draft?: string) => {
    const key = activeKey;
    const current = sessionsRef.current.find((s) => s.key === key);
    if (!current || current.streaming) return;
    const user: ChatMessage = { id: crypto.randomUUID(), role: "user", text, draft: draft || text };
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      text: "",
      thinking: "",
      tools: [],
      streaming: true,
    };
    patchSession(key, (s) => ({
      ...s,
      messages: [...s.messages, user, assistant],
      streaming: true,
      status: "连接中…",
    }));
    const gen = (streamGenRef.current.get(key) || 0) + 1;
    streamGenRef.current.set(key, gen);
    let id: string;
    try {
      id = await ensureConv(key);
    } catch (e) {
      patchSession(key, (s) => ({
        ...s,
        streaming: false,
        status: "",
        messages: applyStreamEvent(s.messages, {
          type: "error",
          message: e instanceof Error ? e.message : String(e),
        }),
      }));
      return;
    }
    const ac = new AbortController();
    abortsRef.current.set(key, ac);
    try {
      await streamChat(
        id,
        text,
        (event) => {
          if (streamGenRef.current.get(key) !== gen) return;
          if (event.type === "status") patchSession(key, { status: event.message || "" });
          if (event.type === "file-change") {
            if (!event.path) return;
            patchSession(key, (s) => {
              const item: FileReview = {
                path: event.path,
                before: clipReviewText(event.before),
                after: clipReviewText(event.after),
                added: Number(event.added) || 0,
                removed: Number(event.removed) || 0,
                status: "pending",
              };
              const reviews = [...(s.reviews || [])];
              const i = reviews.findIndex((r) => r.path === event.path);
              if (i >= 0) reviews[i] = item;
              else reviews.push(item);
              return { ...s, reviews };
            });
            setTreeKey((n) => n + 1);
            setEditorTick((n) => n + 1);
            return;
          }
          patchSession(key, (s) => ({ ...s, messages: applyStreamEvent(s.messages, event) }));
          if (event.type === "tool" && event.status === "completed") {
            setTreeKey((n) => n + 1);
            setEditorTick((n) => n + 1);
          }
          if (event.type === "done" || event.type === "error") {
            patchSession(key, { streaming: false, status: "" });
            setTreeKey((n) => n + 1);
            setEditorTick((n) => n + 1);
            void refreshHist();
            void listReviews(id).then((reviews) => {
              if (streamGenRef.current.get(key) !== gen) return;
              patchSession(key, { reviews });
              setTreeKey((n) => n + 1);
              setEditorTick((n) => n + 1);
            });
          }
        },
        ac.signal,
        { draft: draft || text, messageId: user.id },
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError" && streamGenRef.current.get(key) === gen) {
        patchSession(key, (s) => ({
          ...s,
          messages: applyStreamEvent(s.messages, {
            type: "error",
            message: e instanceof Error ? e.message : String(e),
          }),
        }));
      }
    } finally {
      if (streamGenRef.current.get(key) === gen) patchSession(key, { streaming: false });
      abortsRef.current.delete(key);
    }
  };

  const stop = async () => {
    if (active) await stopSession(active.key);
  };

  const rewindTo = async (messageId: string, keepSelf = false) => {
    const key = activeKey;
    await stopSession(key);
    const current = sessionsRef.current.find((x) => x.key === key);
    if (!current) return;
    const idx = current.messages.findIndex((m) => m.id === messageId);
    if (idx < 0) return;
    const nextMessages = current.messages.slice(0, keepSelf ? idx + 1 : idx);
    patchSession(key, { messages: nextMessages, streaming: false, status: "" });
    if (!current.convId) return;
    try {
      const { reviews } = await rewindChat(current.convId, nextMessages, !keepSelf);
      patchSession(key, { reviews });
      setTreeKey((n) => n + 1);
      setEditorTick((n) => n + 1);
      if (!reviews.some((r) => r.status === "pending")) setReviewOpen(false);
    } catch (e) {
      console.error(e);
    }
  };

  const resendFrom = async (messageId: string, text: string, draft?: string) => {
    await rewindTo(messageId, false);
    await send(text, draft);
  };

  const applyReview = async (kind: "keep" | "undo", path?: string) => {
    const s = sessionsRef.current.find((x) => x.key === activeKey);
    if (!s?.convId) return;
    const reviews = kind === "keep" ? await keepReviews(s.convId, path) : await undoReviews(s.convId, path);
    patchSession(s.key, { reviews });
    setTreeKey((n) => n + 1);
    setEditorTick((n) => n + 1);
  };

  const buildPlan = async (plan: string) => {
    const text = plan.trim();
    if (!text) return;
    const current = sessionsRef.current.find((s) => s.key === activeKey);
    if (current?.streaming) return;
    const next = await saveSettings({ mode: "agent" });
    setSettings(next);
    await send(`请按以下已确认的计划开始实施，直接改代码，不要再只做规划。\n\n${text}`);
  };

  if (!settings) return <div className="welcome">正在加载…</div>;

  const workspaceName = settings.workspace.split(/[/\\]/).filter(Boolean).at(-1) || settings.workspace;

  return (
    <div className="app" style={{ ["--chat-w" as string]: `${chatW}px` }}>
      <header className="titlebar">
        <div className="brand">{workspaceName}</div>
        <span className="spacer" />
        {typeof window !== "undefined" && window.desktop?.platform === "win32" ? (
          <div className="win-controls">
            <button type="button" title="最小化" onClick={() => window.desktop?.minimize()}>
              ─
            </button>
            <button type="button" title="最大化" onClick={() => window.desktop?.maximize()}>
              ☐
            </button>
            <button type="button" className="win-close" title="关闭" onClick={() => window.desktop?.close()}>
              ×
            </button>
          </div>
        ) : null}
      </header>

      <div className="workspace">
        <nav className="activity">
          <button className={sidebar === "search" && !showSettings ? "active" : ""} title="搜索" onClick={() => { setShowSettings(false); setSidebar("search"); }}>
            <Search size={18} />
          </button>
          <button className={sidebar === "files" && !showSettings ? "active" : ""} title="资源管理器" onClick={() => { setShowSettings(false); setSidebar("files"); }}>
            <Files size={18} />
          </button>
          <span className="spacer" />
          <button title="打开文件夹" onClick={() => void pickFolder()}>
            <FolderOpen size={18} />
          </button>
          <button className={showSettings ? "active" : ""} title="设置" onClick={() => setShowSettings(true)}>
            <SettingsIcon size={18} />
          </button>
        </nav>

        <aside className="sidebar">
          <div className={`sidebar-view ${sidebar === "files" ? "" : "is-hidden"}`}>
            <div className="side-head">
              <span className="side-title" title={settings.workspace}>{workspaceName}</span>
              <div className="side-actions">
                <button className="icon-btn" title="新建文件" onClick={() => treeRef.current?.newFile()}>
                  <FilePlus size={14} />
                </button>
                <button className="icon-btn" title="新建文件夹" onClick={() => treeRef.current?.newFolder()}>
                  <FolderPlus size={14} />
                </button>
                <button className="icon-btn" title="刷新" onClick={() => setTreeKey((n) => n + 1)}>
                  <RefreshCw size={14} />
                </button>
                <button className="icon-btn" title="全部折叠" onClick={() => treeRef.current?.collapseAll()}>
                  <FoldVertical size={14} />
                </button>
              </div>
            </div>
            <FileTree
              ref={treeRef}
              activePath={openPath}
              onOpen={setOpenPath}
              refreshKey={treeKey}
              onChanged={() => setTreeKey((n) => n + 1)}
              onPathGone={(path) => {
                setOpenPath((cur) => {
                  if (!cur) return cur;
                  if (cur === path || cur.startsWith(`${path}/`)) return undefined;
                  return cur;
                });
              }}
              onRenamed={(from, to, isDir) => {
                setOpenPath((cur) => {
                  if (!cur) return cur;
                  if (cur === from) return to;
                  if (isDir && cur.startsWith(`${from}/`)) return `${to}${cur.slice(from.length)}`;
                  return cur;
                });
                setEditorTick((n) => n + 1);
              }}
            />
          </div>
          <div className={`sidebar-view ${sidebar === "search" ? "" : "is-hidden"}`}>
            <SearchPanel onOpen={setOpenPath} active={sidebar === "search"} />
          </div>
        </aside>

        <ErrorBoundary
          fallback={
            <div className="editor-wrap">
              <div className="welcome">
                <h1>编辑器出错了</h1>
                <p>关闭 Review 或重新打开文件后再试。</p>
              </div>
            </div>
          }
        >
        <EditorPane
          openPath={openPath}
          reloadToken={editorTick}
          reviewOpen={reviewOpen}
          reviews={active?.reviews || []}
          focusPath={reviewFocus}
          onCloseReview={() => setReviewOpen(false)}
          onKeep={(path) => void applyReview("keep", path)}
          onUndo={(path) => void applyReview("undo", path)}
        />
        </ErrorBoundary>

        <div
          className="resize"
          onMouseDown={(e) => {
            const startX = e.clientX;
            const startW = chatW;
            const move = (ev: MouseEvent) => {
              setChatW(Math.min(640, Math.max(320, startW - (ev.clientX - startX))));
            };
            const up = () => {
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
            };
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }}
        />

        <ErrorBoundary
          key={active?.key}
          fallback={(err, reset) => (
            <aside className="chat crash-inline">
              <p>聊天区出错了。</p>
              <pre>{err.message}</pre>
              <button type="button" className="btn primary" onClick={reset}>
                重试
              </button>
            </aside>
          )}
        >
        <ChatPanel
          messages={active?.messages || []}
          models={models}
          model={settings.model}
          modelParams={settings.modelParams || []}
          mode={settings.mode}
          streaming={Boolean(active?.streaming)}
          status={active?.status}
          disabled={!settings.hasKey}
          title={active?.title || "New Agent"}
          history={history}
          activeId={active?.convId}
          tabs={sessions.map((s) => ({
            key: s.key,
            title: s.title,
            streaming: s.streaming,
            draft: !s.convId,
          }))}
          activeKey={active?.key || ""}
          reviews={active?.reviews || []}
          onSelectTab={setActiveKey}
          onCloseTab={closeTab}
          onKeep={(path) => void applyReview("keep", path)}
          onUndo={(path) => void applyReview("undo", path)}
          onOpenReview={(path) => {
            if (path) setReviewFocus(path);
            setReviewOpen(true);
          }}
          onModelConfig={async (id, modelParams) => {
            const next = await saveSettings({ model: id, modelParams });
            setSettings(next);
          }}
          onMode={async (mode) => {
            const next = await saveSettings({ mode });
            setSettings(next);
          }}
          onSend={(t, draft) => void send(t, draft)}
          onStop={() => void stop()}
          onNew={() => newChat()}
          onSelect={(id) => void loadConv(id)}
          onDelete={(id) => void removeChat(id)}
          onRename={renameChat}
          onBuildPlan={(plan) => void buildPlan(plan)}
          onResend={(id, t, draft) => void resendFrom(id, t, draft)}
        />
        </ErrorBoundary>
      </div>

      <footer className="status">
        {settings.hasKey ? <span className="dot-ok" /> : <span className="dot-off" />}
        <span>{settings.hasKey ? `API Key ${settings.keyHint}` : "未配置 API Key"}</span>
        <span>{formatModelLabel(models, settings.model, settings.modelParams || [])}</span>
        <span>{settings.mode === "plan" ? "Plan 模式" : "Agent 模式"}</span>
      </footer>

      {showSettings ? (
        <SettingsPage
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSaved={(s) => {
            setSettings(s);
            void refreshModels();
          }}
        />
      ) : null}

      {showPicker ? (
        <FolderPicker
          initial={settings.workspace}
          onClose={() => setShowPicker(false)}
          onPick={async (path) => {
            const next = await saveSettings({ workspace: path });
            setSettings(next);
            setShowPicker(false);
            setTreeKey((n) => n + 1);
            setOpenPath(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
