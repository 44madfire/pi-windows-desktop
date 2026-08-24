import { contextBridge, ipcRenderer } from 'electron';
import { HOST_PORT_MESSAGE, isHostPort } from '../shared/host-port.js';
import {
  IPC_CHANNELS,
  type DesktopApi,
  type InvokeChannel,
  type IpcResponse,
} from '../shared/ipc.js';

function invoke<Channel extends InvokeChannel>(channel: Channel): Promise<IpcResponse<Channel>> {
  return ipcRenderer.invoke(channel) as Promise<IpcResponse<Channel>>;
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
};

contextBridge.exposeInMainWorld('piDesktop', desktopApi);
