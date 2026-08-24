export const IPC_CHANNELS = {
  getRuntimeInfo: 'app:get-runtime-info',
  getDiagnostics: 'app:get-diagnostics',
  hostPort: 'app:host-port',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

export type DesktopPlatform = 'windows' | 'macos' | 'linux' | 'unknown';

export interface RuntimeInfo {
  appVersion: string;
  electronVersion: string;
  nodeVersion: string;
  platform: DesktopPlatform;
  architecture: string;
}

export type DiagnosticStatus = 'pass' | 'pending' | 'fail';

export type DiagnosticCheckId =
  | 'host-process'
  | 'renderer-bridge'
  | 'wsl-integration'
  | 'pi-transport';

export interface DiagnosticCheck {
  id: DiagnosticCheckId;
  label: string;
  status: DiagnosticStatus;
  detail: string;
}

export interface DiagnosticsReport {
  checkedAt: string;
  overall: 'ready' | 'pending' | 'degraded';
  checks: DiagnosticCheck[];
}

export interface DesktopApi {
  getRuntimeInfo: () => Promise<RuntimeInfo>;
  getDiagnostics: () => Promise<DiagnosticsReport>;
}

export interface IpcContract {
  [IPC_CHANNELS.getRuntimeInfo]: {
    request: undefined;
    response: RuntimeInfo;
  };
  [IPC_CHANNELS.getDiagnostics]: {
    request: undefined;
    response: DiagnosticsReport;
  };
}

export type InvokeChannel = keyof IpcContract;

export type IpcResponse<Channel extends InvokeChannel> = IpcContract[Channel]['response'];
