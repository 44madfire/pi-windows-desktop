import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiagnosticsReport } from './diagnostics.ts';
import {
  IPC_CHANNELS,
  PI_THINKING_LEVELS,
  requireInvokeObject,
  type DesktopApi,
  type IpcContract,
  type PiModel,
  type PiThinkingLevel,
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
    'pi:get-available-models',
    'pi:get-available-thinking-levels',
    'pi:set-model',
    'pi:set-thinking-level',
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
    [IPC_CHANNELS.getAvailableModels]: 'getAvailableModels',
    [IPC_CHANNELS.getAvailableThinkingLevels]: 'getAvailableThinkingLevels',
    [IPC_CHANNELS.setModel]: 'setModel',
    [IPC_CHANNELS.setThinkingLevel]: 'setThinkingLevel',
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

  const stoppedSnapshot: IpcContract[typeof IPC_CHANNELS.getPiStatus]['response'] = {
    state: 'stopped',
    workspace: null,
    piVersion: null,
    lastError: null,
    model: null,
    thinkingLevel: null,
    availableModels: [],
    availableThinkingLevels: [],
    lastWarning: null,
    lastSeenEntryId: null,
    leafId: null,
    lastEntryId: null,
    sessionId: null,
    sessionFile: null,
  };
  const api: DesktopApi = {
    getRuntimeInfo: async () => ({ appVersion: '', electronVersion: '', nodeVersion: '', platform: 'windows', architecture: 'x64' }),
    getDiagnostics: async () => ({ checkedAt: '', overall: 'pending', checks: [] }),
    listWslDistributions: async () => [],
    probeWslDistribution: async () => ({ distribution: '', available: false, pi: null, detail: '' }),
    startPi: async () => stoppedSnapshot,
    stopPi: async () => stoppedSnapshot,
    getPiStatus: async () => stoppedSnapshot,
    sendExtensionUiResponse: async () => undefined,
    getAvailableModels: async () => [],
    getAvailableThinkingLevels: async () => [],
    setModel: async (_provider, _modelId) => ({ id: 'model-1', provider: 'anthropic' }),
    setThinkingLevel: async (level) => level,
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

test('M1 agent-state selectors expose typed JSON-safe wire shapes', () => {
  // Model switching returns the authoritative Pi model: id + provider, with
  // an optional display name. Nothing else leaks from the wire record.
  const model: IpcContract[typeof IPC_CHANNELS.setModel]['response'] = {
    id: 'claude-sonnet-4-5',
    provider: 'anthropic',
    name: 'Claude Sonnet 4.5',
  };
  assert.deepEqual(JSON.parse(JSON.stringify(model)), model);
  assert.deepEqual(Object.keys(model).sort(), ['id', 'name', 'provider']);

  const bareModel: PiModel = { id: 'gpt-5', provider: 'openai' };
  assert.deepEqual(JSON.parse(JSON.stringify(bareModel)), bareModel);

  // The model catalog is a plain array of the same model shape.
  const models: IpcContract[typeof IPC_CHANNELS.getAvailableModels]['response'] = [
    model,
    bareModel,
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(models)), models);
  const thinkingLevels: IpcContract[typeof IPC_CHANNELS.getAvailableThinkingLevels]['response'] = [
    'off',
    'high',
  ];
  assert.deepEqual(JSON.parse(JSON.stringify(thinkingLevels)), thinkingLevels);

  // set_model accepts exactly the provider/modelId pair; nothing else may
  // reach Pi from the renderer.
  const setModelRequest: IpcContract[typeof IPC_CHANNELS.setModel]['request'] = {
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5',
  };
  assert.deepEqual(JSON.parse(JSON.stringify(setModelRequest)), setModelRequest);
  assert.deepEqual(Object.keys(setModelRequest).sort(), ['modelId', 'provider']);

  // set_thinking_level accepts exactly one level from the closed set.
  const setLevelRequest: IpcContract[typeof IPC_CHANNELS.setThinkingLevel]['request'] = {
    level: 'high',
  };
  assert.deepEqual(JSON.parse(JSON.stringify(setLevelRequest)), setLevelRequest);
  assert.deepEqual(Object.keys(setLevelRequest).sort(), ['level']);
  const appliedLevel: IpcContract[typeof IPC_CHANNELS.setThinkingLevel]['response'] = 'xhigh';
  assert.equal(appliedLevel, 'xhigh');
});

test('PiThinkingLevel is a closed set and the runtime snapshot projects agent state', () => {
  // Every value Pi accepts for `thinkingLevel`/`set_thinking_level` is
  // enumerated; a renderer value outside this set must never pass validation.
  assert.deepEqual(PI_THINKING_LEVELS, [
    'off',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  const levelUnion: PiThinkingLevel = 'max';
  assert.ok(PI_THINKING_LEVELS.includes(levelUnion));

  // The shared runtime snapshot carries the projected agent state: active
  // model, thinking level, and the model/thinking-level catalogs. All fields
  // are plain JSON across the IPC boundary.
  const snapshot: IpcContract[typeof IPC_CHANNELS.getPiStatus]['response'] = {
    state: 'ready',
    workspace: { distro: 'Ubuntu', linuxPath: '/home/pi' },
    piVersion: '0.1.0',
    lastError: null,
    model: { id: 'claude-sonnet-4-5', provider: 'anthropic', name: 'Claude Sonnet 4.5' },
    thinkingLevel: 'high',
    availableModels: [{ id: 'claude-sonnet-4-5', provider: 'anthropic' }],
    availableThinkingLevels: ['off', 'high'],
    lastWarning: null,
    lastSeenEntryId: null,
    leafId: null,
    lastEntryId: null,
    sessionId: 'pi-session-1',
    sessionFile: '/home/pi/.pi/agent/sessions/pi-session-1',
  };
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
  assert.deepEqual(
    Object.keys(snapshot).sort(),
    [
      'availableModels',
      'availableThinkingLevels',
      'lastEntryId',
      'lastError',
      'lastSeenEntryId',
      'lastWarning',
      'leafId',
      'model',
      'piVersion',
      'sessionFile',
      'sessionId',
      'state',
      'thinkingLevel',
      'workspace',
    ],
  );

  // The pre-ready snapshot projects null model/level and empty catalogs:
  // nothing is fabricated before Pi reports it.
  const stopped: IpcContract[typeof IPC_CHANNELS.getPiStatus]['response'] = {
    state: 'stopped',
    workspace: null,
    piVersion: null,
    lastError: null,
    model: null,
    thinkingLevel: null,
    availableModels: [],
    availableThinkingLevels: [],
    lastWarning: null,
    lastSeenEntryId: null,
    leafId: null,
    lastEntryId: null,
    sessionId: null,
    sessionFile: null,
  };
  assert.deepEqual(JSON.parse(JSON.stringify(stopped)), stopped);
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
