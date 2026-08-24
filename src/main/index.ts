import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiagnosticsReport } from '../shared/diagnostics.js';
import { IPC_CHANNELS, type RuntimeInfo } from '../shared/ipc.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const rendererUrl = process.env.ELECTRON_RENDERER_URL;

let mainWindow: BrowserWindow | undefined;

function getDesktopPlatform(platform: NodeJS.Platform): RuntimeInfo['platform'] {
  switch (platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'unknown';
  }
}

function getRuntimeInfo(): RuntimeInfo {
  return {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node ?? 'unknown',
    platform: getDesktopPlatform(process.platform),
    architecture: process.arch,
  };
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getRuntimeInfo, () => getRuntimeInfo());
  ipcMain.handle(IPC_CHANNELS.getDiagnostics, () =>
    createDiagnosticsReport(getRuntimeInfo()),
  );
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0b1018',
    title: 'Pi Desktop',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Sandboxed Electron preloads are emitted as CommonJS. Keep the
      // renderer-facing API in preload; never expose ipcRenderer itself.
      preload: join(currentDirectory, '../preload/index.cjs'),
    },
  });

  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(currentDirectory, '../renderer/index.html'));
  }

  return window;
}

void app.whenReady().then(() => {
  registerIpcHandlers();
  mainWindow = createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
