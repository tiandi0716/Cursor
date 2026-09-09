import { execFile } from "node:child_process";
import { watch, existsSync, mkdirSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import { copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";

const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  "__pycache__",
  ".idea",
  ".DS_Store",
  "target",
  ".turbo",
  ".cache",
]);

export function resolveUnder(root: string, rel = ""): string {
  const base = resolve(root);
  const target = resolve(base, rel || ".");
  const relToBase = relative(base, target);
  if (relToBase.startsWith("..") || relToBase === "..") {
    throw new Error("路径超出工作区");
  }
  return target;
}

export async function listTree(root: string, rel = "") {
  const dir = resolveUnder(root, rel);
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => !SKIP.has(entry.name) && entry.name !== ".DS_Store")
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-CN");
    })
    .map((entry) => ({
      name: entry.name,
      path: rel ? `${rel}/${entry.name}` : entry.name,
      isDir: entry.isDirectory(),
    }));
}

export async function browse(rawPath: string) {
  const target = rawPath ? resolve(rawPath) : homedir();
  const info = await stat(target);
  if (!info.isDirectory()) throw new Error("不是目录");
  const entries = await readdir(target, { withFileTypes: true });
  const parent = dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    entries: entries
      .filter((e) => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"))
      .slice(0, 400)
      .map((e) => ({ name: e.name, path: join(target, e.name), isDir: true })),
  };
}

export async function readWorkspaceFile(root: string, rel: string) {
  const file = resolveUnder(root, rel);
  const info = await stat(file);
  if (info.isDirectory()) throw new Error("是目录");
  if (info.size > 2 * 1024 * 1024) throw new Error("文件超过 2MB，请用系统编辑器打开");
  const content = await readFile(file, "utf8");
  return { path: rel, content, size: info.size };
}

export async function readWorkspaceTextOptional(root: string, rel: string) {
  try {
    const info = await readWorkspaceFile(root, rel);
    return info.content;
  } catch {
    return null;
  }
}

export function toWorkspaceRel(root: string, raw: string) {
  const p = String(raw || "").trim().replaceAll("\\", "/");
  if (!p) return null;
  if (p.startsWith("/")) return relIfInside(root, p);
  try {
    resolveUnder(root, p);
    return normalizeRel(p);
  } catch {
    return relIfInside(root, p);
  }
}

export async function writeWorkspaceFile(root: string, rel: string, content: string) {
  const file = resolveUnder(root, rel);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return { path: rel };
}

export async function createWorkspaceEntry(root: string, rel: string, isDir: boolean) {
  const name = basename(rel);
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) {
    throw new Error("名称不合法");
  }
  const target = resolveUnder(root, rel);
  if (existsSync(target)) throw new Error("已存在同名文件或文件夹");
  if (isDir) {
    await mkdir(target, { recursive: true });
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "", "utf8");
  }
  return { path: normalizeRel(rel), name, isDir };
}

function dirnameRel(rel: string) {
  const i = rel.replaceAll("\\", "/").lastIndexOf("/");
  return i >= 0 ? rel.slice(0, i) : "";
}

function joinRel(parent: string, name: string) {
  return parent ? `${parent}/${name}` : name;
}

export async function deleteWorkspaceEntry(root: string, rel: string) {
  if (!String(rel || "").trim()) throw new Error("不能删除工作区根目录");
  const target = resolveUnder(root, rel);
  await rm(target, { recursive: true });
  return { ok: true };
}

export async function renameWorkspaceEntry(root: string, from: string, name: string) {
  const newName = basename(name.trim());
  if (!newName || newName === "." || newName === ".." || /[\\/]/.test(newName)) {
    throw new Error("名称不合法");
  }
  const src = resolveUnder(root, from);
  const destRel = joinRel(dirnameRel(from), newName);
  const dest = resolveUnder(root, destRel);
  if (src === dest) {
    const info = await stat(src);
    return { path: normalizeRel(from), name: newName, isDir: info.isDirectory() };
  }
  if (existsSync(dest)) throw new Error("已存在同名文件或文件夹");
  await rename(src, dest);
  const info = await stat(dest);
  return { path: normalizeRel(destRel), name: newName, isDir: info.isDirectory() };
}

