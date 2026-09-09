import Editor, { DiffEditor } from "@monaco-editor/react";
import { getFile, saveFile, type FileReview } from "../api";
import { memo, useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { ErrorBoundary } from "./ErrorBoundary";

type Tab = { path: string; content: string; original: string };

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
  reviewOpen?: boolean;
  reviews?: FileReview[];
  onCloseReview?: () => void;
  onKeep?: (path?: string) => void;
  onUndo?: (path?: string) => void;
  focusPath?: string;
};

export function EditorPane({
  openPath,
  reloadToken,
  reviewOpen,
  reviews = [],
  onCloseReview,
  onKeep,
  onUndo,
  focusPath,
}: Props) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>();
  const [error, setError] = useState("");
  const [reviewPath, setReviewPath] = useState<string>();

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

  useEffect(() => {
    if (!openPath) return;
    getFile(openPath)
      .then((f) => {
        setTabs((prev) => {
          const exists = prev.find((t) => t.path === f.path);
          if (exists) {
            return prev.map((t) =>
              t.path === f.path && t.content === t.original
                ? { ...t, content: f.content, original: f.content }
                : t,
            );
          }
          return [...prev, { path: f.path, content: f.content, original: f.content }];
        });
        setActive(f.path);
        setError("");
      })
      .catch((e: Error) => {
        if (/enoent|no such file|不存在/i.test(e.message)) {
          setTabs((prev) => {
            const next = prev.filter((t) => t.path !== openPath);
            setActive((cur) => (cur === openPath ? next.at(-1)?.path : cur));
            return next;
          });
        }
        setError(e.message);
      });
  }, [openPath, reloadToken]);

  const current = tabs.find((t) => t.path === active);
  const review = listed.find((r) => r.path === reviewPath) || listed.at(-1);

  const save = useCallback(async () => {
    if (!current || current.content === current.original) return;
    await saveFile(current.path, current.content);
    setTabs((prev) =>
      prev.map((t) => (t.path === current.path ? { ...t, original: t.content } : t)),
    );
  }, [current]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

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
        <div className="welcome">
          <h1>打开文件夹开始</h1>
          <p>在左侧打开文件，或直接在右侧向 Agent 发消息。⌘/Ctrl + , 打开设置填写 API Key。</p>
          {error ? <p className="err">{error}</p> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="editor-wrap">
      <div className="tabs">
        {tabs.map((t) => (
          <button
            key={t.path}
            className={`tab ${t.path === active ? "active" : ""}`}
            onClick={() => setActive(t.path)}
          >
            {t.content !== t.original ? <span className="dot" /> : null}
            {fileName(t.path)}
            <X
              className="x"
              size={12}
              onClick={(e) => {
                e.stopPropagation();
                setTabs((prev) => {
                  const next = prev.filter((x) => x.path !== t.path);
                  if (active === t.path) setActive(next.at(-1)?.path);
                  return next;
                });
              }}
            />
          </button>
        ))}
      </div>
      {current ? (
        <div className="monaco-fill">
          <Editor
            theme="vs-dark"
            language={langOf(current.path)}
            value={current.content}
            onChange={(v) =>
              setTabs((prev) =>
                prev.map((t) => (t.path === current.path ? { ...t, content: v ?? "" } : t)),
              )
            }
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
    </div>
  );
}
