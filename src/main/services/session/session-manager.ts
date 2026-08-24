import type {
  JsonObject,
  JsonValue,
  PiRpcCommand,
  PiRpcEvent,
  PiRpcSuccessResponse,
} from "../pi/protocol.ts";

export type {
  JsonValue,
  PiRpcCommand,
  PiRpcEvent,
  PiRpcSuccessResponse,
} from "../pi/protocol.ts";

/**
 * Lifecycle for one logical Pi session.
 *
 * The manager owns this small state machine only.  Process, WSL, Electron,
 * provider, model, and authentication lifecycles remain outside this module.
 */
export type SessionLifecycleState =
  | "new"
  | "creating"
  | "resuming"
  | "reconnecting"
  | "synchronizing"
  | "forking"
  | "ready"
  | "closing"
  | "closed"
  | "disconnected"
  | "failed";

/** Pi entry ids are opaque; the manager never orders or interprets them. */
export type SessionCursor = string | null;

/** Plain data that can be persisted and later used to restore a manager. */
export interface SessionSnapshot {
  readonly state: SessionLifecycleState;
  readonly sessionId: string | null;
  readonly lastEntryId: SessionCursor;
  readonly lastError: string | null;
}

/** A structural subset of PiRpcClient used by the session service. */
export interface SessionPiRpcClient {
  request<TData extends JsonValue = JsonValue>(
    command: PiRpcCommand,
  ): Promise<PiRpcSuccessResponse<TData>>;
  onEvent?(listener: (event: PiRpcEvent) => void | Promise<void>): () => void;
}

/** Alias for integrations that prefer the conventional "client-like" name. */
export type PiRpcClientLike = SessionPiRpcClient;

export type SessionSnapshotListener = (snapshot: SessionSnapshot) => void | Promise<void>;

/**
 * Commands are injectable because Pi protocol command names and paging fields
 * may evolve independently of the desktop shell.  The defaults match the
 * current Pi RPC vocabulary used by the reference adapters.
 */
export interface SessionCommandFactory {
  readonly create: (sessionId: string | null) => PiRpcCommand;
  readonly synchronize: (sessionId: string | null, cursor: SessionCursor) => PiRpcCommand;
  readonly close: (sessionId: string | null) => PiRpcCommand | null;
  readonly fork: (sessionId: string | null, entryId: string) => PiRpcCommand;
}

export interface SessionManagerOptions {
  readonly client?: SessionPiRpcClient;
  readonly sessionId?: string | null;
  readonly lastEntryId?: SessionCursor;
  readonly initialSnapshot?: SessionSnapshot;
  readonly commands?: Partial<SessionCommandFactory>;
}

export interface SessionReconnectOptions {
  /** Set false to attach a replacement client without replaying history yet. */
  readonly synchronize?: boolean;
}

export interface SessionSynchronizationResult {
  readonly sessionId: string | null;
  readonly requestedAfter: SessionCursor;
  readonly previousLastEntryId: SessionCursor;
  readonly lastEntryId: SessionCursor;
  /** Raw Pi-owned records returned by the synchronization command. */
  readonly entries: readonly JsonValue[];
  readonly entryCount: number;
}

export interface SessionForkResult {
  readonly sessionId: string | null;
  readonly entryId: string;
  readonly data: JsonValue | null;
  readonly snapshot: SessionSnapshot;
}

export type SessionManagerErrorCode =
  | "NO_CLIENT"
  | "INVALID_STATE"
  | "INVALID_ENTRY_ID"
  | "INVALID_COMMAND"
  | "INVALID_RESPONSE"
  | "RPC_FAILURE";

export class SessionManagerError extends Error {
  readonly code: SessionManagerErrorCode;
  readonly operation: string;

  constructor(
    code: SessionManagerErrorCode,
    operation: string,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "SessionManagerError";
    this.code = code;
    this.operation = operation;
  }
}

const defaultCommands: SessionCommandFactory = {
  create: () => ({ type: "new_session" }),
  synchronize: (_sessionId, cursor) =>
    cursor === null ? { type: "get_messages" } : { type: "get_messages", after: cursor },
  // Closing a logical session does not terminate a Pi process.  The owner of
  // PiRpcClient decides whether to abort or close that process separately.
  close: () => null,
  fork: (_sessionId, entryId) => ({ type: "fork", entryId }),
};

const recoverableStates = new Set<SessionLifecycleState>([
  "new",
  "ready",
  "disconnected",
  "failed",
]);

