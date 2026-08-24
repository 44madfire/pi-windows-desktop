import type { DesktopApi } from '../shared/ipc';

declare global {
  interface Window {
    piDesktop: DesktopApi;
  }
}

export {};
