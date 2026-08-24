import type { DiagnosticsReport, PiRuntimeSnapshot, RuntimeInfo } from './ipc.js';

export function createDiagnosticsReport(
  runtime: RuntimeInfo,
  checkedAt = new Date().toISOString(),
  piRuntime?: PiRuntimeSnapshot,
): DiagnosticsReport {
  const piCheck = piRuntime
    ? piRuntime.state === 'ready'
      ? { status: 'pass' as const, detail: `Pi RPC is connected${piRuntime.piVersion ? ` (${piRuntime.piVersion})` : ''}.` }
      : piRuntime.state === 'failed' || piRuntime.state === 'disconnected'
        ? { status: 'fail' as const, detail: piRuntime.lastError ?? `Pi RPC is ${piRuntime.state}.` }
        : { status: 'pending' as const, detail: `Pi RPC is ${piRuntime.state}.` }
    : { status: 'pending' as const, detail: 'Pi JSONL transport is not connected yet.' };

  return {
    checkedAt,
    overall: piCheck.status === 'pass' ? 'ready' : piCheck.status === 'fail' ? 'degraded' : 'pending',
    checks: [
      {
        id: 'host-process',
        label: 'Desktop host',
        status: 'pass',
        detail: `Electron ${runtime.electronVersion} is running on ${runtime.platform}.`,
      },
      {
        id: 'renderer-bridge',
        label: 'Renderer bridge',
        status: 'pass',
        detail: 'The isolated preload bridge is available to the renderer.',
      },
      {
        id: 'wsl-integration',
        label: 'WSL integration',
        status: 'pending',
        detail: 'Distro and workspace discovery will be added in a later milestone.',
      },
      {
        id: 'pi-transport',
        label: 'Pi transport',
        status: piCheck.status,
        detail: piCheck.detail,
      },
    ],
  };
}
