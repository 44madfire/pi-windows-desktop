import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiagnosticsReport } from '../shared/diagnostics.js';
import { IPC_CHANNELS, type RuntimeInfo, type WslWorkspace } from '../shared/ipc.js';
import { PiRuntimeController } from './services/pi/pi-runtime.js';
import { WslManager } from './wsl/index.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const rendererUrl = process.env.ELECTRON_RENDERER_URL;

let mainWindow: BrowserWindow | undefined;
const wsl = new WslManager();
const piRuntime = new PiRuntimeController({
  wsl,
  handlers: {
    onEvent: (event) => mainWindow?.webContents.send(IPC_CHANNELS.piEvent, event),
  },
});

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
    createDiagnosticsReport(getRuntimeInfo(), new Date().toISOString(), piRuntime.snapshot),
  );
  ipcMain.handle(IPC_CHANNELS.listWslDistributions, () => wsl.listDistributions());
  ipcMain.handle(IPC_CHANNELS.probeWslDistribution, async (_event, request: { distribution: string }) => {
    const probe = await wsl.probeDistribution(request.distribution);
    return {
      distribution: probe.distribution,
      available: probe.available,
      pi: probe.pi
        ? { available: probe.pi.available, version: probe.pi.version }
        : null,
      detail: probe.available
        ? probe.pi?.available
          ? `Pi ${probe.pi.version ?? 'version unknown'} is available.`
          : 'Pi was not found in this distribution.'
        : probe.availability.stderr || 'The WSL distribution is unavailable.',
    };
  });
  ipcMain.handle(IPC_CHANNELS.startPi, (_event, workspace: WslWorkspace) => piRuntime.start(workspace));
  ipcMain.handle(IPC_CHANNELS.stopPi, () => piRuntime.stop());
  ipcMain.handle(IPC_CHANNELS.getPiStatus, () => piRuntime.snapshot);
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

app.on('before-quit', () => {
  void piRuntime.stop();
});
