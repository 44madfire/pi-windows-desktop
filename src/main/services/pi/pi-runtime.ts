import {
  PI_THINKING_LEVELS,
  type PiEvent,
  type PiModel,
  type PiRuntimeSnapshot,
  type PiThinkingLevel,
  type WslWorkspace,
} from '../../../shared/ipc.ts';
import { WslManager, type PiExecutableProbe } from '../../wsl/index.ts';
import { PiRpcClient, type PiRpcTransport } from './index.ts';
import type { PiRpcEvent } from './protocol.ts';
import { createWslPiTransport } from './wsl-process-transport.ts';
import { SessionManager, type SessionSynchronizationResult } from '../session/session-manager.ts';
import { type SessionPointer, type SessionStore } from '../session/session-store.ts';
import { ConversationController, type ConversationEvent } from '../conversation/index.ts';
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
 * Runtime snapshot including Pi session identity and cursor state. The
 * shared `PiRuntimeSnapshot` carries all fields via the host IPC slice; this
 * local extension adds the non-fatal pointer-persistence warning so the
 * session core can report it without widening the shared type.
 */
export interface PiRuntimeSessionSnapshot extends PiRuntimeSnapshot {
  /**
   * Last non-fatal runtime warning — currently a failed best-effort session
   * pointer save. Never an error: the runtime stays ready and the queue
   * keeps dispatching. Cleared by the next successful save.
   */
  lastWarning: string | null;
}

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Parse a Pi model record (`{id, provider, name?}`), preferring a nested
 * `model` object when the response wraps one (e.g. `data: {model: {...}}`).
 * Returns null when the stable identity (id/provider) is missing.
 */
function parseModelRecord(value: unknown): PiModel | null {
  const record = asRecord(value);
  if (!record) return null;
  const candidate = asRecord(record['model']) ?? record;
  const id = nonEmptyString(candidate['id']);
  const provider = nonEmptyString(candidate['provider']);
  if (id === null || provider === null) return null;
  const name = nonEmptyString(candidate['name']);
  return name === null ? { id, provider } : { id, provider, name };
}

/** Parse `get_available_models` data: `{models: [...]}` or a bare array. */
function parseAvailableModels(data: unknown): PiModel[] {
  const record = asRecord(data);
  const candidates = Array.isArray(data) ? data : record?.['models'];
  if (!Array.isArray(candidates)) return [];
  const models: PiModel[] = [];
  for (const entry of candidates) {
    const model = parseModelRecord(entry);
    if (model !== null) models.push(model);
  }
  return models;
}

function isThinkingLevel(value: unknown): value is PiThinkingLevel {
  return typeof value === 'string' && (PI_THINKING_LEVELS as readonly string[]).includes(value);
}

/** Read a thinking level Pi echoed in a response (`data.thinkingLevel`/`level`). */
function parseEchoedThinkingLevel(data: unknown): PiThinkingLevel | null {
  const record = asRecord(data);
  if (!record) return null;
  for (const key of ['thinkingLevel', 'thinking_level', 'level'] as const) {
    const value = record[key];
    if (isThinkingLevel(value)) return value;
  }
  return null;
}

/** Parse an async `model_change` protocol event: `{provider, modelId}`. */
function parseModelChangeEvent(event: PiRpcEvent): PiModel | null {
  const record = asRecord(event);
  if (!record) return null;
  const provider = nonEmptyString(record['provider']);
  const modelId = nonEmptyString(record['modelId']) ?? nonEmptyString(record['model_id']);
  if (provider === null || modelId === null) return null;
  return { id: modelId, provider };
}

/** Parse an async `thinking_level_change` protocol event: `{thinkingLevel}`. */
function parseThinkingLevelChangeEvent(event: PiRpcEvent): PiThinkingLevel | null {
  const record = asRecord(event);
  if (!record) return null;
  for (const key of ['thinkingLevel', 'thinking_level', 'level'] as const) {
    const value = record[key];
    if (isThinkingLevel(value)) return value;
  }
  return null;
}

