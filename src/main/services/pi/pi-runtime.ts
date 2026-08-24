import type { PiEvent, PiRuntimeSnapshot, WslWorkspace } from '../../../shared/ipc.ts';
import { WslManager, type PiExecutableProbe } from '../../wsl/index.ts';
import { PiRpcClient, type PiRpcTransport } from './index.ts';
import { createWslPiTransport } from './wsl-process-transport.ts';
import { SessionManager } from '../session/session-manager.ts';
import { type SessionPointer, type SessionStore } from '../session/session-store.ts';
import { ConversationController } from '../conversation/index.ts';
import type { ConversationSnapshot } from '../../../shared/conversation.ts';

export interface PiRuntimeHandlers {
  onEvent?: (event: PiEvent) => void;
}

export interface PiRuntimeOptions {
  readonly wsl?: WslManager;
  readonly createTransport?: (options: {
    distro: string;
    linuxPath: string;
    piExecutable: string;
  }) => PiRpcTransport;
  readonly handlers?: PiRuntimeHandlers;
  /** Session pointer persistence; null/omitted keeps the runtime in-memory. */
  readonly sessionStore?: SessionStore | null;
}

/**
 * Runtime snapshot extended with Pi session identity. The shared
 * `PiRuntimeSnapshot` carries these fields via the host IPC slice; this local
 * intersection keeps the session core self-contained either way.
 */
export type PiRuntimeSessionSnapshot = PiRuntimeSnapshot & {
  readonly sessionId: string | null;
  readonly sessionFile: string | null;
};

/** Stable workspace key used for session pointer persistence. */
export function sessionWorkspaceKey(workspace: WslWorkspace): string {
  return JSON.stringify([workspace.distro, workspace.linuxPath]);
}

type ExtensionUiReply =
  | { type: 'extension_ui_response'; id: string; value: string }
  | { type: 'extension_ui_response'; id: string; confirmed: boolean }
  | { type: 'extension_ui_response'; id: string; cancelled: true };

/**
 * Validate a renderer extension UI reply and rebuild it with the hardcoded
 * Pi command type, so the renderer can never inject arbitrary Pi commands.
 * Accepts exactly one payload: `{ id, value: string }`, `{ id, confirmed:
 * boolean }`, or `{ id, cancelled: true }`. A `type` field is tolerated only
 * when it already equals the hardcoded value.
 */
function validateExtensionUiResponse(response: unknown): ExtensionUiReply {
  const record =
    response !== null && typeof response === 'object' && !Array.isArray(response)
      ? (response as Record<string, unknown>)
      : null;
  if (!record) throw new TypeError('Extension UI response must be an object');

  const id = record.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('Extension UI response requires a non-empty string id');
  }
  if (record.type !== undefined && record.type !== 'extension_ui_response') {
    throw new TypeError('Extension UI response type must be "extension_ui_response"');
  }

  const { value, confirmed, cancelled } = record;
  const payloadCount = [value, confirmed, cancelled].filter((field) => field !== undefined).length;
  if (payloadCount !== 1) {
    throw new TypeError('Extension UI response must contain exactly one of value, confirmed, or cancelled');
  }
  if (value !== undefined) {
    if (typeof value !== 'string') throw new TypeError('Extension UI response value must be a string');
    return { type: 'extension_ui_response', id, value };
  }
  if (confirmed !== undefined) {
    if (typeof confirmed !== 'boolean') throw new TypeError('Extension UI response confirmed must be a boolean');
    return { type: 'extension_ui_response', id, confirmed };
  }
  if (cancelled !== true) throw new TypeError('Extension UI response cancelled must be true');
  return { type: 'extension_ui_response', id, cancelled: true };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function piProbeDetail(probe: PiExecutableProbe | null): string {
  if (!probe) return 'Pi was not checked because the distribution is unavailable.';
  if (probe.available) return `Pi ${probe.version ?? 'version unknown'} is available.`;
  return `Pi is unavailable (${probe.reason}).`;
}

