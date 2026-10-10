import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { quickOpen } from "../api";
import { FileTypeIcon } from "./FileTypeIcon";

type Props = {
  /** 最近打开（新的在前），查询为空时优先展示 */
  recent: string[];
  onOpen: (path: string) => void;
  onClose: () => void;
};

function splitPath(path: string) {
  const i = path.lastIndexOf("/");
  return i < 0 ? { name: path, dir: "" } : { name: path.slice(i + 1), dir: path.slice(0, i) };
}

/** 文件名里高亮命中的字符：优先连续子串，否则按子序列逐字高亮 */
function highlight(name: string, query: string): ReactNode {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return name;
  const lower = name.toLowerCase();
  const at = lower.indexOf(q);
  if (at >= 0) {
    return (
      <>
        {name.slice(0, at)}
        <mark>{name.slice(at, at + q.length)}</mark>
        {name.slice(at + q.length)}
      </>
    );
  }
  const hits = new Set<number>();
  let k = 0;
  for (let i = 0; i < lower.length && k < q.length; i++) {
    if (lower[i] === q[k]) {
      hits.add(i);
      k++;
    }
  }
  if (k < q.length) return name;
  return [...name].map((ch, i) => (hits.has(i) ? <mark key={i}>{ch}</mark> : ch));
}

export function QuickOpen({ recent, onOpen, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(
      () => {
        setLoading(true);
        quickOpen(query)
          .then((list) => {
            if (!alive) return;
            setFiles(list);
            setSel(0);
          })
          .catch(() => alive && setFiles([]))
          .finally(() => alive && setLoading(false));
      },
      query ? 60 : 0,
    );
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const rows = useMemo(() => {
    if (query.trim()) return files.map((path) => ({ path, recent: false }));
    const seen = new Set(recent);
    return [
      ...recent.slice(0, 12).map((path) => ({ path, recent: true })),
      ...files.filter((p) => !seen.has(p)).map((path) => ({ path, recent: false })),
    ];
  }, [files, recent, query]);

  useEffect(() => {
    listRef.current?.querySelector(".qo-item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const pick = (i: number) => {
    const row = rows[i];
    if (row) onOpen(row.path);
  };

  return (
    <div className="qo-back" onMouseDown={onClose}>
      <div className="qo" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="qo-input"
          autoFocus
          value={query}
          placeholder="按名称搜索文件"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
              e.preventDefault();
              setSel((s) => Math.min(rows.length - 1, s + 1));
            } else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (!e.nativeEvent.isComposing) pick(sel);
            }
          }}
        />
        <div className="qo-list" ref={listRef}>
          {rows.map((row, i) => {
            const { name, dir } = splitPath(row.path);
            const firstRecent = row.recent && i === 0;
            const firstOther = !row.recent && i > 0 && rows[i - 1].recent;
            return (
              <div key={row.path}>
                {firstRecent ? <div className="qo-sec">最近打开</div> : null}
                {firstOther ? <div className="qo-sec">工作区文件</div> : null}
                <button
                  type="button"
                  className={`qo-item${i === sel ? " sel" : ""}`}
                  title={row.path}
                  onMouseMove={() => setSel(i)}
                  onClick={() => pick(i)}
                >
                  <FileTypeIcon name={name} size={14} />
                  <span className="qo-name">{highlight(name, query)}</span>
                  {dir ? <span className="qo-dir">{dir}</span> : null}
                </button>
              </div>
            );
          })}
          {!rows.length && !loading ? <div className="qo-empty">没有匹配的文件</div> : null}
        </div>
      </div>
    </div>
  );
}
