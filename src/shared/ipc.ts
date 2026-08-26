import type { ConversationEvent, ConversationSnapshot } from './conversation.ts';

export const IPC_CHANNELS = {
  getRuntimeInfo: 'app:get-runtime-info',
  getDiagnostics: 'app:get-diagnostics',
  listWslDistributions: 'wsl:list-distributions',
  probeWslDistribution: 'wsl:probe-distribution',
  startPi: 'pi:start',
  stopPi: 'pi:stop',
  getPiStatus: 'pi:get-status',
  piEvent: 'pi:event',
  piExtensionUiResponse: 'pi:extension-ui-response',
  getAvailableModels: 'pi:get-available-models',
  getAvailableThinkingLevels: 'pi:get-available-thinking-levels',
  setModel: 'pi:set-model',
  setThinkingLevel: 'pi:set-thinking-level',
  sendPrompt: 'conversation:send-prompt',
  abortPrompt: 'conversation:abort-prompt',
  getConversation: 'conversation:get',
  readWorkspaceFile: 'workspace:read-file',
  gitStatus: 'workspace:git-status',
  hostPort: 'app:host-port',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * Validate an invoke wire payload before any field is dereferenced. IPC
 * handlers that read request fields must route them through this guard so a
 * null, primitive, or array payload fails with a clear validation error
 * instead of a TypeError. Returns the payload narrowed to a plain object.
 */
export function requireInvokeObject(channel: IpcChannel, request: unknown): Record<string, unknown> {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error(`Invalid IPC request on "${channel}": expected an object payload.`);
  }
  return request as Record<string, unknown>;
}

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

/**
 * A Pi model as exposed to the renderer. The full wire record may carry more
 * fields; the project retains the stable identifier and provider (plus an
 * optional display name when Pi reports one). Pi remains authoritative for
 * which model is active.
 */
export interface PiModel {
  id: string;
  provider: string;
  name?: string;
}

/** Pi's allowed thinking levels, as reported by `get_state` and accepted by `set_thinking_level`. */
export type PiThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The complete set of thinking levels Pi accepts; validated in main and the runtime boundary. */
export const PI_THINKING_LEVELS: readonly PiThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export interface PiRuntimeSnapshot {
  state: PiRuntimeState;
  workspace: WslWorkspace | null;
  piVersion: string | null;
  lastError: string | null;
  /**
   * Active agent model, projected from the authoritative `get_state`
   * handshake (start/reconnect) and refreshed after model mutations.
   * Null until Pi reports one.
   */
  model: PiModel | null;
  /**
   * Active agent thinking level, projected from the authoritative
   * `get_state` handshake and refreshed after thinking-level mutations.
   * Null until Pi reports one.
   */
  thinkingLevel: PiThinkingLevel | null;
  /**
   * Thinking levels Pi reports as supported by the active model, from
   * `get_available_thinking_levels`. Empty until Pi reports one or the
   * runtime stops.
   */
  availableThinkingLevels: PiThinkingLevel[];
  /**
   * Models Pi can switch to, from the `get_available_models` response.
   * Empty until the renderer calls `getAvailableModels()` after the runtime
   * is ready; cleared when the runtime stops.
   */
  availableModels: PiModel[];
  /** Non-fatal runtime warning, such as a failed best-effort pointer save. */
  lastWarning: string | null;
  /**
   * Durable append-order cursor: the last entry id observed in a get_entries
   * response, driving the next `since` catch-up. `lastEntryId` is a
   * compatibility alias of this value.
   */
  lastSeenEntryId: string | null;
  /**
   * Current active leaf from the last get_entries response. The leaf pins
   * the branch tip and may lag the append end; it is never a catch-up cursor.
   */
  leafId: string | null;
  /** Compatibility alias equal to lastSeenEntryId (legacy name). */
  lastEntryId: string | null;
  /** Logical Pi session identifier from the latest get_state handshake. */
  sessionId: string | null;
  /** On-disk session pointer path Pi reports for the active session. */
  sessionFile: string | null;
}

export type PiEvent =
  | { type: 'runtime'; snapshot: PiRuntimeSnapshot }
  | { type: 'stderr'; text: string }
  | ConversationEvent
  | { type: 'protocol'; message: unknown };

/**
 * Renderer replies to Pi extension UI requests. The variant discriminant is
 * fixed: the main process hardcodes `type: 'extension_ui_response'` and never
 * lets a renderer pick a different Pi command.
 */
