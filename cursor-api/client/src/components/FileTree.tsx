import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  FILE_DRAG_TYPE,
  createEntry,
  deleteEntry,
  getTree,
  pasteEntry,
  renameEntry,
  resolveEntry,
  type ChatAttachment,
  type FsNode,
} from "../api";

type Props = {
  activePath?: string;
  onOpen: (path: string) => void;
  refreshKey: number;
  onChanged?: () => void;
  onPathGone?: (path: string) => void;
  onRenamed?: (from: string, to: string, isDir: boolean) => void;
};

export type FileTreeHandle = {
  newFile: () => void;
  newFolder: () => void;
  collapseAll: () => void;
};

type Creating = { parent: string; kind: "file" | "dir" };
type Clip = { mode: "copy" | "cut"; path: string; isDir: boolean };
type MenuState = { x: number; y: number; path: string; isDir: boolean };

type TreeCtx = {
  activePath?: string;
  creating: Creating | null;
  renaming: string | null;
  cutPath: string | null;
  collapseTick: number;
  refreshKey: number;
  onOpen: (path: string) => void;
  onSelect: (path: string, isDir: boolean) => void;
  onCreate: (parent: string, kind: "file" | "dir", name: string) => Promise<void>;
  onCancelCreate: () => void;
  onRename: (path: string, name: string) => Promise<void>;
  onCancelRename: () => void;
  onContext: (e: ReactMouseEvent, target: { path: string; isDir: boolean }) => void;
};

const FileTreeCtx = createContext<TreeCtx | null>(null);

function parentOf(selected: { path: string; isDir: boolean } | null) {
  if (!selected || !selected.path) return "";
  if (selected.isDir) return selected.path;
  const i = selected.path.lastIndexOf("/");
  return i >= 0 ? selected.path.slice(0, i) : "";
}

function destDirOf(target: { path: string; isDir: boolean } | null) {
  return parentOf(target);
}

function isMac() {
  return window.desktop?.platform === "darwin" || /Mac/i.test(navigator.platform);
}

function isTypingTarget(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  if (!t) return false;
  return Boolean(t.closest("input, textarea, [contenteditable='true']"));
}

async function writeClipboard(text: string) {
  await navigator.clipboard.writeText(text);
}

