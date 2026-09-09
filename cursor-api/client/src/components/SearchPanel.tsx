import { ChevronDown, ChevronRight, File, FoldVertical, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { searchFiles, type SearchHit } from "../api";

type Props = {
  onOpen: (path: string) => void;
  active?: boolean;
};

export function SearchPanel({ onOpen, active }: Props) {
  const [query, setQuery] = useState("");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [tick, setTick] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (active) input.current?.focus();
  }, [active]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setError("");
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void searchFiles(q)
        .then((rows) => {
          if (cancelled) return;
          setHits(rows);
          setError("");
        })
        .catch((e: Error) => {
          if (!cancelled) setError(e.message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, tick]);

  const filtered = useMemo(
    () => hits.filter((hit) => matchPath(hit.path, include, exclude)),
    [hits, include, exclude],
  );
  const matchCount = filtered.reduce((n, hit) => n + Math.max(1, hit.matches.length), 0);

  const collapseAll = () => {
    const next: Record<string, boolean> = {};
    for (const hit of filtered) next[hit.path] = true;
    setCollapsed(next);
  };

  return (
    <div className="search-panel">
      <div className="side-head">
        <span className="side-title">搜索</span>
        <div className="side-actions">
          <button type="button" className="icon-btn" title="刷新" onClick={() => setTick((n) => n + 1)}>
            <RefreshCw size={14} />
          </button>
          <button type="button" className="icon-btn" title="全部折叠" onClick={collapseAll}>
            <FoldVertical size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="清除"
            disabled={!query && !include && !exclude}
            onClick={() => {
              setQuery("");
              setInclude("");
              setExclude("");
              setHits([]);
              setCollapsed({});
              input.current?.focus();
            }}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="search-fields">
        <input
          ref={input}
          className="search-input"
          value={query}
          placeholder="搜索"
          onChange={(e) => setQuery(e.target.value)}
        />
        <input
          className="search-input"
          value={include}
          placeholder="要包含的文件"
          onChange={(e) => setInclude(e.target.value)}
        />
        <input
          className="search-input"
          value={exclude}
          placeholder="要排除的文件"
          onChange={(e) => setExclude(e.target.value)}
        />
      </div>
      <div className="search-results">
        {error ? <div className="empty">{error}</div> : null}
        {!error && !query.trim() ? (
          <div className="search-hint">在工作区中搜索文件名和内容。可用 glob，例如 `src/**`、`*.ts`。</div>
        ) : null}
        {!error && query.trim() && loading ? <div className="empty">搜索中…</div> : null}
        {!error && query.trim() && !loading && !filtered.length ? <div className="empty">没有匹配结果</div> : null}
        {!error && query.trim() && !loading && filtered.length ? (
          <div className="search-meta">
            {matchCount} 个结果，来自 {filtered.length} 个文件
          </div>
        ) : null}
        {filtered.map((hit) => {
          const closed = Boolean(collapsed[hit.path]);
          const dir = hit.path.split("/").slice(0, -1).join("/") || ".";
          return (
            <div key={hit.path} className="search-file">
              <button
                type="button"
                className="search-file-head"
                title={hit.path}
                onClick={() => {
                  if (hit.matches.length) {
                    setCollapsed((prev) => ({ ...prev, [hit.path]: !prev[hit.path] }));
                    return;
                  }
                  onOpen(hit.path);
                }}
                onDoubleClick={() => onOpen(hit.path)}
              >
                {hit.matches.length ? (
                  closed ? <ChevronRight className="chev" size={14} /> : <ChevronDown className="chev" size={14} />
                ) : (
                  <span className="chev" />
                )}
                <File size={14} color="#8a8a8a" />
                <span className="name">{hit.name}</span>
                <span className="search-dir">{dir}</span>
                {hit.matches.length ? <span className="search-count">{hit.matches.length}</span> : null}
              </button>
              {!closed
                ? hit.matches.map((m, i) => (
                    <button
                      key={`${hit.path}-${m.line}-${i}`}
                      type="button"
                      className="search-line"
                      onClick={() => onOpen(hit.path)}
                    >
                      <span className="ln">{m.line}</span>
                      <span className="tx">{highlight(m.text, query)}</span>
                    </button>
                  ))
                : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function highlight(text: string, query: string) {
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped, "ig");
  const nodes: Array<string | { t: string }> = [];
  let last = 0;
  let m = re.exec(text);
  while (m) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    nodes.push({ t: m[0] });
    last = m.index + m[0].length;
    if (m[0] === "") re.lastIndex += 1;
    m = re.exec(text);
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes.map((part, i) =>
    typeof part === "string" ? (
      <span key={i}>{part}</span>
    ) : (
      <em key={i} className="search-hl">
        {part.t}
      </em>
    ),
  );
}

function matchPath(path: string, include: string, exclude: string) {
  const inc = splitGlobs(include);
  const exc = splitGlobs(exclude);
  if (inc.length && !inc.some((g) => globMatch(path, g))) return false;
  if (exc.some((g) => globMatch(path, g))) return false;
  return true;
}

function splitGlobs(raw: string) {
  return raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function globMatch(path: string, glob: string) {
  const g = glob.replaceAll("\\", "/").replace(/^\/+/, "");
  const p = path.replaceAll("\\", "/");
  const re = new RegExp(
    `^${g
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\u0000/g, ".*")}$`,
    "i",
  );
  if (re.test(p)) return true;
  if (!g.includes("/") && !g.includes("**")) {
    const name = p.split("/").pop() || p;
    return new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i").test(name);
  }
  if (g.endsWith("/**") || g.includes("/")) return re.test(p) || p.startsWith(g.replace(/\/\*\*$/, "") + "/");
  return p.includes(g.replace(/\*/g, ""));
}
