/// <reference types="vite/client" />

export type DesktopAPI = {
  platform: string;
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  openFolder?: () => Promise<string | null>;
  getPathForFile?: (file: File) => string;
  onOpenSettings?: (cb: () => void) => () => void;
  onOpenFolder?: (cb: () => void) => () => void;
  showInFolder?: (path: string) => Promise<{ ok: boolean }>;
  openTerminal?: (dir: string) => Promise<{ ok: boolean; error?: string }>;
};

declare global {
  interface Window {
    desktop?: DesktopAPI;
  }
}