export class PiRuntimeController {
  private readonly wsl: WslManager;
  private readonly createTransport: NonNullable<PiRuntimeOptions['createTransport']>;
  private readonly handlers: PiRuntimeHandlers;
  private readonly sessionStore: SessionStore | null;
  private client: PiRpcClient | null = null;
  private conversation: ConversationController | null = null;
  private session: SessionManager | null = null;
  private snapshotValue: PiRuntimeSessionSnapshot = {
    state: 'stopped',
    workspace: null,
    piVersion: null,
    lastError: null,
    lastEntryId: null,
    sessionId: null,
    sessionFile: null,
  };

  constructor(options: PiRuntimeOptions = {}) {
    this.wsl = options.wsl ?? new WslManager();
    this.createTransport = options.createTransport ?? ((transportOptions) => createWslPiTransport(transportOptions));
    this.handlers = options.handlers ?? {};
    this.sessionStore = options.sessionStore ?? null;
  }

  get snapshot(): PiRuntimeSessionSnapshot {
    return { ...this.snapshotValue, workspace: this.snapshotValue.workspace && { ...this.snapshotValue.workspace } };
  }

  /**
   * Handshake-based startup: load the persisted pointer, connect the
   * transport, open the Pi session (`switch_session` with soft fallback to
   * `new_session`, then `get_state`), catch up from the durable cursor
   * (`get_entries`), hydrate the conversation, persist the resulting pointer,
   * and only then publish `ready`.
   */
  async start(workspace: WslWorkspace): Promise<PiRuntimeSnapshot> {
    if (this.snapshotValue.state === 'ready' || this.snapshotValue.state === 'starting') {
      await this.stop();
    }

    const workspaceKey = sessionWorkspaceKey(workspace);
    const pointer = await this.loadPointer(workspaceKey);
    const sameWorkspace =
      this.snapshotValue.workspace !== null &&
      this.snapshotValue.workspace.distro === workspace.distro &&
      this.snapshotValue.workspace.linuxPath === workspace.linuxPath;
    const previousCursor = pointer?.lastEntryId ?? (sameWorkspace ? this.snapshotValue.lastEntryId : null);
    const previousSessionId = pointer?.sessionId ?? (sameWorkspace ? this.snapshotValue.sessionId : null);
    const previousSessionFile = pointer?.sessionFile ?? (sameWorkspace ? this.snapshotValue.sessionFile : null);
    this.setSnapshot({
      state: 'starting',
      workspace,
      lastError: null,
      lastEntryId: previousCursor,
      sessionId: previousSessionId,
      sessionFile: previousSessionFile,
      piVersion: null,
    });

    try {
      const probe = await this.wsl.probeDistribution(workspace.distro);
      if (!probe.available) throw new Error(`WSL distribution is unavailable: ${workspace.distro}`);
      if (!probe.pi?.available) throw new Error(`Pi was not found in ${workspace.distro}`);

      const piExecutable = probe.pi.executable;
      const client = new PiRpcClient({
        transportFactory: () => this.createTransport({ distro: workspace.distro, linuxPath: workspace.linuxPath, piExecutable }),
      });
      this.client = client;
      this.conversation = new ConversationController(client);
      this.conversation.onEvent((event) => this.handlers.onEvent?.(event));
      const session = new SessionManager({
        sessionId: previousSessionId,
        sessionFile: previousSessionFile,
        lastEntryId: previousCursor,
        client,
      });
      this.session = session;
      session.onStateChange((sessionSnapshot) => {
        if (this.client !== client) return;
        const patch: Partial<PiRuntimeSessionSnapshot> = {};
        if (sessionSnapshot.lastEntryId !== null) patch.lastEntryId = sessionSnapshot.lastEntryId;
        if (sessionSnapshot.sessionId !== null) patch.sessionId = sessionSnapshot.sessionId;
        if (sessionSnapshot.sessionFile !== null) patch.sessionFile = sessionSnapshot.sessionFile;
        if (Object.keys(patch).length > 0) {
          this.setSnapshot(patch);
          if (sessionSnapshot.lastEntryId !== null) {
            // Re-persist whenever a synchronization produces a durable cursor.
            void this.persistPointer(workspaceKey, session).catch(() => undefined);
          }
        }
      });
      client.onEvent((event) => {
        this.handlers.onEvent?.({ type: 'protocol', message: event });
      });
      client.onStderr((text) => this.handlers.onEvent?.({ type: 'stderr', text }));
      client.onError((error) => {
        if (this.client !== client || this.snapshotValue.state === 'stopping') return;
        this.setSnapshot({ state: 'disconnected', lastError: error.message });
      });

      await client.connect();

      // The Pi process is only "ready" after the session handshake, history
      // catch-up, hydration, and pointer persistence have all completed.
      await session.openSession(previousSessionFile);
      const sync = await session.synchronize();
      this.conversation.hydrate(sync.entries);
      await this.persistPointer(workspaceKey, session);

      this.setSnapshot({
        state: 'ready',
        workspace,
        piVersion: probe.pi.version,
        lastError: null,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        lastEntryId: session.lastEntryId,
      });
      return this.snapshot;
    } catch (error) {
      this.client = null;
      this.conversation = null;
      this.session = null;
      this.setSnapshot({ state: 'failed', lastError: errorMessage(error) });
      throw error;
    }
  }

