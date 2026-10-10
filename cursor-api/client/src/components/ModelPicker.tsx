import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo, ModelParam } from "../api";

type Props = {
  models: ModelInfo[];
  model: string;
  modelParams: ModelParam[];
  onChange: (model: string, params: ModelParam[]) => void;
};

function paramValue(params: ModelParam[], id: string) {
  return params.find((p) => p.id === id)?.value;
}

function upsert(params: ModelParam[], id: string, value: string): ModelParam[] {
  const next = params.filter((p) => p.id !== id);
  next.push({ id, value });
  return next;
}

function effortParamId(info?: ModelInfo) {
  if (info?.parameters?.some((p) => p.id === "effort")) return "effort";
  if (info?.parameters?.some((p) => p.id === "reasoning")) return "reasoning";
  if (info?.parameters?.some((p) => p.id === "reasoningEffort")) return "reasoningEffort";
  return null;
}

function resolvedParams(info: ModelInfo | undefined, stored: ModelParam[]) {
  const defaults = info?.defaultParams ? [...info.defaultParams] : [];
  if (!stored?.length) return defaults;
  const next = [...defaults];
  for (const p of stored) {
    const i = next.findIndex((x) => x.id === p.id);
    if (i >= 0) next[i] = p;
    else next.push(p);
  }
  return next;
}

function labelOf(info: ModelInfo | undefined, id: string, value?: string) {
  if (!value) return "";
  const def = info?.parameters?.find((p) => p.id === id);
  return def?.values?.find((v) => v.value === value)?.displayName || value;
}

export function formatModelLabel(models: ModelInfo[], model: string, modelParams: ModelParam[]) {
  const info = (models?.length ? models : [{ id: model, displayName: model }]).find((m) => m.id === model);
  const params = resolvedParams(info, modelParams || []);
  const effortId = effortParamId(info);
  const effortVal = effortId ? paramValue(params, effortId) : undefined;
  const effortLabel = effortId ? labelOf(info, effortId, effortVal) : "";
  const fastOn = paramValue(params, "fast") === "true";
  return [info?.displayName || model, effortLabel, fastOn ? "Fast" : ""].filter(Boolean).join(" ");
}

type Group = { title: string; sub?: string; items: ModelInfo[] };

function groupModels(list: ModelInfo[]): Group[] {
  const groups: Group[] = [];
  const index = new Map<string, Group>();
  for (const m of list) {
    const title = m.provider || "";
    let g = index.get(title);
    if (!g) {
      g = { title, sub: m.group, items: [] };
      index.set(title, g);
      groups.push(g);
    }
    g.items.push(m);
  }
  return groups;
}

export function ModelPicker({ models, model, modelParams, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number; width: number }>({ left: 0, bottom: 0, width: 288 });

  const catalog = models?.length ? models : [{ id: model, displayName: model }];
  const info = catalog.find((m) => m.id === model);
  const params = useMemo(() => resolvedParams(info, modelParams), [info, modelParams]);
  const fastDef = info?.parameters?.find((p) => p.id === "fast");
  const effortId = effortParamId(info);
  const effortDef = effortId ? info?.parameters?.find((p) => p.id === effortId) : undefined;
  const fastOn = paramValue(params, "fast") === "true";
  const effortVal = effortId ? paramValue(params, effortId) : undefined;
  const effortLabel = effortId ? labelOf(info, effortId, effortVal) : "";

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 弹层用 fixed 定位并夹在窗口内，避免聊天栏很窄时被右边缘截断
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = triggerRef.current?.getBoundingClientRect();
      if (!r) return;
      const width = Math.min(300, window.innerWidth - 16);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      setPos({ left, bottom: window.innerHeight - r.top + 6, width });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery("");
      window.setTimeout(() => {
        searchRef.current?.focus();
        root.current?.querySelector(".model-item.picked")?.scrollIntoView({ block: "center" });
      }, 0);
    }
  }, [open]);

  const commit = (id: string, nextParams: ModelParam[]) => {
    const nextInfo = catalog.find((m) => m.id === id);
    const allowed = new Set((nextInfo?.parameters || []).map((p) => p.id));
    const defaults = nextInfo?.defaultParams || [];
    const merged = resolvedParams(nextInfo, nextParams).filter(
      (p) => allowed.has(p.id) || defaults.some((d) => d.id === p.id),
    );
    onChange(id, merged);
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalog;
    return catalog.filter((m) =>
      [m.displayName, m.bare, m.id, m.provider, m.group]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(q)),
    );
  }, [catalog, query]);
  const groups = useMemo(() => groupModels(filtered), [filtered]);
  const grouped = catalog.some((m) => m.provider);

  const suffix = [effortLabel, fastOn ? "Fast" : ""].filter(Boolean).join(" ");
  const trigger = [info?.displayName || model, suffix].filter(Boolean).join(" ");

  const pick = (m: ModelInfo) => {
    commit(m.id, m.id === model ? params : []);
    setOpen(false);
  };

  return (
    <div className="model-picker" ref={root}>
      <button
        ref={triggerRef}
        type="button"
        className={`model-trigger ${open ? "open" : ""}`}
        title={info?.provider ? `${trigger} · ${info.provider}` : trigger}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="model-trigger-label">
          {info?.displayName || model}
          {suffix ? <em> {suffix}</em> : null}
        </span>
        <ChevronDown size={12} />
      </button>

      {open ? (
        <div className="model-pop" style={{ left: pos.left, bottom: pos.bottom, width: pos.width }}>
          <div className="model-search">
            <Search size={13} />
            <input
              ref={searchRef}
              value={query}
              placeholder="搜索模型"
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filtered[0]) pick(filtered[0]);
              }}
            />
          </div>

          {fastDef || (effortDef && effortId) ? (
            <div className="model-opts">
              {fastDef ? (
                <div className="model-opt">
                  <span>Fast</span>
                  <button
                    type="button"
                    className={`switch ${fastOn ? "on" : ""}`}
                    aria-label="Fast"
                    onClick={() => commit(model, upsert(params, "fast", fastOn ? "false" : "true"))}
                  >
                    <i />
                  </button>
                </div>
              ) : null}
              {effortDef && effortId ? (
                <div className="model-opt">
                  <span>推理强度</span>
                  <div className="seg">
                    {effortDef.values.map((v) => (
                      <button
                        type="button"
                        key={v.value}
                        className={v.value === effortVal ? "on" : ""}
                        onClick={() => commit(model, upsert(params, effortId, v.value))}
                      >
                        {v.displayName || v.value}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="model-list">
            {groups.length === 0 ? <div className="model-empty">没有匹配的模型</div> : null}
            {groups.map((g) => (
              <div key={g.title || "_"} className="model-group">
                {grouped && g.title ? (
                  <div className="model-group-title">
                    <span>{g.title}</span>
                    {g.sub ? <em>{g.sub}</em> : null}
                  </div>
                ) : null}
                {g.items.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    className={`model-item ${m.id === model ? "picked" : ""}`}
                    title={m.bare || m.id}
                    onClick={() => pick(m)}
                  >
                    <span className="model-item-name">{m.displayName || m.id}</span>
                    {m.id === model ? <Check size={14} /> : null}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