export type ExtensionUiResponse =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true };

export type WorkspaceFileReadFailureReason =
  | 'invalid-workspace'
  | 'not-found'
  | 'is-directory'
  | 'command-failed';

/**
 * Payload for a workspace file read: the validated workspace root plus a
 * relative POSIX file path inside it. The main process validates both before
 * any WSL command runs; Git status continues to receive only the root.
 */
export interface WorkspaceFileReadRequest {
  workspace: WslWorkspace;
  relativePath: string;
}

/**
 * Wire result of a workspace file read. Internal process diagnostics
 * (WslCommandResult, raw stderr/stdout) are deliberately absent.
 */
export type WorkspaceFileReadResponse =
  | {
      ok: true;
      workspace: WslWorkspace;
      content: string;
      byteLength: number;
    }
  | { ok: false; reason: WorkspaceFileReadFailureReason; message: string };

export interface WorkspaceGitStatusEntry {
  path: string;
  xy: string;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  renamedFrom?: string;
}

export type WorkspaceGitStatusFailureReason =
  | 'invalid-workspace'
  | 'not-a-repository'
  | 'git-unavailable'
  | 'command-failed';

/**
 * Wire result of a workspace git status call. The porcelain header/raw text
 * and the underlying WslCommandResult stay out of the envelope.
 */
export type WorkspaceGitStatusResponse =
  | {
      ok: true;
      workspace: WslWorkspace;
      branch: string | null;
      entries: WorkspaceGitStatusEntry[];
    }
  | { ok: false; reason: WorkspaceGitStatusFailureReason; message: string };

export interface DesktopApi {
  getRuntimeInfo: () => Promise<RuntimeInfo>;
  getDiagnostics: () => Promise<DiagnosticsReport>;
  listWslDistributions: () => Promise<WslDistributionInfo[]>;
  probeWslDistribution: (distribution: string) => Promise<WslProbeInfo>;
  startPi: (workspace: WslWorkspace) => Promise<PiRuntimeSnapshot>;
  stopPi: () => Promise<PiRuntimeSnapshot>;
  getPiStatus: () => Promise<PiRuntimeSnapshot>;
  sendExtensionUiResponse: (response: ExtensionUiResponse) => Promise<void>;
  getAvailableModels: () => Promise<PiModel[]>;
  getAvailableThinkingLevels: () => Promise<PiThinkingLevel[]>;
  setModel: (provider: string, modelId: string) => Promise<PiModel>;
  setThinkingLevel: (level: PiThinkingLevel) => Promise<PiThinkingLevel>;
  sendPrompt: (prompt: string) => Promise<ConversationSnapshot>;
  abortPrompt: () => Promise<ConversationSnapshot>;
  getConversation: () => Promise<ConversationSnapshot>;
  readWorkspaceFile: (request: WorkspaceFileReadRequest) => Promise<WorkspaceFileReadResponse>;
  gitStatus: (workspace: WslWorkspace) => Promise<WorkspaceGitStatusResponse>;
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
  [IPC_CHANNELS.piExtensionUiResponse]: {
    request: { response: ExtensionUiResponse };
    response: void;
  };
  [IPC_CHANNELS.getAvailableModels]: {
    request: undefined;
    response: PiModel[];
  };
  [IPC_CHANNELS.getAvailableThinkingLevels]: {
    request: undefined;
    response: PiThinkingLevel[];
  };
  [IPC_CHANNELS.setModel]: {
    request: { provider: string; modelId: string };
    response: PiModel;
  };
  [IPC_CHANNELS.setThinkingLevel]: {
    request: { level: PiThinkingLevel };
    response: PiThinkingLevel;
  };
  [IPC_CHANNELS.sendPrompt]: {
    request: { prompt: string };
    response: ConversationSnapshot;
  };
  [IPC_CHANNELS.abortPrompt]: {
    request: undefined;
    response: ConversationSnapshot;
  };
  [IPC_CHANNELS.getConversation]: {
    request: undefined;
    response: ConversationSnapshot;
  };
  [IPC_CHANNELS.readWorkspaceFile]: {
    request: WorkspaceFileReadRequest;
    response: WorkspaceFileReadResponse;
  };
  [IPC_CHANNELS.gitStatus]: {
    request: WslWorkspace;
    response: WorkspaceGitStatusResponse;
  };
}

export type InvokeChannel = keyof IpcContract;

export type IpcResponse<Channel extends InvokeChannel> = IpcContract[Channel]['response'];
