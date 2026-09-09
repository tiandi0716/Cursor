import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelInfo, ModelParam } from "../api";

type View = "main" | "effort" | "model";

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

export function ModelPicker({ models, model, modelParams, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("main");
  const root = useRef<HTMLDivElement>(null);

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
      if (!root.current?.contains(e.target as Node)) {
        setOpen(false);
        setView("main");
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
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

  const chip = [info?.displayName || model, effortLabel, fastOn ? "Fast" : ""].filter(Boolean).join(" ");
  const trigger = chip || info?.displayName || model;

  return (
    <div className="model-picker" ref={root}>
      <button
        type="button"
        className="model-trigger"
        title={trigger}
        onClick={() => {
          setOpen((v) => !v);
          setView("main");
        }}
      >
        <span className="model-trigger-label">{trigger}</span>
        <ChevronDown size={12} />
      </button>

      {open ? (
        <div className="model-pop">
          {view === "main" ? (
            <>
              {fastDef ? (
                <div className="model-row">
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
                <button type="button" className="model-row" onClick={() => setView("effort")}>
                  <span>Effort</span>
                  <span className="val">
                    {effortLabel || "—"}
                    <ChevronRight size={14} />
                  </span>
                </button>
              ) : null}
              {(fastDef || effortDef) && <div className="model-sep" />}
              <button type="button" className="model-row" onClick={() => setView("model")}>
                <span>Model</span>
                <span className="val">
                  {info?.displayName || model}
                  <ChevronRight size={14} />
                </span>
              </button>
            </>
          ) : null}

          {view === "effort" && effortDef && effortId ? (
            <>
              <button type="button" className="model-row back" onClick={() => setView("main")}>
                ‹ Effort
              </button>
              <div className="model-sep" />
              {effortDef.values.map((v) => (
                <button
                  type="button"
                  key={v.value}
                  className={`model-row ${v.value === effortVal ? "picked" : ""}`}
                  onClick={() => {
                    commit(model, upsert(params, effortId, v.value));
                    setView("main");
                  }}
                >
                  {v.displayName || v.value}
                </button>
              ))}
            </>
          ) : null}

          {view === "model" ? (
            <>
              <button type="button" className="model-row back" onClick={() => setView("main")}>
                ‹ Model
              </button>
              <div className="model-sep" />
              <div className="model-list">
                {catalog.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    className={`model-row ${m.id === model ? "picked" : ""}`}
                    onClick={() => {
                      commit(m.id, params);
                      setView("main");
                    }}
                  >
                    {m.displayName || m.id}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
