import { contextBridge, ipcRenderer } from 'electron';
import { HOST_PORT_MESSAGE, isHostPort } from '../shared/host-port.js';
import {
  IPC_CHANNELS,
  type DesktopApi,
  type InvokeChannel,
  type IpcResponse,
  type PiEvent,
} from '../shared/ipc.js';

function invoke<Channel extends InvokeChannel>(
  channel: Channel,
  request?: unknown,
): Promise<IpcResponse<Channel>> {
  return ipcRenderer.invoke(channel, request) as Promise<IpcResponse<Channel>>;
}

function forwardHostPort(event: Electron.IpcRendererEvent): void {
  const port = event.ports[0];
  if (!isHostPort(port)) return;

  // A future isolated host can be connected by the main process with
  // event.sender.postMessage(..., [port]). The port stays out of the bridge.
  window.postMessage({ type: HOST_PORT_MESSAGE }, '*', [port as MessagePort]);
}

ipcRenderer.on(IPC_CHANNELS.hostPort, forwardHostPort);

const desktopApi: DesktopApi = {
  getRuntimeInfo: () => invoke(IPC_CHANNELS.getRuntimeInfo),
  getDiagnostics: () => invoke(IPC_CHANNELS.getDiagnostics),
  listWslDistributions: () => invoke(IPC_CHANNELS.listWslDistributions),
  probeWslDistribution: (distribution) =>
    invoke(IPC_CHANNELS.probeWslDistribution, { distribution }),
  startPi: (workspace) => invoke(IPC_CHANNELS.startPi, workspace),
  stopPi: () => invoke(IPC_CHANNELS.stopPi),
  getPiStatus: () => invoke(IPC_CHANNELS.getPiStatus),
  sendPrompt: (prompt) => invoke(IPC_CHANNELS.sendPrompt, { prompt }),
  abortPrompt: () => invoke(IPC_CHANNELS.abortPrompt),
  getConversation: () => invoke(IPC_CHANNELS.getConversation),
  onPiEvent: (listener: (event: PiEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: PiEvent) => listener(payload);
    ipcRenderer.on(IPC_CHANNELS.piEvent, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.piEvent, handler);
  },
};

contextBridge.exposeInMainWorld('piDesktop', desktopApi);