  /** Persist the current session pointer before resolving, so quit awaits it. */
  async stop(): Promise<PiRuntimeSnapshot> {
    if (!this.client) {
      this.setSnapshot({ state: 'stopped', workspace: null });
      return this.snapshot;
    }

    const client = this.client;
    const session = this.session;
    const workspace = this.snapshotValue.workspace;
    this.setSnapshot({ state: 'stopping' });
    this.client = null;
    this.conversation = null;
    try {
      await client.close();
    } finally {
      if (session && workspace) {
        await this.persistPointer(sessionWorkspaceKey(workspace), session).catch(() => undefined);
      }
      this.session = null;
      this.setSnapshot({ state: 'stopped', workspace: null, piVersion: null });
    }
    return this.snapshot;
  }

  get conversationSnapshot(): ConversationSnapshot {
    return this.conversation?.snapshot ?? {
      timeline: [],
      executionState: 'idle',
      queuedPromptCount: 0,
      error: null,
    };
  }

  async sendPrompt(prompt: string): Promise<ConversationSnapshot> {
    if (!this.conversation) throw new Error('Pi is not running. Start Pi before sending a prompt.');
    await this.conversation.sendPrompt(prompt);
    return this.conversation.snapshot;
  }

  async abortPrompt(): Promise<ConversationSnapshot> {
    if (!this.conversation) return this.conversationSnapshot;
    await this.conversation.abort();
    return this.conversation.snapshot;
  }

  /**
   * Reply to a Pi extension UI request. The wire type is hardcoded to
   * `extension_ui_response`: the renderer supplies only the id plus exactly
   * one of `value` (string), `confirmed` (boolean), or `cancelled` (true).
   * The reply is written without registering a pending request because Pi
   * does not answer extension UI responses.
   */
  async sendExtensionUiResponse(response: unknown): Promise<void> {
    if (!this.client) {
      throw new Error('Pi is not running. Start Pi before responding to an extension UI request.');
    }
    this.client.write(validateExtensionUiResponse(response));
  }

  /** Tolerate a missing or corrupt store: startup degrades to a fresh session. */
  private async loadPointer(workspaceKey: string): Promise<SessionPointer | null> {
    if (!this.sessionStore) return null;
    try {
      return await this.sessionStore.load(workspaceKey);
    } catch {
      return null;
    }
  }

  /** Persist the current session pointer. Failures are non-fatal: Pi remains authoritative. */
  private async persistPointer(workspaceKey: string, session: SessionManager): Promise<void> {
    if (!this.sessionStore) return;
    const pointer: SessionPointer = {
      workspace: workspaceKey,
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      lastEntryId: session.lastEntryId,
    };
    await this.sessionStore.save(pointer);
  }

  private setSnapshot(patch: Partial<PiRuntimeSessionSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    this.handlers.onEvent?.({ type: 'runtime', snapshot: this.snapshot });
  }
}

export { piProbeDetail };
