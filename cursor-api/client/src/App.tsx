import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  FilePlus,
  Files,
  FolderOpen,
  FolderPlus,
  FoldVertical,
  GitBranch,
  RefreshCw,
  PanelLeft,
  PanelRight,
  Search,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  cancelChat,
  createConversation,
  deleteConversation,
  getConversation,
  getGitInfo,
  getOpenTabs,
  getSettings,
  keepReviews,
  listConversations,
  listModelsWithSources,
  type CcSourceSummary,
  listReviews,
  patchConversation,
  saveOpenTabs,
  saveSettings,
  streamChat,
  undoReviews,
  rewindChat,
  watchWorkspace,
  type ChatAttachment,
  type ChatMessage,
  type ConversationSummary,
  type FileReview,
  type GitInfo,
  type ModelInfo,
  type Settings,
} from "./api";
import { FileTree, type FileTreeHandle } from "./components/FileTree";
import { EditorPane, type EmptyAction } from "./components/EditorPane";
import { QuickOpen } from "./components/QuickOpen";
import { ChatPanel, applyStreamEvent } from "./components/ChatPanel";
import { SettingsPage } from "./components/SettingsModal";
import { FolderPicker } from "./components/FolderPicker";
import { SearchPanel } from "./components/SearchPanel";
import { formatModelLabel } from "./components/ModelPicker";
import { ErrorBoundary } from "./components/ErrorBoundary";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";
const DRAFT_PREFIX = "__untitled__/";

/** 布局：一侧变大可挤另一侧，两侧与编辑器各自保底 */
const ACTIVITY_W = 0; // 活动栏已改为侧栏顶部的横向图标行（和 Cursor 一致）
const RESIZE_GUTTERS = 6; // 两条 3px 分隔条
const SIDEBAR_MIN = 210;
const CHAT_MIN = 240;
const EDITOR_MIN = 280;

function workspaceInnerWidth(el: HTMLElement | null) {
  const total = el?.clientWidth || window.innerWidth || 1200;
  return Math.max(0, total - ACTIVITY_W - RESIZE_GUTTERS);
}

/** 拖左侧：目标侧栏宽；不够时先压聊天到下限，再卡死侧栏 */
function fitSidebarDrag(desiredSide: number, otherChat: number, budget: number) {
  let side = Math.max(SIDEBAR_MIN, desiredSide);
  let chat = Math.max(CHAT_MIN, otherChat);
  const overflow = side + chat + EDITOR_MIN - budget;
  if (overflow > 0) {
    const shrinkChat = Math.min(overflow, chat - CHAT_MIN);
    chat -= shrinkChat;
    const still = side + chat + EDITOR_MIN - budget;
    if (still > 0) side = Math.max(SIDEBAR_MIN, side - still);
  }
  return { side, chat };
}

/** 拖右侧：目标聊天宽；不够时先压侧栏到下限，再卡死聊天 */
function fitChatDrag(desiredChat: number, otherSide: number, budget: number) {
  let chat = Math.max(CHAT_MIN, desiredChat);
  let side = Math.max(SIDEBAR_MIN, otherSide);
  const overflow = side + chat + EDITOR_MIN - budget;
  if (overflow > 0) {
    const shrinkSide = Math.min(overflow, side - SIDEBAR_MIN);
    side -= shrinkSide;
    const still = side + chat + EDITOR_MIN - budget;
    if (still > 0) chat = Math.max(CHAT_MIN, chat - still);
  }
  return { side, chat };
}

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