/** Value equality for projected models; fresh objects with equal content must not re-emit. */
function modelsEqual(a: PiModel | null, b: PiModel | null): boolean {
  if (a === null || b === null) return a === b;
  return a.id === b.id && a.provider === b.provider && (a.name ?? null) === (b.name ?? null);
}

/** Validate a renderer-supplied model identity before it becomes a Pi command. */
function validateModelIdentifier(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`Pi ${field} must be a non-empty string`);
  }
  return normalized;
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
    lastWarning: null,
    lastSeenEntryId: null,
    leafId: null,
    lastEntryId: null,
    sessionId: null,
    sessionFile: null,
    model: null,
    thinkingLevel: null,
    availableModels: [],
  };

  constructor(options: PiRuntimeOptions = {}) {
    this.wsl = options.wsl ?? new WslManager();
    this.createTransport = options.createTransport ?? ((transportOptions) => createWslPiTransport(transportOptions));
    this.handlers = options.handlers ?? {};
    this.sessionStore = options.sessionStore ?? null;
  }

  get snapshot(): PiRuntimeSessionSnapshot {
    return {
      ...this.snapshotValue,
      workspace: this.snapshotValue.workspace && { ...this.snapshotValue.workspace },
      availableModels: [...this.snapshotValue.availableModels],
    };
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
   * `new_session`, then `get_state`), request the full entry list
   * (`get_entries` without `since`) so the fresh conversation re-hydrates
   * the complete history, persist the resulting pointer (best effort), and
   * only then publish `ready`.
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
      lastWarning: null,
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
      const activeClient = client;
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
        // Agent-state projections come from the authoritative get_state
        // response; explicit nulls reset the runtime snapshot alongside the
        // session identity. Models are compared by value: each session emit
        // rebuilds the snapshot object, so reference equality would re-emit
        // unchanged models on every cursor/state transition.
        if (!modelsEqual(sessionSnapshot.model, this.snapshotValue.model)) {
          patch.model = sessionSnapshot.model;
        }
        if (sessionSnapshot.thinkingLevel !== this.snapshotValue.thinkingLevel) {
          patch.thinkingLevel = sessionSnapshot.thinkingLevel;
        }
        if (Object.keys(patch).length > 0) {
          this.setSnapshot(patch);
          if (sessionSnapshot.lastSeenEntryId !== null) {
            // Re-persist whenever a synchronization produces a durable cursor.
            void this.persistPointer(workspaceKey, session);
          }
        }
      });
      let conversation: ConversationController;
      conversation = new ConversationController(activeClient, {
        // After agent_settled completes a turn, synchronize get_entries from
        // the durable append cursor, reconcile the authoritative entries with
        // the live timeline, and persist the resulting pointer. The controller
        // keeps its queue paused until this resolves, so the next queued
        // prompt is never dispatched before the post-settled sync. The
        // lifecycle tail serializes this against start/stop/reconnect.
        onSettle: (): Promise<void> =>
          this.enqueueLifecycle(() =>
            this.synchronizeAfterSettle(workspaceKey, activeClient, session, conversation),
          ),
      });
      this.conversation = conversation;
      conversation.onEvent((event: ConversationEvent) => this.handlers.onEvent?.(event));

      client.onEvent((event) => {
        // Agent-state change events are projected into the runtime snapshot
        // so selectors observe the authoritative state without re-querying;
        // the raw event is still forwarded for protocol consumers.
        if (this.client === client) {
          if (event.type === 'model_change') {
            const model = parseModelChangeEvent(event);
            if (model !== null) this.setSnapshot({ model });
          } else if (event.type === 'thinking_level_change') {
            const level = parseThinkingLevelChangeEvent(event);
            if (level !== null) this.setSnapshot({ thinkingLevel: level });
          }
        }
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
      // A cold start creates a fresh ConversationController with an empty
      // timeline: request the full entry list (no `since` cursor) so a clean
      // restart re-hydrates the complete user/assistant history even when
      // the persisted append cursor is at the tail. The override is
      // request-scoped — the restored cursor stays in memory, and reconnect
      // and post-settle synchronization keep catching up incrementally.
      const sync = await session.synchronize({ since: null });
      conversation.hydrate(sync.entries);
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
        // Projected from the get_state handshake run by openSession; no
        // second request is needed to seed the agent-state selectors.
        model: session.model,
        thinkingLevel: session.thinkingLevel,
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
    this.setSnapshot({ state: 'starting', workspace, lastError: null, lastWarning: null });
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
        // Projected from the get_state handshake run by the forced open;
        // reconnect re-seeds the agent state without an extra round trip.
        model: session.model,
        thinkingLevel: session.thinkingLevel,
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
        await this.persistPointer(sessionWorkspaceKey(workspace), session);
      }
      this.session = null;
      // The Pi process is gone: the projected agent state and the model list
      // no longer describe anything, so the selectors reset with the runtime.
      this.setSnapshot({
        state: 'stopped',
        workspace: null,
        piVersion: null,
        model: null,
        thinkingLevel: null,
        availableModels: [],
      });
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

  /**
   * List the models Pi can switch to. The command shape is owned here: the
   * renderer can never pick a Pi command type. The response's `models` array
   * is authoritative and replaces `snapshot.availableModels` so selectors
   * observe the same list the response returned.
   */
  async getAvailableModels(): Promise<PiModel[]> {
    if (!this.client) {
      throw new Error('Pi is not running. Start Pi before listing models.');
    }
    const response = await this.client.request({ type: 'get_available_models' });
    const models = parseAvailableModels(response.data);
    this.setSnapshot({ availableModels: models });
    return models;
  }

  /**
   * Switch the active agent model. Provider and model id are validated here
   * (the last boundary before a Pi command is built) and forwarded verbatim
   * as `{type: 'set_model', provider, modelId}`. The response's model data
   * is authoritative: it is applied to the snapshot and returned to the
   * caller, falling back to the requested identity when Pi acknowledges
   * without echoing the model.
   */
  async setModel(provider: string, modelId: string): Promise<PiModel> {
    if (!this.client) {
      throw new Error('Pi is not running. Start Pi before changing the model.');
    }
    const validatedProvider = validateModelIdentifier(provider, 'provider');
    const validatedModelId = validateModelIdentifier(modelId, 'modelId');
    const response = await this.client.request({
      type: 'set_model',
      provider: validatedProvider,
      modelId: validatedModelId,
    });
    const model = parseModelRecord(response.data) ?? {
      id: validatedModelId,
      provider: validatedProvider,
    };
    this.setSnapshot({ model });
    return model;
  }

  /**
   * Switch the agent thinking level. Only Pi's allowed levels pass the
   * runtime boundary; the command is `{type: 'set_thinking_level', level}`.
   * The applied level (echoed by Pi when it does, otherwise the requested
   * one) is authoritative and updates the snapshot.
   */
  async setThinkingLevel(level: PiThinkingLevel): Promise<PiThinkingLevel> {
    if (!this.client) {
      throw new Error('Pi is not running. Start Pi before changing the thinking level.');
    }
    if (!isThinkingLevel(level)) {
      throw new TypeError(
        `Invalid Pi thinking level: "${String(level)}". Expected one of: ${PI_THINKING_LEVELS.join(', ')}`,
      );
    }
    const response = await this.client.request({ type: 'set_thinking_level', level });
    const applied = parseEchoedThinkingLevel(response.data) ?? level;
    this.setSnapshot({ thinkingLevel: applied });
    return applied;
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

  /**
   * Persist the current session pointer. Persistence is best effort: Pi stays
   * authoritative for the session, so a failed save never rejects the healthy
   * startup, reconnect, or post-settle path. The failure is reported as a
   * visible runtime warning (`lastWarning`, published via the runtime event
   * channel) while the runtime keeps running and the queue keeps dispatching;
   * the next successful save clears it. The in-memory cursor state is never
   * affected.
   */
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
    try {
      await this.sessionStore.save(pointer);
    } catch (error) {
      this.setSnapshot({
        lastWarning: `Failed to persist the Pi session pointer: ${errorMessage(error)}`,
      });
      return;
    }
    if (this.snapshotValue.lastWarning !== null) {
      this.setSnapshot({ lastWarning: null });
    }
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
