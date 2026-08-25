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
  /** Pi-owned session file path, authoritative for resuming the session. */
  readonly sessionFile: string | null;
  /**
   * Durable append-order cursor: the last entry id observed in a get_entries
   * response (preserved when a response returns no entries). Drives the next
   * `since` catch-up; `lastEntryId` is a compatibility alias of this value.
   */
  readonly lastSeenEntryId: SessionCursor;
  /** Current active leaf from the last get_entries response; never a cursor. */
  readonly leafId: SessionCursor;
  /** Compatibility alias equal to lastSeenEntryId (legacy name). */
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
 * may evolve independently of the desktop shell.  The defaults match Pi's
 * current RPC vocabulary: session open is `switch_session` (resume) or
 * `new_session` (create) followed by `get_state`; history replay is
 * `get_entries` with an optional `since` cursor; the response's `entries`
 * (append order) and `leafId` (active leaf) are authoritative.
 */
export interface SessionCommandFactory {
  readonly create: (sessionId: string | null) => PiRpcCommand;
  /** Resume a persisted Pi-owned session file (`switch_session`). */
  readonly switchSession: (sessionFile: string) => PiRpcCommand;
  /** Read authoritative session identity (`get_state`). */
  readonly getState: () => PiRpcCommand;
  readonly synchronize: (sessionId: string | null, cursor: SessionCursor) => PiRpcCommand;
  readonly close: (sessionId: string | null) => PiRpcCommand | null;
  readonly fork: (sessionId: string | null, entryId: string) => PiRpcCommand;
}

export interface SessionManagerOptions {
  readonly client?: SessionPiRpcClient;
  readonly sessionId?: string | null;
  readonly sessionFile?: string | null;
  /** Durable append-order cursor; drives the next get_entries `since`. */
  readonly lastSeenEntryId?: SessionCursor;
  /** Current active leaf from the last get_entries; never a cursor. */
  readonly leafId?: SessionCursor;
  /** Legacy alias for `lastSeenEntryId` accepted for restored pointers. */
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
  /** The durable cursor the replay was requested from; null = full history. */
  readonly requestedAfter: SessionCursor;
  readonly previousLastEntryId: SessionCursor;
  /**
   * Durable append-order cursor: the last entry id observed in the response
   * (preserved when the response returns no entries). `lastEntryId` is a
   * compatibility alias of this value.
   */
  readonly lastSeenEntryId: SessionCursor;
  /** Current active leaf from the response (`leafId`); never a cursor. */
  readonly leafId: SessionCursor;
  /** Compatibility alias equal to lastSeenEntryId (legacy name). */
  readonly lastEntryId: SessionCursor;
  /** Raw Pi-owned records returned by the synchronization command. */
  readonly entries: readonly JsonValue[];
  readonly entryCount: number;
}

/** Outcome of the open handshake: resume (switch) or fresh session plus state. */
export interface SessionOpenResult {
  readonly sessionId: string | null;
  readonly sessionFile: string | null;
  /** True when a persisted Pi session file was resumed via switch_session. */
  readonly resumed: boolean;
  readonly snapshot: SessionSnapshot;
}

export interface SessionOpenOptions {
  /**
   * Re-run the open handshake even when the manager is already ready. Used
   * after a transport replacement: the new Pi process must be bound to the
   * persisted session file again before history catch-up.
   */
  readonly force?: boolean;
  /**
   * Permit a failed/cancelled switch_session to create a fresh session.
   * Initial startup permits this by default; reconnect callers disable it so
   * an old conversation cannot be paired with a new Pi session.
   */
  readonly fallbackToNewSession?: boolean;
}

export type SessionManagerErrorCode =
  | "NO_CLIENT"
  | "INVALID_STATE"
  | "INVALID_ENTRY_ID"
  | "INVALID_COMMAND"
  | "INVALID_RESPONSE"
  | "RPC_FAILURE"
  | "SESSION_NOT_RESUMED";

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
  // Resume the persisted Pi-owned session file. Cancellation and failures are
  // soft fallbacks handled by openSession, not startup errors.
  switchSession: (sessionFile) => ({ type: "switch_session", sessionPath: sessionFile }),
  getState: () => ({ type: "get_state" }),
  synchronize: (_sessionId, cursor) =>
    cursor === null ? { type: "get_entries" } : { type: "get_entries", since: cursor },
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

  // `entries` is the authoritative history output of Pi's get_entries
  // command; legacy message/item collection shapes are no longer read.
  const entries = record["entries"];
  return Array.isArray(entries) ? [...(entries as JsonValue[])] : [];
}