/** 打开标签快照写入 ~/.cursor-ui/open-tabs.json（经服务端），不绑端口 origin */
function snapshotOpenTabs(sessions: ChatSession[], activeKey: string) {
  const convIds = sessions.map((s) => s.convId).filter((id): id is string => Boolean(id));
  const active = sessions.find((s) => s.key === activeKey)?.convId;
  return {
    convIds,
    activeConvId: active && convIds.includes(active) ? active : convIds[0],
  };
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
  const [ccSources, setCcSources] = useState<CcSourceSummary[]>([]);
  const [sidebar, setSidebar] = useState<"files" | "search">("files");
  const [openPath, setOpenPath] = useState<string>();
  const [treeKey, setTreeKey] = useState(0);
  const treeRef = useRef<FileTreeHandle>(null);
  const [editorTick, setEditorTick] = useState(0);
  /** Undo 后强制从磁盘覆盖这些路径的标签缓冲 */
  const [forceReloadPaths, setForceReloadPaths] = useState<string[]>([]);
  const clearForceReloadPaths = useCallback(() => setForceReloadPaths([]), []);
  const [showSettings, setShowSettings] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [history, setHistory] = useState<ConversationSummary[]>([]);
  const [boot] = useState(() => {
    const s = blankSession();
    return { sessions: [s] as ChatSession[], key: s.key };
  });
  const [sessions, setSessions] = useState<ChatSession[]>(boot.sessions);
  const [activeKey, setActiveKey] = useState(boot.key);
  const [tabsReady, setTabsReady] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewFocus, setReviewFocus] = useState<string>();
  const [sidebarW, setSidebarW] = useState(220);
  const [chatW, setChatW] = useState(380);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem("ui.sidebarOpen") !== "0");
  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem("ui.chatOpen") !== "0");
  useEffect(() => {
    localStorage.setItem("ui.sidebarOpen", sidebarOpen ? "1" : "0");
  }, [sidebarOpen]);
  useEffect(() => {
    localStorage.setItem("ui.chatOpen", chatOpen ? "1" : "0");
  }, [chatOpen]);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [quickOpenVisible, setQuickOpenVisible] = useState(false);
  const [composerFocusTick, setComposerFocusTick] = useState(0);
  const [git, setGit] = useState<GitInfo>(null);

  const openFile = useCallback((path: string) => {
    // 关掉标签后再打开同一文件时 openPath 不变，需 bump tick 才能重开
    setOpenPath(path);
    setEditorTick((n) => n + 1);
  }, []);

  // 前进 / 后退：记录编辑器里依次激活过的文件（与 Cursor 标题栏的 ← → 一致）
  const navRef = useRef({ stack: [] as string[], index: -1 });
  const [nav, setNav] = useState({ back: false, fwd: false });
  const syncNav = useCallback(() => {
    const n = navRef.current;
    setNav({ back: n.index > 0, fwd: n.index < n.stack.length - 1 });
  }, []);
  const recordActive = useCallback(
    (path?: string) => {
      if (!path || path.startsWith(DRAFT_PREFIX)) return;
      const n = navRef.current;
      if (n.stack[n.index] === path) return;
      n.stack = [...n.stack.slice(0, n.index + 1), path].slice(-50);
      n.index = n.stack.length - 1;
      syncNav();
    },
    [syncNav],
  );
  const goNav = useCallback(
    (delta: -1 | 1) => {
      const n = navRef.current;
      const i = n.index + delta;
      if (i < 0 || i >= n.stack.length) return;
      n.index = i;
      syncNav();
      openFile(n.stack[i]);
    },
    [openFile, syncNav],
  );

  const focusChat = useCallback(() => {
    setChatOpen(true);
    setComposerFocusTick((n) => n + 1);
  }, []);

  // ⌘B 切换侧栏，⌘⌥B 切换 Agent 面板，⌘P 转到文件，⌘L 聚焦聊天，⌃- / ⌃⇧- 后退前进（与 Cursor 一致）
  // 用捕获阶段，避免焦点在 Monaco 里时快捷键被编辑器吃掉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // mac 上 ⌃B / ⌃P 等是输入框的 Emacs 光标键，只认 ⌘
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (mod && e.code === "KeyB") {
        e.preventDefault();
        if (e.altKey) setChatOpen((v) => !v);
        else setSidebarOpen((v) => !v);
        return;
      }
      if (mod && !e.shiftKey && !e.altKey && e.code === "KeyP") {
        e.preventDefault();
        e.stopPropagation();
        setQuickOpenVisible(true);
        return;
      }
      if (mod && !e.altKey && e.code === "KeyL") {
        e.preventDefault();
        e.stopPropagation();
        focusChat();
        return;
      }
      const back = IS_MAC
        ? e.ctrlKey && !e.metaKey && !e.altKey && e.code === "Minus"
        : e.altKey && !mod && (e.key === "ArrowLeft" || e.key === "ArrowRight");
      if (back) {
        e.preventDefault();
        goNav(IS_MAC ? (e.shiftKey ? 1 : -1) : e.key === "ArrowRight" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [focusChat, goNav]);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef({ side: 220, chat: 380 });
  layoutRef.current = { side: sidebarW, chat: chatW };
  const abortsRef = useRef(new Map<string, AbortController>());
  const streamGenRef = useRef(new Map<string, number>());
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;

  // 窗口变窄时同步压缩，避免固定宽把布局撑破
  useEffect(() => {
    const clamp = () => {
      const budget = workspaceInnerWidth(workspaceRef.current);
      const { side, chat } = layoutRef.current;
      if (side + chat + EDITOR_MIN <= budget) return;
      const next = fitSidebarDrag(side, chat, budget);
      if (next.side !== side) setSidebarW(next.side);
      if (next.chat !== chat) setChatW(next.chat);
    };
    window.addEventListener("resize", clamp);
    clamp();
    return () => window.removeEventListener("resize", clamp);
  }, []);

  const patchSession = useCallback((key: string, patch: Partial<ChatSession> | ((s: ChatSession) => ChatSession)) => {
    setSessions((list) =>
      list.map((s) => {
        if (s.key !== key) return s;
        return typeof patch === "function" ? patch(s) : { ...s, ...patch };
      }),
    );
  }, []);

  const active = sessions.find((s) => s.key === activeKey) || sessions[0];

  const refreshModels = useCallback(async (refresh = false) => {
    try {
      const r = await listModelsWithSources(refresh);
      setModels(r.models);
      setCcSources(r.sources);
    } catch {
      setModels([]);
      setCcSources([]);
    }
  }, []);

  // CC Switch：当前选中的模型不在列表里（旧的纯模型名 / 供应商被删），自动换成可用的
  useEffect(() => {
    if (!settings || settings.aiSource !== "ccswitch" || !models.length) return;
    if (models.some((m) => m.id === settings.model)) return;
    const pick =
      models.find((m) => m.bare === settings.model) ||
      models.find((m) => /sonnet/i.test(m.bare || "")) ||
      models[0];
    if (!pick) return;
    void saveSettings({ model: pick.id, modelParams: pick.defaultParams || [] })
      .then(setSettings)
      .catch(() => {});
  }, [models, settings]);

  // CC Switch 里增删/切换供应商后，状态提示会变，顺带刷新模型目录
  const ccHint = settings?.ccswitchStatus?.providerHint;
  useEffect(() => {
    if (settings?.aiSource !== "ccswitch") return;
    void refreshModels(true);
  }, [ccHint, settings?.aiSource, refreshModels]);

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

  // CC Switch 切换供应商后 DB 立刻更新；轮询设置把状态栏/设置页的「当前激活」跟上
  useEffect(() => {
    if (settings?.aiSource !== "ccswitch") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await getSettings();
        if (cancelled) return;
        setSettings((prev) => {
          if (!prev || prev.aiSource !== "ccswitch") return prev;
          const a = prev.ccswitchStatus;
          const b = s.ccswitchStatus;
          if (
            a?.connected === b?.connected &&
            a?.providerHint === b?.providerHint &&
            a?.baseUrl === b?.baseUrl &&
            a?.error === b?.error &&
            prev.canChat === s.canChat
          ) {
            return prev;
          }
          return { ...prev, canChat: s.canChat, ccswitchStatus: b };
        });
      } catch {
        /* ignore transient */
      }
    };
    const id = window.setInterval(() => void tick(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [settings?.aiSource]);

  useEffect(() => {
    void (async () => {
      const s = await getSettings();
      setSettings(s);
      const ready =
        s.canChat ??
        (s.aiSource === "ccswitch" ? Boolean(s.ccswitchStatus?.connected) : s.hasKey);
      if (!ready) setShowSettings(true);
      else await refreshModels();
      await refreshHist();

      // 还原上次打开的对话标签（内容 sessions.json，标签列表 open-tabs.json）
      let snap: { convIds: string[]; activeConvId?: string } = { convIds: [] };
      try {
        snap = await getOpenTabs();
      } catch {
        snap = { convIds: [] };
      }
      const ids = snap.convIds || [];
      if (!ids.length) {
        setTabsReady(true);
        return;
      }
      const restored: ChatSession[] = [];
      for (const id of ids) {
        try {
          const c = await getConversation(id);
          const reviews = await listReviews(id).catch(() => [] as FileReview[]);
          restored.push({
            key: crypto.randomUUID(),
            convId: c.id,
            title: displayTitle(c.title),
            messages: c.messages || [],
            streaming: false,
            status: "",
            reviews,
          });
        } catch {
          /* 对话已删则跳过 */
        }
      }
      if (restored.length) {
        const activeId = snap.activeConvId;
        const active =
          restored.find((x) => x.convId === activeId) || restored[restored.length - 1];
        setSessions(restored);
        setActiveKey(active.key);
      }
      setTabsReady(true);
    })();
  }, [refreshHist, refreshModels]);

  // 有真实对话 id 的标签变化时写入磁盘，下次启动还原（不依赖 localStorage）
  useEffect(() => {
    if (!tabsReady) return;
    const snap = snapshotOpenTabs(sessions, activeKey);
    const t = window.setTimeout(() => {
      void saveOpenTabs(snap).catch(() => {});
    }, 200);
    return () => window.clearTimeout(t);
  }, [sessions, activeKey, tabsReady]);

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

  // 状态栏的 git 分支：切换工作区、窗口重新获得焦点时刷新，并定时轮询
  const workspacePath = settings?.workspace;
  useEffect(() => {
    if (!workspacePath) return;
    navRef.current = { stack: [], index: -1 };
    syncNav();
    let alive = true;
    const refresh = () => {
      void getGitInfo().then((g) => {
        if (alive) setGit(g);
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [workspacePath, syncNav]);

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

  const send = async (text: string, draft?: string, attachments?: ChatAttachment[]) => {
    const key = activeKey;
    const current = sessionsRef.current.find((s) => s.key === key);
    if (!current || current.streaming) return;
    const files = (attachments || []).filter((f) => f?.path);
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      draft: draft || text,
      attachments: files.length ? files : undefined,
    };
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
            // 只刷新文件树；不自动打开/刷新编辑器，等用户点 Review 再预览
            setTreeKey((n) => n + 1);
            return;
          }
          patchSession(key, (s) => ({ ...s, messages: applyStreamEvent(s.messages, event) }));
          if (event.type === "tool" && event.status === "completed") {
            setTreeKey((n) => n + 1);
          }
          if (event.type === "done" || event.type === "error") {
            patchSession(key, { streaming: false, status: "" });
            setTreeKey((n) => n + 1);
            void refreshHist();
            void listReviews(id).then((reviews) => {
              if (streamGenRef.current.get(key) !== gen) return;
              patchSession(key, { reviews });
              setTreeKey((n) => n + 1);
            });
          }
        },
        ac.signal,
        { draft: draft || text, messageId: user.id, attachments: files.length ? files : undefined },
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
      if (streamGenRef.current.get(key) === gen) {
        // 流异常中断时也收尾 running 工具，避免卡片一直转圈
        patchSession(key, (s) => {
          const messages = s.messages.map((m, idx, arr) => {
            if (idx !== arr.length - 1 || m.role !== "assistant" || !m.tools?.length) return m;
            if (!m.tools.some((t) => t.status === "running")) return { ...m, streaming: false };
            return {
              ...m,
              streaming: false,
              tools: m.tools.map((t) => (t.status === "running" ? { ...t, status: "completed" } : t)),
            };
          });
          return { ...s, streaming: false, status: "", messages };
        });
      }
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

  const resendFrom = async (messageId: string, text: string, draft?: string, attachments?: ChatAttachment[]) => {
    await rewindTo(messageId, false);
    await send(text, draft, attachments);
  };

  const applyReview = async (kind: "keep" | "undo", path?: string) => {
    const s = sessionsRef.current.find((x) => x.key === activeKey);
    if (!s?.convId) return;
    try {
      const targets =
        kind === "undo"
          ? path
            ? [path]
            : (s.reviews || []).filter((r) => r.status !== "undone").map((r) => r.path)
          : [];
      const reviews = kind === "keep" ? await keepReviews(s.convId, path) : await undoReviews(s.convId, path);
      patchSession(s.key, { reviews });
      setTreeKey((n) => n + 1);
      // Undo 必须强制从磁盘重载标签内容（覆盖编辑器缓冲），否则界面仍显示 Agent 改后的内容
      if (kind === "undo" && targets.length) {
        setForceReloadPaths(targets);
        if (path) setOpenPath(path);
        else if (targets[0]) setOpenPath(targets[0]);
      }
      setEditorTick((n) => n + 1);
    } catch (e) {
      console.error(e);
      window.alert(e instanceof Error ? e.message : String(e));
    }
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

  const canChat =
    settings.canChat ??
    (settings.aiSource === "ccswitch"
      ? Boolean(settings.ccswitchStatus?.connected)
      : settings.hasKey);
  const selectedModel = models.find((m) => m.id === settings.model);
  const sourceLabel =
    settings.aiSource === "ccswitch"
      ? settings.ccswitchStatus?.connected
        ? `CC Switch · ${
            selectedModel?.provider
              ? `${selectedModel.group} · ${selectedModel.provider}`
              : settings.ccswitchStatus.providerHint || "已连接"
          }`
        : "CC Switch · 未连接"
      : settings.hasKey
        ? `API Key ${settings.keyHint}`
        : "未配置 API Key";
  const workspaceName = settings.workspace.split(/[/\\]/).filter(Boolean).at(-1) || settings.workspace;
  const emptyActions: EmptyAction[] = [
    { label: "打开聊天", keys: [MOD_KEY, "L"], run: focusChat },
    { label: "转到文件", keys: [MOD_KEY, "P"], run: () => setQuickOpenVisible(true) },
    { id: "untitled", label: "新建文件", keys: [MOD_KEY, "N"] },
    { label: "打开文件夹", keys: [MOD_KEY, "O"], run: () => void pickFolder() },
    { label: "切换侧边栏", keys: [MOD_KEY, "B"], run: () => setSidebarOpen((v) => !v) },
    { label: "打开设置", keys: [MOD_KEY, ","], run: () => setShowSettings(true) },
  ];

  return (
    <div
      className="app"
      style={{
        ["--sidebar-w" as string]: `${sidebarOpen ? sidebarW : 0}px`,
        ["--chat-w" as string]: `${chatOpen ? chatW : 0}px`,
        ["--rs-side" as string]: sidebarOpen ? "3px" : "0px",
        ["--rs-chat" as string]: chatOpen ? "3px" : "0px",
      }}
    >
      <header className="titlebar">
        <div className="tb-group">
          <button
            type="button"
            className={`tb-btn ${sidebarOpen ? "on" : ""}`}
            title="切换侧边栏 (⌘B)"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <PanelLeft size={16} />
          </button>
          <button
            type="button"
            className="tb-btn nav"
            title={IS_MAC ? "后退 (⌃-)" : "后退 (Alt+←)"}
            disabled={!nav.back}
            onClick={() => goNav(-1)}
          >
            <ArrowLeft size={15} />
          </button>
          <button
            type="button"
            className="tb-btn nav"
            title={IS_MAC ? "前进 (⌃⇧-)" : "前进 (Alt+→)"}
            disabled={!nav.fwd}
            onClick={() => goNav(1)}
          >
            <ArrowRight size={15} />
          </button>
        </div>
        <div className="tb-title" title={settings.workspace}>
          {workspaceName}
        </div>
        <span className="spacer" />
        <div className="tb-group">
          <button
            type="button"
            className={`tb-btn ${showSettings ? "on" : ""}`}
            title="设置"
            onClick={() => setShowSettings((v) => !v)}
          >
            <SettingsIcon size={16} />
          </button>
          <button
            type="button"
            className={`tb-btn ${chatOpen ? "on" : ""}`}
            title="切换 Agent 面板 (⌘⌥B)"
            onClick={() => setChatOpen((v) => !v)}
          >
            <PanelRight size={16} />
          </button>
        </div>
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

      <div
        className={`workspace ${sidebarOpen ? "" : "no-sidebar"} ${chatOpen ? "" : "no-chat"}`}
        ref={workspaceRef}
      >
        <aside className="sidebar">
          <nav className="side-tabs">
            <button
              type="button"
              className={sidebar === "files" && !showSettings ? "active" : ""}
              title="资源管理器"
              onClick={() => {
                setShowSettings(false);
                setSidebar("files");
              }}
            >
              <Files size={16} />
            </button>
            <button
              type="button"
              className={sidebar === "search" && !showSettings ? "active" : ""}
              title="搜索"
              onClick={() => {
                setShowSettings(false);
                setSidebar("search");
              }}
            >
              <Search size={16} />
            </button>
          </nav>
          <div className={`sidebar-view ${sidebar === "files" ? "" : "is-hidden"}`}>
            <div
              className="side-head section"
              title={settings.workspace}
              onClick={() => setExplorerOpen((v) => !v)}
            >
              <span className="side-title">
                {explorerOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {workspaceName}
              </span>
              <div className="side-actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="icon-btn"
                  title="新建文件"
                  onClick={() => {
                    setExplorerOpen(true);
                    treeRef.current?.newFile();
                  }}
                >
                  <FilePlus size={14} />
                </button>
                <button
                  className="icon-btn"
                  title="新建文件夹"
                  onClick={() => {
                    setExplorerOpen(true);
                    treeRef.current?.newFolder();
                  }}
                >
                  <FolderPlus size={14} />
                </button>
                <button className="icon-btn" title="刷新" onClick={() => setTreeKey((n) => n + 1)}>
                  <RefreshCw size={14} />
                </button>
                <button className="icon-btn" title="全部折叠" onClick={() => treeRef.current?.collapseAll()}>
                  <FoldVertical size={14} />
                </button>
                <button className="icon-btn" title={`打开文件夹 (${MOD_KEY}O)`} onClick={() => void pickFolder()}>
                  <FolderOpen size={14} />
                </button>
              </div>
            </div>
            <div style={{ display: explorerOpen ? "contents" : "none" }}>
            <FileTree
              ref={treeRef}
              activePath={openPath}
              onOpen={openFile}
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
          </div>
          <div className={`sidebar-view ${sidebar === "search" ? "" : "is-hidden"}`}>
            <SearchPanel onOpen={openFile} active={sidebar === "search"} />
          </div>
        </aside>

        <div
          className="resize resize-side"
          title="拖动调整侧栏宽度"
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startSide = layoutRef.current.side;
            // 本次拖拽中对侧只能被压缩，不会跟回来
            let pinnedChat = layoutRef.current.chat;
            const move = (ev: MouseEvent) => {
              const budget = workspaceInnerWidth(workspaceRef.current);
              const desired = startSide + (ev.clientX - startX);
              const next = fitSidebarDrag(desired, pinnedChat, budget);
              pinnedChat = Math.min(pinnedChat, next.chat);
              setSidebarW(next.side);
              setChatW(pinnedChat);
            };
            const up = () => {
              document.body.classList.remove("is-resizing");
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
            };
            document.body.classList.add("is-resizing");
            window.addEventListener("mousemove", move);
            window.addEventListener("mouseup", up);
          }}
        />

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
          forceReloadPaths={forceReloadPaths}
          onForceReloaded={clearForceReloadPaths}
          reviewOpen={reviewOpen}
          reviews={active?.reviews || []}
          focusPath={reviewFocus}
          onCloseReview={() => setReviewOpen(false)}
          onKeep={(path) => void applyReview("keep", path)}
          onUndo={(path) => void applyReview("undo", path)}
          onDraftSaved={(path) => {
            setOpenPath(path);
            setTreeKey((n) => n + 1);
            setEditorTick((n) => n + 1);
          }}
          onActiveChange={recordActive}
          emptyActions={emptyActions}
        />
        </ErrorBoundary>

        <div
          className="resize resize-chat"
          title="拖动调整聊天宽度"
          onMouseDown={(e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startChat = layoutRef.current.chat;
            let pinnedSide = layoutRef.current.side;
            const move = (ev: MouseEvent) => {
              const budget = workspaceInnerWidth(workspaceRef.current);
              // 向左拖 → 聊天变宽
              const desired = startChat - (ev.clientX - startX);
              const next = fitChatDrag(desired, pinnedSide, budget);
              pinnedSide = Math.min(pinnedSide, next.side);
              setSidebarW(pinnedSide);
              setChatW(next.chat);
            };
            const up = () => {
              document.body.classList.remove("is-resizing");
              window.removeEventListener("mousemove", move);
              window.removeEventListener("mouseup", up);
            };
            document.body.classList.add("is-resizing");
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
          disabled={!canChat}
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
          onSend={(t, draft, attachments) => void send(t, draft, attachments)}
          onStop={() => void stop()}
          onNew={() => newChat()}
          onSelect={(id) => void loadConv(id)}
          onDelete={(id) => void removeChat(id)}
          onRename={renameChat}
          onBuildPlan={(plan) => void buildPlan(plan)}
          onResend={(id, t, draft, attachments) => void resendFrom(id, t, draft, attachments)}
          focusComposerToken={composerFocusTick}
        />
        </ErrorBoundary>
      </div>

      <footer className="status">
        {git ? (
          <span className="st-item" title={git.dirty ? "当前分支（有未提交的改动）" : "当前分支"}>
            <GitBranch size={12} />
            {git.branch}
            {git.dirty ? "*" : ""}
          </span>
        ) : null}
        <span className="st-item" title={settings.workspace}>
          {workspaceName}
        </span>
        <span className="spacer" />
        <span className="st-item" title={canChat ? "已连接" : "未连接"}>
          {canChat ? <span className="dot-ok" /> : <span className="dot-off" />}
          {sourceLabel}
        </span>
        <span className="st-item">{formatModelLabel(models, settings.model, settings.modelParams || [])}</span>
        <span className="st-item">{settings.mode === "plan" ? "Plan" : "Agent"}</span>
      </footer>

      {quickOpenVisible ? (
        <QuickOpen
          recent={[...navRef.current.stack].reverse().filter((p, i, a) => a.indexOf(p) === i)}
          onClose={() => setQuickOpenVisible(false)}
          onOpen={(path) => {
            setQuickOpenVisible(false);
            setShowSettings(false);
            openFile(path);
          }}
        />
      ) : null}

      {showSettings ? (
        <SettingsPage
          settings={settings}
          models={models}
          sources={ccSources}
          onRefreshModels={refreshModels}
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
