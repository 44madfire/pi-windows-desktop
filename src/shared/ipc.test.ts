import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiagnosticsReport } from './diagnostics.ts';
import {
  IPC_CHANNELS,
  requireInvokeObject,
  type DesktopApi,
  type IpcContract,
  type RuntimeInfo,
} from './ipc.ts';

test('IPC channel names are unique and scoped to app capabilities', () => {
  const channels = Object.values(IPC_CHANNELS);

  assert.equal(new Set(channels).size, channels.length);
  assert.deepEqual(channels, [
    'app:get-runtime-info',
    'app:get-diagnostics',
    'wsl:list-distributions',
    'wsl:probe-distribution',
    'pi:start',
    'pi:stop',
    'pi:get-status',
    'pi:event',
    'pi:extension-ui-response',
    'conversation:send-prompt',
    'conversation:abort-prompt',
    'conversation:get',
    'workspace:read-file',
    'workspace:git-status',
    'app:host-port',
  ]);
});

test('invoke payload guard rejects null, primitives, and arrays before dereference', () => {
  const payload = requireInvokeObject(IPC_CHANNELS.sendPrompt, { prompt: 'hello' });
  assert.equal(payload.prompt, 'hello');

  const invalid = [null, undefined, 'prompt', 42, true, ['prompt'], () => undefined];
  for (const request of invalid) {
    assert.throws(
      () => requireInvokeObject(IPC_CHANNELS.sendPrompt, request),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('Invalid IPC request') &&
        error.message.includes(IPC_CHANNELS.sendPrompt),
    );
  }
});

test('every invoke channel is wired to a typed DesktopApi method', () => {
  // The renderer bridge exposes exactly one method per invoke channel. This
  // table is the channel-to-method contract; typing `api` as DesktopApi
  // forces every declared method to be present and nothing extra.
  const invokeMethodByChannel: Record<string, Exclude<keyof DesktopApi, 'onPiEvent'>> = {
    [IPC_CHANNELS.getRuntimeInfo]: 'getRuntimeInfo',
    [IPC_CHANNELS.getDiagnostics]: 'getDiagnostics',
    [IPC_CHANNELS.listWslDistributions]: 'listWslDistributions',
    [IPC_CHANNELS.probeWslDistribution]: 'probeWslDistribution',
    [IPC_CHANNELS.startPi]: 'startPi',
    [IPC_CHANNELS.stopPi]: 'stopPi',
    [IPC_CHANNELS.getPiStatus]: 'getPiStatus',
    [IPC_CHANNELS.piExtensionUiResponse]: 'sendExtensionUiResponse',
    [IPC_CHANNELS.sendPrompt]: 'sendPrompt',
    [IPC_CHANNELS.abortPrompt]: 'abortPrompt',
    [IPC_CHANNELS.getConversation]: 'getConversation',
    [IPC_CHANNELS.readWorkspaceFile]: 'readWorkspaceFile',
    [IPC_CHANNELS.gitStatus]: 'gitStatus',
  };
  const eventOnlyChannels: Record<string, true> = {
    [IPC_CHANNELS.piEvent]: true,
    [IPC_CHANNELS.hostPort]: true,
  };

  // Every declared channel is either invoke-wired or intentionally
  // event-only, and vice versa: no channel is left unwired.
  for (const channel of Object.values(IPC_CHANNELS)) {
    assert.ok(
      channel in invokeMethodByChannel || channel in eventOnlyChannels,
      `${channel} is neither invoke-wired nor event-only`,
    );
  }
  const invokeChannels = Object.keys(invokeMethodByChannel);
  assert.equal(invokeChannels.length + Object.keys(eventOnlyChannels).length, Object.keys(IPC_CHANNELS).length);

  const api: DesktopApi = {
    getRuntimeInfo: async () => ({ appVersion: '', electronVersion: '', nodeVersion: '', platform: 'windows', architecture: 'x64' }),
    getDiagnostics: async () => ({ checkedAt: '', overall: 'pending', checks: [] }),
    listWslDistributions: async () => [],
    probeWslDistribution: async () => ({ distribution: '', available: false, pi: null, detail: '' }),
    startPi: async () => ({ state: 'stopped', workspace: null, piVersion: null, lastError: null, lastEntryId: null, sessionId: null, sessionFile: null }),
    stopPi: async () => ({ state: 'stopped', workspace: null, piVersion: null, lastError: null, lastEntryId: null, sessionId: null, sessionFile: null }),
    getPiStatus: async () => ({ state: 'stopped', workspace: null, piVersion: null, lastError: null, lastEntryId: null, sessionId: null, sessionFile: null }),
    sendExtensionUiResponse: async () => undefined,
    sendPrompt: async () => ({ timeline: [], executionState: 'idle', queuedPromptCount: 0, error: null }),
    abortPrompt: async () => ({ timeline: [], executionState: 'idle', queuedPromptCount: 0, error: null }),
    getConversation: async () => ({ timeline: [], executionState: 'idle', queuedPromptCount: 0, error: null }),
    readWorkspaceFile: async (_request) => ({ ok: false, reason: 'invalid-workspace', message: '' }),
    gitStatus: async (_workspace) => ({ ok: false, reason: 'invalid-workspace', message: '' }),
    onPiEvent: () => () => undefined,
  };

  const apiMethods = Object.keys(api);
  const wiredMethods = [...Object.values(invokeMethodByChannel), 'onPiEvent'];
  assert.deepEqual(apiMethods.sort(), wiredMethods.sort());
});