function asRecord(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readString(record: JsonObject | null, keys: readonly string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = nonEmptyString(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function readEntries(value: unknown): JsonValue[] {
  if (Array.isArray(value)) return [...value] as JsonValue[];

  const record = asRecord(value);
  if (!record) return [];

  for (const key of ["entries", "missingEntries", "messages", "items"]) {
    if (Array.isArray(record[key])) {
      return [...(record[key] as JsonValue[])];
    }
  }

  return [];
}

function entryIdFromValue(value: unknown, allowGenericId: boolean): string | null {
  const record = asRecord(value);
  if (!record) return null;

  const namedId = readString(record, [
    "entryId",
    "entry_id",
    "lastEntryId",
    "last_entry_id",
    "leafId",
    "leaf_id",
  ]);
  if (namedId !== null) return namedId;

  return allowGenericId ? readString(record, ["id"]) : null;
}

function eventEntryId(event: PiRpcEvent): string | null {
  const direct = entryIdFromValue(event, false);
  if (direct !== null) return direct;

  const record = asRecord(event);
  if (!record) return null;

  // Pi adapters place entry metadata on the event, its message, or a data
  // envelope.  Do not inspect event.id: Pi uses that field for RPC request
  // correlation, not session history identity.
  for (const key of ["entry", "message", "data", "payload"]) {
    const nested = asRecord(record[key]);
    const nestedId = entryIdFromValue(nested, key === "entry");
    if (nestedId !== null) return nestedId;
  }

  return null;
}

function responseSessionId(response: PiRpcSuccessResponse): string | null {
  const root = asRecord(response);
  const rootId = readString(root, ["sessionId", "session_id"]);
  if (rootId !== null) return rootId;

  const data = asRecord(response.data);
  const dataId = readString(data, ["sessionId", "session_id"]);
  if (dataId !== null) return dataId;

  return readString(asRecord(data?.session), ["sessionId", "session_id"]);
}

function responseCursor(response: PiRpcSuccessResponse, entries: readonly JsonValue[]): string | null {
  const root = asRecord(response);
  const rootCursor = readString(root, ["lastEntryId", "last_entry_id", "nextCursor", "next_cursor"]);
  if (rootCursor !== null) return rootCursor;

  const data = asRecord(response.data);
  const dataCursor = readString(data, [
    "lastEntryId",
    "last_entry_id",
    "nextCursor",
    "next_cursor",
    "cursor",
  ]);
  if (dataCursor !== null) return dataCursor;

  const nestedCursor = readString(asRecord(data?.session), ["lastEntryId", "last_entry_id"]);
  if (nestedCursor !== null) return nestedCursor;

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entryId = entryIdFromValue(entries[index], true);
    if (entryId !== null) return entryId;
  }

  return null;
}

function responseData(response: PiRpcSuccessResponse): JsonValue | null {
  return response.data === undefined ? null : response.data;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateCommand(command: PiRpcCommand, operation: string): PiRpcCommand {
  if (!command || typeof command.type !== "string" || command.type.trim().length === 0) {
    throw new SessionManagerError(
      "INVALID_COMMAND",
      operation,
      `Session ${operation} command must have a non-empty type`,
    );
  }
  return { ...command, type: command.type.trim() };
}

function validateSessionId(sessionId: string | null | undefined): string | null {
  if (sessionId === undefined || sessionId === null) return null;
  const normalized = nonEmptyString(sessionId);
  if (normalized === null) {
    throw new TypeError("sessionId must be a non-empty string or null");
  }
  return normalized;
}

function validateCursor(cursor: SessionCursor | undefined): SessionCursor {
  if (cursor === undefined || cursor === null) return null;
  return validateSessionId(cursor);
}

/**
 * Owns logical session state and Pi-history catch-up, but not the Pi process.
 *
 * `PiRpcClient` satisfies `SessionPiRpcClient` structurally.  A new client can
 * be supplied to `reconnect()` after a Pi restart; the manager then requests
 * history after its persisted `lastEntryId` cursor and returns raw Pi records
 * to the caller without maintaining a second history database.
 */
export class SessionManager {
  private clientValue: SessionPiRpcClient | null = null;
  private unsubscribeValue: (() => void) | null = null;
  private stateValue: SessionLifecycleState = "new";
  private sessionIdValue: string | null = null;
  private lastEntryIdValue: SessionCursor = null;
  private lastErrorValue: string | null = null;
  private readonly commands: SessionCommandFactory;
  private readonly stateListeners = new Set<SessionSnapshotListener>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(options: SessionManagerOptions = {}) {
    const initial = options.initialSnapshot;
    this.stateValue = initial?.state ?? "new";
    this.sessionIdValue = validateSessionId(options.sessionId ?? initial?.sessionId);
    this.lastEntryIdValue = validateCursor(options.lastEntryId ?? initial?.lastEntryId);
    this.lastErrorValue = initial?.lastError ?? null;
    this.commands = { ...defaultCommands, ...options.commands };

    if (options.client) {
      this.attachClient(options.client);
    }
  }

  /** Restore serializable manager state and attach a replacement client later. */
  static fromSnapshot(
    snapshot: SessionSnapshot,
    client?: SessionPiRpcClient,
    options: Omit<SessionManagerOptions, "initialSnapshot" | "client"> = {},
  ): SessionManager {
    return new SessionManager({ ...options, initialSnapshot: snapshot, client });
  }

  get state(): SessionLifecycleState {
    return this.stateValue;
  }

  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  get lastEntryId(): SessionCursor {
    return this.lastEntryIdValue;
  }

  /** Alias that makes the persisted entry id explicit as a synchronization cursor. */
  get cursor(): SessionCursor {
    return this.lastEntryIdValue;
  }

  getSnapshot(): SessionSnapshot {
    return {
      state: this.stateValue,
      sessionId: this.sessionIdValue,
      lastEntryId: this.lastEntryIdValue,
      lastError: this.lastErrorValue,
    };
  }

  /** A property-style snapshot seam for callers that prefer state access. */
  get snapshot(): SessionSnapshot {
    return this.getSnapshot();
  }

  onStateChange(listener: SessionSnapshotListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  /** Create a new Pi-owned session through the injected client. */
  create(): Promise<SessionSnapshot> {
    return this.enqueue(async () => {
      if (this.stateValue === "ready") return this.getSnapshot();
      this.assertState("create", ["new", "failed", "disconnected"]);
      const client = this.requireClient("create");
      this.clearError();
      this.setState("creating");

      try {
        const command = validateCommand(this.commands.create(this.sessionIdValue), "create");
        const response = await this.request(client, command, "create");
        this.applyResponseMetadata(response);
        this.setState("ready");
        return this.getSnapshot();
      } catch (error: unknown) {
        throw this.fail("create", error, "failed");
      }
    });
  }

  /**
   * Resume from the current cursor.  This is deliberately a history replay,
   * not a second provider/model/auth bootstrap; Pi remains authoritative.
   */
  resume(): Promise<SessionSynchronizationResult> {
    return this.enqueue(async () => {
      this.assertState("resume", [...recoverableStates]);
      this.requireClient("resume");
      this.clearError();
      this.setState("resuming");
      return this.synchronizeInternal("resume");
    });
  }

  /** Attach a replacement Pi client and optionally catch up from the cursor. */
  reconnect(
    client: SessionPiRpcClient,
    options: SessionReconnectOptions = {},
  ): Promise<SessionSynchronizationResult | null> {
    return this.enqueue(async () => {
      this.assertState("reconnect", [
        "new",
        "ready",
        "failed",
        "disconnected",
      ]);
      this.clearError();
      this.detachClient();
      this.attachClient(client);
      this.setState("reconnecting");

      if (options.synchronize === false) {
        this.setState("ready");
        return null;
      }

      return this.synchronizeInternal("reconnect");
    });
  }

  /** Request Pi-owned records after the current last-entry cursor. */
  synchronize(): Promise<SessionSynchronizationResult> {
    return this.enqueue(async () => {
      this.assertState("synchronize", [...recoverableStates]);
      this.requireClient("synchronize");
      this.clearError();
      return this.synchronizeInternal("synchronize");
    });
  }

  /** Fork the active Pi session at an authoritative Pi entry id. */
  fork(entryId: string): Promise<SessionForkResult> {
    return this.enqueue(async () => {
      this.assertState("fork", ["ready"]);
      const normalizedEntryId = nonEmptyString(entryId);
      if (normalizedEntryId === null) {
        throw new SessionManagerError(
          "INVALID_ENTRY_ID",
          "fork",
          "Session fork requires a non-empty Pi entry id",
        );
      }

      const client = this.requireClient("fork");
      this.clearError();
      this.setState("forking");

      try {
        const command = validateCommand(
          this.commands.fork(this.sessionIdValue, normalizedEntryId),
          "fork",
        );
        const response = await this.request(client, command, "fork");
        this.applyResponseMetadata(response);
        this.setState("ready");
        return {
          sessionId: this.sessionIdValue,
          entryId: normalizedEntryId,
          data: responseData(response),
          snapshot: this.getSnapshot(),
        };
      } catch (error: unknown) {
        throw this.fail("fork", error, "failed");
      }
    });
  }

  /**
   * Close this logical manager and detach event listeners.  By default this
   * sends no process command; an integration may inject a close command (for
   * example `abort`) while retaining ownership of PiRpcClient shutdown.
   */
  close(): Promise<SessionSnapshot> {
    return this.enqueue(async () => {
      if (this.stateValue === "closed") return this.getSnapshot();
      this.assertState("close", [
        "new",
        "ready",
        "failed",
        "disconnected",
      ]);
      this.clearError();
      this.setState("closing");

      try {
        const command = validateOptionalCommand(
          this.commands.close(this.sessionIdValue),
          "close",
        );
        if (command) {
          const client = this.requireClient("close");
          const response = await this.request(client, command, "close");
          this.applyResponseMetadata(response);
        }
        this.detachClient();
        this.setState("closed");
        return this.getSnapshot();
      } catch (error: unknown) {
        throw this.fail("close", error, "failed");
      }
    });
  }

  private synchronizeInternal(operation: "resume" | "reconnect" | "synchronize"): Promise<SessionSynchronizationResult> {
    const client = this.requireClient(operation);
    const previousLastEntryId = this.lastEntryIdValue;
    this.setState("synchronizing");

    return this.request(
      client,
      validateCommand(
        this.commands.synchronize(this.sessionIdValue, previousLastEntryId),
        "synchronize",
      ),
      "synchronize",
    )
      .then((response) => {
        const entries = readEntries(response.data);
        this.applyResponseMetadata(response, entries);
        this.setState("ready");
        return {
          sessionId: this.sessionIdValue,
          requestedAfter: previousLastEntryId,
          previousLastEntryId,
          lastEntryId: this.lastEntryIdValue,
          entries,
          entryCount: entries.length,
        };
      })
      .catch((error: unknown) => {
        throw this.fail(operation, error, "disconnected");
      });
  }

  private applyResponseMetadata(
    response: PiRpcSuccessResponse,
    entries: readonly JsonValue[] = [],
  ): void {
    const sessionId = responseSessionId(response);
    if (sessionId !== null) this.sessionIdValue = sessionId;

    const cursor = responseCursor(response, entries);
    if (cursor !== null) this.lastEntryIdValue = cursor;
  }

  private request(
    client: SessionPiRpcClient,
    command: PiRpcCommand,
    operation: string,
  ): Promise<PiRpcSuccessResponse> {
    return client.request(command).then((response) => {
      if (!response || response.success !== true || response.type !== "response") {
        throw new SessionManagerError(
          "RPC_FAILURE",
          operation,
          `Pi rejected session ${operation}`,
        );
      }
      return response;
    });
  }

  private attachClient(client: SessionPiRpcClient): void {
    this.clientValue = client;
    if (typeof client.onEvent !== "function") return;
    this.unsubscribeValue = client.onEvent((event) => {
      const entryId = eventEntryId(event);
      if (entryId !== null) {
        this.lastEntryIdValue = entryId;
        this.emitSnapshot();
      }
    });
  }

  private detachClient(): void {
    const unsubscribe = this.unsubscribeValue;
    this.unsubscribeValue = null;
    this.clientValue = null;
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // Event-listener cleanup is best effort; the manager is detached.
      }
    }
  }

  private requireClient(operation: string): SessionPiRpcClient {
    if (this.clientValue) return this.clientValue;
    throw new SessionManagerError(
      "NO_CLIENT",
      operation,
      `Cannot ${operation} session without an injected Pi RPC client`,
    );
  }

  private assertState(operation: string, allowed: readonly SessionLifecycleState[]): void {
    if (allowed.includes(this.stateValue)) return;
    throw new SessionManagerError(
      "INVALID_STATE",
      operation,
      `Cannot ${operation} session while state is ${this.stateValue}`,
    );
  }

  private clearError(): void {
    this.lastErrorValue = null;
  }

  private fail(
    operation: string,
    error: unknown,
    state: "failed" | "disconnected",
  ): SessionManagerError {
    const wrapped =
      error instanceof SessionManagerError
        ? error
        : new SessionManagerError(
            "RPC_FAILURE",
            operation,
            `Session ${operation} failed: ${errorMessage(error)}`,
            { cause: error },
          );
    this.lastErrorValue = wrapped.message;
    this.setState(state);
    return wrapped;
  }

  private setState(state: SessionLifecycleState): void {
    this.stateValue = state;
    this.emitSnapshot();
  }

  private emitSnapshot(): void {
    const snapshot = this.getSnapshot();
    for (const listener of [...this.stateListeners]) {
      try {
        void listener(snapshot);
      } catch {
        // State observers are not allowed to break session recovery.
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationTail.then(operation, operation);
    this.operationTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function validateOptionalCommand(
  command: PiRpcCommand | null,
  operation: string,
): PiRpcCommand | null {
  return command === null ? null : validateCommand(command, operation);
}
