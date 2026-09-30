import Editor, { DiffEditor } from "@monaco-editor/react";
import {
  createEntry,
  getFile,
  isExternalOpenablePath,
  openPathInSystem,
  saveFile,
  type FileReview,
} from "../api";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import { ErrorBoundary } from "./ErrorBoundary";

const BINARY_MSG =
  "此文件是二进制文件或使用了不受支持的文本编码，所以无法在文本编辑器中显示。";

type Tab = {
  path: string;
  content: string;
  original: string;
  /** 未落盘的草稿（Untitled） */
  draft?: boolean;
  /** 二进制/Office 等：不进 Monaco，只展示占位 */
  binary?: boolean;
  /** 系统打开结果（可选提示） */
  systemNote?: string;
};

const DRAFT_PREFIX = "__untitled__/";

const LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  py: "python",
  go: "go",
  rs: "rust",
  java: "java",
  css: "css",
  html: "html",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
  sh: "shell",
  sql: "sql",
};

function langOf(path: string) {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  return LANG[ext] || "plaintext";
}

function fileName(path: string) {
  return path.split(/[/\\]/).pop() || path;
}

function isDraftPath(path: string) {
  return path.startsWith(DRAFT_PREFIX);
}

function draftLabel(path: string) {
  return fileName(path.replace(DRAFT_PREFIX, ""));
}

const ReviewDiffView = memo(function ReviewDiffView({
  path,
  original,
  modified,
}: {
  path: string;
  original: string;
  modified: string;
}) {
  const orig = original || "";
  const mod = modified || "";
  const lines = Math.max(orig.split("\n").length, mod.split("\n").length);
  return (
    <ErrorBoundary fallback={<pre className="review-fallback">{mod || orig}</pre>}>
      <DiffEditor
        key={path}
        height="100%"
        theme="vs-dark"
        language={langOf(path)}
        original={orig}
        modified={mod}
        options={{
          readOnly: true,
          fontSize: 13,
          minimap: { enabled: false },
          renderSideBySide: true,
          useInlineViewWhenSpaceIsLimited: false,
          smoothScrolling: true,
          wordWrap: "on",
          padding: { top: 8 },
          scrollBeyondLastLine: false,
          hideUnchangedRegions: {
            enabled: lines > 40 && orig !== mod,
            contextLineCount: 3,
            minimumLineCount: 3,
            revealLineCount: 3,
          },
        }}
      />
    </ErrorBoundary>
  );
});

type Props = {
  openPath?: string;
  reloadToken: number;
  /** Undo 等场景：强制用磁盘内容覆盖这些路径的标签缓冲（即使有未保存改动） */
  forceReloadPaths?: string[];
  onForceReloaded?: () => void;
  reviewOpen?: boolean;
  reviews?: FileReview[];
  onCloseReview?: () => void;
  onKeep?: (path?: string) => void;
  onUndo?: (path?: string) => void;
  focusPath?: string;
  /** 草稿首次保存落盘后通知外层打开真实路径并刷新树 */
  onDraftSaved?: (path: string) => void;
};