test('IpcResponse resolves typed results for the new channels', () => {
  type ReadResponse = IpcContract[typeof IPC_CHANNELS.readWorkspaceFile]['response'];
  type GitResponse = IpcContract[typeof IPC_CHANNELS.gitStatus]['response'];

  const okRead: ReadResponse = {
    ok: true,
    workspace: { distro: 'Ubuntu', linuxPath: '/home/dev/notes.md' },
    content: '# notes',
    byteLength: 7,
  };
  const okGit: GitResponse = {
    ok: true,
    workspace: { distro: 'Ubuntu', linuxPath: '/home/dev' },
    branch: 'main',
    entries: [{ path: 'a.ts', xy: ' M', indexStatus: ' ', worktreeStatus: 'M', staged: false, unstaged: true, untracked: false }],
  };

  // Wire shapes are plain JSON: structured-clone friendly across the IPC
  // boundary and free of internal process state.
  assert.deepEqual(JSON.parse(JSON.stringify(okRead)), okRead);
  assert.deepEqual(JSON.parse(JSON.stringify(okGit)), okGit);
  assert.deepEqual(Object.keys(okGit).sort(), ['branch', 'entries', 'ok', 'workspace']);

  // A file read addresses a workspace root plus a relative POSIX path; Git
  // status keeps receiving only the root.
  const readRequest: IpcContract[typeof IPC_CHANNELS.readWorkspaceFile]['request'] = {
    workspace: { distro: 'Ubuntu', linuxPath: '/home/dev/project' },
    relativePath: 'README.md',
  };
  const gitRequest: IpcContract[typeof IPC_CHANNELS.gitStatus]['request'] = {
    distro: 'Ubuntu',
    linuxPath: '/home/dev/project',
  };
  assert.deepEqual(JSON.parse(JSON.stringify(readRequest)), readRequest);
  assert.deepEqual(JSON.parse(JSON.stringify(gitRequest)), gitRequest);
  assert.deepEqual(Object.keys(readRequest).sort(), ['relativePath', 'workspace']);

  // The extension response channel is the only renderer-to-Pi command
  // boundary besides prompts; its discriminant is fixed.
  const response: IpcContract[typeof IPC_CHANNELS.piExtensionUiResponse]['request'] = {
    response: { type: 'extension_ui_response', id: 'req-1', confirmed: true },
  };
  assert.equal(response.response.type, 'extension_ui_response');
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
