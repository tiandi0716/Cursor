import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let child: ChildProcessWithoutNullStreams | null = null;
let publicOrigin = "";
let lastError = "";
let resolvedBin: string | null | undefined;

function candidateBins() {
  const name = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const home = homedir();
  const dirs = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    "C:\\Program Files\\cloudflared",
    "C:\\Program Files (x86)\\cloudflared",
    ...(process.env.PATH || "").split(delimiter).filter(Boolean),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dir of dirs) {
    const full = join(dir, name);
    if (seen.has(full)) continue;
    seen.add(full);
    out.push(full);
  }
  out.push(name);
  return out;
}

function whichCloudflared() {
  if (resolvedBin) return resolvedBin;
  for (const bin of candidateBins()) {
    try {
      if (bin.includes("/") || bin.includes("\\")) {
        if (!existsSync(bin)) continue;
      }
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      resolvedBin = bin;
      return bin;
    } catch {
      /* try next */
    }
  }
  resolvedBin = null;
  return process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

export function hasCloudflared() {
  if (resolvedBin === undefined) whichCloudflared();
  return Boolean(resolvedBin);
}

export function tunnelStatus() {
  return {
    running: Boolean(child && child.exitCode === null),
    url: publicOrigin,
    error: lastError,
    hasBinary: hasCloudflared(),
  };
}

export function stopTunnel() {
  lastError = "";
  publicOrigin = "";
  const proc = child;
  child = null;
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  setTimeout(() => {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }, 2000);
}

export function startTunnel(port: number): Promise<string> {
  if (child && child.exitCode === null && publicOrigin) return Promise.resolve(publicOrigin);

  stopTunnel();
  lastError = "";

  return new Promise((resolve, reject) => {
    let settled = false;
    const bin = whichCloudflared();
    const proc = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      lastError = "开启隧道超时。请确认已安装 cloudflared（brew install cloudflared）。";
      stopTunnel();
      reject(new Error(lastError));
    }, 45000);

    const onChunk = (buf: Buffer) => {
      const text = buf.toString();
      const line = text.trim();
      if (line) console.log("[cloudflared]", line);
      const match = text.match(URL_RE);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      publicOrigin = match[0].replace(/\/$/, "");
      resolve(publicOrigin);
    };

    proc.stdout.on("data", onChunk);
    proc.stderr.on("data", onChunk);
    proc.on("error", (err) => {
      lastError = err.message.includes("ENOENT")
        ? "未找到 cloudflared。请先执行：brew install cloudflared"
        : err.message;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child = null;
      reject(new Error(lastError));
    });
    proc.on("exit", (code) => {
      if (child === proc) {
        child = null;
        publicOrigin = "";
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lastError = `cloudflared 退出（${code ?? "null"}）`;
      reject(new Error(lastError));
    });
  });
}