export function EditorPane({
  openPath,
  reloadToken,
  forceReloadPaths = [],
  onForceReloaded,
  reviewOpen,
  reviews = [],
  onCloseReview,
  onKeep,
  onUndo,
  focusPath,
  onDraftSaved,
}: Props) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>();
  const [error, setError] = useState("");
  const [reviewPath, setReviewPath] = useState<string>();
  const [hintGone, setHintGone] = useState(false);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  const listed = reviews.filter((r) => r && r.path);
  const pending = listed.filter((r) => r.status === "pending");
  const changedKey = listed.map((r) => `${r.path}:${r.status}`).join("\n");

  useEffect(() => {
    if (!changedKey) {
      setReviewPath(undefined);
      return;
    }
    const paths = listed.map((r) => r.path);
    setReviewPath((cur) => {
      if (focusPath && paths.includes(focusPath)) return focusPath;
      return cur && paths.includes(cur) ? cur : paths.at(-1);
    });
  }, [changedKey, focusPath]);

  const upsertBinaryTab = useCallback((path: string, systemNote?: string) => {
    setTabs((prev) => {
      const exists = prev.find((t) => t.path === path);
      if (exists) {
        return prev.map((t) =>
          t.path === path
            ? {
                ...t,
                binary: true,
                content: "",
                original: "",
                draft: false,
                // 已有 note 时不覆盖，避免 watch 重入清掉/重写提示
                systemNote: systemNote !== undefined ? systemNote : t.systemNote,
              }
            : t,
        );
      }
      return [...prev, { path, content: "", original: "", binary: true, systemNote }];
    });
    setActive(path);
    setError("");
    setHintGone(true);
  }, []);

  // 每个路径只自动调一次系统打开，避免文件监视/reload 反复拉起 WPS
  const autoOpenedRef = useRef(new Set<string>());

  useEffect(() => {
    const forceSet = new Set(forceReloadPaths);
    // Undo 可能一次回退多个文件：对 force 列表全部从磁盘拉
    const paths = [
      ...forceReloadPaths,
      ...(openPath && !isDraftPath(openPath) && !forceSet.has(openPath) ? [openPath] : []),
    ];
    if (!paths.length) return;
    let cancelled = false;
    void (async () => {
      let anyForce = false;
      for (const path of paths) {
        const force = forceSet.has(path);
        if (force) anyForce = true;

        // Office / PDF 等：只展示占位；系统应用只在首次自动打开一次
        if (isExternalOpenablePath(path) && !force) {
          const alreadyTab = tabsRef.current.some((t) => t.path === path && t.binary);
          const shouldLaunch = !autoOpenedRef.current.has(path);
          if (shouldLaunch) {
            autoOpenedRef.current.add(path);
            // 不 await：先出占位，后台 fire-and-forget 打开
            void openPathInSystem(path).then((opened) => {
              if (cancelled) return;
              if (!opened.ok) {
                const note = opened.error
                  ? `未能用系统应用打开：${opened.error}`
                  : "未能用系统应用打开（未安装 WPS / Office 或无关联程序）";
                upsertBinaryTab(path, note);
              }
            });
          }
          if (!alreadyTab || shouldLaunch) upsertBinaryTab(path);
          else {
            // 已有占位 tab：只切到它，不重复 launch
            setActive(path);
            setError("");
          }
          continue;
        }

        try {
          const f = await getFile(path);
          if (cancelled) return;
          setTabs((prev) => {
            const exists = prev.find((t) => t.path === f.path);
            if (exists) {
              return prev.map((t) => {
                if (t.path !== f.path) return t;
                // force：覆盖缓冲；否则仅在无未保存改动时同步
                if (force || (t.content === t.original && !t.draft)) {
                  return {
                    ...t,
                    content: f.content,
                    original: f.content,
                    draft: false,
                    binary: false,
                    systemNote: undefined,
                  };
                }
                return t;
              });
            }
            return [...prev, { path: f.path, content: f.content, original: f.content }];
          });
          if (path === openPath || force) {
            setActive(f.path);
            setError("");
            setHintGone(true);
          }
        } catch (e) {
          if (cancelled) return;
          const msg = e instanceof Error ? e.message : String(e);
          if (/enoent|no such file|不存在/i.test(msg)) {
            setTabs((prev) => {
              const next = prev.filter((t) => t.path !== path);
              setActive((cur) => (cur === path ? next.at(-1)?.path : cur));
              return next;
            });
            if (path === openPath) setError(msg);
          } else if (/二进制|不受支持的文本编码|无法在文本编辑器/i.test(msg)) {
            upsertBinaryTab(path);
          } else if (path === openPath) {
            setError(msg);
          }
        }
      }
      if (!cancelled && anyForce) onForceReloaded?.();
    })();
    return () => {
      cancelled = true;
    };
  }, [openPath, reloadToken, forceReloadPaths, onForceReloaded, upsertBinaryTab]);

  const openUntitled = useCallback(() => {
    // 只看当前仍打开的草稿；全部关掉后从 Untitled-1 重新计
    const used = new Set<number>();
    for (const t of tabsRef.current) {
      if (!t.draft) continue;
      const m = draftLabel(t.path).match(/^Untitled-(\d+)$/i);
      if (m) used.add(Number(m[1]));
    }
    let n = 1;
    while (used.has(n)) n += 1;
    const label = `Untitled-${n}`;
    const path = `${DRAFT_PREFIX}${label}`;
    setTabs((prev) => [...prev, { path, content: "", original: "", draft: true }]);
    setActive(path);
    setError("");
    setHintGone(false);
  }, []);

  const current = tabs.find((t) => t.path === active);
  const review = listed.find((r) => r.path === reviewPath) || listed.at(-1);

  const uniqueWorkspaceName = async (base: string) => {
    const stem = base.replace(/\.[^./\\]+$/, "") || base;
    const extMatch = base.match(/(\.[^./\\]+)$/);
    const ext = extMatch ? extMatch[1] : "";
    let candidate = base;
    for (let i = 0; i < 50; i++) {
      try {
        await createEntry(candidate, false);
        return candidate;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!/exist|已存在|EEXIST/i.test(msg)) throw e;
        candidate = `${stem}-${i + 2}${ext}`;
      }
    }
    throw new Error("无法分配文件名");
  };

  const save = useCallback(async () => {
    if (!current || current.binary) return;
    if (current.draft) {
      const label = draftLabel(current.path);
      const dest = await uniqueWorkspaceName(label.includes(".") ? label : label);
      await saveFile(dest, current.content);
      setTabs((prev) =>
        prev.map((t) =>
          t.path === current.path
            ? { path: dest, content: t.content, original: t.content, draft: false }
            : t,
        ),
      );
      setActive(dest);
      setHintGone(true);
      onDraftSaved?.(dest);
      return;
    }
    if (current.content === current.original) return;
    await saveFile(current.path, current.content);
    setTabs((prev) =>
      prev.map((t) => (t.path === current.path ? { ...t, original: t.content } : t)),
    );
  }, [current, onDraftSaved]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save().catch((err: Error) => setError(err.message));
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n" && !e.shiftKey) {
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
        e.preventDefault();
        openUntitled();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save, openUntitled]);

  if (reviewOpen && listed.length) {
    const dir = review ? review.path.split(/[/\\]/).slice(0, -1).join("/") : "";
    const showReviewActions = pending.length > 0;
    return (
      <div className="editor-wrap review-mode">
        <div className="tabs">
          <button type="button" className="tab active">
            Review: {review ? fileName(review.path) : "changes"}
            <X className="x" size={12} onClick={onCloseReview} />
          </button>
        </div>
        <div className="review-toolbar">
          <span className="review-all">All Changes</span>
          <span className="spacer" />
          {showReviewActions ? (
            <>
              <button type="button" className="review-tool-btn" onClick={() => onUndo?.()}>
                Undo All
              </button>
              <button type="button" className="review-tool-btn keep" onClick={() => onKeep?.()}>
                Keep All
              </button>
            </>
          ) : null}
        </div>
        {review ? (
          <div className="review-frame">
            {listed.length > 1 ? (
              <div className="review-file-switch">
                {listed.map((item) => (
                  <button
                    key={item.path}
                    type="button"
                    className={item.path === review.path ? "on" : ""}
                    title={item.path}
                    onClick={() => setReviewPath(item.path)}
                  >
                    {fileName(item.path)}
                    {item.status === "kept" ? <em className="kept">Kept</em> : null}
                    {item.status === "undone" ? <em className="kept">Undone</em> : null}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="review-file-bar">
              <span className="review-hash">#</span>
              <strong>{fileName(review.path)}</strong>
              {dir ? <span className="review-dir">{dir}</span> : null}
              {review.status === "kept" ? <em className="kept">Kept</em> : null}
              {review.status === "undone" ? <em className="kept">Undone</em> : null}
              <em className="add">+{review.added}</em>
              <em className="del">-{review.removed}</em>
              {showReviewActions && review.status === "pending" ? (
                <>
                  <span className="spacer" />
                  <button type="button" className="review-link" onClick={() => onUndo?.(review.path)}>
                    Undo
                  </button>
                  <button type="button" className="review-link" onClick={() => onKeep?.(review.path)}>
                    Keep
                  </button>
                </>
              ) : null}
            </div>
            <div className="monaco-fill">
              <ReviewDiffView
                path={review.path}
                original={typeof review.before === "string" ? review.before : ""}
                modified={typeof review.after === "string" ? review.after : ""}
              />
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  if (!tabs.length) {
    return (
      <div className="editor-wrap">
        <div
          className="welcome welcome-clickable"
          role="button"
          tabIndex={0}
          title="双击新建 Untitled 文件"
          onDoubleClick={openUntitled}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openUntitled();
            }
          }}
        >
          <h1>
            <span className="welcome-hot">打开</span>文件夹开始
          </h1>
          <p>
            双击此处新建 Untitled 文件；或在左侧打开已有文件。也可直接在右侧向 Agent 发消息。⌘/Ctrl + , 打开设置。
          </p>
          {error ? <p className="err">{error}</p> : null}
        </div>
      </div>
    );
  }

  const showHint = Boolean(current?.draft && !current.content && !hintGone);

  return (
    <div className="editor-wrap">
      <div
        className="tabs"
        title="双击空白处新建 Untitled"
        onDoubleClick={(e) => {
          if (e.target === e.currentTarget) openUntitled();
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.path}
            type="button"
            className={`tab ${t.path === active ? "active" : ""}`}
            onClick={() => setActive(t.path)}
          >
            {(t.draft && t.content !== "") || (!t.draft && t.content !== t.original) ? (
              <span className="dot" />
            ) : null}
            {t.draft ? draftLabel(t.path) : fileName(t.path)}
            <X
              className="x"
              size={12}
              onClick={(e) => {
                e.stopPropagation();
                autoOpenedRef.current.delete(t.path);
                setTabs((prev) => {
                  const next = prev.filter((x) => x.path !== t.path);
                  if (active === t.path) setActive(next.at(-1)?.path);
                  return next;
                });
              }}
            />
          </button>
        ))}
        <div
          className="tabs-rest"
          title="双击新建 Untitled"
          onDoubleClick={(e) => {
            e.stopPropagation();
            openUntitled();
          }}
        />
      </div>
      {current?.binary ? (
        <div className="binary-placeholder">
          <TriangleAlert className="binary-icon" size={48} strokeWidth={1.6} />
          <p className="binary-msg">{BINARY_MSG}</p>
          {current.systemNote ? <p className="binary-note">{current.systemNote}</p> : null}
          <button
            type="button"
            className="btn"
            onClick={() => {
              void openPathInSystem(current.path).then((r) => {
                if (!r.ok) {
                  setTabs((prev) =>
                    prev.map((t) =>
                      t.path === current.path
                        ? {
                            ...t,
                            systemNote: r.error
                              ? `未能用系统应用打开：${r.error}`
                              : "未能用系统应用打开",
                          }
                        : t,
                    ),
                  );
                } else {
                  setTabs((prev) =>
                    prev.map((t) =>
                      t.path === current.path ? { ...t, systemNote: undefined } : t,
                    ),
                  );
                }
              });
            }}
          >
            用系统应用打开
          </button>
        </div>
      ) : current ? (
        <div className="monaco-fill editor-surface">
          {showHint ? (
            <div className="untitled-hint" aria-hidden>
              <span className="untitled-link">开始输入</span>
              <span>，或 </span>
              <kbd>⌘S</kbd>
              <span> 保存到工作区。快捷键 </span>
              <kbd>⌘N</kbd>
              <span> 再开一个 Untitled。</span>
            </div>
          ) : null}
          <Editor
            theme="vs-dark"
            language={langOf(current.draft ? draftLabel(current.path) : current.path)}
            value={current.content}
            onChange={(v) => {
              const next = v ?? "";
              if (next) setHintGone(true);
              setTabs((prev) =>
                prev.map((t) => (t.path === current.path ? { ...t, content: next } : t)),
              );
            }}
            options={{
              fontSize: 13,
              minimap: { enabled: false },
              smoothScrolling: true,
              wordWrap: "on",
              padding: { top: 12 },
              scrollBeyondLastLine: false,
            }}
          />
        </div>
      ) : null}
      {error ? <div className="editor-error">{error}</div> : null}
    </div>
  );
}
