import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";

/**
 * Opt-in contract suite against a live `pi --mode rpc --no-session` process.
 *
 * Pins the authoritative wire shapes the desktop shell depends on:
 * - `get_state` answers `success: true` with a JSON `data` object carrying the
 *   session identity.
 * - `get_entries` answers `success: true` with `data.entries` (array, in
 *   append order) and `data.leafId`, the current active leaf — which may be
 *   null. The append cursor is the last entry id, not `leafId`.
 * - `get_entries` with a stale `since` cursor answers `success: false`.
 * - The suite never triggers extension UI requests; any
 *   `extension_ui_request` events pi happens to interleave are tolerated
 *   without breaking request/response correlation.
 *
 * The suite is inert unless `PI_RPC_INTEGRATION=1` (no prompt is sent and no
 * model credentials are required). `PI_RPC_BIN` overrides the executable;
 * the default is `pi` resolved from PATH.
 */

const INTEGRATION_ENABLED = process.env.PI_RPC_INTEGRATION === "1";
const PI_RPC_BIN = process.env.PI_RPC_BIN ?? "pi";

const skipReason =
  "set PI_RPC_INTEGRATION=1 to run against a live `pi --mode rpc --no-session` " +
  `process (override the executable with PI_RPC_BIN; default is "${PI_RPC_BIN}")`;
const skip = INTEGRATION_ENABLED ? false : skipReason;

// Deadline timers for a real child process: fake timers cannot drive an
// external executable. Every wait is bounded (per-request timeout, escalating
// exit grace periods) so a hung or missing pi cannot stall the suite.
const REQUEST_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 60_000;
const EXIT_GRACE_MS = 3_000;
const SIGTERM_GRACE_MS = 1_000;

interface PiRpcWireRecord {
  type: string;
  id?: unknown;
  command?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
  [key: string]: unknown;
}

type PiRpcCommand = { type: string; [key: string]: unknown };

