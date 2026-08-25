import { app, BrowserWindow, ipcMain } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiagnosticsReport } from '../shared/diagnostics.js';
import { IPC_CHANNELS, requireInvokeObject, type RuntimeInfo, type WslWorkspace } from '../shared/ipc.js';
import { PiRuntimeController } from './services/pi/pi-runtime.js';
import { JsonSessionStore } from './services/session/session-store.js';
import { gitStatusEnvelope, readWorkspaceFileEnvelope } from './services/workspace/ipc-mapping.js';
import { validateLinuxWorkspace } from './services/workspace/index.js';
import { WorkspaceFileService } from './services/workspace/workspace-file.js';
import { WorkspaceGitService } from './services/workspace/workspace-git.js';
import { WslManager, isValidWslDistributionName } from './wsl/index.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const rendererUrl = process.env.ELECTRON_RENDERER_URL;

let mainWindow: BrowserWindow | undefined;
const wsl = new WslManager();
const piRuntime = new PiRuntimeController({
  wsl,
  // The session store persists the last Pi session pointer under Electron's
  // per-user data directory; PiRuntimeController saves it as part of stop().
  sessionStore: new JsonSessionStore({
    filePath: join(app.getPath('userData'), 'session-pointers.json'),
  }),
  handlers: {
    onEvent: (event) => mainWindow?.webContents.send(IPC_CHANNELS.piEvent, event),
  },
});
const workspaceFiles = new WorkspaceFileService(wsl);
const workspaceGit = new WorkspaceGitService(wsl);

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
  ipcMain.handle(IPC_CHANNELS.probeWslDistribution, async (_event, request: unknown) => {
    const payload = requireInvokeObject(IPC_CHANNELS.probeWslDistribution, request);
    if (!isValidWslDistributionName(payload.distribution)) {
      throw new Error(
        `Invalid IPC request on "${IPC_CHANNELS.probeWslDistribution}": "distribution" must be a string.`,
      );
    }
    const probe = await wsl.probeDistribution(payload.distribution);
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
  ipcMain.handle(IPC_CHANNELS.startPi, (_event, request: unknown) => {
    // Same canonical validator as the workspace slice: a malformed workspace
    // fails fast with a clear validation error instead of a TypeError deep
    // inside start().
    const workspace = validateLinuxWorkspace(request);
    return piRuntime.start(workspace);
  });
  ipcMain.handle(IPC_CHANNELS.stopPi, () => piRuntime.stop());
  ipcMain.handle(IPC_CHANNELS.getPiStatus, () => piRuntime.snapshot);
  // The renderer can only reply to Pi extension UI requests through this
  // hardcoded boundary. Shape validation is delegated to the runtime so no
  // arbitrary Pi command type can be selected from the renderer.
  ipcMain.handle(IPC_CHANNELS.piExtensionUiResponse, async (_event, request: unknown) => {
    const payload = requireInvokeObject(IPC_CHANNELS.piExtensionUiResponse, request);
    if (
      payload.response === null ||
      typeof payload.response !== 'object' ||
      Array.isArray(payload.response)
    ) {
      throw new Error(
        `Invalid IPC request on "${IPC_CHANNELS.piExtensionUiResponse}": "response" must be an object.`,
      );
    }
    // The renderer cannot select a Pi command type here: only this hardcoded
    // extension_ui_response boundary exists, and the runtime re-validates the
    // payload shape before writing it to Pi.
    await piRuntime.sendExtensionUiResponse(payload.response);
  });
  ipcMain.handle(IPC_CHANNELS.getConversation, () => piRuntime.conversationSnapshot);
  ipcMain.handle(IPC_CHANNELS.sendPrompt, (_event, request: unknown) => {
    const payload = requireInvokeObject(IPC_CHANNELS.sendPrompt, request);
    if (typeof payload.prompt !== 'string') {
      throw new Error(
        `Invalid IPC request on "${IPC_CHANNELS.sendPrompt}": "prompt" must be a string.`,
      );
    }
    return piRuntime.sendPrompt(payload.prompt);
  });
  ipcMain.handle(IPC_CHANNELS.abortPrompt, () => piRuntime.abortPrompt());
  ipcMain.handle(IPC_CHANNELS.readWorkspaceFile, (_event, request: unknown) => {
    const payload = requireInvokeObject(IPC_CHANNELS.readWorkspaceFile, request);
    if (
      payload.workspace === null ||
      typeof payload.workspace !== 'object' ||
      Array.isArray(payload.workspace) ||
      typeof payload.relativePath !== 'string'
    ) {
      throw new Error(
        `Invalid IPC request on "${IPC_CHANNELS.readWorkspaceFile}": "workspace" and "relativePath" are required.`,
      );
    }
    // The workspace root and the relative path are re-validated inside the
    // service before any WSL command runs; invalid inputs become typed
    // {ok:false,...} envelopes instead of reaching the runner.
    return readWorkspaceFileEnvelope(workspaceFiles, payload.workspace, payload.relativePath);
  });
  ipcMain.handle(IPC_CHANNELS.gitStatus, (_event, request: WslWorkspace) =>
    gitStatusEnvelope(workspaceGit, request),
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

let isQuitting = false;

app.on('before-quit', (event) => {
  // Persist the final session pointer before the process exits. The first
  // quit is deferred only until piRuntime.stop() settles (which saves the
  // pointer); quit is then re-issued so app lifecycle semantics are unchanged.
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  void piRuntime.stop().finally(() => app.quit());
});