export async function pasteWorkspaceEntry(
  root: string,
  from: string,
  destDir: string,
  mode: "copy" | "cut",
) {
  const src = resolveUnder(root, from);
  const parent = resolveUnder(root, destDir || "");
  const srcInfo = await stat(src);
  const parentInfo = await stat(parent);
  if (!parentInfo.isDirectory()) throw new Error("目标不是文件夹");
  const base = basename(from);
  if (srcInfo.isDirectory() && (parent === src || parent.startsWith(src + sep))) {
    throw new Error(mode === "cut" ? "不能移动到自身内部" : "不能复制到自身内部");
  }
  if (mode === "cut" && dirname(src) === parent) {
    return { path: normalizeRel(from), name: base, isDir: srcInfo.isDirectory() };
  }
  let destName = base;
  if (existsSync(join(parent, destName))) destName = await uniqueDest(parent, base);
  const dest = join(parent, destName);
  if (mode === "cut") await rename(src, dest);
  else if (srcInfo.isDirectory()) await cp(src, dest, { recursive: true });
  else await copyFile(src, dest);
  return { path: normalizeRel(joinRel(destDir, destName)), name: destName, isDir: srcInfo.isDirectory() };
}

export async function resolveWorkspaceEntry(root: string, rel: string) {
  const abs = resolveUnder(root, rel || "");
  const info = await stat(abs);
  return {
    abs,
    dir: info.isDirectory() ? abs : dirname(abs),
    rel: normalizeRel(rel || ""),
    name: rel ? basename(rel) : basename(root),
    isDir: info.isDirectory(),
  };
}

export type SearchHit = {
  path: string;
  name: string;
  matches: Array<{ line: number; text: string }>;
};

function rgGlobs() {
  return [...SKIP].flatMap((name) => ["--glob", `!${name}`]);
}

function runExec(cmd: string, args: string[], cwd: string, timeout: number) {
  return new Promise<{ stdout: string; code: number }>((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      const code =
        err && typeof (err as { code?: unknown }).code === "number"
          ? Number((err as { code: number }).code)
          : err
            ? 1
            : 0;
      if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout || ""), code });
    });
  });
}

function toRel(root: string, raw: string) {
  const abs = raw.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(raw) ? raw : join(root, raw);
  return relIfInside(root, abs);
}

function addHit(map: Map<string, SearchHit>, rel: string | null, match?: { line: number; text: string }) {
  if (!rel) return;
  const path = normalizeRel(rel);
  if (!path) return;
  let hit = map.get(path);
  if (!hit) {
    hit = { path, name: basename(path), matches: [] };
    map.set(path, hit);
  }
  if (match && hit.matches.length < 20) hit.matches.push(match);
}

async function searchWithRg(root: string, query: string): Promise<SearchHit[] | null> {
  const map = new Map<string, SearchHit>();
  const needle = query.replace(/[\\*?[\]{}]/g, "");
  try {
    if (needle) {
      const files = await runExec(
        "rg",
        ["--files", "-i", "--glob", `*${needle}*`, ...rgGlobs()],
        root,
        5000,
      );
      for (const line of files.stdout.split("\n")) {
        const raw = line.trim();
        if (!raw) continue;
        addHit(map, toRel(root, raw));
        if (map.size >= 80) break;
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
  }

  try {
    const content = await runExec(
      "rg",
      ["--json", "-i", "--max-count", "12", "--max-filesize", "1M", ...rgGlobs(), query, root],
      root,
      8000,
    );
    for (const line of content.stdout.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const row = JSON.parse(line) as {
          type?: string;
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
        };
        if (row.type !== "match" || !row.data?.path?.text) continue;
        const rel = toRel(root, row.data.path.text);
        const text = String(row.data.lines?.text || "").replace(/\n$/, "");
        addHit(map, rel, { line: Number(row.data.line_number || 0), text: text.slice(0, 200) });
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
  }
  return [...map.values()].slice(0, 120);
}

async function searchByWalk(root: string, query: string): Promise<SearchHit[]> {
  const map = new Map<string, SearchHit>();
  const q = query.toLowerCase();
  const started = Date.now();

  async function walk(dir: string, rel: string) {
    if (map.size >= 80 || Date.now() - started > 6000) return;
    let entries: Awaited<ReturnType<typeof readdir>>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name) || entry.name === ".DS_Store") continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase().includes(q)) addHit(map, childRel);
        await walk(childAbs, childRel);
        continue;
      }
      if (entry.name.toLowerCase().includes(q)) addHit(map, childRel);
      try {
        const info = await stat(childAbs);
        if (info.size > 1024 * 1024) continue;
        const buf = await readFile(childAbs);
        if (buf.includes(0)) continue;
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!lines[i].toLowerCase().includes(q)) continue;
          addHit(map, childRel, { line: i + 1, text: lines[i].trim().slice(0, 200) });
          if ((map.get(childRel)?.matches.length || 0) >= 8) break;
        }
      } catch {
        /* ignore */
      }
    }
  }

  await walk(root, "");
  return [...map.values()].slice(0, 120);
}

