import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isJsonObject } from "../pi/protocol.ts";

/**
 * A workspace-scoped pointer to a Pi-owned session.
 *
 * Pi owns its session file (and the history inside it); the desktop persists
 * only this small pointer, enough to ask Pi to resume the same session on the
 * next start. `sessionFile` is authoritative for resuming; `sessionId` is a
 * diagnostic fallback identity; `lastEntryId` is the durable `get_entries`
 * cursor used to catch up.
 */
export interface SessionPointer {
  /** Stable workspace key the pointer is stored under. */
  readonly workspace: string;
  /** Pi-owned session file path, authoritative when non-null. */
  readonly sessionFile: string | null;
  /** Pi session id, kept for diagnostics and as a fallback identity. */
  readonly sessionId: string | null;
  /** Durable history cursor (get_entries `leafId`); null = full history. */
  readonly lastEntryId: string | null;
}

/** Persistence seam for the runtime: load by workspace, save a whole pointer. */
export interface SessionStore {
  load(workspace: string): Promise<SessionPointer | null>;
  save(pointer: SessionPointer): Promise<void>;
}

export interface JsonSessionStoreOptions {
  /** Pointer file path; defaults to ~/.pi-desktop/session-pointer.json. */
  readonly filePath?: string;
  readonly readFile?: (path: string) => Promise<string>;
  readonly writeFile?: (path: string, content: string) => Promise<void>;
  readonly rename?: (fromPath: string, toPath: string) => Promise<void>;
}

function defaultPointerPath(): string {
  return join(homedir(), ".pi-desktop", "session-pointer.json");
}

function stringOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requireWorkspaceKey(workspace: unknown): string {
  const key = stringOrNull(workspace);
  if (key === null) {
    throw new TypeError("Session pointer workspace must be a non-empty string");
  }
  return key;
}

/**
 * An empty workspace index with no prototype, so workspace keys are always
 * plain data properties: a key like `__proto__` or `constructor` can never
 * touch the object's prototype or shadow its members.
 */
function createIndex(): Record<string, SessionPointer> {
  return Object.create(null) as Record<string, SessionPointer>;
}

/**
 * Parse a pointer file into a null-prototype record. `JSON.parse` itself
 * never invokes the `__proto__` setter, but a later `index[key] = …`
 * assignment on a plain object would; copying the parsed object into a
 * null-prototype container keeps every key a plain own data property.
 */
function parseIndexRecord(content: string): Record<string, SessionPointer> | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!isJsonObject(value)) return null;
  return Object.assign(createIndex(), value);
}

/**
 * Validate and normalize one loaded pointer record. Missing or non-string
 * identity fields degrade to null; a pointer with neither a session file nor
 * a session id is useless and treated as absent.
 */
function parsePointerFile(content: string, workspace: string): SessionPointer | null {
  const record = parseIndexRecord(content);
  if (record === null) return null;
  // `workspace` is caller-supplied; on a null-prototype record an absent key
  // is `undefined` without consulting any prototype chain.
  const entry = record[workspace];
  if (!isJsonObject(entry)) return null;

  const sessionFile = stringOrNull(entry.sessionFile);
  const sessionId = stringOrNull(entry.sessionId);
  const lastEntryId = stringOrNull(entry.lastEntryId);
  if (sessionFile === null && sessionId === null) return null;

  return { workspace, sessionFile, sessionId, lastEntryId };
}

/**
 * Atomic JSON session pointer store keyed by workspace.
 *
 * Writes go to a unique sibling temp file (mode 0600) that is renamed over
 * the target (mode preserved by the rename), so a crash never leaves a
 * truncated pointer file and the pointer data is never world-readable. The
 * pointer directory is created with mode 0700 where supported. Missing
 * files, corrupt JSON, and invalid records are tolerated: `load` returns
 * null and `save` starts a fresh index rather than failing startup.
 *
 * Indexing is prototype-safe: the parsed index and every new index are
 * null-prototype records, so workspace keys such as `__proto__` or
 * `constructor` are stored as plain data and can never mutate the object
 * prototype or shadow its members. Saves are serialized through a promise
 * tail, so concurrent sync/stop persistence can never read the same stale
 * index and drop a workspace's write. A failed write removes its unique
 * temporary file before rejecting.
 */
export class JsonSessionStore implements SessionStore {
  private readonly filePath: string;
  private readonly readFile: (path: string) => Promise<string>;
  private readonly writeFile: (path: string, content: string) => Promise<void>;
  private readonly rename: (fromPath: string, toPath: string) => Promise<void>;
  private saveTail: Promise<void> = Promise.resolve();

  constructor(options: JsonSessionStoreOptions = {}) {
    this.filePath = options.filePath ?? defaultPointerPath();
    this.readFile = options.readFile ?? ((path) => readFile(path, "utf8"));
    this.writeFile =
      options.writeFile ??
      ((path, content) => writeFile(path, content, { encoding: "utf8", mode: 0o600 }));
    this.rename = options.rename ?? rename;
  }

  async load(workspace: string): Promise<SessionPointer | null> {
    const key = requireWorkspaceKey(workspace);
    let content: string;
    try {
      content = await this.readFile(this.filePath);
    } catch {
      return null;
    }
    return parsePointerFile(content, key);
  }

  /**
   * Persist one workspace pointer. Concurrent saves are serialized so each
   * read-modify-write cycle sees the previous cycle's result; the promise
   * returned to this caller rejects on this save's failure without wedging
   * the tail, so later saves still run.
   */
  save(pointer: SessionPointer): Promise<void> {
    const operation = () => this.performSave(pointer);
    const next = this.saveTail.then(operation, operation);
    this.saveTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async performSave(pointer: SessionPointer): Promise<void> {
    const key = requireWorkspaceKey(pointer.workspace);
    const index = await this.readIndex();
    index[key] = {
      workspace: key,
      sessionFile: stringOrNull(pointer.sessionFile),
      sessionId: stringOrNull(pointer.sessionId),
      lastEntryId: stringOrNull(pointer.lastEntryId),
    };

    // A unique temp name avoids clobbering a leftover temp file from a
    // crashed earlier run and is removed on failure before rejecting.
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      await this.writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`);
      await this.rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async readIndex(): Promise<Record<string, SessionPointer>> {
    let content: string;
    try {
      content = await this.readFile(this.filePath);
    } catch {
      return createIndex();
    }
    const record = parseIndexRecord(content);
    return record ?? createIndex();
  }
}
