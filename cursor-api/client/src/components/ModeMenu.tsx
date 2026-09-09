import { Check, ChevronDown, Infinity, Waypoints } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type ChatMode = "agent" | "plan";

const ITEMS: Array<{
  id: ChatMode;
  label: string;
  shortcut?: string;
  icon: typeof Infinity;
}> = [
  { id: "agent", label: "Agent", shortcut: "⌘I", icon: Infinity },
  { id: "plan", label: "Plan", icon: Waypoints },
];

type Props = {
  mode: ChatMode;
  onMode: (mode: ChatMode) => void;
};

export function ModeMenu({ mode, onMode }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const current = ITEMS.find((m) => m.id === mode) || ITEMS[0];
  const Icon = current.icon;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="mode-menu" ref={root}>
      <button type="button" className="mode-pill" onClick={() => setOpen((v) => !v)}>
        <Icon size={14} />
        <span>{current.label}</span>
        <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="mode-pop">
          {ITEMS.map((item) => {
            const ItemIcon = item.icon;
            const active = item.id === mode;
            return (
              <button
                key={item.id}
                type="button"
                className={`mode-item ${active ? "on" : ""}`}
                onClick={() => {
                  onMode(item.id);
                  setOpen(false);
                }}
              >
                <ItemIcon size={15} />
                <span className="lab">{item.label}</span>
                {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
                {active ? <Check size={14} /> : <span className="mode-gap" />}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