function entryIdFromValue(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;

  // Named id fields first; a bare `id` is accepted only for records that are
  // part of the authoritative get_entries output.
  return readString(record, [
    "entryId",
    "entry_id",
    "lastEntryId",
    "last_entry_id",
    "leafId",
    "leaf_id",
    "id",
  ]);
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

function responseSessionFile(response: PiRpcSuccessResponse): string | null {
  const root = asRecord(response);
  const rootFile = readString(root, ["sessionFile", "session_file"]);
  if (rootFile !== null) return rootFile;
  return readString(asRecord(response.data), ["sessionFile", "session_file"]);
}

function recordHasKey(record: JsonObject | null, key: string): boolean {
  return record !== null && record[key] !== undefined;
}

/**
 * Read the current active leaf (`leafId`) from a response. The leaf pins the
 * branch tip and may lag the append end; it is exposed separately and never
 * used as a catch-up cursor.
 *
 * A response that carries the key with an explicit `null` (Pi reports no
 * active leaf) must reset the leaf, so presence is reported separately from
 * the value.
 */
function responseLeafId(response: PiRpcSuccessResponse): {
  readonly present: boolean;
  readonly value: string | null;
} {
  const root = asRecord(response);
  if (recordHasKey(root, "leafId") || recordHasKey(root, "leaf_id")) {
    return { present: true, value: readString(root, ["leafId", "leaf_id"]) };
  }
  const data = asRecord(response.data);
  if (recordHasKey(data, "leafId") || recordHasKey(data, "leaf_id")) {
    return { present: true, value: readString(data, ["leafId", "leaf_id"]) };
  }
  return { present: false, value: null };
}

/**
 * Resolve the durable append-order cursor from a response.
 *
 * The last entry id observed in append order is authoritative. When a
 * response returns no append-ordered entries the previous cursor is
 * preserved; explicit cursor fields carried by other command responses
 * (`lastEntryId`/`nextCursor`/`cursor`) are honored only then. `leafId` is
 * deliberately excluded: it is the active branch leaf, which can point
 * anywhere in the branch tree, and using it as a `since` cursor would skip
 * append-ordered records.
 */
function responseAppendCursor(
  response: PiRpcSuccessResponse,
  entries: readonly JsonValue[],
  previous: SessionCursor,
): SessionCursor {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entryId = entryIdFromValue(entries[index]);
    if (entryId !== null) return entryId;
  }

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

  return previous;
}

function responseData(response: PiRpcSuccessResponse): JsonValue | null {
  return response.data === undefined ? null : response.data;
}

/**
 * A successful `switch_session` may still report `cancelled: true`; that is a
 * soft fallback signal, not an RPC failure.
 */
function isCancelled(response: PiRpcSuccessResponse): boolean {
  if (asRecord(response)?.["cancelled"] === true) return true;
  return asRecord(response.data)?.["cancelled"] === true;
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

function validateSessionFile(sessionFile: string | null | undefined): string | null {
  if (sessionFile === undefined || sessionFile === null) return null;
  const normalized = nonEmptyString(sessionFile);
  if (normalized === null) {
    throw new TypeError("sessionFile must be a non-empty string or null");
  }
  if (!isCanonicalSessionFilePath(normalized)) {
    throw new TypeError(
      "sessionFile must be an absolute Linux-style path without backslashes, " +
        "control characters, dot segments, duplicate separators, or a trailing slash",
    );
  }
  return normalized;
}

/**
 * Only canonical absolute Linux-style paths may be forwarded to Pi via
 * `switch_session`. Relative and Windows-style paths, NUL/control
 * characters, `.`/`..` segments, duplicate separators, and trailing slashes
 * (except root itself) are rejected so malformed session files never reach
 * Pi.
 */
function isCanonicalSessionFilePath(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.includes("\\")) return false;
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code === 0 || code < 0x20 || code === 0x7f) return false;
  }
  if (path === "/") return true; // root: canonical absolute path, no name
  if (path.endsWith("/")) return false;
  const segments = path.split("/");
  // segments[0] is the "" from the leading "/"; every later segment must be a
  // non-empty, non-dot name (an empty name means a duplicate separator).
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.length === 0 || segment === "." || segment === "..") return false;
  }
  return true;
}