export const FileTree = forwardRef<FileTreeHandle, Props>(function FileTree(
  { activePath, onOpen, refreshKey, onChanged, onPathGone, onRenamed },
  ref,
) {
  const wrap = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<FsNode[]>([]);
  const [error, setError] = useState("");
  const [opError, setOpError] = useState("");
  const [selected, setSelected] = useState<{ path: string; isDir: boolean } | null>(null);
  const [creating, setCreating] = useState<Creating | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [collapseTick, setCollapseTick] = useState(0);
  const selectedRef = useRef(selected);
  const clipRef = useRef(clip);
  selectedRef.current = selected;
  clipRef.current = clip;

  useEffect(() => {
    let cancelled = false;
    getTree("")
      .then((d) => {
        if (cancelled) return;
        setRoot(d.children);
        setError("");
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  useEffect(() => {
    if (!activePath) return;
    setSelected({ path: activePath, isDir: false });
  }, [activePath]);

  const fail = (e: unknown) => {
    setOpError(e instanceof Error ? e.message : String(e));
  };

  const startCreate = useCallback((parent: string, kind: "file" | "dir") => {
    setMenu(null);
    setRenaming(null);
    setOpError("");
    setCreating({ parent, kind });
  }, []);

  useImperativeHandle(ref, () => ({
    newFile: () => startCreate(parentOf(selectedRef.current), "file"),
    newFolder: () => startCreate(parentOf(selectedRef.current), "dir"),
    collapseAll: () => {
      setCreating(null);
      setRenaming(null);
      setMenu(null);
      setCollapseTick((n) => n + 1);
    },
  }));

  const submitCreate = async (parent: string, kind: "file" | "dir", name: string) => {
    const path = parent ? `${parent}/${name}` : name;
    const created = await createEntry(path, kind === "dir");
    setCreating(null);
    setSelected({ path: created.path, isDir: created.isDir });
    onChanged?.();
    if (!created.isDir) onOpen(created.path);
  };

  const submitRename = async (path: string, name: string) => {
    const next = await renameEntry(path, name);
    setRenaming(null);
    setSelected({ path: next.path, isDir: next.isDir });
    if (clipRef.current?.path === path) {
      setClip({ ...clipRef.current, path: next.path, isDir: next.isDir });
    }
    onRenamed?.(path, next.path, next.isDir);
    onChanged?.();
  };

  const copyPaths = async (path: string, relative: boolean) => {
    if (relative) {
      await writeClipboard(path || ".");
      return;
    }
    const info = await resolveEntry(path);
    await writeClipboard(info.abs);
  };

  const reveal = async (path: string) => {
    const info = await resolveEntry(path);
    if (window.desktop?.showInFolder) {
      await window.desktop.showInFolder(info.abs);
      return;
    }
    await writeClipboard(info.abs);
  };

  const openTerm = async (path: string) => {
    const info = await resolveEntry(path);
    if (window.desktop?.openTerminal) {
      const result = await window.desktop.openTerminal(info.dir);
      if (!result.ok) throw new Error(result.error || "无法打开终端");
      return;
    }
    await writeClipboard(`cd ${JSON.stringify(info.dir)}`);
  };

  const doPaste = async (dest: { path: string; isDir: boolean } | null) => {
    const item = clipRef.current;
    if (!item) return;
    const destDir = destDirOf(dest);
    const next = await pasteEntry(item.path, destDir, item.mode);
    if (item.mode === "cut") {
      if (next.path !== item.path) onRenamed?.(item.path, next.path, next.isDir);
      setClip(null);
    }
    setSelected({ path: next.path, isDir: next.isDir });
    onChanged?.();
  };

  const doDelete = async (target: { path: string; isDir: boolean } | null) => {
    if (!target?.path) return;
    const kind = target.isDir ? "文件夹" : "文件";
    if (!window.confirm(`确定删除${kind}「${target.path.split("/").pop()}」？此操作不可撤销。`)) return;
    await deleteEntry(target.path);
    if (clipRef.current?.path === target.path) setClip(null);
    setSelected(null);
    onPathGone?.(target.path);
    onChanged?.();
  };

  const run = async (fn: () => Promise<void>) => {
    setOpError("");
    try {
      await fn();
    } catch (e) {
      fail(e);
    }
  };

  const opsRef = useRef({
    copyPaths,
    reveal,
    doPaste,
    doDelete,
    run,
    setClip,
    setMenu,
    setCreating,
    setRenaming,
  });
  opsRef.current = {
    copyPaths,
    reveal,
    doPaste,
    doDelete,
    run,
    setClip,
    setMenu,
    setCreating,
    setRenaming,
  };

  const openMenu = (e: ReactMouseEvent, target: { path: string; isDir: boolean }) => {
    e.preventDefault();
    e.stopPropagation();
    setCreating(null);
    setRenaming(null);
    setSelected(target.path ? target : null);
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 260),
      y: Math.min(e.clientY, window.innerHeight - 420),
      ...target,
    });
  };

  useEffect(() => {
    if (!menu) return;
    const close = (ev: Event) => {
      const el = ev.target as HTMLElement | null;
      if (el?.closest(".ctx-menu")) return;
      setMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setMenu(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!wrap.current?.contains(e.target as Node)) return;
      if (isTypingTarget(e.target)) return;
      const mac = isMac();
      const mod = mac ? e.metaKey : e.ctrlKey;
      const cur = selectedRef.current;
      const hasTarget = Boolean(cur?.path);

      const ops = opsRef.current;
      if (mod && e.altKey && e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        if (cur) void ops.run(() => ops.copyPaths(cur.path, true));
        return;
      }
      if (mod && e.altKey && !e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        if (cur) void ops.run(() => ops.copyPaths(cur.path, false));
        return;
      }
      if (mod && e.altKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        if (cur) void ops.run(() => ops.reveal(cur.path));
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "x") {
        e.preventDefault();
        if (hasTarget && cur) ops.setClip({ mode: "cut", path: cur.path, isDir: cur.isDir });
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "c") {
        e.preventDefault();
        if (hasTarget && cur) ops.setClip({ mode: "copy", path: cur.path, isDir: cur.isDir });
        return;
      }
      if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "v") {
        e.preventDefault();
        void ops.run(() => ops.doPaste(cur));
        return;
      }
      if ((mac && mod && e.key === "Backspace") || e.key === "Delete") {
        e.preventDefault();
        void ops.run(() => ops.doDelete(cur));
        return;
      }
      if (e.key === "F2" || (e.key === "Enter" && !mod && !e.altKey)) {
        if (!hasTarget || !cur) return;
        e.preventDefault();
        ops.setMenu(null);
        ops.setCreating(null);
        ops.setRenaming(cur.path);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const ctx: TreeCtx = {
    activePath: selected?.path || activePath,
    creating,
    renaming,
    cutPath: clip?.mode === "cut" ? clip.path : null,
    collapseTick,
    refreshKey,
    onOpen: (path) => {
      setSelected({ path, isDir: false });
      onOpen(path);
    },
    onSelect: (path, isDir) => setSelected({ path, isDir }),
    onCreate: submitCreate,
    onCancelCreate: () => setCreating(null),
    onRename: submitRename,
    onCancelRename: () => setRenaming(null),
    onContext: openMenu,
  };

  const mac = isMac();
  const revealLabel = mac ? "在 Finder 中显示" : "在资源管理器中显示";
  const menuTarget = menu ? { path: menu.path, isDir: menu.isDir } : null;
  const canMutate = Boolean(menu?.path);
  const pasteDisabled = !clip;

  return (
    <FileTreeCtx.Provider value={ctx}>
      <div
        ref={wrap}
        className="file-tree"
        tabIndex={0}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest(".tree-row, .ctx-menu")) return;
          openMenu(e, { path: "", isDir: true });
        }}
      >
        {error ? <div className="empty">{error}</div> : null}
        {opError ? <div className="tree-op-err">{opError}</div> : null}
        {!error && !root.length && !creating ? (
          <div className="empty">工作区是空的。右键或点上方按钮新建文件。</div>
        ) : null}
        {creating?.parent === "" ? (
          <CreateRow
            depth={0}
            kind={creating.kind}
            onSubmit={(name) => submitCreate("", creating.kind, name)}
            onCancel={() => setCreating(null)}
          />
        ) : null}
        {root.map((n) => (
          <TreeNode key={n.path} node={n} depth={0} />
        ))}
      </div>
      {menu
        ? createPortal(
            <div
              className="ctx-menu"
              style={{ left: menu.x, top: menu.y }}
              onMouseDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <MenuItem
                label="新建文件..."
                onClick={() => startCreate(menu.isDir ? menu.path : parentOf(menuTarget), "file")}
              />
              <MenuItem
                label="新建文件夹..."
                onClick={() => startCreate(menu.isDir ? menu.path : parentOf(menuTarget), "dir")}
              />
              <MenuItem
                label={revealLabel}
                shortcut={mac ? "⌥⌘R" : "Alt+Ctrl+R"}
                onClick={() => {
                  setMenu(null);
                  void run(() => reveal(menu.path));
                }}
              />
              <MenuItem
                label="在集成终端中打开"
                onClick={() => {
                  setMenu(null);
                  void run(() => openTerm(menu.path));
                }}
              />
              <div className="ctx-sep" />
              <MenuItem
                label="剪切"
                shortcut={mac ? "⌘X" : "Ctrl+X"}
                disabled={!canMutate}
                onClick={() => {
                  if (!menu.path) return;
                  setClip({ mode: "cut", path: menu.path, isDir: menu.isDir });
                  setMenu(null);
                }}
              />
              <MenuItem
                label="复制"
                shortcut={mac ? "⌘C" : "Ctrl+C"}
                disabled={!canMutate}
                onClick={() => {
                  if (!menu.path) return;
                  setClip({ mode: "copy", path: menu.path, isDir: menu.isDir });
                  setMenu(null);
                }}
              />
              <MenuItem
                label="粘贴"
                shortcut={mac ? "⌘V" : "Ctrl+V"}
                disabled={pasteDisabled}
                onClick={() => {
                  setMenu(null);
                  void run(() => doPaste(menuTarget));
                }}
              />
              <div className="ctx-sep" />
              <MenuItem
                label="复制路径"
                shortcut={mac ? "⌥⌘C" : "Alt+Ctrl+C"}
                onClick={() => {
                  setMenu(null);
                  void run(() => copyPaths(menu.path, false));
                }}
              />
              <MenuItem
                label="复制相对路径"
                shortcut={mac ? "⇧⌥⌘C" : "Shift+Alt+Ctrl+C"}
                onClick={() => {
                  setMenu(null);
                  void run(() => copyPaths(menu.path, true));
                }}
              />
              <div className="ctx-sep" />
              <MenuItem
                label="重命名..."
                shortcut={mac ? "↩" : "F2"}
                disabled={!canMutate}
                onClick={() => {
                  if (!menu.path) return;
                  setCreating(null);
                  setRenaming(menu.path);
                  setMenu(null);
                }}
              />
              <MenuItem
                label="删除"
                shortcut={mac ? "⌘⌫" : "Delete"}
                danger
                disabled={!canMutate}
                onClick={() => {
                  setMenu(null);
                  void run(() => doDelete(menuTarget));
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </FileTreeCtx.Provider>
  );
});

function MenuItem({
  label,
  shortcut,
  disabled,
  danger,
  onClick,
}: {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`ctx-item ${danger ? "danger" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      <span>{label}</span>
      {shortcut ? <span className="ctx-k">{shortcut}</span> : null}
    </button>
  );
}

function startFileDrag(e: DragEvent, node: FsNode) {
  const payload: ChatAttachment = { path: node.path, name: node.name, isDir: node.isDir };
  e.dataTransfer.setData(FILE_DRAG_TYPE, JSON.stringify(payload));
  e.dataTransfer.setData("text/plain", node.path);
  e.dataTransfer.effectAllowed = "copy";
}

function CreateRow({
  depth,
  kind,
  initial = "",
  onSubmit,
  onCancel,
}: {
  depth: number;
  kind: "file" | "dir";
  initial?: string;
  onSubmit: (name: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [err, setErr] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    input.current?.focus();
    if (initial) input.current?.select();
  }, [initial]);

  const finish = async (submit: boolean) => {
    if (done.current) return;
    const value = name.trim();
    if (!submit || !value || value === initial) {
      done.current = true;
      onCancel();
      return;
    }
    done.current = true;
    try {
      await onSubmit(value);
    } catch (e) {
      done.current = false;
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div>
      <div className="tree-row creating" style={{ paddingLeft: 20 + depth * 12 }}>
        {kind === "dir" ? <Folder size={14} color="#c09553" /> : <File size={14} color="#8a8a8a" />}
        <input
          ref={input}
          className="tree-input"
          value={name}
          placeholder={kind === "dir" ? "文件夹名" : "文件名"}
          onChange={(e) => {
            setName(e.target.value);
            setErr("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              void finish(true);
            }
            if (e.key === "Escape") {
              e.preventDefault();
              void finish(false);
            }
          }}
          onBlur={() => void finish(Boolean(name.trim()) && name.trim() !== initial)}
        />
      </div>
      {err ? <div className="tree-create-err">{err}</div> : null}
    </div>
  );
}

function TreeNode({ node, depth }: { node: FsNode; depth: number }) {
  const ctx = useContext(FileTreeCtx);
  if (!ctx) return null;
  const {
    activePath,
    creating,
    renaming,
    cutPath,
    collapseTick,
    refreshKey,
    onOpen,
    onSelect,
    onCreate,
    onCancelCreate,
    onRename,
    onCancelRename,
    onContext,
  } = ctx;
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FsNode[] | null>(null);
  const dragging = useRef(false);
  const creatingHere = Boolean(creating && creating.parent === node.path);
  const creatingInside = Boolean(
    creating && (creating.parent === node.path || creating.parent.startsWith(`${node.path}/`)),
  );
  const rowClass = [
    "tree-row",
    activePath === node.path ? "active" : "",
    cutPath === node.path ? "cut" : "",
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    if (!collapseTick) return;
    setOpen(false);
  }, [collapseTick]);

  useEffect(() => {
    if (creatingInside) setOpen(true);
  }, [creatingInside]);

  useEffect(() => {
    if (!node.isDir || !open) return;
    let cancelled = false;
    getTree(node.path)
      .then((d) => {
        if (!cancelled) setChildren(d.children);
      })
      .catch(() => {
        if (!cancelled) setChildren([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, node.path, refreshKey]);

  const renameRow = renaming === node.path ? (
    <CreateRow
      depth={depth}
      kind={node.isDir ? "dir" : "file"}
      initial={node.name}
      onSubmit={(name) => onRename(node.path, name)}
      onCancel={onCancelRename}
    />
  ) : null;

  if (node.isDir) {
    return (
      <div>
        {renameRow || (
          <button
            type="button"
            className={rowClass}
            title={`${node.path}\n拖到右侧输入框可附加到对话`}
            draggable
            style={{ paddingLeft: 6 + depth * 12 }}
            onDragStart={(e) => {
              dragging.current = true;
              startFileDrag(e, node);
            }}
            onDragEnd={() => {
              window.setTimeout(() => {
                dragging.current = false;
              }, 0);
            }}
            onClick={() => {
              if (dragging.current) return;
              onSelect(node.path, true);
              setOpen((v) => !v);
            }}
            onContextMenu={(e) => onContext(e, { path: node.path, isDir: true })}
          >
            <span className="chev">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
            {open ? <FolderOpen size={14} color="#c09553" /> : <Folder size={14} color="#c09553" />}
            <span className="name">{node.name}</span>
          </button>
        )}
        {open ? (
          <>
            {creatingHere ? (
              <CreateRow
                depth={depth + 1}
                kind={creating!.kind}
                onSubmit={(name) => onCreate(node.path, creating!.kind, name)}
                onCancel={onCancelCreate}
              />
            ) : null}
            {children?.map((c) => (
              <TreeNode key={c.path} node={c} depth={depth + 1} />
            ))}
          </>
        ) : null}
      </div>
    );
  }

  if (renameRow) return renameRow;

  return (
    <button
      type="button"
      className={rowClass}
      title={`${node.path}\n拖到右侧输入框可附加到对话`}
      draggable
      style={{ paddingLeft: 20 + depth * 12 }}
      onDragStart={(e) => {
        dragging.current = true;
        startFileDrag(e, node);
      }}
      onDragEnd={() => {
        window.setTimeout(() => {
          dragging.current = false;
        }, 0);
      }}
      onClick={() => {
        if (dragging.current) return;
        onOpen(node.path);
      }}
      onContextMenu={(e) => onContext(e, { path: node.path, isDir: false })}
    >
      <File size={14} color="#8a8a8a" />
      <span className="name">{node.name}</span>
    </button>
  );
}
