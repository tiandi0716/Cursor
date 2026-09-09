import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, Menu, shell, ipcMain, dialog } from "electron";
import { startAppServer } from "../src/server.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.ELECTRON_RENDERER_URL) && !app.isPackaged;

app.setName("Cursor 代理");
app.setPath("userData", join(app.getPath("appData"), "cursor-proxy"));

let mainWindow: BrowserWindow | null = null;
let stopServer: (() => Promise<void>) | null = null;
let startUrl = process.env.ELECTRON_RENDERER_URL || "";

function createMenu() {
  const isMac = process.platform === "darwin";
  const openSettings = () => mainWindow?.webContents.send("open-settings");
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
            ]),
        ...(isMac ? [] : [{ type: "separator" as const }, { role: "quit" as const }]),
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 820,
    height: 720,
    minWidth: 640,
    minHeight: 560,
    backgroundColor: "#181818",
    show: false,
    title: "Cursor 代理",
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

  await mainWindow.loadURL(startUrl);
}

ipcMain.on("win:minimize", () => mainWindow?.minimize());
ipcMain.on("win:maximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on("win:close", () => mainWindow?.close());

app.whenReady().then(async () => {
  createMenu();
  try {
    if (!isDev) {
      const distDir = join(app.getAppPath(), "dist");
      const started = await startAppServer({ distDir });
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