function validateCursor(cursor: SessionCursor | undefined): SessionCursor {
  if (cursor === undefined || cursor === null) return null;
  return validateSessionId(cursor);
}

/**
 * Owns logical session state and Pi-history catch-up, but not the Pi process.
 *
 * `PiRpcClient` satisfies `SessionPiRpcClient` structurally.  `openSession()`
 * runs the resume-or-create handshake (`switch_session`/`new_session` then
 * `get_state`) and adopts Pi's authoritative session file/id; `synchronize()`
 * requests history via `get_entries` since the persisted append cursor
 * (`lastSeenEntryId`) and returns the raw `entries` plus the active
 * `leafId` to the caller without maintaining a second history database.
 * The append cursor is the last entry id observed in append order (never the
 * active leaf), and durable cursors come only from those responses, never
 * from agent events.
 */
export class SessionManager {
  private clientValue: SessionPiRpcClient | null = null;
  private stateValue: SessionLifecycleState = "new";
  private sessionIdValue: string | null = null;
  private sessionFileValue: string | null = null;
  private lastSeenEntryIdValue: SessionCursor = null;
  private leafIdValue: SessionCursor = null;
  private lastErrorValue: string | null = null;
  private readonly commands: SessionCommandFactory;
  private readonly stateListeners = new Set<SessionSnapshotListener>();
  private operationTail: Promise<void> = Promise.resolve();

