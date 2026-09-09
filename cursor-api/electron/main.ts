import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, shell, ipcMain, dialog } from "electron";
import { startAppServer } from "../server/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.ELECTRON_RENDERER_URL) && !app.isPackaged;

app.setName("Cursor");
app.setPath("userData", join(app.getPath("appData"), "cursor-ui"));

let mainWindow: BrowserWindow | null = null;
let stopServer: (() => Promise<void>) | null = null;
let startUrl = process.env.ELECTRON_RENDERER_URL || "";

function isReloadShortcut(input: Electron.Input) {
  const key = String(input.key || "").toLowerCase();
  if (key === "f5") return true;
  return Boolean((input.control || input.meta) && key === "r");
}

function createMenu() {
  const isMac = process.platform === "darwin";
  const openSettings = () => mainWindow?.webContents.send("open-settings");
  const openFolder = () => mainWindow?.webContents.send("open-folder");
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              {
                label: "Settings…",
                accelerator: "CmdOrCtrl+,",
                click: openSettings,
              },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: isMac ? "File" : "文件",
      submenu: [
        ...(isMac
          ? []
          : [
              {
                label: "设置",
                accelerator: "CmdOrCtrl+,",
                click: openSettings,
              } as Electron.MenuItemConstructorOptions,
              { type: "separator" as const },
            ]),
        {
          label: isMac ? "Open Folder…" : "打开文件夹…",
          accelerator: "CmdOrCtrl+O",
          click: openFolder,
        },
        ...(isMac
          ? []
          : [{ type: "separator" as const }, { role: "quit" as const }]),
      ],
    },
    { role: "editMenu" },
    {
      label: isMac ? "View" : "查看",
      submenu: [
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#181818",
    show: false,
    title: "Cursor",
    autoHideMenuBar: process.platform === "win32",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 11 } }
      : { frame: false }),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file:")) event.preventDefault();
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (isReloadShortcut(input)) event.preventDefault();
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("renderer gone", details);
    if (details.reason === "clean-exit") return;
    if (mainWindow && !mainWindow.isDestroyed()) void mainWindow.reload();
  });
  await mainWindow.loadURL(startUrl);
}

ipcMain.on("win:minimize", () => mainWindow?.minimize());
ipcMain.on("win:maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on("win:close", () => mainWindow?.close());

ipcMain.handle("dialog:openFolder", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle("shell:showItemInFolder", (_event, target: string) => {
  if (typeof target !== "string" || !target.trim()) return { ok: false };
  shell.showItemInFolder(target);
  return { ok: true };
});

ipcMain.handle("shell:openTerminal", (_event, dir: string) => {
  if (typeof dir !== "string" || !dir.trim()) return { ok: false, error: "缺少目录" };
  try {
    openExternalTerminal(dir);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

function openExternalTerminal(dir: string) {
  if (process.platform === "darwin") {
    spawn("open", ["-a", "Terminal", dir], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/K"], {
      cwd: dir,
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    }).unref();
    return;
  }
  const candidates = [
    process.env.TERMINAL,
    "x-terminal-emulator",
    "gnome-terminal",
    "konsole",
    "xfce4-terminal",
    "xterm",
  ].filter((cmd): cmd is string => Boolean(cmd));
  const cmd = candidates[0] || "xterm";
  spawn(cmd, { cwd: dir, detached: true, stdio: "ignore" }).unref();
}

app.whenReady().then(async () => {
  createMenu();
  try {
    if (!isDev) {
      const distDir = join(app.getAppPath(), "dist");
      const started = await startAppServer({ port: 0, distDir });
      stopServer = started.close;
      startUrl = `http://${started.host}:${started.port}`;
    }
    await createWindow();
  } catch (err) {
    dialog.showErrorBox("启动失败", err instanceof Error ? err.message : String(err));
    app.quit();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void stopServer?.();
});
