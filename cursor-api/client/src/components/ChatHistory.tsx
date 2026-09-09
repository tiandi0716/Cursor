import { Check, History, Loader2, MessageSquare, MoreHorizontal, Plus, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { ConversationSummary } from "../api";

export type HistoryHandlers = {
  items: ConversationSummary[];
  activeId?: string;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => Promise<void> | void;
};

type Section = { id: string; label: string; items: ConversationSummary[] };

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function groupConversations(items: ConversationSummary[], q = ""): Section[] {
  const query = q.trim().toLowerCase();
  const filtered = query
    ? items.filter((h) => (h.title || "").toLowerCase().includes(query))
    : items;
  const now = new Date();
  const today = startOfDay(now);
  const yesterday = today - 86400000;
  const week = today - 6 * 86400000;
  const rest = filtered;
  const buckets: Section[] = [
    { id: "today", label: "今天", items: rest.filter((h) => h.updatedAt >= today) },
    { id: "yesterday", label: "昨天", items: rest.filter((h) => h.updatedAt >= yesterday && h.updatedAt < today) },
    {
      id: "week",
      label: "过去 7 天",
      items: rest.filter((h) => h.updatedAt >= week && h.updatedAt < yesterday),
    },
    { id: "older", label: "更早", items: rest.filter((h) => h.updatedAt < week) },
  ];
  return buckets.filter((s) => s.items.length);
}

function displayTitle(title: string) {
  return title === "新对话" ? "New Agent" : title;
}

export function ChatHistoryList({
  items,
  activeId,
  query = "",
  compact,
  onSelect,
  onDelete,
  onRename,
}: HistoryHandlers & { query?: string; compact?: boolean }) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const sections = useMemo(() => groupConversations(items, query), [items, query]);

  useEffect(() => {
    if (!menu) return;
    const close = (ev: Event) => {
      const el = ev.target as HTMLElement | null;
      if (el?.closest(".ctx-menu")) return;
      setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const current = menu ? items.find((h) => h.id === menu.id) : null;

  return (
    <div className={`hist-list ${compact ? "compact" : ""}`}>
      {sections.length === 0 ? <div className="empty">{query ? "没有匹配的对话" : "还没有对话"}</div> : null}
      {sections.map((section) => (
        <div key={section.id} className="hist-section">
          <div className="hist-label">{section.label}</div>
          {section.items.map((h) =>
            renaming === h.id ? (
              <RenameRow
                key={h.id}
                title={h.title}
                onCancel={() => setRenaming(null)}
                onSubmit={async (title) => {
                  await onRename(h.id, title);
                  setRenaming(null);
                }}
              />
            ) : (
              <div
                key={h.id}
                className={`hist-item ${h.id === activeId ? "active" : ""}`}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({
                    id: h.id,
                    x: Math.min(e.clientX, window.innerWidth - 180),
                    y: Math.min(e.clientY, window.innerHeight - 160),
                  });
                }}
              >
                <button type="button" className="grow tree-row" onClick={() => onSelect(h.id)}>
                  <span className={`hist-dot ${h.id === activeId ? "on" : ""}`}>
                    {h.id === activeId ? <Check size={10} /> : null}
                  </span>
                  <span className="name">{displayTitle(h.title)}</span>
                </button>
                <div className="hist-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title="更多"
                    onClick={(e) => openMenu(e, h.id, setMenu)}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn del"
                    title="删除"
                    onClick={() => onDelete(h.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ),
          )}
        </div>
      ))}
      {menu && current
        ? createPortal(
            <div
              className="ctx-menu"
              style={{ left: menu.x, top: menu.y }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                className="ctx-item danger"
                onClick={() => {
                  onDelete(current.id);
                  setMenu(null);
                }}
              >
                删除
              </button>
              <button
                type="button"
                className="ctx-item"
                onClick={() => {
                  setRenaming(current.id);
                  setMenu(null);
                }}
              >
                重命名
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function openMenu(
  e: ReactMouseEvent,
  id: string,
  setMenu: (v: { id: string; x: number; y: number }) => void,
) {
  e.preventDefault();
  e.stopPropagation();
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  setMenu({
    id,
    x: Math.min(rect.left, window.innerWidth - 180),
    y: Math.min(rect.bottom + 4, window.innerHeight - 160),
  });
}

function RenameRow({
  title,
  onSubmit,
  onCancel,
}: {
  title: string;
  onSubmit: (title: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(title);
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const finish = async (submit: boolean) => {
    if (done.current) return;
    const next = value.trim();
    if (!submit || !next || next === title) {
      done.current = true;
      onCancel();
      return;
    }
    done.current = true;
    try {
      await onSubmit(next);
    } catch (e) {
      done.current = false;
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="hist-rename">
      <input
        ref={input}
        className="tree-input"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setErr("");
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void finish(true);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            void finish(false);
          }
        }}
        onBlur={() => void finish(Boolean(value.trim()) && value.trim() !== title)}
      />
      {err ? <div className="tree-create-err">{err}</div> : null}
    </div>
  );
}

export function ChatHeadActions({
  title,
  canEdit,
  historyOpen,
  tabs,
  activeKey,
  onSelectTab,
  onCloseTab,
  onToggleHistory,
  onNew,
  onRename,
  onDelete,
}: {
  title: string;
  canEdit: boolean;
  historyOpen: boolean;
  tabs: Array<{ key: string; title: string; streaming?: boolean; draft?: boolean }>;
  activeKey: string;
  onSelectTab: (key: string) => void;
  onCloseTab: (key: string) => void;
  onToggleHistory: () => void;
  onNew: () => void;
  onRename: (title: string) => Promise<void> | void;
  onDelete: () => void;
}) {
  const [more, setMore] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!more) return;
    const onDoc = (e: MouseEvent) => {
      if (!moreRef.current?.contains(e.target as Node)) setMore(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [more]);

  useEffect(() => {
    if (historyOpen) setMore(false);
  }, [historyOpen]);

  return (
    <>
      <div className="chat-head-title">
        {renaming && canEdit ? (
          <RenameRow
            title={title}
            onCancel={() => setRenaming(false)}
            onSubmit={async (next) => {
              await onRename(next);
              setRenaming(false);
            }}
          />
        ) : (
          <div className="chat-tabs">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`chat-tab ${tab.key === activeKey ? "active" : ""}`}
                title={tab.title}
                onClick={() => onSelectTab(tab.key)}
              >
                {tab.streaming ? <Loader2 className="spin" size={11} /> : tab.draft ? <Sparkles size={11} /> : <MessageSquare size={11} />}
                <span>{tab.title}</span>
                <X
                  className="x"
                  size={12}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.key);
                  }}
                />
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="chat-head-actions">
        <button type="button" className="icon-btn" title="新对话" onClick={onNew}>
          <Plus size={16} />
        </button>
        <button
          type="button"
          className={`icon-btn ${historyOpen ? "on" : ""}`}
          title="历史对话"
          onClick={onToggleHistory}
        >
          <History size={16} />
        </button>
        <div className="chat-more" ref={moreRef}>
          <button
            type="button"
            className={`icon-btn ${more ? "on" : ""}`}
            title="更多"
            onClick={() => {
              if (historyOpen) onToggleHistory();
              setMore((v) => !v);
            }}
          >
            <MoreHorizontal size={16} />
          </button>
          {more ? (
            <div className="ctx-menu chat-more-pop">
              <button
                type="button"
                className="ctx-item"
                disabled={!canEdit}
                onClick={() => {
                  setMore(false);
                  setRenaming(true);
                }}
              >
                重命名
              </button>
              <button
                type="button"
                className="ctx-item danger"
                disabled={!canEdit}
                onClick={() => {
                  setMore(false);
                  onDelete();
                }}
              >
                删除
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
