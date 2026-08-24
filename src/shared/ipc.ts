export const IPC_CHANNELS = {
  getRuntimeInfo: 'app:get-runtime-info',
  getDiagnostics: 'app:get-diagnostics',
  listWslDistributions: 'wsl:list-distributions',
  probeWslDistribution: 'wsl:probe-distribution',
  startPi: 'pi:start',
  stopPi: 'pi:stop',
  getPiStatus: 'pi:get-status',
  piEvent: 'pi:event',
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

export interface WslDistributionInfo {
  name: string;
}

export interface WslWorkspace {
  distro: string;
  linuxPath: string;
}

export interface WslProbeInfo {
  distribution: string;
  available: boolean;
  pi: {
    available: boolean;
    version: string | null;
  } | null;
  detail: string;
}

export type PiRuntimeState = 'stopped' | 'starting' | 'ready' | 'disconnected' | 'stopping' | 'failed';

export interface PiRuntimeSnapshot {
  state: PiRuntimeState;
  workspace: WslWorkspace | null;
  piVersion: string | null;
  lastError: string | null;
  lastEntryId: string | null;
}

export type PiEvent =
  | { type: 'runtime'; snapshot: PiRuntimeSnapshot }
  | { type: 'stderr'; text: string }
  | { type: 'protocol'; message: unknown };

export interface DesktopApi {
  getRuntimeInfo: () => Promise<RuntimeInfo>;
  getDiagnostics: () => Promise<DiagnosticsReport>;
  listWslDistributions: () => Promise<WslDistributionInfo[]>;
  probeWslDistribution: (distribution: string) => Promise<WslProbeInfo>;
  startPi: (workspace: WslWorkspace) => Promise<PiRuntimeSnapshot>;
  stopPi: () => Promise<PiRuntimeSnapshot>;
  getPiStatus: () => Promise<PiRuntimeSnapshot>;
  onPiEvent: (listener: (event: PiEvent) => void) => () => void;
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
  [IPC_CHANNELS.listWslDistributions]: {
    request: undefined;
    response: WslDistributionInfo[];
  };
  [IPC_CHANNELS.probeWslDistribution]: {
    request: { distribution: string };
    response: WslProbeInfo;
  };
  [IPC_CHANNELS.startPi]: {
    request: WslWorkspace;
    response: PiRuntimeSnapshot;
  };
  [IPC_CHANNELS.stopPi]: {
    request: undefined;
    response: PiRuntimeSnapshot;
  };
  [IPC_CHANNELS.getPiStatus]: {
    request: undefined;
    response: PiRuntimeSnapshot;
  };
}

export type InvokeChannel = keyof IpcContract;

export type IpcResponse<Channel extends InvokeChannel> = IpcContract[Channel]['response'];