interface PendingRequest {
  resolve: (record: PiRpcWireRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * LF-delimited JSON framing for pi stdout. Only LF ends a record; a trailing
 * CR is stripped for CRLF compatibility and blank lines are ignored. Parsed
 * manually (no generic readline) so the framing contract stays explicit.
 */
class LfFrameParser {
  private buffered = "";
  private decoder = new TextDecoder("utf-8", { fatal: true });

  push(chunk: Buffer | string): string[] {
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    // Streaming decode keeps multibyte sequences that span chunk boundaries
    // intact (same framing as PiJsonlBuffer; no generic readline).
    this.buffered += this.decoder.decode(bytes, { stream: true });

    const records: string[] = [];
    let newline = this.buffered.indexOf("\n");

    while (newline >= 0) {
      let line = this.buffered.slice(0, newline);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      if (line.length > 0) {
        records.push(line);
      }
      this.buffered = this.buffered.slice(newline + 1);
      newline = this.buffered.indexOf("\n");
    }

    return records;
  }
}

/** Spawns `pi --mode rpc --no-session` and speaks the JSONL wire protocol. */
class LivePiRpcClient {
  /** Non-response records (extension_ui_request, agent events, ...). */
  readonly events: PiRpcWireRecord[] = [];

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly parser = new LfFrameParser();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly stderrChunks: string[] = [];
  private nextRequestId = 1;
  private spawnError: Error | null = null;
  private exited = false;
  private closed = false;
  private exitSignal!: Promise<void>;
  private markExited!: () => void;

  constructor(executable: string) {
    // Executor-form promise: `Promise.withResolvers` needs lib ES2024, but the
    // project targets ES2022 (mirrors session-store.test.ts).
    this.exitSignal = new Promise<void>((resolve) => {
      this.markExited = resolve;
    });

    this.child = spawn(executable, ["--mode", "rpc", "--no-session"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.on("data", (chunk: Buffer) => this.handleStdoutChunk(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (this.stderrChunks.join("").length + text.length > 4_000) {
        this.stderrChunks.shift();
      }
      this.stderrChunks.push(text);
    });
    // A failed spawn emits only "error" (no "exit"), so both paths must
    // release exitSignal or close() could wait forever.
    this.child.on("error", (error: Error) => {
      this.spawnError = error;
      this.markExited();
      this.failAllPending(
        new Error(
          `failed to start pi RPC process "${executable}": ${error.message}. ` +
            "Install pi or point PI_RPC_BIN at the executable.",
        ),
      );
    });
    this.child.on("exit", () => {
      this.exited = true;
      this.markExited();
      this.failAllPending(new Error("pi RPC process exited before answering the request"));
    });
    this.child.stdin.on("error", (error: Error) => {
      this.failAllPending(new Error(`pi RPC stdin failed: ${error.message}`));
    });
  }

  /** Send one JSONL command and resolve with its correlated response. */
  request(command: PiRpcCommand, timeoutMs = REQUEST_TIMEOUT_MS): Promise<PiRpcWireRecord> {
    if (this.spawnError !== null) {
      return Promise.reject(
        new Error(`pi RPC process failed to start: ${this.spawnError.message}`),
      );
    }
    if (this.exited) {
      return Promise.reject(new Error("pi RPC process exited before answering the request"));
    }
    if (this.closed) {
      return Promise.reject(new Error("pi RPC process is already closed"));
    }

    const id = this.nextRequestId++;
    const frame = `${JSON.stringify({ ...command, id })}\n`;
    const stderrText = this.stderrChunks.join("");
    const stderrTail =
      stderrText.length > 500 ? `...${stderrText.slice(-500)}` : stderrText;

    return new Promise<PiRpcWireRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `pi RPC request "${command.type}" (id ${id}) timed out after ${timeoutMs}ms; ` +
              `stderr: ${stderrTail || "(empty)"}`,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(frame, "utf8");
    });
  }

  /**
   * Deterministic teardown: stdin EOF first, then SIGTERM, then SIGKILL, each
   * with a bounded grace period. Safe to call more than once.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.child.stdin.end();
    if (await this.settle(this.exitSignal, EXIT_GRACE_MS)) return;

    this.child.kill("SIGTERM");
    if (await this.settle(this.exitSignal, SIGTERM_GRACE_MS)) return;

    this.child.kill("SIGKILL");
    await this.exitSignal;
  }

  private handleStdoutChunk(chunk: Buffer): void {
    let lines: string[];
    try {
      lines = this.parser.push(chunk);
    } catch (error: unknown) {
      this.failAllPending(
        new Error(`pi emitted invalid UTF-8 on stdout: ${String(error)}`),
      );
      return;
    }
    for (const line of lines) {
      let record: PiRpcWireRecord;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          throw new TypeError("stdout record is not a JSON object");
        }
        record = parsed as PiRpcWireRecord;
      } catch (error: unknown) {
        this.failAllPending(
          new Error(
            `pi emitted a non-JSON stdout record: ${JSON.stringify(line)} (${String(error)})`,
          ),
        );
        return;
      }

      if (record.type === "response") {
        // Correlate by echoed id; records not matching an in-flight request
        // (never expected from pi) are ignored.
        const pending = this.pending.get(record.id as number);
        if (pending !== undefined) {
          this.pending.delete(record.id as number);
          clearTimeout(pending.timer);
          pending.resolve(record);
        }
      } else {
        // Agent events and extension UI requests interleave with responses.
        this.events.push(record);
      }
    }
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private settle(promise: Promise<void>, ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      promise.then(
        () => {
          clearTimeout(timer);
          resolve(true);
        },
        () => {
          clearTimeout(timer);
          resolve(true);
        },
      );
    });
  }
}

test(
  "live pi RPC answers get_state and get_entries with authoritative shapes and tolerates interleaved extension_ui_request events when observed",
  { skip, timeout: TEST_TIMEOUT_MS },
  async () => {
    const client = new LivePiRpcClient(PI_RPC_BIN);
    try {
      const state = await client.request({ type: "get_state" });
      assert.equal(state.type, "response");
      assert.equal(state.command, "get_state");
      assert.equal(state.success, true);
      assert.ok(Number.isFinite(state.id));
      assert.ok(state.data !== null && typeof state.data === "object");
      const stateData = state.data as Record<string, unknown>;
      assert.equal(typeof stateData.sessionId, "string");
      assert.ok((stateData.sessionId as string).length > 0);

      const entries = await client.request({ type: "get_entries" });
      assert.equal(entries.type, "response");
      assert.equal(entries.command, "get_entries");
      assert.equal(entries.success, true);
      assert.ok(Number.isFinite(entries.id));
      assert.ok(entries.data !== null && typeof entries.data === "object");
      const entriesData = entries.data as Record<string, unknown>;
      assert.ok(Array.isArray(entriesData.entries));
      const entryRecords = entriesData.entries as Array<Record<string, unknown>>;
      for (const entry of entryRecords) {
        assert.ok(entry !== null && typeof entry === "object");
        assert.equal(typeof entry.id, "string");
        assert.ok((entry.id as string).length > 0);
      }
      // `leafId` is the current active leaf, NOT the append cursor: it may be
      // null (no active leaf) or a non-empty string (the active leaf id, which
      // can point anywhere in the branch tree). The append cursor is the last
      // entry id in append order, derived independently from the entries array.
      if (entryRecords.length > 0) {
        const appendCursor = entryRecords[entryRecords.length - 1].id as string;
        assert.equal(typeof appendCursor, "string");
        assert.ok(appendCursor.length > 0);
        if (entriesData.leafId !== null) {
          assert.equal(typeof entriesData.leafId, "string");
          assert.ok((entriesData.leafId as string).length > 0);
        }
      } else {
        // No entries: there is no active leaf, so `leafId` must be null.
        assert.equal(entriesData.leafId, null);
      }

      // The responses above correlated despite any interleaved events; the
      // suite never triggers extension UI requests, but any that happen to
      // arrive must carry a well-formed shape and remain tolerated.
      for (const event of client.events) {
        assert.equal(typeof event.type, "string");
        assert.ok((event.type as string).length > 0);
        if (event.type === "extension_ui_request") {
          assert.equal(typeof event.id, "string");
          assert.ok((event.id as string).length > 0);
          assert.equal(typeof event.method, "string");
          assert.ok((event.method as string).length > 0);
        }
      }
    } finally {
      await client.close();
    }
  },
);

test(
  "live pi RPC rejects get_entries with a stale since cursor",
  { skip, timeout: TEST_TIMEOUT_MS },
  async () => {
    const client = new LivePiRpcClient(PI_RPC_BIN);
    try {
      const stale = await client.request({
        type: "get_entries",
        since: "stale-entry-does-not-exist",
      });
      assert.equal(stale.type, "response");
      assert.equal(stale.command, "get_entries");
      assert.equal(stale.success, false);
      assert.equal(typeof stale.error, "string");
      assert.ok((stale.error as string).length > 0);
    } finally {
      await client.close();
    }
  },
);