export async function searchWorkspace(root: string, query: string): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  if (q.length > 80) throw new Error("关键字过长");
  const fromRg = await searchWithRg(root, q);
  if (fromRg) return fromRg;
  return searchByWalk(root, q);
}

export function normalizeRel(p: string) {
  return normalize(p).split(sep).join("/");
}

export function relIfInside(root: string, abs: string): string | null {
  const base = resolve(root);
  const target = resolve(abs);
  const rel = relative(base, target);
  if (rel.startsWith("..") || rel === "..") return null;
  return normalizeRel(rel);
}

async function uniqueDest(dir: string, name: string) {
  let destName = name;
  let i = 1;
  while (existsSync(join(dir, destName))) {
    const ext = extname(name);
    const stem = ext ? name.slice(0, -ext.length) : name;
    destName = `${stem}-${i}${ext}`;
    i += 1;
  }
  return destName;
}

export async function importDroppedPaths(root: string, absPaths: string[]) {
  const uploads = join(root, "uploads");
  const out: { path: string; name: string; isDir: boolean }[] = [];
  for (const raw of absPaths) {
    const abs = resolve(String(raw || "").trim());
    if (!abs) continue;
    const info = await stat(abs);
    const inside = relIfInside(root, abs);
    if (inside !== null) {
      out.push({
        path: inside || basename(abs),
        name: basename(abs),
        isDir: info.isDirectory(),
      });
      continue;
    }
    if (!info.isDirectory() && info.size > 50 * 1024 * 1024) {
      throw new Error(`${basename(abs)} 超过 50MB，无法导入`);
    }
    await mkdir(uploads, { recursive: true });
    const destName = await uniqueDest(uploads, basename(abs));
    const dest = join(uploads, destName);
    if (info.isDirectory()) {
      await cp(abs, dest, { recursive: true });
    } else {
      await copyFile(abs, dest);
    }
    out.push({ path: `uploads/${destName}`, name: destName, isDir: info.isDirectory() });
  }
  return out;
}

type FsChangeListener = () => void;
const fsListeners = new Set<FsChangeListener>();
let fsWatcher: FSWatcher | null = null;
let watchedRoot = "";
let fsDebounce: ReturnType<typeof setTimeout> | null = null;

function emitFsChange() {
  if (fsDebounce) clearTimeout(fsDebounce);
  fsDebounce = setTimeout(() => {
    for (const fn of fsListeners) fn();
  }, 120);
}

export function subscribeWorkspace(listener: FsChangeListener) {
  fsListeners.add(listener);
  return () => {
    fsListeners.delete(listener);
  };
}

export function watchWorkspace(root: string) {
  const abs = resolve(root);
  if (!existsSync(abs)) {
    try {
      mkdirSync(abs, { recursive: true });
    } catch {
      return;
    }
  }
  if (watchedRoot === abs && fsWatcher) return;
  try {
    fsWatcher?.close();
  } catch {
    /* ignore */
  }
  fsWatcher = null;
  watchedRoot = abs;
  try {
    fsWatcher = watch(abs, { recursive: true }, (_event, filename) => {
      const parts = String(filename || "").split(/[/\\]/);
      if (parts.some((p) => SKIP.has(p))) return;
      emitFsChange();
    });
    fsWatcher.on("error", () => {
      fsWatcher = null;
    });
  } catch {
    fsWatcher = null;
  }
}
