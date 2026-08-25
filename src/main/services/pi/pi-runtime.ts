import type { PiEvent, PiRuntimeSnapshot, WslWorkspace } from '../../../shared/ipc.ts';
import { WslManager, type PiExecutableProbe } from '../../wsl/index.ts';
import { PiRpcClient, type PiRpcTransport } from './index.ts';
import { createWslPiTransport } from './wsl-process-transport.ts';
import { SessionManager, type SessionSynchronizationResult } from '../session/session-manager.ts';
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
 * Runtime snapshot including Pi session identity and cursor state. The shared
 * `PiRuntimeSnapshot` carries all fields via the host IPC slice; this local
 * alias keeps the session core self-contained either way.
 */
export type PiRuntimeSessionSnapshot = PiRuntimeSnapshot;

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
  /**
   * Serializes lifecycle mutations (start/stop/reconnect). Public lifecycle
   * methods enqueue their internal bodies so overlapping calls run one at a
   * time; internal cross-calls (start -> stop/reconnect) use the internal
   * bodies directly so the tail never deadlocks on a nested enqueue.
   */
  private operationTail: Promise<void> = Promise.resolve();
  /** Lifecycle operations currently enqueued or running, for immediate rejection. */
  private lifecycleInFlight = 0;
  private snapshotValue: PiRuntimeSessionSnapshot = {
    state: 'stopped',
    workspace: null,
    piVersion: null,
    lastError: null,
    lastSeenEntryId: null,
    leafId: null,
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
   * Serialized lifecycle entry: see {@link startInternal}.
   */
  start(workspace: WslWorkspace): Promise<PiRuntimeSnapshot> {
    return this.enqueueLifecycle(() => this.startInternal(workspace));
  }

  /**
   * Handshake-based startup: load the persisted pointer, connect the
   * transport, open the Pi session (`switch_session` with soft fallback to
   * `new_session`, then `get_state`), catch up from the durable cursor
   * (`get_entries`), hydrate the conversation, persist the resulting pointer,
   * and only then publish `ready`.
   */
  private async startInternal(workspace: WslWorkspace): Promise<PiRuntimeSnapshot> {
    if (this.snapshotValue.state === 'ready' || this.snapshotValue.state === 'starting') {
      await this.stopInternal();
    }

    const sameWorkspace =
      this.snapshotValue.workspace !== null &&
      this.snapshotValue.workspace.distro === workspace.distro &&
      this.snapshotValue.workspace.linuxPath === workspace.linuxPath;
    // A runtime whose transport died on the same workspace reuses the
    // existing logical session and conversation through the explicit
    // reconnect seam; a fresh start would create a second, unhandshaken
    // conversation and lose the queue.
    if (this.snapshotValue.state === 'disconnected' && sameWorkspace) {
      return this.reconnectInternal();
    }

    const workspaceKey = sessionWorkspaceKey(workspace);
    const pointer = await this.loadPointer(workspaceKey);
    const previousCursor = pointer?.lastEntryId ?? (sameWorkspace ? this.snapshotValue.lastSeenEntryId : null);
    const previousSessionId = pointer?.sessionId ?? (sameWorkspace ? this.snapshotValue.sessionId : null);
    const previousSessionFile = pointer?.sessionFile ?? (sameWorkspace ? this.snapshotValue.sessionFile : null);
    // The active leaf is restored as an independent nullable field: it is
    // never the append cursor, but a restarted runtime exposes the branch
    // tip until the next authoritative get_entries response replaces it.
    const previousLeafId = pointer?.leafId ?? (sameWorkspace ? this.snapshotValue.leafId : null);
    this.setSnapshot({
      state: 'starting',
      workspace,
      lastError: null,
      lastSeenEntryId: previousCursor,
      lastEntryId: previousCursor,
      leafId: previousLeafId,
      sessionId: previousSessionId,
      sessionFile: previousSessionFile,
      piVersion: null,
    });

    // Hoisted so the failure path can terminate the client it created before
    // dropping the runtime references.
    let client: PiRpcClient | null = null;
    try {
      const probe = await this.wsl.probeDistribution(workspace.distro);
      if (!probe.available) throw new Error(`WSL distribution is unavailable: ${workspace.distro}`);
      if (!probe.pi?.available) throw new Error(`Pi was not found in ${workspace.distro}`);

      const piExecutable = probe.pi.executable;
      client = new PiRpcClient({
        transportFactory: () => this.createTransport({ distro: workspace.distro, linuxPath: workspace.linuxPath, piExecutable }),
      });
      this.client = client;
      const session = new SessionManager({
        sessionId: previousSessionId,
        sessionFile: previousSessionFile,
        lastEntryId: previousCursor,
        leafId: previousLeafId,
        client,
      });
      this.session = session;
      session.onStateChange((sessionSnapshot) => {
        if (this.client !== client) return;
        // Propagate identity/cursor unconditionally, including explicit nulls:
        // a cancelled resume must reset the runtime snapshot instead of
        // retaining stale session fields alongside a new identity.
        const patch: Partial<PiRuntimeSessionSnapshot> = {};
        if (sessionSnapshot.lastSeenEntryId !== this.snapshotValue.lastSeenEntryId) {
          patch.lastSeenEntryId = sessionSnapshot.lastSeenEntryId;
          // The shared snapshot keeps lastEntryId as a compat alias.
          patch.lastEntryId = sessionSnapshot.lastSeenEntryId;
        }
        if (sessionSnapshot.leafId !== this.snapshotValue.leafId) {
          patch.leafId = sessionSnapshot.leafId;
        }
        if (sessionSnapshot.sessionId !== this.snapshotValue.sessionId) {
          patch.sessionId = sessionSnapshot.sessionId;
        }
        if (sessionSnapshot.sessionFile !== this.snapshotValue.sessionFile) {
          patch.sessionFile = sessionSnapshot.sessionFile;
        }
        if (Object.keys(patch).length > 0) {
          this.setSnapshot(patch);
          if (sessionSnapshot.lastSeenEntryId !== null) {
            // Re-persist whenever a synchronization produces a durable cursor.
            void this.persistPointer(workspaceKey, session).catch(() => undefined);
          }
        }
      });
      const conversation = new ConversationController(client, {
        // After agent_settled completes a turn, synchronize get_entries from
        // the durable append cursor, reconcile the authoritative entries with
        // the live timeline, and persist the resulting pointer. The controller
        // keeps its queue paused until this resolves, so the next queued
        // prompt is never dispatched before the post-settled sync. The
        // lifecycle tail serializes this against start/stop/reconnect.
        onSettle: () =>
          this.enqueueLifecycle(() =>
            this.synchronizeAfterSettle(workspaceKey, client, session, conversation),
          ),
      });
      this.conversation = conversation;
      conversation.onEvent((event) => this.handlers.onEvent?.(event));

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
        lastSeenEntryId: session.lastSeenEntryId,
        leafId: session.leafId,
        lastEntryId: session.lastSeenEntryId,
      });
      return this.snapshot;
    } catch (error) {
      // Any failure after the client was created must not leak the Pi
      // process: terminate the transport (stdin EOF, then escalation) before
      // dropping references and surfacing the rejection. A cleanup failure
      // never masks the original startup failure.
      if (client) {
        try {
          await client.close();
        } catch {
          // The references are dropped below regardless, so the failed
          // client cannot be double-closed by a later stop().
        }
      }
      this.client = null;
      this.conversation = null;
      this.session = null;
      this.setSnapshot({ state: 'failed', lastError: errorMessage(error) });
      throw error;
    }
  }

  /**
   * Serialized lifecycle entry with an immediate deterministic guard: a
   * reconnect is rejected at call time when the runtime is not disconnected
   * or another lifecycle operation is still in flight, and is otherwise
   * queued behind any running lifecycle operation. See {@link reconnectInternal}.
   */
  async reconnect(): Promise<PiRuntimeSnapshot> {
    const workspace = this.snapshotValue.workspace;
    if (!this.client || !this.session || !this.conversation || !workspace) {
      throw new Error('Pi is not running. Start Pi before reconnecting.');
    }
    if (this.lifecycleInFlight > 0 || this.snapshotValue.state !== 'disconnected') {
      const state = this.snapshotValue.state === 'disconnected' ? 'starting' : this.snapshotValue.state;
      throw new Error(`Cannot reconnect Pi while runtime is ${state}`);
    }
    this.lifecycleInFlight += 1;
    try {
      return await this.enqueueLifecycle(() => this.reconnectInternal());
    } finally {
      this.lifecycleInFlight -= 1;
    }
  }

  /**
   * Reconnect the existing disconnected client/session/conversation.
   *
   * Replaces the Pi transport (`client.reconnect()`), then re-runs the
   * session handshake (`switch_session` with strict resume semantics),
   * `get_state`, catch-up from the durable append cursor (`get_entries`),
   * conversation hydration, and pointer persistence. `ready` is published
   * only after that handshake completes, and only then are prompts queued
   * while disconnected resumed — no prompt is sent before the handshake.
   *
   * On failure the transport is closed cleanly (best-effort) but the session
   * and conversation references are kept, so the queued conversation work
   * and the durable cursor survive for a later retry via `reconnect()` or a
   * same-workspace `start()`.
   */
  private async reconnectInternal(): Promise<PiRuntimeSnapshot> {
    const client = this.client;
    const session = this.session;
    const conversation = this.conversation;
    const workspace = this.snapshotValue.workspace;
    if (!client || !session || !conversation || !workspace) {
      throw new Error('Pi is not running. Start Pi before reconnecting.');
    }
    if (this.snapshotValue.state !== 'disconnected') {
      throw new Error(`Cannot reconnect Pi while runtime is ${this.snapshotValue.state}`);
    }

    const workspaceKey = sessionWorkspaceKey(workspace);
    this.setSnapshot({ state: 'starting', workspace, lastError: null });
    try {
      // Replace the transport. Pending requests are rejected and are not
      // replayed: Pi may have accepted a command before the transport died.
      await client.reconnect();

      // The same logical session is reopened and caught up from the durable
      // append cursor; no fresh session is created behind the caller's back.
      // The handshake is forced: a replacement transport is a new Pi process
      // that must be bound to the session file again even if the manager was
      // already ready when the transport died.
      await session.openSession(session.sessionFile, {
        force: true,
        fallbackToNewSession: false,
      });
      const sync = await session.synchronize();
      conversation.hydrate(sync.entries);
      await this.persistPointer(workspaceKey, session);

      this.setSnapshot({
        state: 'ready',
        workspace,
        lastError: null,
        sessionId: session.sessionId,
        sessionFile: session.sessionFile,
        lastSeenEntryId: session.lastSeenEntryId,
        leafId: session.leafId,
        lastEntryId: session.lastSeenEntryId,
      });

      // The handshake is complete: resume prompts queued while disconnected.
      conversation.resumeQueuedPrompts();
      return this.snapshot;
    } catch (error) {
      // Terminate the transport so no Pi process leaks, while preserving the
      // conversation queue and session cursor for a later reconnect.
      try {
        await client.close();
      } catch {
        // A cleanup failure never masks the reconnect failure.
      }
      this.setSnapshot({ state: 'disconnected', lastError: errorMessage(error) });
      throw error;
    }
  }

  /**
   * Post-settle synchronization for the runtime wiring that created it:
   * catch up get_entries from the durable cursor, reconcile the
   * authoritative entries with the live timeline (idempotent), and persist
   * the resulting pointer. Runs on the lifecycle tail so it never overlaps
   * start/stop/reconnect. When the wiring is no longer live (the runtime was
   * stopped) it rejects so the conversation keeps its queue paused instead
   * of dispatching into a dead runtime.
   */
  private async synchronizeAfterSettle(
    workspaceKey: string,
    client: PiRpcClient,
    session: SessionManager,
    conversation: ConversationController,
  ): Promise<void> {
    if (this.client !== client || this.session !== session || this.conversation !== conversation) {
      throw new Error('Pi runtime wiring changed before the post-settled synchronization');
    }
    let sync: SessionSynchronizationResult;
    try {
      sync = await session.synchronize();
    } catch (error) {
      // The post-settled catch-up failed (transport or RPC). The session is
      // already marked disconnected by the manager; surface the same state
      // here so the reconnect seam is the recovery path, and rethrow so the
      // conversation keeps its queue paused with a visible error.
      this.setSnapshot({ state: 'disconnected', lastError: errorMessage(error) });
      throw error;
    }
    if (this.client !== client || this.session !== session) return;
    conversation.hydrate(sync.entries);
    await this.persistPointer(workspaceKey, session);
  }

  /**
   * Serialized lifecycle entry: see {@link stopInternal}.
   */
  stop(): Promise<PiRuntimeSnapshot> {
    return this.enqueueLifecycle(() => this.stopInternal());
  }

  /** Persist the current session pointer before resolving, so quit awaits it. */
  private async stopInternal(): Promise<PiRuntimeSnapshot> {
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
    await this.client.write(validateExtensionUiResponse(response));
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
      // The durable append-order cursor (compat alias lastEntryId) plus the
      // transient active leaf; the leaf is never used as a catch-up cursor.
      lastEntryId: session.lastSeenEntryId,
      leafId: session.leafId,
    };
    await this.sessionStore.save(pointer);
  }

  /**
   * Serialize one lifecycle operation behind the tail. A rejected operation
   * never blocks the next one, and the returned promise carries the
   * rejection to the caller.
   */
  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation, operation);
    this.operationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private setSnapshot(patch: Partial<PiRuntimeSessionSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    this.handlers.onEvent?.({ type: 'runtime', snapshot: this.snapshot });
  }
}

export { piProbeDetail };
