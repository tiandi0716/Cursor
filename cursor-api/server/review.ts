export type FileReview = {
  path: string;
  before: string | null;
  after: string | null;
  added: number;
  removed: number;
  status: "pending" | "kept" | "undone";
};

const store = new Map<string, FileReview[]>();
const beforeCache = new Map<string, Map<string, string | null>>();
const beforeLock = new Map<string, Map<string, Promise<string | null>>>();

function lcsLength(a: string[], b: string[]) {
  if (a.length * b.length > 250_000) {
    return Math.min(a.length, b.length);
  }
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : prev[j] > cur[j - 1] ? prev[j] : cur[j - 1];
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
    cur.fill(0);
  }
  return prev[b.length];
}

export function diffStats(before: string | null, after: string | null) {
  if (before == null && after == null) return { added: 0, removed: 0 };
  if (before == null) return { added: (after || "").split("\n").length, removed: 0 };
  if (after == null) return { added: 0, removed: before.split("\n").length };
  if (before === after) return { added: 0, removed: 0 };
  const a = before.split("\n");
  const b = after.split("\n");
  const lcs = lcsLength(a, b);
  return { added: b.length - lcs, removed: a.length - lcs };
}

export function listReviews(convId: string) {
  return (store.get(convId) || []).slice();
}

export function pendingReviews(convId: string) {
  return listReviews(convId).filter((r) => r.status === "pending");
}

export function upsertReview(convId: string, next: Omit<FileReview, "status"> & { status?: FileReview["status"] }) {
  const list = store.get(convId) || [];
  const i = list.findIndex((r) => r.path === next.path);
  if (i >= 0) {
    const prev = list[i];
    const before = prev.status === "pending" ? prev.before : next.before;
    const stats = diffStats(before, next.after);
    list[i] = {
      path: next.path,
      before,
      after: next.after,
      added: stats.added,
      removed: stats.removed,
      status: "pending",
    };
  } else {
    const stats = diffStats(next.before, next.after);
    list.push({
      path: next.path,
      before: next.before,
      after: next.after,
      added: stats.added,
      removed: stats.removed,
      status: "pending",
    });
  }
  store.set(convId, list);
  return list[i >= 0 ? i : list.length - 1];
}

export function markReview(convId: string, path: string | undefined, status: "kept" | "undone") {
  const list = store.get(convId) || [];
  const cache = beforeCache.get(convId);
  for (const item of list) {
    if (path && item.path !== path) continue;
    if (status === "kept") {
      if (item.status !== "pending") continue;
      item.status = "kept";
    } else {
      if (item.status === "undone") continue;
      item.status = "undone";
    }
    cache?.delete(item.path);
  }
  store.set(convId, list);
  return listReviews(convId);
}

export function markPendingUndone(convId: string) {
  const list = store.get(convId) || [];
  const cache = beforeCache.get(convId);
  for (const item of list) {
    if (item.status !== "pending") continue;
    item.status = "undone";
    cache?.delete(item.path);
  }
  store.set(convId, list);
  return listReviews(convId);
}

export function cachedBefore(convId: string, path: string) {
  return beforeCache.get(convId)?.get(path);
}

export function rememberBefore(convId: string, path: string, loader: () => Promise<string | null>) {
  const cached = beforeCache.get(convId)?.get(path);
  if (cached !== undefined) return Promise.resolve(cached);
  const existing = (store.get(convId) || []).find((r) => r.path === path && r.status === "pending");
  if (existing) {
    let conv = beforeCache.get(convId);
    if (!conv) {
      conv = new Map();
      beforeCache.set(convId, conv);
    }
    conv.set(path, existing.before);
    return Promise.resolve(existing.before);
  }
  let convLocks = beforeLock.get(convId);
  if (!convLocks) {
    convLocks = new Map();
    beforeLock.set(convId, convLocks);
  }
  const hit = convLocks.get(path);
  if (hit) return hit;
  const task = loader().then((content) => {
    let conv = beforeCache.get(convId);
    if (!conv) {
      conv = new Map();
      beforeCache.set(convId, conv);
    }
    if (!conv.has(path)) conv.set(path, content);
    return conv.get(path) ?? content;
  });
  convLocks.set(path, task);
  return task;
}

export function isMutatingTool(name: string) {
  const n = name.toLowerCase();
  return /write|edit|delete|apply.?patch|str.?replace|search.?replace|create.?file|rm\b|unlink/.test(n);
}

export function pathFromToolArgs(args: unknown) {
  if (!args || typeof args !== "object") return null;
  const o = args as Record<string, unknown>;
  for (const key of ["path", "targetFile", "file", "file_path", "filePath", "filename", "target_file"]) {
    if (typeof o[key] === "string" && o[key].trim()) return o[key].trim();
  }
  if (o.value && typeof o.value === "object") return pathFromToolArgs(o.value);
  return null;
}
