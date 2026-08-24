import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiagnosticsReport } from './diagnostics.ts';
import { IPC_CHANNELS, type RuntimeInfo } from './ipc.ts';

test('M0 IPC channel names are unique and scoped to app capabilities', () => {
  const channels = Object.values(IPC_CHANNELS);

  assert.equal(new Set(channels).size, channels.length);
  assert.deepEqual(channels, [
    'app:get-runtime-info',
    'app:get-diagnostics',
    'app:host-port',
  ]);
});

test('M0 diagnostics pass shell checks while future integrations remain pending', () => {
  const runtime: RuntimeInfo = {
    appVersion: '0.1.0',
    electronVersion: '36.4.0',
    nodeVersion: '22.0.0',
    platform: 'windows',
    architecture: 'x64',
  };

  const report = createDiagnosticsReport(runtime, '2026-08-24T17:00:00.000Z');

  assert.equal(report.checkedAt, '2026-08-24T17:00:00.000Z');
  assert.equal(report.overall, 'pending');
  assert.deepEqual(report.checks.map((check) => [check.id, check.status]), [
    ['host-process', 'pass'],
    ['renderer-bridge', 'pass'],
    ['wsl-integration', 'pending'],
    ['pi-transport', 'pending'],
  ]);
});
