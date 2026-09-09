/// <reference types="vite/client" />

export type DesktopAPI = {
  platform: string;
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  onOpenSettings?: (cb: () => void) => () => void;
};

declare global {
  interface Window {
    desktop?: DesktopAPI;
  }
}

export {};
