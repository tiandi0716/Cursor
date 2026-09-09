import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("desktop", {
  platform: process.platform,
  minimize: () => ipcRenderer.send("win:minimize"),
  maximize: () => ipcRenderer.send("win:maximize"),
  close: () => ipcRenderer.send("win:close"),
  openFolder: () => ipcRenderer.invoke("dialog:openFolder") as Promise<string | null>,
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  onOpenSettings: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("open-settings", listener);
    return () => ipcRenderer.removeListener("open-settings", listener);
  },
  onOpenFolder: (cb: () => void) => {
    const listener = () => cb();
    ipcRenderer.on("open-folder", listener);
    return () => ipcRenderer.removeListener("open-folder", listener);
  },
  showInFolder: (path: string) =>
    ipcRenderer.invoke("shell:showItemInFolder", path) as Promise<{ ok: boolean }>,
  openTerminal: (dir: string) =>
    ipcRenderer.invoke("shell:openTerminal", dir) as Promise<{ ok: boolean; error?: string }>,
});