  constructor(options: SessionManagerOptions = {}) {
    const initial = options.initialSnapshot;
    this.stateValue = initial?.state ?? "new";
    this.sessionIdValue = validateSessionId(options.sessionId ?? initial?.sessionId);
    this.sessionFileValue = validateSessionFile(options.sessionFile ?? initial?.sessionFile);
    // The canonical append cursor is lastSeenEntryId; lastEntryId is accepted
    // as a legacy alias so restored pointers migrate without losing the
    // durable cursor.
    this.lastSeenEntryIdValue = validateCursor(
      options.lastSeenEntryId ??
        initial?.lastSeenEntryId ??
        options.lastEntryId ??
        initial?.lastEntryId,
    );
    this.leafIdValue = validateCursor(options.leafId ?? initial?.leafId);
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

  get sessionFile(): string | null {
    return this.sessionFileValue;
  }

  /** Durable append-order cursor; drives the next get_entries `since`. */
  get lastSeenEntryId(): SessionCursor {
    return this.lastSeenEntryIdValue;
  }

  /** Current active leaf from the last get_entries response; never a cursor. */
  get leafId(): SessionCursor {
    return this.leafIdValue;
  }

  /** Compatibility alias equal to lastSeenEntryId (legacy name). */
  get lastEntryId(): SessionCursor {
    return this.lastSeenEntryIdValue;
  }

  /** Alias that makes the durable append cursor explicit as a synchronization cursor. */
  get cursor(): SessionCursor {
    return this.lastSeenEntryIdValue;
  }

  getSnapshot(): SessionSnapshot {
    return {
      state: this.stateValue,
      sessionId: this.sessionIdValue,
      sessionFile: this.sessionFileValue,
      lastSeenEntryId: this.lastSeenEntryIdValue,
      leafId: this.leafIdValue,
      lastEntryId: this.lastSeenEntryIdValue,
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
   * Open the Pi-owned session and read its authoritative identity.
   *
   * Handshake: when a persisted session file is supplied, `switch_session` is
   * tried first; a cancellation (`cancelled: true`) or any failure degrades
   * softly to `new_session`. The successful open is always followed by
   * `get_state`, whose `sessionFile` (falling back to `sessionId`) is the
   * authoritative session identity. Pi owns the session file; the caller
   * persists only this pointer.
   */
  openSession(sessionFile: string | null, options: SessionOpenOptions = {}): Promise<SessionOpenResult> {
    return this.enqueue(async () => {
      if (this.stateValue === "ready" && !options.force) return this.openResult(false);
      this.assertState(
        "open",
        options.force
          ? ["new", "ready", "failed", "disconnected"]
          : ["new", "failed", "disconnected"],
      );
      const client = this.requireClient("open");
      this.clearError();
      // Reject a malformed persisted session file before touching state or
      // Pi: it must never reach `switch_session`, and the manager must not be
      // left mid-handshake by a validation error.
      const target = validateSessionFile(sessionFile);
      this.setState("creating");

      try {
        const resumed = target !== null ? await this.trySwitchSession(client, target) : false;
        if (!resumed) {
          if (options.fallbackToNewSession === false) {
            throw new SessionManagerError(
              "SESSION_NOT_RESUMED",
              "open",
              "Pi did not resume the existing session",
            );
          }
          // The persisted session could not be resumed: drop the stale
          // identity and cursor before starting a fresh session so the
          // `new_session -> get_state -> get_entries` sequence sends no
          // `since` cursor from the abandoned Pi session and adopts the new
          // authoritative identity.  The reset is published as an explicit
          // snapshot so observers (e.g. runtime snapshot forwarding) never
          // retain the abandoned session's pointer data.
          this.sessionIdValue = null;
          this.sessionFileValue = null;
          this.lastSeenEntryIdValue = null;
          this.leafIdValue = null;
          this.emitSnapshot();
          const command = validateCommand(this.commands.create(this.sessionIdValue), "create");
          const response = await this.request(client, command, "create");
          this.applyResponseMetadata(response);
        }
        return await this.readState(client, resumed);
      } catch (error: unknown) {
        throw this.fail("open", error, "failed");
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

  /**
   * Attempt `switch_session` against a persisted Pi session file. Returns
   * true when Pi accepted it; cancellation and RPC failures degrade softly to
   * false so the caller falls back to `new_session` without failing startup.
   */
  private async trySwitchSession(
    client: SessionPiRpcClient,
    sessionFile: string,
  ): Promise<boolean> {
    const command = validateCommand(this.commands.switchSession(sessionFile), "switch");
    try {
      const response = await this.request(client, command, "switch");
      this.applyResponseMetadata(response);
      return !isCancelled(response);
    } catch {
      return false;
    }
  }

  /** Read `get_state` and adopt the authoritative session identity. */
  private async readState(client: SessionPiRpcClient, resumed: boolean): Promise<SessionOpenResult> {
    const command = validateCommand(this.commands.getState(), "state");
    const response = await this.request(client, command, "state");
    this.applyResponseMetadata(response);
    this.setState("ready");
    return this.openResult(resumed);
  }

  private openResult(resumed: boolean): SessionOpenResult {
    return {
      sessionId: this.sessionIdValue,
      sessionFile: this.sessionFileValue,
      resumed,
      snapshot: this.getSnapshot(),
    };
  }

  private synchronizeInternal(operation: "resume" | "reconnect" | "synchronize"): Promise<SessionSynchronizationResult> {
    const client = this.requireClient(operation);
    const previousLastEntryId = this.lastSeenEntryIdValue;
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
          lastSeenEntryId: this.lastSeenEntryIdValue,
          leafId: this.leafIdValue,
          lastEntryId: this.lastSeenEntryIdValue,
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

    const sessionFile = responseSessionFile(response);
    if (sessionFile !== null) this.sessionFileValue = sessionFile;

    const leaf = responseLeafId(response);
    if (leaf.present) this.leafIdValue = leaf.value;

    const cursor = responseAppendCursor(response, entries, this.lastSeenEntryIdValue);
    if (cursor !== null) this.lastSeenEntryIdValue = cursor;
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
    // Durable synchronization cursors come only from get_entries responses.
    // Agent events are forwarded by the caller but never interpreted here as
    // entry ids, so the manager does not subscribe to them.
    this.clientValue = client;
  }

  private detachClient(): void {
    this.clientValue = null;
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
