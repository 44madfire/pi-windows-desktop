import type { DiagnosticsReport, RuntimeInfo } from './ipc.js';

export function createDiagnosticsReport(
  runtime: RuntimeInfo,
  checkedAt = new Date().toISOString(),
): DiagnosticsReport {
  return {
    checkedAt,
    overall: 'pending',
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
        status: 'pending',
        detail: 'Pi JSONL transport will be added in a later milestone.',
      },
    ],
  };
}
