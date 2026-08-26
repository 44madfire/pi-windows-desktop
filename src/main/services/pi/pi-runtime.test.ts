import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { PiEvent, PiThinkingLevel, WslWorkspace } from "../../../shared/ipc.ts";
import type { WslDistributionProbe, WslManager } from "../../wsl/index.ts";
import type {
  PiRpcProcessSignal,
  PiRpcReadable,
  PiRpcTransport,
  PiRpcWriteResult,
  PiRpcWritable,
} from "./transport.ts";
import type { SessionPointer, SessionStore } from "../session/session-store.ts";
import {
  SessionManager,
  SessionManagerError,
  type SessionPiRpcClient,
  type SessionSnapshot,
} from "../session/session-manager.ts";
import { PiRuntimeController, sessionWorkspaceKey, type PiRuntimeSessionSnapshot } from "./pi-runtime.ts";

const workspace: WslWorkspace = { distro: "Ubuntu", linuxPath: "/home/pi" };
const sessionFile = "/home/pi/.pi/agent/sessions/pi-session-1";

const fakeWsl = {
  probeDistribution: async (): Promise<WslDistributionProbe> =>
    ({
      distribution: workspace.distro,
      available: true,
      availability: undefined,
      pi: {
        available: true,
        executable: "/bin/pi",
        version: "0.1.0",
        versionResult: undefined,
      },
    }) as unknown as WslDistributionProbe,
} as unknown as WslManager;

type WireCommand = { type: string; id?: unknown; [key: string]: unknown };
type FakeResponse = Record<string, unknown> | readonly unknown[];

/**
 * Default Pi behavior for the handshake commands. `get_entries` yields the
 * optional `since` cursor plus `entries`/`leafId` when supplied.
 *
 * The default `get_state` reports Pi's required model and thinkingLevel
 * fields (the authoritative agent state the handshake and mutation refreshes
 * project), so tests that exercise mutations against the default fixture
 * satisfy the required-field refresh contract.
 */
const defaultResponses = (command: WireCommand): FakeResponse => {
  switch (command.type) {
    case "new_session":
    case "switch_session":
      return { sessionId: "pi-session-1" };
    case "get_state":
      return {
        sessionId: "pi-session-1",
        sessionFile,
        model: { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
        thinkingLevel: "medium",
      };
    case "get_entries":
      return {
        entries:
          command.since !== undefined
            ? [
                {
                  type: "message",
                  id: "user-1",
                  parentId: null,
                  timestamp: "2026-01-01T00:00:00.000Z",
                  message: { role: "user", content: "recovered prompt" },
                },
              ]
            : [],
        leafId: command.since !== undefined ? "entry-10" : null,
      };
    default:
      return {};
  }
};

class FakeTransport implements PiRpcTransport {
  readonly stdout = new EventEmitter() as unknown as PiRpcReadable;
  readonly stderr = new EventEmitter() as unknown as PiRpcReadable;
  readonly writes: string[] = [];
  /** Termination signals received via kill(), in order. */
  readonly killSignals: string[] = [];
  /** stdin EOF deliveries (writable end() calls). */
  stdinEndCount = 0;
  /** Process termination lifecycle emissions (exit events). */
  exitCount = 0;
  /** Ordered transport operations ("end" and "kill:<signal>") for ordering assertions. */
  readonly operations: string[] = [];
  /** stdin.write() return value; a rejected promise simulates an async write failure. */
  writeResult: PiRpcWriteResult = true;
  /** Command types held back even when deferResponses is off (membership only). */
  private readonly deferCommandTypes: Record<string, boolean>;
  /** Commands whose responses were deferred (deferResponses mode), in write order. */
  readonly deferredCommands: WireCommand[] = [];
  private readonly lifecycle = new EventEmitter();
  private readonly respond: (command: WireCommand) => FakeResponse;
  private readonly failCommands: Readonly<Record<string, boolean | number>>;
  private readonly failCounters = new Map<string, number>();
  private readonly exitOnEof: boolean;
  private readonly deferResponses: boolean;

  constructor(
    respond: (command: WireCommand) => FakeResponse = defaultResponses,
    options: {
      /** true = fail every occurrence; a number = fail only the Nth occurrence (1-based). */
      readonly failCommands?: Readonly<Record<string, boolean | number>>;
      readonly exitOnEof?: boolean;
      /** Hold responses until {@link flushDeferredResponses} releases them. */
      readonly deferResponses?: boolean;
      /** Hold responses for exactly these command types until {@link flushDeferredResponses} releases them. */
      readonly deferCommandTypes?: readonly string[];
    } = {},
  ) {
    this.respond = respond;
    this.failCommands = options.failCommands ?? {};
    this.exitOnEof = options.exitOnEof ?? true;
    this.deferResponses = options.deferResponses ?? false;
    const deferred = options.deferCommandTypes ?? [];
    this.deferCommandTypes = Object.fromEntries(deferred.map((type) => [type, true]));
  }

  /** Release responses for all deferred commands, in write order. */
  flushDeferredResponses(): void {
    for (const command of this.deferredCommands.splice(0)) {
      this.emitResponse(command);
    }
  }

  readonly stdin: PiRpcWritable = {
    write: (chunk: unknown): PiRpcWriteResult => {
      const frame = String(chunk);
      this.writes.push(frame);
      const line = frame.trim();
      if (line) {
        const command = JSON.parse(line) as WireCommand;
        if (this.deferResponses || this.deferCommandTypes[command.type] === true) {
          this.deferredCommands.push(command);
        } else {
          this.emitResponse(command);
        }
      }
      return this.writeResult;
    },
    end: (): void => {
      this.stdinEndCount += 1;
      this.operations.push("end");
      if (this.exitOnEof) {
        // Emitting exit on stdin EOF keeps close() fast and deterministic.
        this.emitExit(0, null);
      }
    },
    on: (): unknown => undefined,
  };

  on(event: "error", listener: (error: unknown) => void): unknown;
  on(
    event: "exit" | "close",
    listener: (code?: number | null, signal?: string | null) => void,
  ): unknown;
  on(
    event: "error" | "exit" | "close",
    listener:
      | ((error: unknown) => void)
      | ((code?: number | null, signal?: string | null) => void),
  ): unknown {
    return this.lifecycle.on(event, listener as (...args: unknown[]) => void);
  }

  kill(signal?: PiRpcProcessSignal): boolean {
    const normalized = signal ?? "SIGTERM";
    this.killSignals.push(normalized);
    this.operations.push(`kill:${normalized}`);
    // The signal terminates the fake process: report the exit so close()
    // settles promptly instead of escalating to SIGKILL.
    this.emitExit(0, normalized);
    return true;
  }

  emitStdoutLine(line: string): void {
    (this.stdout as EventEmitter).emit("data", `${line}\n`);
  }

  writtenCommands(): WireCommand[] {
    return this.writes.map((frame) => JSON.parse(frame) as WireCommand);
  }

  /** Simulate the Pi process terminating (transport exit event). */
  emitExit(code: number, signal: string | null): void {
    this.exitCount += 1;
    this.lifecycle.emit("exit", code, signal);
  }

  private emitResponse(command: WireCommand): void {
    const failSpec = this.failCommands[command.type];
    let failed = false;
    if (failSpec === true) {
      failed = true;
    } else if (typeof failSpec === "number") {
      const count = (this.failCounters.get(command.type) ?? 0) + 1;
      this.failCounters.set(command.type, count);
      failed = count === failSpec;
    }
    (this.stdout as EventEmitter).emit(
      "data",
      `${JSON.stringify({
        type: "response",
        success: !failed,
        id: command.id,
        ...(failed
          ? { error: `simulated failure for ${command.type}` }
          : { data: this.respond(command) }),
      })}\n`,
    );
  }
}

// PiRpcClient dispatches stdout-derived events through a microtask boundary
// (Promise.resolve().then), so assertions must await that boundary first.
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test("a fresh runtime opens new_session -> get_state -> get_entries before ready", async () => {
  const forwarded: PiEvent[] = [];
  const transport = new FakeTransport();
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => transport,
    handlers: { onEvent: (event) => forwarded.push(event) },
  });

  const started = await runtime.start(workspace);

  assert.equal(started.state, "ready");
  assert.equal(started.lastEntryId, null);
  assert.equal(started.sessionId, "pi-session-1");
  assert.equal(started.sessionFile, sessionFile);

  const commands = transport.writtenCommands().map((command) => command.type);
  assert.deepEqual(commands, ["new_session", "get_state", "get_entries"]);
  const getEntries = transport.writtenCommands().find((command) => command.type === "get_entries");
  assert.equal(getEntries?.since, undefined);

  // No ready snapshot is published before the full handshake completed.
  const readyEvents = forwarded.filter(
    (event) => event.type === "runtime" && event.snapshot.state === "ready",
  );
  assert.equal(readyEvents.length, 1);

  await runtime.stop();
  assert.equal(runtime.snapshot.state, "stopped");
  assert.equal(runtime.snapshot.lastEntryId, null);
});
test("reconnect rejects while ready or while another reconnect is active", async () => {
  const { runtime, transports } = runtimeWithTransportSequence([
    new FakeTransport(reconnectResponses),
    new FakeTransport(reconnectResponses),
  ]);

  await runtime.start(workspace);
  await assert.rejects(runtime.reconnect(), /runtime is ready/);

  transports[0].emitExit(1, "SIGTERM");
  await flushMicrotasks();
  const reconnecting = runtime.reconnect();
  await assert.rejects(runtime.reconnect(), /runtime is starting/);
  await reconnecting;
  await runtime.stop();
});


test("start rejects and terminates the transport when a post-connect handshake request fails", async () => {
  const transport = new FakeTransport(defaultResponses, {
    // The get_state handshake read answers with an RPC failure instead of
    // session identity, after the transport already connected.
    failCommands: { get_state: true },
    // The fake process does not exit on stdin EOF alone, so the runtime's
    // cleanup must escalate to a termination signal for the transport to end.
    exitOnEof: false,
  });
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => transport,
  });

  await assert.rejects(runtime.start(workspace), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /get_state/);
    return true;
  });

  // The failed start must not leak the Pi process: before the runtime drops
  // the client reference and surfaces the rejection, the transport received
  // stdin EOF and was terminated (SIGTERM after the EOF grace period).
  assert.equal(runtime.snapshot.state, "failed");
  assert.match(runtime.snapshot.lastError ?? "", /get_state/);
  assert.equal(transport.stdinEndCount, 1);
  assert.deepEqual(transport.killSignals, ["SIGTERM"]);
  assert.equal(transport.exitCount, 1);
  assert.ok(
    transport.operations.indexOf("end") < transport.operations.indexOf("kill:SIGTERM"),
    "stdin EOF precedes the termination signal",
  );

  // The runtime no longer references the client; further RPC is refused.
  await assert.rejects(
    runtime.sendExtensionUiResponse({ id: "ui-1", value: "x" }),
    /not running/,
  );

  await runtime.stop();
});

test("agent/message/tool events never advance the durable entry cursor and still forward", async () => {
  const forwarded: PiEvent[] = [];
  const transport = new FakeTransport();
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => transport,
    handlers: { onEvent: (event) => forwarded.push(event) },
  });

  const started = await runtime.start(workspace);
  assert.equal(started.state, "ready");
  assert.equal(started.lastEntryId, null);

  // Events shaped like cursor carriers (direct, nested, or response cursors)
  // must not move the durable cursor.
  transport.emitStdoutLine('{"type":"agent_message","entryId":"cursor-1"}');
  transport.emitStdoutLine('{"type":"tool_call","entry":{"id":"cursor-2"}}');
  transport.emitStdoutLine('{"type":"session_update","lastEntryId":"cursor-3"}');
  transport.emitStdoutLine('{"type":"extension_ui_request"}');
  // PiRpcClient forwards stdout events through a microtask boundary; wait for
  // the dispatch to complete before asserting on the forwarded events.
  await flushMicrotasks();

  assert.equal(runtime.snapshot.lastEntryId, null);

  // Forwarding is unchanged: every protocol event reached the handler.
  const protocolEvents = forwarded.filter((event) => event.type === "protocol");
  assert.equal(protocolEvents.length, 4);
  const messageTypes: string[] = [];
  for (const event of protocolEvents) {
    assert.ok("message" in event);
    const message = event.message;
    assert.ok(message !== null && typeof message === "object" && "type" in message);
    messageTypes.push(String(message.type));
  }
  assert.deepEqual(messageTypes, [
    "agent_message",
    "tool_call",
    "session_update",
    "extension_ui_request",
  ]);

  await runtime.stop();
  assert.equal(runtime.snapshot.state, "stopped");
  assert.equal(runtime.snapshot.lastEntryId, null);
});

function fakeStore(pointer: SessionPointer | null): SessionStore & { saved: SessionPointer[] } {
  let current = pointer;
  return {
    saved: [],
    async load(workspaceKey: string): Promise<SessionPointer | null> {
      return current && current.workspace === workspaceKey ? current : null;
    },
    async save(saved: SessionPointer): Promise<void> {
      current = saved;
      this.saved.push(saved);
    },
  };
}

test("a restored runtime resumes switch_session, requests full history, and re-hydrates the fresh conversation", async () => {
  const forwarded: PiEvent[] = [];
  const transport = new FakeTransport((command) => {
    switch (command.type) {
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "get_state":
        // A resumed persisted session must report the authoritative agent
        // state (model + thinking level).
        return {
          sessionId: "pi-session-1",
          sessionFile,
          model: { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
          thinkingLevel: "medium",
        };
      case "get_entries":
        // Full history (no `since` cursor): the persisted session's old
        // user/assistant turn is restored for the fresh conversation. An
        // incremental catch-up from the persisted tail would return nothing.
        if (command.since === undefined) {
          return {
            entries: [
              {
                type: "message",
                id: "user-1",
                parentId: null,
                timestamp: "2026-01-01T00:00:00.000Z",
                message: { role: "user", content: "old prompt" },
              },
              {
                type: "message",
                id: "assistant-1",
                parentId: "user-1",
                timestamp: "2026-01-01T00:00:01.000Z",
                message: { role: "assistant", content: [{ type: "text", text: "old answer" }] },
              },
            ],
            leafId: "assistant-1",
          };
        }
        return { entries: [], leafId: "assistant-1" };
      default:
        return {};
    }
  });
  const store = fakeStore({
    workspace: sessionWorkspaceKey(workspace),
    sessionFile,
    sessionId: "pi-session-1",
    lastEntryId: "assistant-1",
    leafId: "user-1",
  });
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => transport,
    sessionStore: store,
    handlers: { onEvent: (event) => forwarded.push(event) },
  });

  const started = await runtime.start(workspace);

  // The stored pointer round-trips both values: from the very first
  // published snapshot, the runtime exposes the durable append cursor
  // (`lastEntryId`) alongside the restored active leaf, until the
  // authoritative catch-up response replaces the leaf.
  const starting = forwarded.find(
    (event): event is Extract<PiEvent, { type: "runtime" }> =>
      event.type === "runtime" && event.snapshot.state === "starting",
  );
  assert.ok(starting, "a starting snapshot must be published");
  assert.equal(starting.snapshot.lastEntryId, "assistant-1");
  assert.equal(starting.snapshot.leafId, "user-1");

  const commands = transport.writtenCommands();
  assert.deepEqual(
    commands.map((command) => command.type),
    ["switch_session", "get_state", "get_entries"],
  );
  assert.equal(commands[0].sessionPath, sessionFile);
  const getEntries = commands[2];
  // A cold start creates a fresh conversation: the full entry list is
  // requested (no `since` cursor) so old history is restored even when the
  // persisted append cursor is at the tail — never an incremental catch-up
  // that would hydrate nothing.
  assert.equal(getEntries.since, undefined);

  assert.equal(started.state, "ready");
  assert.equal(started.lastSeenEntryId, "assistant-1");
  assert.equal(started.leafId, "assistant-1");
  assert.equal(started.lastEntryId, "assistant-1");
  assert.equal(started.sessionId, "pi-session-1");
  assert.equal(started.sessionFile, sessionFile);

  // Full history hydrated the fresh conversation before ready: both the old
  // user prompt and the assistant answer are restored.
  const contents = runtime.conversationSnapshot.timeline.map((record) =>
    record.type === "message" ? record.content : "",
  );
  assert.deepEqual(contents, ["old prompt", "old answer"]);

  // The resulting pointer was persisted with the durable append cursor,
  // not the active leaf.
  assert.ok(store.saved.length >= 1);
  const persisted = store.saved[store.saved.length - 1];
  assert.equal(persisted.workspace, sessionWorkspaceKey(workspace));
  assert.equal(persisted.sessionFile, sessionFile);
  assert.equal(persisted.lastEntryId, "assistant-1");

  await runtime.stop();
  const stopped = store.saved[store.saved.length - 1];
  assert.equal(stopped.lastEntryId, "assistant-1");
});

test("a stored leaf and cursor round-trip through a full-history cold start", async () => {
  const transport = new FakeTransport((command) => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "get_state":
        // A resumed persisted session must report the authoritative agent
        // state (model + thinking level).
        return {
          sessionId: "pi-session-1",
          sessionFile,
          model: { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
          thinkingLevel: "medium",
        };
      case "get_entries":
        // The response carries no leafId key: it is not authoritative about
        // the active leaf, so the restored leaf must be preserved.
        return { entries: [] };
      default:
        return {};
    }
  });
  const store = fakeStore({
    workspace: sessionWorkspaceKey(workspace),
    sessionFile,
    sessionId: "pi-session-1",
    lastEntryId: "entry-2",
    leafId: "entry-1",
  });
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => transport,
    sessionStore: store,
  });

  const started = await runtime.start(workspace);

  // Both stored values round-trip through startup: the cold start requests
  // the full entry list (no `since` cursor) for the fresh conversation — the
  // restored cursor is preserved in memory and still exposed — and the
  // restored active leaf survives until an authoritative response replaces
  // it. Reconnect and post-settle synchronization (not the cold start)
  // request `since` from the durable append cursor.
  const getEntries = transport.writtenCommands().find((command) => command.type === "get_entries");
  assert.equal(getEntries?.since, undefined);
  assert.equal(started.state, "ready");
  assert.equal(started.lastSeenEntryId, "entry-2");
  assert.equal(started.leafId, "entry-1");
  assert.equal(started.lastEntryId, "entry-2");

  await runtime.stop();
});

test("a missing or invalid pointer still starts a fresh session without crashing", async () => {
  const transport = new FakeTransport();
  const store = fakeStore(null);
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => transport,
    sessionStore: store,
  });

  const started = await runtime.start(workspace);

  assert.equal(started.state, "ready");
  assert.deepEqual(
    transport.writtenCommands().map((command) => command.type),
    ["new_session", "get_state", "get_entries"],
  );
  await runtime.stop();
});

test("a cancelled resume propagates explicit null identity/cursor resets into runtime snapshots", async () => {
  const forwarded: PiEvent[] = [];
  const staleSessionFile = "/home/pi/.pi/agent/sessions/stale-session";
  const freshSessionFile = "/home/pi/.pi/agent/sessions/pi-session-2";
  const stalePointer: SessionPointer = {
    workspace: sessionWorkspaceKey(workspace),
    sessionFile: staleSessionFile,
    sessionId: "stale-session",
    lastEntryId: "entry-9",
    leafId: null,
  };
  const transport = new FakeTransport((command) => {
    switch (command.type) {
      case "switch_session":
        // Pi declines to resume the persisted session: soft fallback.
        return { cancelled: true };
      case "new_session":
        return { sessionId: "pi-session-2" };
      case "get_state":
        return { sessionId: "pi-session-2", sessionFile: freshSessionFile };
      case "get_entries":
        return { entries: [], leafId: null };
      default:
        return {};
    }
  });
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => transport,
    sessionStore: fakeStore(stalePointer),
    handlers: { onEvent: (event) => forwarded.push(event) },
  });

  const started = await runtime.start(workspace);

  assert.deepEqual(
    transport.writtenCommands().map((command) => command.type),
    ["switch_session", "new_session", "get_state", "get_entries"],
  );
  // The catch-up must not replay from the abandoned session's cursor.
  const getEntries = transport.writtenCommands().find((command) => command.type === "get_entries");
  assert.equal(getEntries?.since, undefined);

  assert.equal(started.state, "ready");
  assert.equal(started.sessionId, "pi-session-2");
  assert.equal(started.sessionFile, freshSessionFile);
  assert.equal(started.lastEntryId, null);

  // Once the new session identity is adopted, no published runtime snapshot
  // may retain the abandoned session's cursor or session file.
  for (const event of forwarded) {
    if (event.type !== "runtime") continue;
    if (event.snapshot.sessionId === "pi-session-2") {
      assert.notEqual(event.snapshot.lastEntryId, "entry-9");
      assert.notEqual(event.snapshot.sessionFile, staleSessionFile);
    }
  }

  // The explicit reset itself is observable: between the stale pointer and
  // the fresh identity, the runtime publishes an all-null identity/cursor
  // snapshot instead of silently retaining the stale fields.
  assert.ok(
    forwarded.some(
      (event) =>
        event.type === "runtime" &&
        event.snapshot.sessionId === null &&
        event.snapshot.sessionFile === null &&
        event.snapshot.lastEntryId === null,
    ),
    "explicit null identity/cursor reset must be published",
  );

  await runtime.stop();
});

test("session state listeners observe the explicit null identity/cursor reset of a soft fallback", async () => {
  const staleSessionFile = "/home/pi/.pi/agent/sessions/stale-session";
  const freshSessionFile = "/home/pi/.pi/agent/sessions/pi-session-2";
  const sessionCalls: string[] = [];
  const sessionClient = {
    request: async (command: { type: string }): Promise<{ type: "response"; success: true; id: string; data: Record<string, unknown> }> => {
      sessionCalls.push(command.type);
      switch (command.type) {
        case "switch_session":
          // Soft fallback: Pi declines the persisted session.
          return { type: "response", success: true, id: "s1", data: { cancelled: true } };
        case "new_session":
          return { type: "response", success: true, id: "s2", data: { sessionId: "pi-session-2" } };
        case "get_state":
          return { type: "response", success: true, id: "s3", data: { sessionId: "pi-session-2", sessionFile: freshSessionFile } };
        default:
          return { type: "response", success: true, id: "s4", data: {} };
      }
    },
  } as unknown as SessionPiRpcClient;
  const manager = new SessionManager({
    client: sessionClient,
    sessionId: "stale-session",
    sessionFile: staleSessionFile,
    lastEntryId: "entry-9",
  });
  const snapshots: SessionSnapshot[] = [];
  manager.onStateChange((snapshot) => {
    snapshots.push(snapshot);
  });

  const opened = await manager.openSession(staleSessionFile);

  assert.deepEqual(sessionCalls, ["switch_session", "new_session", "get_state"]);
  assert.equal(opened.resumed, false);
  assert.equal(opened.sessionId, "pi-session-2");
  assert.equal(opened.sessionFile, freshSessionFile);

  // The abandoned session's fields are dropped explicitly: state listeners
  // observe an all-null identity/cursor reset before the new identity lands,
  // so integrations never carry stale session fields through the fallback.
  const nullResetIndex = snapshots.findIndex(
    (snapshot) =>
      snapshot.sessionId === null && snapshot.sessionFile === null && snapshot.lastEntryId === null,
  );
  assert.ok(nullResetIndex !== -1, "state listeners must observe an explicit null identity/cursor reset");
  const adoptedIndex = snapshots.findIndex(
    (snapshot) => snapshot.sessionId === "pi-session-2" && snapshot.sessionFile === freshSessionFile,
  );
  assert.ok(adoptedIndex !== -1, "the fresh session identity must be adopted");
  assert.ok(nullResetIndex < adoptedIndex, "the null reset must precede adoption of the new identity");
});

test("sendExtensionUiResponse writes a hardcoded type and rejects invalid payloads", async () => {
  const transport = new FakeTransport();
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => transport,
  });
  await runtime.start(workspace);

  await runtime.sendExtensionUiResponse({ id: "ui-1", value: "selected" });
  await runtime.sendExtensionUiResponse({ id: "ui-2", confirmed: true });
  await runtime.sendExtensionUiResponse({ id: "ui-3", cancelled: true });
  // A type field equal to the hardcoded value is tolerated, never forwarded raw.
  await runtime.sendExtensionUiResponse({ type: "extension_ui_response", id: "ui-4", value: "ok" });

  const replies = transport
    .writtenCommands()
    .filter((command) => command.type === "extension_ui_response");
  assert.deepEqual(replies, [
    { type: "extension_ui_response", id: "ui-1", value: "selected" },
    { type: "extension_ui_response", id: "ui-2", confirmed: true },
    { type: "extension_ui_response", id: "ui-3", cancelled: true },
    { type: "extension_ui_response", id: "ui-4", value: "ok" },
  ]);

  await assert.rejects(runtime.sendExtensionUiResponse({ id: "ui-5", value: 42 }), TypeError);
  await assert.rejects(runtime.sendExtensionUiResponse({ id: "ui-5" }), TypeError);
  await assert.rejects(runtime.sendExtensionUiResponse({ value: "no-id" }), TypeError);
  await assert.rejects(runtime.sendExtensionUiResponse({ id: "ui-5", value: "x", confirmed: true }), TypeError);
  await assert.rejects(
    runtime.sendExtensionUiResponse({ type: "some_other_command", id: "ui-5", value: "x" }),
    TypeError,
  );

  await runtime.stop();
});

test("sendExtensionUiResponse rejects before the runtime is started", async () => {
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => new FakeTransport() });
  await assert.rejects(
    runtime.sendExtensionUiResponse({ id: "ui-1", value: "x" }),
    /not running/,
  );
});

test("sendExtensionUiResponse propagates asynchronous stdin write failures", async () => {
  const transport = new FakeTransport();
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => transport,
  });
  await runtime.start(workspace);

  // The underlying stdin pipe rejects asynchronously, the way a real
  // child-process pipe does when the peer disappears mid-write.
  const writeError = new Error("pipe broken");
  transport.writeResult = Promise.reject(writeError);

  // Renderer completion reflects the actual outbound write: the async
  // transport failure rejects the call instead of resolving.
  await assert.rejects(
    runtime.sendExtensionUiResponse({ id: "ui-1", value: "x" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      const cause = (error as { cause?: unknown }).cause;
      assert.ok(cause === writeError || error === writeError, "write failure must propagate");
      return true;
    },
  );

  await runtime.stop();
});

test("stop persists the session pointer before resolving", async () => {
  const store = fakeStore(null);
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => new FakeTransport(),
    sessionStore: store,
  });
  await runtime.start(workspace);
  assert.equal(store.saved.length, 1);

  await runtime.stop();

  assert.equal(store.saved.length, 2);
  const persisted = store.saved[1];
  assert.equal(persisted.workspace, sessionWorkspaceKey(workspace));
  assert.equal(persisted.sessionId, "pi-session-1");
  assert.equal(persisted.sessionFile, sessionFile);
});

/**
 * Pi behavior for the reconnect tests. The first `get_entries` (full
 * history, no `since`) returns one append-ordered entry; a catch-up with a
 * `since` cursor returns a newer entry while the active leaf lags the append
 * end (leaf "entry-1", append tail "entry-2"), pinning that the append
 * cursor — never the active leaf — drives the next catch-up.
 */
const reconnectResponses = (command: WireCommand): Record<string, unknown> => {
  switch (command.type) {
    case "new_session":
    case "switch_session":
      return { sessionId: "pi-session-1" };
    case "get_state":
      // Resumed/established sessions must report the authoritative agent
      // state (model + thinking level).
      return {
        sessionId: "pi-session-1",
        sessionFile,
        model: { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
        thinkingLevel: "medium",
      };
    case "get_entries":
      return command.since === undefined
        ? {
            entries: [
              {
                type: "message",
                id: "entry-1",
                parentId: null,
                timestamp: "2026-01-01T00:00:00.000Z",
                message: { role: "user", content: "first prompt" },
              },
            ],
            leafId: "entry-1",
          }
        : {
            entries: [
              {
                type: "message",
                id: "entry-2",
                parentId: "entry-1",
                timestamp: "2026-01-01T00:00:01.000Z",
                message: { role: "assistant", content: "first answer" },
              },
            ],
            leafId: "entry-1",
          };
    default:
      return {};
  }
};

/**
 * Build a runtime whose transport factory hands out the given transports in
 * order (one per `connect()`/`reconnect()`), recording them as they are
 * created so tests can drive each transport's lifecycle.
 */
function runtimeWithTransportSequence(
  transports: FakeTransport[],
  store: SessionStore | null = null,
): { runtime: PiRuntimeController; transports: FakeTransport[] } {
  const queue = [...transports];
  const created: FakeTransport[] = [];
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => {
      const next = queue.shift() ?? new FakeTransport();
      created.push(next);
      return next;
    },
    sessionStore: store,
  });
  return { runtime, transports: created };
}

test("a second runtime cold start requests full history and restores the previous run's turn", async () => {
  // Pi owns the history: after runtime A's turn settles, the full entry list
  // contains the old user/assistant turn, while an incremental catch-up from
  // the persisted tail finds nothing new.
  let turnPersisted = false;
  const sharedHistory = (command: WireCommand): Record<string, unknown> => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "get_state":
        // A resumed persisted session must report the authoritative agent
        // state (model + thinking level).
        return {
          sessionId: "pi-session-1",
          sessionFile,
          model: { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
          thinkingLevel: "medium",
        };
      case "get_entries": {
        if (command.since === undefined) {
          return turnPersisted
            ? {
                entries: [
                  {
                    type: "message",
                    id: "user-1",
                    parentId: null,
                    timestamp: "2026-01-01T00:00:00.000Z",
                    message: { role: "user", content: "old prompt" },
                  },
                  {
                    type: "message",
                    id: "assistant-1",
                    parentId: "user-1",
                    timestamp: "2026-01-01T00:00:01.000Z",
                    message: { role: "assistant", content: [{ type: "text", text: "old answer" }] },
                  },
                ],
                leafId: "assistant-1",
              }
            : { entries: [], leafId: null };
        }
        // Incremental catch-up after the persisted tail: nothing new.
        return { entries: [], leafId: "assistant-1" };
      }
      default:
        return {};
    }
  };
  const store = fakeStore(null);

  // Runtime A: a fresh session, one live turn, then a clean stop persists
  // the pointer at the append tail.
  const { runtime: runtimeA, transports: transportsA } = runtimeWithTransportSequence(
    [new FakeTransport(sharedHistory)],
    store,
  );
  const startedA = await runtimeA.start(workspace);
  assert.equal(startedA.state, "ready");

  await runtimeA.sendPrompt("old prompt");
  transportsA[0].emitStdoutLine(JSON.stringify({ type: "agent_start" }));
  transportsA[0].emitStdoutLine(
    JSON.stringify({ type: "message_start", message: { id: "msg-1", role: "assistant", content: [] } }),
  );
  transportsA[0].emitStdoutLine(
    JSON.stringify({
      type: "message_end",
      message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "old answer" }] },
    }),
  );
  // Pi now owns the settled turn's authoritative entries.
  turnPersisted = true;
  transportsA[0].emitStdoutLine(JSON.stringify({ type: "agent_settled" }));
  await flushMicrotasks();
  await flushMicrotasks();

  // The post-settled synchronization reconciled the turn; the pointer is
  // persisted at the append tail (assistant-1).
  assert.equal(runtimeA.snapshot.state, "ready");
  assert.equal(runtimeA.snapshot.lastSeenEntryId, "assistant-1");
  assert.equal(
    runtimeA.conversationSnapshot.timeline.filter(
      (record) => record.type === "message" && record.role === "user",
    ).length,
    1,
  );
  assert.equal(
    runtimeA.conversationSnapshot.timeline.filter(
      (record) => record.type === "message" && record.role === "assistant",
    ).length,
    1,
  );
  await runtimeA.stop();
  assert.equal(store.saved[store.saved.length - 1].lastEntryId, "assistant-1");

  // Runtime B: a clean cold start over the same workspace and pointer.
  const { runtime: runtimeB, transports: transportsB } = runtimeWithTransportSequence(
    [new FakeTransport(sharedHistory)],
    store,
  );
  const startedB = await runtimeB.start(workspace);
  assert.equal(startedB.state, "ready");

  // B requested the full entry list — no `since` cursor — despite the
  // persisted tail, and restored the old user/assistant turn.
  const commandsB = transportsB[0].writtenCommands();
  assert.deepEqual(
    commandsB.map((command) => command.type),
    ["switch_session", "get_state", "get_entries"],
  );
  assert.equal(commandsB[2].since, undefined);
  const contentsB = runtimeB.conversationSnapshot.timeline.map((record) =>
    record.type === "message" ? record.content : "",
  );
  assert.deepEqual(contentsB, ["old prompt", "old answer"]);
  assert.equal(runtimeB.snapshot.lastSeenEntryId, "assistant-1");

  await runtimeB.stop();
});

test("a failing pointer save stays best-effort: runtime stays ready, warns, and the queue keeps dispatching", async () => {
  const forwarded: PiEvent[] = [];
  const failingStore = {
    async load(): Promise<SessionPointer | null> {
      return null;
    },
    async save(): Promise<void> {
      throw new Error("disk full");
    },
  } satisfies SessionStore;
  let getEntriesCalls = 0;
  const responses = (command: WireCommand): Record<string, unknown> => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "get_state":
        return { sessionId: "pi-session-1", sessionFile };
      case "get_entries": {
        getEntriesCalls += 1;
        // 1: startup full-history catch-up on a fresh session — empty.
        if (getEntriesCalls === 1) return { entries: [], leafId: null };
        // 2: the post-agent_settled synchronization returns the settled
        // turn's authoritative user entry for reconciliation.
        return {
          entries: [
            {
              type: "message",
              id: "user-1",
              parentId: null,
              timestamp: "2026-01-01T00:00:00.000Z",
              message: { role: "user", content: "first" },
            },
          ],
          leafId: "user-1",
        };
      }
      default:
        return {};
    }
  };
  const transport = new FakeTransport(responses);
  const transports = [transport];
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => transport,
    sessionStore: failingStore,
    handlers: { onEvent: (event) => forwarded.push(event) },
  });

  // Startup persistence is best effort: the pointer save fails, but the
  // runtime still reaches ready and reports the warning instead of failing.
  const started = await runtime.start(workspace);
  assert.equal(started.state, "ready");
  assert.match(runtime.snapshot.lastWarning ?? "", /disk full/);

  await runtime.sendPrompt("first");
  await runtime.sendPrompt("second");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 1);
  assert.equal(
    transports[0].writtenCommands().filter((command) => command.type === "prompt").length,
    1,
  );

  // The first turn settles; the authoritative post-settled sync succeeds
  // while the pointer save keeps failing. The failure must not strand the
  // queue: the runtime stays ready, the warning stays visible, and the next
  // queued prompt dispatches after the sync.
  transports[0].emitStdoutLine(JSON.stringify({ type: "agent_settled" }));
  await flushMicrotasks();
  await flushMicrotasks();

  assert.deepEqual(
    transports[0].writtenCommands().map((command) => command.type),
    [
      "new_session",
      "get_state",
      "get_entries",
      "prompt",
      // The controlled settle refresh: get_entries catch-up, then the
      // authoritative get_state, then a best-effort supported-levels read.
      "get_entries",
      "get_state",
      "get_available_thinking_levels",
      "prompt",
    ],
    "the queued prompt must follow the post-settled synchronization despite the failing pointer save",
  );
  assert.equal(runtime.snapshot.state, "ready");
  assert.equal(runtime.snapshot.lastSeenEntryId, "user-1");
  assert.match(runtime.snapshot.lastWarning ?? "", /disk full/);
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 0);
  assert.equal(
    runtime.conversationSnapshot.timeline.filter(
      (record) => record.type === "message" && record.content === "first",
    ).length,
    1,
    "the reconciled user entry must not duplicate the live prompt record",
  );

  // The warning is visible on the runtime event channel, not just the local
  // snapshot.
  const warned = forwarded.find(
    (event): event is Extract<PiEvent, { type: "runtime" }> =>
      event.type === "runtime" &&
      (event.snapshot as PiRuntimeSessionSnapshot).lastWarning !== null,
  );
  assert.ok(warned, "the pointer save failure must surface as a visible runtime warning");
  assert.match(
    (warned.snapshot as PiRuntimeSessionSnapshot).lastWarning ?? "",
    /disk full/,
  );

  await runtime.stop();
});

test("reconnect reruns the handshake, catches up from the append cursor, hydrates, and persists before ready", async () => {
  const store = fakeStore(null);
  const { runtime, transports } = runtimeWithTransportSequence(
    [new FakeTransport(reconnectResponses), new FakeTransport(reconnectResponses)],
    store,
  );

  const started = await runtime.start(workspace);
  assert.equal(started.state, "ready");
  assert.deepEqual(
    transports[0].writtenCommands().map((command) => command.type),
    ["new_session", "get_state", "get_entries"],
  );

  // The Pi process dies while the runtime is idle: the client and session
  // are left disconnected with the append cursor intact.
  transports[0].emitExit(1, "SIGTERM");
  await flushMicrotasks();
  assert.equal(runtime.snapshot.state, "disconnected");
  assert.equal(runtime.snapshot.lastSeenEntryId, "entry-1");

  // The replacement handshake completes before the next assertion; the
  // queued-prompt ordering test below pins the pre-ready write boundary.
  const reconnecting = runtime.reconnect();
  await reconnecting;

  // The replacement transport was bound to the existing session file
  // (switch_session -> get_state), then caught up from the append cursor —
  // never the active leaf — with no fresh session created.
  const commands = transports[1].writtenCommands();
  assert.deepEqual(
    commands.map((command) => command.type),
    ["switch_session", "get_state", "get_entries"],
  );
  assert.equal(commands[0].sessionPath, sessionFile);
  assert.equal(commands[2].since, "entry-1");

  // The append cursor advanced to the last entry id in append order while
  // the lagging active leaf is exposed separately and never becomes the
  // durable cursor.
  assert.equal(runtime.snapshot.state, "ready");
  assert.equal(runtime.snapshot.lastSeenEntryId, "entry-2");
  assert.equal(runtime.snapshot.leafId, "entry-1");
  assert.equal(runtime.snapshot.lastEntryId, "entry-2");

  // Recovered entries hydrated the same conversation before ready.
  assert.deepEqual(
    runtime.conversationSnapshot.timeline.map((record) =>
      record.type === "message" ? record.content : "",
    ),
    ["first prompt", "first answer"],
  );

  // The reconnect persisted the pointer with the durable append cursor and
  // the transient active leaf.
  const persisted = store.saved[store.saved.length - 1];
  assert.equal(persisted.workspace, sessionWorkspaceKey(workspace));
  assert.equal(persisted.sessionFile, sessionFile);
  assert.equal(persisted.lastEntryId, "entry-2");
  assert.equal(persisted.leafId, "entry-1");

  await runtime.stop();
});

test("queued prompts are never sent before the handshake and resume only after ready", async () => {
  const store = fakeStore(null);
  const { runtime, transports } = runtimeWithTransportSequence(
    [new FakeTransport(reconnectResponses), new FakeTransport(reconnectResponses)],
    store,
  );

  await runtime.start(workspace);
  transports[0].emitExit(1, "SIGTERM");
  await flushMicrotasks();
  assert.equal(runtime.snapshot.state, "disconnected");

  // A prompt sent while disconnected is retained in the paused queue; no
  // prompt command is written to any live transport.
  await runtime.sendPrompt("queued prompt");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 1);
  assert.ok(
    transports[0].writtenCommands().every((command) => command.type !== "prompt"),
    "no prompt command may be written while disconnected",
  );

  await runtime.reconnect();

  // The prompt is the last command written: it follows the full handshake
  // (switch_session, get_state, get_entries) and is dispatched only after
  // the runtime published ready.
  const commands = transports[1].writtenCommands();
  assert.deepEqual(
    commands.map((command) => command.type),
    ["switch_session", "get_state", "get_entries", "prompt"],
  );
  const prompt = commands[3];
  assert.equal(prompt.type, "prompt");
  assert.equal(prompt.message, "queued prompt");
  assert.equal(runtime.snapshot.state, "ready");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 0);

  // The same conversation was reused: hydrated history and the queued prompt
  // both appear in the timeline.
  const contents = runtime.conversationSnapshot.timeline.map((record) =>
    record.type === "message" ? record.content : "",
  );
  assert.ok(contents.includes("first prompt"));
  assert.ok(contents.includes("first answer"));
  assert.ok(contents.includes("queued prompt"));

  await runtime.stop();
});

test("start on a same-workspace disconnected runtime delegates to the reconnect seam", async () => {
  const store = fakeStore(null);
  const { runtime, transports } = runtimeWithTransportSequence(
    [new FakeTransport(reconnectResponses), new FakeTransport(reconnectResponses)],
    store,
  );

  await runtime.start(workspace);
  transports[0].emitExit(1, "SIGTERM");
  await flushMicrotasks();
  assert.equal(runtime.snapshot.state, "disconnected");

  // Queue a prompt while disconnected: it must survive the start() call.
  await runtime.sendPrompt("queued prompt");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 1);

  const started = await runtime.start(workspace);
  assert.equal(started.state, "ready");

  // The existing conversation was reused and its queue resumed: the prompt
  // was actually dispatched after the reconnect handshake. A fresh,
  // unhandshaken second conversation would have dropped the queue and never
  // sent this prompt.
  const commands = transports[1].writtenCommands();
  assert.deepEqual(
    commands.map((command) => command.type),
    ["switch_session", "get_state", "get_entries", "prompt"],
  );
  assert.equal(commands[3].message, "queued prompt");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 0);
  assert.equal(runtime.snapshot.lastSeenEntryId, "entry-2");

  await runtime.stop();
});

test("a failed reconnect closes the transport and preserves queued work for retry", async () => {
  const store = fakeStore(null);
  const { runtime, transports } = runtimeWithTransportSequence(
    [
      new FakeTransport(reconnectResponses),
      new FakeTransport(reconnectResponses, { failCommands: { get_state: true } }),
      new FakeTransport(reconnectResponses),
    ],
    store,
  );

  await runtime.start(workspace);
  transports[0].emitExit(1, "SIGTERM");
  await flushMicrotasks();
  assert.equal(runtime.snapshot.state, "disconnected");

  await runtime.sendPrompt("queued prompt");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 1);

  // The failed handshake closes the replacement transport cleanly (stdin
  // EOF) and leaves the runtime disconnected without dropping the queue.
  await assert.rejects(runtime.reconnect(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /get_state/);
    return true;
  });
  assert.equal(runtime.snapshot.state, "disconnected");
  assert.match(runtime.snapshot.lastError ?? "", /get_state/);
  assert.equal(transports[1].stdinEndCount, 1);
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 1, "queued work must survive a failed reconnect");

  // A later retry over a healthy transport completes the handshake and
  // resumes the preserved queue.
  await runtime.reconnect();
  const commands = transports[2].writtenCommands();
  assert.deepEqual(
    commands.map((command) => command.type),
    ["switch_session", "get_state", "get_entries", "prompt"],
  );
  assert.equal(commands[3].message, "queued prompt");
  assert.equal(runtime.snapshot.state, "ready");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 0);

  await runtime.stop();
});
test("a reconnect that cannot resume the old session never creates a fresh Pi session", async () => {
  const store = fakeStore(null);
  const cancelledResume = (command: WireCommand): Record<string, unknown> =>
    command.type === "switch_session" ? { cancelled: true } : reconnectResponses(command);
  const { runtime, transports } = runtimeWithTransportSequence(
    [new FakeTransport(reconnectResponses), new FakeTransport(cancelledResume), new FakeTransport(reconnectResponses)],
    store,
  );

  await runtime.start(workspace);
  transports[0].emitExit(1, "SIGTERM");
  await flushMicrotasks();
  await runtime.sendPrompt("queued prompt");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 1);

  await assert.rejects(runtime.reconnect(), /did not resume the existing session/);
  assert.deepEqual(
    transports[1].writtenCommands().map((command) => command.type),
    ["switch_session"],
  );
  assert.equal(runtime.snapshot.state, "disconnected");
  assert.equal(runtime.snapshot.sessionId, "pi-session-1");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 1);
  assert.ok(
    runtime.conversationSnapshot.timeline.some(
      (record) => record.type === "message" && record.content === "first prompt",
    ),
    "the old conversation must remain visible when resume fails",
  );

  await runtime.reconnect();
  assert.deepEqual(
    transports[2].writtenCommands().map((command) => command.type),
    ["switch_session", "get_state", "get_entries", "prompt"],
  );
  assert.equal(runtime.snapshot.state, "ready");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 0);
  await runtime.stop();
});

test("a live turn that settled before the transport died is never duplicated by reconnect", async () => {
  const store = fakeStore(null);
  let getEntriesCalls = 0;
  const liveTurnResponses = (command: WireCommand): Record<string, unknown> => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "get_state":
        // A resumed persisted session must report the authoritative agent
        // state (model + thinking level).
        return {
          sessionId: "pi-session-1",
          sessionFile,
          model: { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
          thinkingLevel: "medium",
        };
      case "get_entries": {
        getEntriesCalls += 1;
        // 1: startup catch-up on a fresh session — empty history.
        if (getEntriesCalls === 1) return { entries: [], leafId: null };
        // 2+: the post-agent_settled synchronization and the reconnect
        // catch-up both return the live turn's authoritative entries (Pi
        // persisted them after the turn settled); reconciliation must never
        // append a second user/assistant record for them.
        return {
          entries: [
            {
              type: "message",
              id: "user-1",
              parentId: null,
              timestamp: "2026-01-01T00:00:00.000Z",
              message: { role: "user", content: "Inspect the project" },
            },
            {
              type: "message",
              id: "assistant-1",
              parentId: "user-1",
              timestamp: "2026-01-01T00:00:01.000Z",
              message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
            },
          ],
          leafId: "assistant-1",
        };
      }
      default:
        return {};
    }
  };
  const { runtime, transports } = runtimeWithTransportSequence(
    [new FakeTransport(liveTurnResponses), new FakeTransport(liveTurnResponses)],
    store,
  );

  const started = await runtime.start(workspace);
  assert.equal(started.state, "ready");
  assert.equal(started.lastSeenEntryId, null);

  // A live turn runs and settles while connected.
  await runtime.sendPrompt("Inspect the project");
  transports[0].emitStdoutLine(JSON.stringify({ type: "agent_start" }));
  transports[0].emitStdoutLine(JSON.stringify({ type: "message_start", message: { id: "msg-1", role: "assistant", content: [] } }));
  transports[0].emitStdoutLine(JSON.stringify({ type: "message_end", message: { id: "msg-1", role: "assistant", content: [{ type: "text", text: "Done" }] } }));
  transports[0].emitStdoutLine(JSON.stringify({ type: "agent_settled" }));
  await flushMicrotasks();
  await flushMicrotasks();

  // The post-settled synchronization reconciled the turn and persisted the
  // authoritative append cursor before any next prompt could dispatch.
  assert.equal(runtime.snapshot.state, "ready");
  assert.equal(runtime.snapshot.lastSeenEntryId, "assistant-1");
  const settledTimeline = runtime.conversationSnapshot.timeline;
  assert.equal(
    settledTimeline.filter((record) => record.type === "message" && record.role === "user").length,
    1,
  );
  assert.equal(
    settledTimeline.filter((record) => record.type === "message" && record.role === "assistant").length,
    1,
  );

  // The Pi process dies; reconnect catches up from the durable cursor and
  // the same authoritative entries replay. The live turn is still
  // represented exactly once per role.
  transports[0].emitExit(1, "SIGTERM");
  await flushMicrotasks();
  assert.equal(runtime.snapshot.state, "disconnected");

  await runtime.reconnect();

  const timeline = runtime.conversationSnapshot.timeline;
  assert.equal(
    timeline.filter((record) => record.type === "message" && record.role === "user").length,
    1,
    "exactly one user record after reconciliation",
  );
  assert.equal(
    timeline.filter((record) => record.type === "message" && record.role === "assistant").length,
    1,
    "exactly one assistant record after reconciliation",
  );
  assert.equal(runtime.snapshot.state, "ready");

  await runtime.stop();
});

test("a queued prompt is dispatched only after the post-settled synchronization reconciles", async () => {
  const store = fakeStore(null);
  let getEntriesCalls = 0;
  const responses = (command: WireCommand): Record<string, unknown> => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "get_state":
        return { sessionId: "pi-session-1", sessionFile };
      case "get_entries": {
        getEntriesCalls += 1;
        // 1: startup catch-up on a fresh session — empty history.
        if (getEntriesCalls === 1) return { entries: [], leafId: null };
        // 2: the post-agent_settled synchronization returns the settled
        // turn's authoritative user entry for reconciliation.
        return {
          entries: [
            {
              type: "message",
              id: "user-1",
              parentId: null,
              timestamp: "2026-01-01T00:00:00.000Z",
              message: { role: "user", content: "first" },
            },
          ],
          leafId: "user-1",
        };
      }
      default:
        return {};
    }
  };
  const { runtime, transports } = runtimeWithTransportSequence([new FakeTransport(responses)], store);

  await runtime.start(workspace);
  assert.deepEqual(
    transports[0].writtenCommands().map((command) => command.type),
    ["new_session", "get_state", "get_entries"],
  );

  await runtime.sendPrompt("first");
  await runtime.sendPrompt("second");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 1);
  assert.equal(transports[0].writtenCommands().filter((command) => command.type === "prompt").length, 1);

  // The first turn settles; the post-settled get_entries must reconcile the
  // old entries before the queued prompt is dispatched.
  transports[0].emitStdoutLine(JSON.stringify({ type: "agent_settled" }));
  await flushMicrotasks();
  await flushMicrotasks();

  const commands = transports[0].writtenCommands().map((command) => command.type);
  assert.deepEqual(
    commands,
    [
      "new_session",
      "get_state",
      "get_entries",
      "prompt",
      // The settle refresh reads the authoritative get_state plus a
      // best-effort supported-levels query before the queue resumes.
      "get_entries",
      "get_state",
      "get_available_thinking_levels",
      "prompt",
    ],
    "the queued prompt must follow the post-settled synchronization",
  );
  assert.equal(runtime.snapshot.lastSeenEntryId, "user-1");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 0);
  assert.equal(
    runtime.conversationSnapshot.timeline.filter(
      (record) => record.type === "message" && record.content === "first",
    ).length,
    1,
    "the reconciled user entry must not duplicate the live prompt record",
  );

  await runtime.stop();
});

test("overlapping start/stop/reconnect lifecycle operations serialize deterministically", async () => {
  const store = fakeStore(null);
  const { runtime, transports } = runtimeWithTransportSequence(
    [
      new FakeTransport(reconnectResponses),
      // The reconnect handshake is held open: its responses stay deferred
      // until explicitly released, keeping the lifecycle tail occupied.
      new FakeTransport(reconnectResponses, { deferResponses: true }),
      new FakeTransport(reconnectResponses),
    ],
    store,
  );

  await runtime.start(workspace);
  transports[0].emitExit(1, "SIGTERM");
  await flushMicrotasks();
  assert.equal(runtime.snapshot.state, "disconnected");

  const reconnecting = runtime.reconnect();
  await flushMicrotasks();
  assert.equal(runtime.snapshot.state, "starting");

  // A stop requested while the reconnect is in flight must not run
  // concurrently: it waits for the reconnect handshake to complete.
  let stopSettled = false;
  const stopping = runtime.stop().then((snapshot) => {
    stopSettled = true;
    return snapshot;
  });
  await flushMicrotasks();
  assert.equal(stopSettled, false, "stop must be serialized behind the reconnect handshake");

  // A second reconnect while one is in flight is rejected deterministically.
  await assert.rejects(runtime.reconnect(), /runtime is starting/);

  // Release the handshake: the reconnect completes, then the queued stop
  // runs and persists the advanced cursor.
  for (let index = 0; index < 5; index += 1) {
    transports[1].flushDeferredResponses();
    await flushMicrotasks();
  }
  await reconnecting;
  await stopping;

  assert.equal(stopSettled, true);
  assert.equal(runtime.snapshot.state, "stopped");
  assert.equal(
    runtime.snapshot.lastSeenEntryId,
    "entry-2",
    "the reconnect handshake completed before the stop ran",
  );
  assert.equal(store.saved[store.saved.length - 1].lastEntryId, "entry-2");
});

test("a failed post-settled synchronization surfaces disconnected and reconnect resumes the queue", async () => {
  const store = fakeStore(null);
  const emptyHistory = (command: WireCommand): Record<string, unknown> => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "get_state":
        return { sessionId: "pi-session-1", sessionFile };
      default:
        return {};
    }
  };
  const { runtime, transports } = runtimeWithTransportSequence(
    [
      // The startup get_entries succeeds; the post-agent_settled get_entries
      // (second occurrence) fails at the RPC level while the transport stays
      // healthy.
      new FakeTransport(emptyHistory, { failCommands: { get_entries: 2 } }),
      new FakeTransport(reconnectResponses),
    ],
    store,
  );

  await runtime.start(workspace);
  await runtime.sendPrompt("first");
  await runtime.sendPrompt("second");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 1);

  transports[0].emitStdoutLine(JSON.stringify({ type: "agent_settled" }));
  await flushMicrotasks();
  await flushMicrotasks();

  // The failed post-settled sync is visible: the runtime is disconnected so
  // the reconnect seam is available, and the queued prompt is preserved
  // behind the paused queue.
  assert.equal(runtime.snapshot.state, "disconnected");
  assert.match(runtime.snapshot.lastError ?? "", /get_entries/);
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 1);
  assert.equal(runtime.conversationSnapshot.executionState, "error");
  assert.equal(
    transports[0].writtenCommands().filter((command) => command.type === "prompt").length,
    1,
    "no prompt may dispatch after the failed post-settled sync",
  );

  // The reconnect handshake recovers: the queue resumes only after it
  // completes, and the preserved prompt is dispatched last.
  await runtime.reconnect();
  const commands = transports[1].writtenCommands();
  assert.deepEqual(
    commands.map((command) => command.type),
    ["switch_session", "get_state", "get_entries", "prompt"],
  );
  assert.equal(commands[3].message, "second");
  assert.equal(runtime.snapshot.state, "ready");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 0);

  await runtime.stop();
});

test("get_state seeds the active model and thinking level without an extra round trip", async () => {
  const forwarded: PiEvent[] = [];
  const transport = new FakeTransport((command) => {
    switch (command.type) {
      case "new_session":
        return { sessionId: "pi-session-1" };
      case "get_state":
        return {
          sessionId: "pi-session-1",
          sessionFile,
          model: { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
          thinkingLevel: "high",
        };
      case "get_entries":
        return { entries: [], leafId: null };
      default:
        return {};
    }
  });
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => transport,
    handlers: { onEvent: (event) => forwarded.push(event) },
  });

  const started = await runtime.start(workspace);

  // The ready snapshot carries the authoritative agent state projected from
  // the existing get_state handshake — never fabricated and never re-queried.
  assert.equal(started.state, "ready");
  assert.deepEqual(started.model, {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    name: "Claude Sonnet 4.5",
  });
  assert.equal(started.thinkingLevel, "high");
  assert.deepEqual(
    transport.writtenCommands().map((command) => command.type),
    ["new_session", "get_state", "get_entries"],
    "no extra get_available_models or second get_state round trip may seed the selectors",
  );

  // The runtime event channel publishes the same projection.
  const readyEvent = forwarded.find(
    (event): event is Extract<PiEvent, { type: "runtime" }> =>
      event.type === "runtime" && event.snapshot.state === "ready",
  );
  assert.ok(readyEvent, "a ready snapshot must be published");
  assert.equal(readyEvent.snapshot.model?.id, "claude-sonnet-4-5");
  assert.equal(readyEvent.snapshot.thinkingLevel, "high");

  await runtime.stop();
  assert.equal(runtime.snapshot.model, null);
  assert.equal(runtime.snapshot.thinkingLevel, null);
});

test("reconnect re-seeds the model and thinking level from the forced get_state handshake", async () => {
  let getStateCalls = 0;
  const agentStateResponses = (command: WireCommand): Record<string, unknown> => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "get_state":
        getStateCalls += 1;
        // The first handshake reports one model; the replacement Pi process
        // reports another after the transport died.
        return getStateCalls === 1
          ? {
              sessionId: "pi-session-1",
              sessionFile,
              model: { id: "claude-sonnet-4-5", provider: "anthropic" },
              thinkingLevel: "low",
            }
          : {
              sessionId: "pi-session-1",
              sessionFile,
              model: { id: "gpt-5", provider: "openai" },
              thinkingLevel: "max",
            };
      case "get_entries":
        return { entries: [], leafId: null };
      default:
        return {};
    }
  };
  const { runtime, transports } = runtimeWithTransportSequence([
    new FakeTransport(agentStateResponses),
    new FakeTransport(agentStateResponses),
  ]);

  const started = await runtime.start(workspace);
  assert.equal(started.model?.id, "claude-sonnet-4-5");
  assert.equal(started.thinkingLevel, "low");

  transports[0].emitExit(1, "SIGTERM");
  await flushMicrotasks();
  assert.equal(runtime.snapshot.state, "disconnected");

  await runtime.reconnect();

  // The replacement handshake re-seeds the authoritative agent state; the
  // stale pre-death projection never survives the reconnect.
  assert.equal(runtime.snapshot.state, "ready");
  assert.equal(runtime.snapshot.model?.id, "gpt-5");
  assert.equal(runtime.snapshot.model?.provider, "openai");
  assert.equal(runtime.snapshot.thinkingLevel, "max");
  assert.deepEqual(
    transports[1].writtenCommands().map((command) => command.type),
    ["switch_session", "get_state", "get_entries"],
    "reconnect seeds the selectors from the handshake, not an extra query",
  );

  await runtime.stop();
});

test("getAvailableModels writes the catalog command, parses data.models, and seeds the snapshot", async () => {
  const transport = new FakeTransport((command) => {
    if (command.type === "get_available_models") {
      return {
        models: [
          { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
          { id: "gpt-5", provider: "openai" },
          // Records without the stable identity are skipped, never fabricated.
          { id: "orphan-model" },
          "not-a-record",
        ],
      };
    }
    return defaultResponses(command);
  });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);
  // The catalog is not seeded by the handshake: empty until queried.
  assert.deepEqual(runtime.snapshot.availableModels, []);

  const models = await runtime.getAvailableModels();

  assert.deepEqual(models, [
    { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
    { id: "gpt-5", provider: "openai" },
  ]);
  assert.deepEqual(runtime.snapshot.availableModels, models);
  // The command carries only the owned type (+ the correlation id): the
  // renderer can never influence the request shape.
  const command = transport.writtenCommands().find((c) => c.type === "get_available_models");
  assert.deepEqual(Object.keys(command ?? {}).sort(), ["id", "type"]);

  await runtime.stop();
  assert.deepEqual(runtime.snapshot.availableModels, []);
});

test("getAvailableModels tolerates a bare array response for the catalog", async () => {
  const transport = new FakeTransport((command) => {
    if (command.type === "get_available_models") {
      return [{ id: "gpt-5", provider: "openai" }];
    }
    return defaultResponses(command);
  });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);

  const models = await runtime.getAvailableModels();

  assert.deepEqual(models, [{ id: "gpt-5", provider: "openai" }]);
  assert.deepEqual(runtime.snapshot.availableModels, [{ id: "gpt-5", provider: "openai" }]);
  await runtime.stop();
});

test("setModel writes the exact command and applies the authoritative response", async () => {
  const transport = new FakeTransport((command) => {
    if (command.type === "set_model") {
      return { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" };
    }
    return defaultResponses(command);
  });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);

  const model = await runtime.setModel("anthropic", "claude-sonnet-4-5");

  // The effective model comes from the authoritative get_state refresh (the
  // default fixture reports the same model Pi's set_model echoed): it is
  // applied to the snapshot and returned to the caller.
  assert.deepEqual(model, {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    name: "Claude Sonnet 4.5",
  });
  assert.deepEqual(runtime.snapshot.model, model);
  const command = transport.writtenCommands().find((c) => c.type === "set_model");
  assert.deepEqual(
    { provider: command?.provider, modelId: command?.modelId },
    { provider: "anthropic", modelId: "claude-sonnet-4-5" },
  );

  await runtime.stop();
});

test("setModel refreshes the effective state from get_state and the supported levels", async () => {
  let getStateCalls = 0;
  const transport = new FakeTransport((command) => {
    switch (command.type) {
      case "set_model":
        return {}; // bare acknowledgement: no model echo at all
      case "get_state":
        getStateCalls += 1;
        if (getStateCalls === 1) {
          // Handshake seeds the previous selection.
          return {
            sessionId: "pi-session-1",
            sessionFile,
            model: { id: "claude-sonnet-4-5", provider: "anthropic" },
            thinkingLevel: "medium",
          };
        }
        // The authoritative refresh after set_model reports the applied model.
        return {
          sessionId: "pi-session-1",
          sessionFile,
          model: { id: "gpt-5", provider: "openai", name: "GPT-5" },
          thinkingLevel: "low",
        };
      case "get_available_thinking_levels":
        return { levels: ["off", "low"] };
      default:
        return defaultResponses(command);
    }
  });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);

  const model = await runtime.setModel("anthropic", "claude-sonnet-4-5");

  // The effective model comes from the authoritative get_state refresh —
  // never fabricated from the requested identity.
  assert.deepEqual(model, { id: "gpt-5", provider: "openai", name: "GPT-5" });
  assert.deepEqual(runtime.snapshot.model, model);
  // The get_state refresh re-reads the effective thinking level too.
  assert.equal(runtime.snapshot.thinkingLevel, "low");
  // The switch refreshed the model-specific supported thinking levels.
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, ["off", "low"]);
  // The exact command shape plus the refresh sequence.
  const command = transport.writtenCommands().find((c) => c.type === "set_model");
  assert.deepEqual(
    { provider: command?.provider, modelId: command?.modelId },
    { provider: "anthropic", modelId: "claude-sonnet-4-5" },
  );
  assert.deepEqual(
    transport.writtenCommands().map((c) => c.type).slice(-3),
    ["set_model", "get_state", "get_available_thinking_levels"],
  );

  await runtime.stop();
});

test("setModel clears the supported levels when the catalog read fails after the switch", async () => {
  let getStateCalls = 0;
  let levelsCalls = 0;
  const transport = new FakeTransport((command) => {
    switch (command.type) {
      case "set_model":
        return { id: "gpt-5", provider: "openai" };
      case "get_state":
        getStateCalls += 1;
        // The handshake seeds the previous model; the mutation refresh
        // reports the switched-to model with its effective thinking level.
        return {
          sessionId: "pi-session-1",
          sessionFile,
          model:
            getStateCalls === 1
              ? { id: "claude-sonnet-4-5", provider: "anthropic" }
              : { id: "gpt-5", provider: "openai" },
          thinkingLevel: "medium",
        };
      case "get_available_thinking_levels":
        levelsCalls += 1;
        return levelsCalls === 1 ? { levels: ["off"] } : {}; // malformed after
      default:
        return defaultResponses(command);
    }
  });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);
  await runtime.getAvailableThinkingLevels();
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, ["off"]);
  assert.equal(runtime.snapshot.model?.id, "claude-sonnet-4-5");

  // A malformed levels payload never fails the successful model mutation,
  // but the stale pre-switch list is cleared: the new model's supported
  // options are unknown, so the old model's list must not remain selectable.
  const model = await runtime.setModel("openai", "gpt-5");
  assert.deepEqual(model, { id: "gpt-5", provider: "openai" });
  assert.equal(runtime.snapshot.state, "ready");
  assert.equal(runtime.snapshot.model?.id, "gpt-5");
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, []);

  await runtime.stop();
});

test("setModel preserves the compatible display name while get_state owns the effective identity", async () => {
  const transport = new FakeTransport((command) => {
    switch (command.type) {
      case "set_model":
        // Pi's set_model answers the full model object, including the name.
        return { id: "gpt-5", provider: "openai", name: "GPT-5" };
      case "get_state":
        // The authoritative get_state confirms the same identity without the
        // optional display name; the compatible name survives.
        return {
          sessionId: "pi-session-1",
          sessionFile,
          model: { id: "gpt-5", provider: "openai" },
          thinkingLevel: "low",
        };
      case "get_available_thinking_levels":
        return { levels: ["off"] };
      default:
        return defaultResponses(command);
    }
  });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);

  const model = await runtime.setModel("openai", "gpt-5");

  // Identity and effective level come from get_state; the name is the
  // compatible echo enrichment.
  assert.deepEqual(model, { id: "gpt-5", provider: "openai", name: "GPT-5" });
  assert.deepEqual(runtime.snapshot.model, { id: "gpt-5", provider: "openai", name: "GPT-5" });
  assert.equal(runtime.snapshot.thinkingLevel, "low");
  await runtime.stop();
});

test("setThinkingLevel writes the exact command and reads the effective level from get_state", async () => {
  let getStateCalls = 0;
  const transport = new FakeTransport((command) => {
    switch (command.type) {
      case "set_thinking_level":
        return {}; // success-only: Pi answers with no effective payload
      case "get_state":
        getStateCalls += 1;
        if (getStateCalls === 1) {
          return { sessionId: "pi-session-1", sessionFile, thinkingLevel: "medium" };
        }
        return { sessionId: "pi-session-1", sessionFile, thinkingLevel: "max" };
      default:
        return defaultResponses(command);
    }
  });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);

  const applied = await runtime.setThinkingLevel("high");

  // The effective level is read back from the authoritative get_state, not
  // an echo (there is none) and never the requested value.
  assert.equal(applied, "max");
  assert.equal(runtime.snapshot.thinkingLevel, "max");
  const command = transport.writtenCommands().find((c) => c.type === "set_thinking_level");
  assert.equal(command?.level, "high");
  assert.deepEqual(Object.keys(command ?? {}).sort(), ["id", "level", "type"]);
  // The mutation followed the command with the get_state refresh.
  assert.deepEqual(
    transport.writtenCommands().map((c) => c.type).slice(-2),
    ["set_thinking_level", "get_state"],
  );

  await runtime.stop();
});

test("setThinkingLevel never falls back to the requested level", async () => {
  let getStateCalls = 0;
  const transport = new FakeTransport((command) => {
    switch (command.type) {
      case "set_thinking_level":
        return {}; // success without any effective level payload
      case "get_state":
        getStateCalls += 1;
        if (getStateCalls === 1) {
          return { sessionId: "pi-session-1", sessionFile, thinkingLevel: "medium" };
        }
        // Pi applies a different effective level than the one requested.
        return { sessionId: "pi-session-1", sessionFile, thinkingLevel: "low" };
      default:
        return defaultResponses(command);
    }
  });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);

  const applied = await runtime.setThinkingLevel("high");

  // The requested "high" is never used as a fallback: get_state reports the
  // authoritative "low" and the shell must expose exactly that.
  assert.equal(applied, "low");
  assert.equal(runtime.snapshot.thinkingLevel, "low");
  await runtime.stop();
});

test("model_change and thinking_level_change events never project state and still forward raw", async () => {
  const forwarded: PiEvent[] = [];
  const transport = new FakeTransport((command) => {
    if (command.type === "get_state") {
      return {
        sessionId: "pi-session-1",
        sessionFile,
        model: { id: "seed", provider: "anthropic" },
        thinkingLevel: "medium",
      };
    }
    return defaultResponses(command);
  });
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => transport,
    handlers: { onEvent: (event) => forwarded.push(event) },
  });
  await runtime.start(workspace);
  assert.deepEqual(runtime.snapshot.model, { id: "seed", provider: "anthropic" });
  assert.equal(runtime.snapshot.thinkingLevel, "medium");

  transport.emitStdoutLine(
    JSON.stringify({ type: "model_change", provider: "openai", modelId: "gpt-5" }),
  );
  transport.emitStdoutLine(JSON.stringify({ type: "thinking_level_change", thinkingLevel: "xhigh" }));
  await flushMicrotasks();

  // Model/thinking changes are not Pi RPC events: `get_state` is the only
  // authoritative source, so no fake `model_change`/`thinking_level_change`
  // projection may mutate the snapshot.
  assert.deepEqual(runtime.snapshot.model, { id: "seed", provider: "anthropic" });
  assert.equal(runtime.snapshot.thinkingLevel, "medium");

  // The raw events still reach protocol consumers unchanged.
  const protocolTypes: string[] = [];
  for (const event of forwarded) {
    if (event.type !== "protocol") continue;
    const message = event.message;
    assert.ok(message !== null && typeof message === "object" && "type" in message);
    protocolTypes.push(String(message.type));
  }
  assert.ok(protocolTypes.includes("model_change"));
  assert.ok(protocolTypes.includes("thinking_level_change"));

  await runtime.stop();
});

test("state-like RPC events never mutate the projected agent state regardless of payload shape", async () => {
  const transport = new FakeTransport((command) => {
    if (command.type === "get_state") {
      return {
        sessionId: "pi-session-1",
        sessionFile,
        model: { id: "seed", provider: "anthropic" },
        thinkingLevel: "medium",
      };
    }
    return defaultResponses(command);
  });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);

  // snake_case payloads are equally inert.
  transport.emitStdoutLine(
    JSON.stringify({ type: "model_change", provider: "anthropic", model_id: "claude-sonnet-4-5" }),
  );
  transport.emitStdoutLine(JSON.stringify({ type: "thinking_level_change", thinking_level: "medium" }));
  await flushMicrotasks();
  assert.equal(runtime.snapshot.model?.id, "seed");
  assert.equal(runtime.snapshot.thinkingLevel, "medium");

  // Malformed events are inert too: the snapshot keeps the last
  // authoritative get_state values.
  transport.emitStdoutLine(JSON.stringify({ type: "model_change", provider: "orphan" }));
  transport.emitStdoutLine(JSON.stringify({ type: "thinking_level_change", thinkingLevel: "turbo" }));
  await flushMicrotasks();
  assert.equal(runtime.snapshot.model?.id, "seed");
  assert.equal(runtime.snapshot.thinkingLevel, "medium");

  await runtime.stop();
});

test("getAvailableThinkingLevels writes the exact command, parses data.levels, and seeds the snapshot", async () => {
  const transport = new FakeTransport((command) => {
    if (command.type === "get_available_thinking_levels") {
      return { levels: ["off", "low", "max"] };
    }
    return defaultResponses(command);
  });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);
  // The catalog is not seeded by the handshake: empty until queried.
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, []);

  const levels = await runtime.getAvailableThinkingLevels();

  assert.deepEqual(levels, ["off", "low", "max"]);
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, levels);
  // The command carries only the owned type (+ the correlation id).
  const command = transport.writtenCommands().find((c) => c.type === "get_available_thinking_levels");
  assert.deepEqual(Object.keys(command ?? {}).sort(), ["id", "type"]);

  await runtime.stop();
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, []);
});

test("getAvailableThinkingLevels rejects malformed levels and keeps the previous list", async () => {
  let levelsCalls = 0;
  const transport = new FakeTransport((command) => {
    if (command.type === "get_available_thinking_levels") {
      levelsCalls += 1;
      return levelsCalls === 1 ? { levels: ["off"] } : { levels: ["off", "turbo"] };
    }
    return defaultResponses(command);
  });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);

  await runtime.getAvailableThinkingLevels();
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, ["off"]);

  // An unknown entry is malformed: the whole list is rejected and the
  // previous authoritative list survives — the shell never fabricates levels.
  await assert.rejects(runtime.getAvailableThinkingLevels(), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, ["off"]);
  assert.equal(runtime.snapshot.state, "ready", "a catalog failure never fails the runtime");

  await runtime.stop();
});

test("getAvailableThinkingLevels rejects an absent levels payload", async () => {
  const transport = new FakeTransport(); // default: `{}` for the catalog query
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);

  await assert.rejects(runtime.getAvailableThinkingLevels(), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, []);

  await runtime.stop();
});

test("set -> settle -> post-settle synchronize preserves the selected model and thinking level", async () => {
  const forwarded: PiEvent[] = [];
  let getStateCalls = 0;
  let getEntriesCalls = 0;
  const responses = (command: WireCommand): Record<string, unknown> => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "get_state":
        getStateCalls += 1;
        if (getStateCalls === 1) {
          return {
            sessionId: "pi-session-1",
            sessionFile,
            model: { id: "claude-sonnet-4-5", provider: "anthropic" },
            thinkingLevel: "medium",
          };
        }
        // Every later refresh (set_model, settle) confirms the selection.
        return {
          sessionId: "pi-session-1",
          sessionFile,
          model: { id: "gpt-5", provider: "openai" },
          thinkingLevel: "max",
        };
      case "get_entries":
        getEntriesCalls += 1;
        if (getEntriesCalls === 1) return { entries: [], leafId: null };
        return {
          entries: [
            {
              type: "message",
              id: "user-1",
              parentId: null,
              timestamp: "2026-01-01T00:00:00.000Z",
              message: { role: "user", content: "first" },
            },
          ],
          leafId: "user-1",
        };
      case "get_available_thinking_levels":
        return { levels: ["off", "max"] };
      default:
        return {};
    }
  };
  const transport = new FakeTransport(responses);
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => transport,
    handlers: { onEvent: (event) => forwarded.push(event) },
  });
  await runtime.start(workspace);

  await runtime.setModel("anthropic", "gpt-5");
  assert.equal(runtime.snapshot.model?.id, "gpt-5");
  assert.equal(runtime.snapshot.thinkingLevel, "max");

  await runtime.sendPrompt("first");
  transport.emitStdoutLine(JSON.stringify({ type: "agent_settled" }));
  await flushMicrotasks();
  await flushMicrotasks();

  // The controlled settle refresh ran: get_entries catch-up, authoritative
  // get_state, then best-effort supported levels.
  assert.deepEqual(
    transport.writtenCommands().map((command) => command.type).slice(-3),
    ["get_entries", "get_state", "get_available_thinking_levels"],
  );
  assert.equal(runtime.snapshot.state, "ready");
  // The selection never regressed through the settle synchronization.
  assert.equal(runtime.snapshot.model?.id, "gpt-5");
  assert.equal(runtime.snapshot.thinkingLevel, "max");
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, ["off", "max"]);

  // No runtime snapshot published after the model switch may regress the
  // selected model or thinking level (the session enters synchronizing
  // during the settle; the projection must not follow it).
  let sawPostSetSnapshot = false;
  for (const event of forwarded) {
    if (event.type !== "runtime") continue;
    const snapshot = event.snapshot;
    if (snapshot.model?.id === "gpt-5") {
      sawPostSetSnapshot = true;
      assert.equal(
        snapshot.thinkingLevel,
        "max",
        "the selected thinking level must never regress",
      );
    }
  }
  assert.ok(sawPostSetSnapshot, "the post-set model selection must be published");

  await runtime.stop();
});

test("model/level selectors reject before the runtime is started", async () => {
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => new FakeTransport(),
  });

  await assert.rejects(runtime.getAvailableModels(), /not running/);
  await assert.rejects(runtime.getAvailableThinkingLevels(), /not running/);
  await assert.rejects(runtime.setModel("anthropic", "claude-sonnet-4-5"), /not running/);
  await assert.rejects(runtime.setThinkingLevel("high"), /not running/);
});

test("setModel and setThinkingLevel reject invalid renderer inputs at the runtime boundary", async () => {
  const transport = new FakeTransport();
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);

  await assert.rejects(runtime.setModel("", "claude-sonnet-4-5"), /provider must be a non-empty string/);
  await assert.rejects(runtime.setModel("anthropic", "   "), /modelId must be a non-empty string/);
  await assert.rejects(
    runtime.setThinkingLevel("turbo" as unknown as PiThinkingLevel),
    /Invalid Pi thinking level/,
  );

  // No rejected payload ever became a Pi command.
  assert.ok(
    transport
      .writtenCommands()
      .every((command) => !["set_model", "set_thinking_level"].includes(command.type)),
    "invalid renderer inputs must not reach Pi",
  );

  await runtime.stop();
});

test("stop clears the projected agent state, the model catalog, and the supported thinking levels", async () => {
  let getStateCalls = 0;
  const transport = new FakeTransport((command) => {
    switch (command.type) {
      case "get_available_models":
        return { models: [{ id: "gpt-5", provider: "openai" }] };
      case "set_model":
        return { id: "gpt-5", provider: "openai" };
      case "get_available_thinking_levels":
        return { levels: ["off", "low"] };
      case "get_state":
        getStateCalls += 1;
        if (getStateCalls === 1) {
          // Handshake: a no-model session is valid.
          return { sessionId: "pi-session-1", sessionFile, thinkingLevel: "medium" };
        }
        // Mutation refreshes must report the effective model and level.
        return {
          sessionId: "pi-session-1",
          sessionFile,
          model: { id: "gpt-5", provider: "openai" },
          thinkingLevel: "max",
        };
      default:
        return defaultResponses(command);
    }
  });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);

  await runtime.getAvailableModels();
  await runtime.setModel("openai", "gpt-5");
  await runtime.setThinkingLevel("high");
  assert.equal(runtime.snapshot.availableModels.length, 1);
  assert.equal(runtime.snapshot.model?.id, "gpt-5");
  assert.equal(runtime.snapshot.thinkingLevel, "max");
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, ["off", "low"]);

  await runtime.stop();

  // The Pi process is gone: agent state and the catalogs reset with it.
  assert.equal(runtime.snapshot.state, "stopped");
  assert.equal(runtime.snapshot.model, null);
  assert.equal(runtime.snapshot.thinkingLevel, null);
  assert.deepEqual(runtime.snapshot.availableModels, []);
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, []);
});

test("a model mutation in flight when stop is requested never publishes stale agent state into the stopped runtime", async () => {
  let getStateCalls = 0;
  const responses = (command: WireCommand): Record<string, unknown> => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "set_model":
        return { id: "gpt-5", provider: "openai" };
      case "get_state":
        getStateCalls += 1;
        return {
          sessionId: "pi-session-1",
          sessionFile,
          model:
            getStateCalls === 1
              ? { id: "claude-sonnet-4-5", provider: "anthropic" }
              : { id: "gpt-5", provider: "openai" },
          thinkingLevel: "medium",
        };
      case "get_entries":
        return { entries: [], leafId: null };
      case "get_available_thinking_levels":
        return { levels: ["off", "low"] };
      default:
        return {};
    }
  };
  const transport = new FakeTransport(responses, { deferResponses: true });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });

  const starting = runtime.start(workspace);
  for (let index = 0; index < 5; index += 1) {
    transport.flushDeferredResponses();
    await flushMicrotasks();
  }
  await starting;
  assert.equal(runtime.snapshot.state, "ready");

  // The mutation's responses are deferred, so it holds the lifecycle tail
  // when stop() is requested; the stop is serialized behind the mutation,
  // which publishes into the ready runtime and is then cleared by the stop —
  // an overlapping result can never be published into the stopped snapshot.
  const changing = runtime.setModel("openai", "gpt-5");
  const stopping = runtime.stop();
  for (let index = 0; index < 5; index += 1) {
    transport.flushDeferredResponses();
    await flushMicrotasks();
  }
  const model = await changing;
  const stopped = await stopping;

  assert.deepEqual(model, { id: "gpt-5", provider: "openai" });
  assert.equal(stopped.state, "stopped");
  assert.equal(runtime.snapshot.state, "stopped");
  assert.equal(runtime.snapshot.model, null);
  assert.equal(runtime.snapshot.thinkingLevel, null);
  assert.deepEqual(runtime.snapshot.availableModels, []);
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, []);
});

test("a catalog read in flight when stop is requested never overwrites the stopped runtime's cleared catalog", async () => {
  const transport = new FakeTransport(
    (command) => {
      if (command.type === "get_available_models") {
        return { models: [{ id: "gpt-5", provider: "openai" }] };
      }
      return defaultResponses(command);
    },
    { deferResponses: true },
  );
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });

  const starting = runtime.start(workspace);
  for (let index = 0; index < 5; index += 1) {
    transport.flushDeferredResponses();
    await flushMicrotasks();
  }
  await starting;
  assert.equal(runtime.snapshot.state, "ready");

  // The catalog read holds the lifecycle tail while stop() is requested; the
  // stop queues behind it, so the overlapping result is published into the
  // ready runtime and then cleared by the stop — never into the stopped
  // snapshot.
  const reading = runtime.getAvailableModels();
  const stopping = runtime.stop();
  for (let index = 0; index < 5; index += 1) {
    transport.flushDeferredResponses();
    await flushMicrotasks();
  }
  const models = await reading;
  await stopping;

  assert.deepEqual(models, [{ id: "gpt-5", provider: "openai" }]);
  assert.equal(runtime.snapshot.state, "stopped");
  assert.deepEqual(runtime.snapshot.availableModels, []);
});

test("a mutation whose transport dies before its catalog read rejects instead of publishing into the disconnected runtime", async () => {
  let getStateCalls = 0;
  const responses = (command: WireCommand): Record<string, unknown> => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "set_model":
        return { id: "gpt-5", provider: "openai" };
      case "get_state":
        getStateCalls += 1;
        return {
          sessionId: "pi-session-1",
          sessionFile,
          model:
            getStateCalls === 1
              ? { id: "claude-sonnet-4-5", provider: "anthropic" }
              : { id: "gpt-5", provider: "openai" },
          thinkingLevel: "medium",
        };
      case "get_entries":
        return { entries: [], leafId: null };
      case "get_available_thinking_levels":
        return { levels: ["off", "low"] };
      default:
        return {};
    }
  };
  const transport = new FakeTransport(responses, { deferResponses: true });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });

  const starting = runtime.start(workspace);
  for (let index = 0; index < 5; index += 1) {
    transport.flushDeferredResponses();
    await flushMicrotasks();
  }
  await starting;
  assert.equal(runtime.snapshot.state, "ready");
  assert.equal(runtime.snapshot.model?.id, "claude-sonnet-4-5");

  // The mutation completes its set_model + get_state refresh, then its
  // supported-levels catalog read is in flight when the transport dies. The
  // wiring references are unchanged by a transport error, but the runtime is
  // no longer ready: the result must be discarded, not published.
  const changing = runtime.setModel("openai", "gpt-5");
  await flushMicrotasks();
  await flushMicrotasks();
  transport.flushDeferredResponses(); // release set_model
  await flushMicrotasks();
  await flushMicrotasks();
  transport.flushDeferredResponses(); // release get_state; the catalog read is now in flight
  await flushMicrotasks();
  await flushMicrotasks();
  transport.emitExit(1, "SIGTERM"); // transport dies while the catalog read is pending
  await flushMicrotasks();
  await flushMicrotasks();

  await assert.rejects(changing, /discarded/);
  // The disconnected runtime never received the new model: the handshake
  // projection is untouched and nothing stale was published.
  assert.equal(runtime.snapshot.state, "disconnected");
  assert.equal(runtime.snapshot.model?.id, "claude-sonnet-4-5");
  assert.equal(runtime.snapshot.thinkingLevel, "medium");

  await runtime.stop();
});

test("a settle catalog failure clears the supported levels instead of keeping the previous model's list", async () => {
  let levelsCalls = 0;
  let getEntriesCalls = 0;
  const responses = (command: WireCommand): Record<string, unknown> => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "get_state":
        return {
          sessionId: "pi-session-1",
          sessionFile,
          model: { id: "claude-sonnet-4-5", provider: "anthropic" },
          thinkingLevel: "medium",
        };
      case "get_entries": {
        getEntriesCalls += 1;
        if (getEntriesCalls === 1) return { entries: [], leafId: null };
        return {
          entries: [
            {
              type: "message",
              id: "user-1",
              parentId: null,
              timestamp: "2026-01-01T00:00:00.000Z",
              message: { role: "user", content: "first" },
            },
          ],
          leafId: "user-1",
        };
      }
      case "get_available_thinking_levels":
        levelsCalls += 1;
        return levelsCalls === 1 ? { levels: ["off", "low"] } : { levels: ["off", "turbo"] };
      default:
        return {};
    }
  };
  const transport = new FakeTransport(responses);
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);
  await runtime.getAvailableThinkingLevels();
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, ["off", "low"]);

  await runtime.sendPrompt("first");
  transport.emitStdoutLine(JSON.stringify({ type: "agent_settled" }));
  await flushMicrotasks();
  await flushMicrotasks();

  // The settle catalog read failed (an unknown level): the stale pre-settle
  // list is cleared so unsupported options cannot be selected, while the
  // settled queue stays healthy.
  assert.equal(runtime.snapshot.state, "ready");
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, []);
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 0);

  await runtime.stop();
});

test("a transport death during the settle-time catalog read keeps the queue paused and reconnect recovers it", async () => {
  const store = fakeStore(null);
  let getEntriesCalls = 0;
  const responses = (command: WireCommand): Record<string, unknown> => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "get_state":
        return {
          sessionId: "pi-session-1",
          sessionFile,
          model: { id: "claude-sonnet-4-5", provider: "anthropic" },
          thinkingLevel: "medium",
        };
      case "get_entries": {
        getEntriesCalls += 1;
        // 1: startup catch-up on a fresh session — empty history.
        if (getEntriesCalls === 1) return { entries: [], leafId: null };
        // 2: the post-agent_settled synchronization returns the settled
        // turn's authoritative user entry for reconciliation.
        return {
          entries: [
            {
              type: "message",
              id: "user-1",
              parentId: null,
              timestamp: "2026-01-01T00:00:00.000Z",
              message: { role: "user", content: "first" },
            },
          ],
          leafId: "user-1",
        };
      }
      case "get_available_thinking_levels":
        return { levels: ["off", "low"] };
      default:
        return {};
    }
  };
  const { runtime, transports } = runtimeWithTransportSequence(
    [
      // Only the settle-time catalog read is held: its response stays
      // deferred until the transport is killed, pinning the failure at
      // exactly that boundary.
      new FakeTransport(responses, { deferCommandTypes: ["get_available_thinking_levels"] }),
      new FakeTransport(reconnectResponses),
    ],
    store,
  );

  await runtime.start(workspace);
  assert.equal(runtime.snapshot.model?.id, "claude-sonnet-4-5");
  await runtime.sendPrompt("first");
  await runtime.sendPrompt("second");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 1);

  // The first turn settles; the settle sequence runs (get_entries catch-up,
  // get_state refresh) and the model-specific catalog read is now in flight
  // on the wire.
  transports[0].emitStdoutLine(JSON.stringify({ type: "agent_settled" }));
  await flushMicrotasks();
  await flushMicrotasks();
  assert.ok(
    transports[0].writtenCommands().some((command) => command.type === "get_available_thinking_levels"),
    "the settle sequence must reach the catalog read",
  );

  // The transport dies exactly while the catalog read is pending.
  transports[0].emitExit(1, "SIGTERM");
  await flushMicrotasks();
  await flushMicrotasks();

  // The settle hook rejected through the disconnect seam: the queue stays
  // paused with a visible error and the queued prompt was never dispatched,
  // while the runtime publishes no stale agent state — the handshake
  // projection is untouched.
  assert.equal(runtime.snapshot.state, "disconnected");
  assert.equal(runtime.snapshot.model?.id, "claude-sonnet-4-5");
  assert.equal(runtime.snapshot.thinkingLevel, "medium");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 1);
  assert.equal(runtime.conversationSnapshot.executionState, "error");
  assert.equal(
    transports[0].writtenCommands().filter((command) => command.type === "prompt").length,
    1,
    "no prompt may dispatch after the settle catalog transport loss",
  );

  // The reconnect handshake recovers: the queue resumes only after it
  // completes, and the preserved prompt is dispatched last.
  await runtime.reconnect();
  const commands = transports[1].writtenCommands();
  assert.deepEqual(
    commands.map((command) => command.type),
    ["switch_session", "get_state", "get_entries", "prompt"],
  );
  assert.equal(commands[3].message, "second");
  assert.equal(runtime.snapshot.state, "ready");
  assert.equal(runtime.conversationSnapshot.queuedPromptCount, 0);

  await runtime.stop();
});

test("an accepted setModel whose get_state readback fails clears the unconfirmed selection from the snapshot", async () => {
  let getStateCalls = 0;
  const responses = (command: WireCommand): Record<string, unknown> => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "set_model":
        return { id: "gpt-5", provider: "openai" };
      case "get_state":
        getStateCalls += 1;
        if (getStateCalls === 1) {
          return {
            sessionId: "pi-session-1",
            sessionFile,
            model: { id: "claude-sonnet-4-5", provider: "anthropic" },
            thinkingLevel: "medium",
          };
        }
        // The authoritative refresh omits the model and the level: the
        // mutation cannot be confirmed.
        return { sessionId: "pi-session-1", sessionFile };
      case "get_entries":
        return { entries: [], leafId: null };
      case "get_available_thinking_levels":
        return { levels: ["off", "low"] };
      default:
        return {};
    }
  };
  const transport = new FakeTransport(responses);
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);
  await runtime.getAvailableThinkingLevels();
  assert.equal(runtime.snapshot.model?.id, "claude-sonnet-4-5");
  assert.equal(runtime.snapshot.thinkingLevel, "medium");
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, ["off", "low"]);

  await assert.rejects(runtime.setModel("openai", "gpt-5"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });

  // Pi accepted set_model but the readback could not confirm it: the
  // runtime publishes the explicit reset (wiring is still ready) instead of
  // retaining the stale selection — and the stale model's supported levels
  // are cleared with it so unsupported options cannot stay selectable.
  assert.equal(runtime.snapshot.state, "ready");
  assert.equal(runtime.snapshot.model, null);
  assert.equal(runtime.snapshot.thinkingLevel, null);
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, []);
  await runtime.stop();
});

test("the post-settled synchronization publishes model, thinking level, and supported levels in one snapshot", async () => {
  const forwarded: PiEvent[] = [];
  let getEntriesCalls = 0;
  const responses = (command: WireCommand): Record<string, unknown> => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "get_state":
        return {
          sessionId: "pi-session-1",
          sessionFile,
          model: { id: "claude-sonnet-4-5", provider: "anthropic" },
          thinkingLevel: "medium",
        };
      case "get_entries": {
        getEntriesCalls += 1;
        // 1: startup catch-up on a fresh session — empty history.
        if (getEntriesCalls === 1) return { entries: [], leafId: null };
        // 2: the post-agent_settled synchronization returns the settled
        // turn's authoritative user entry for reconciliation.
        return {
          entries: [
            {
              type: "message",
              id: "user-1",
              parentId: null,
              timestamp: "2026-01-01T00:00:00.000Z",
              message: { role: "user", content: "first" },
            },
          ],
          leafId: "user-1",
        };
      }
      case "get_available_thinking_levels":
        return { levels: ["off", "low"] };
      default:
        return {};
    }
  };
  const transport = new FakeTransport(responses);
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => transport,
    handlers: { onEvent: (event) => forwarded.push(event) },
  });
  await runtime.start(workspace);
  await runtime.sendPrompt("first");
  transport.emitStdoutLine(JSON.stringify({ type: "agent_settled" }));
  await flushMicrotasks();
  await flushMicrotasks();

  assert.equal(runtime.snapshot.state, "ready");
  assert.equal(runtime.snapshot.model?.id, "claude-sonnet-4-5");
  assert.equal(runtime.snapshot.thinkingLevel, "medium");
  assert.deepEqual(runtime.snapshot.availableThinkingLevels, ["off", "low"]);

  // The agent-state projection after the settle is a single snapshot: the
  // model-specific supported levels are published together with the
  // authoritative model and thinking level (after the reconcile and pointer
  // persistence), never in a separate earlier event.
  const settledEvents = forwarded.filter(
    (event): event is Extract<PiEvent, { type: "runtime" }> =>
      event.type === "runtime" &&
      Array.isArray(event.snapshot.availableThinkingLevels) &&
      event.snapshot.availableThinkingLevels.length === 2,
  );
  assert.equal(settledEvents.length, 1);
  assert.equal(settledEvents[0].snapshot.model?.id, "claude-sonnet-4-5");
  assert.equal(settledEvents[0].snapshot.thinkingLevel, "medium");
  await runtime.stop();
});

test("a setModel rejected before acceptance preserves the previous selection", async () => {
  const transport = new FakeTransport(defaultResponses, { failCommands: { set_model: true } });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);
  assert.equal(runtime.snapshot.model?.id, "claude-sonnet-4-5");
  assert.equal(runtime.snapshot.thinkingLevel, "medium");

  await assert.rejects(runtime.setModel("openai", "gpt-5"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "RPC_FAILURE");
    return true;
  });

  // Pi never accepted the command: the previous selection is preserved and
  // nothing was published onto the ready runtime.
  assert.equal(runtime.snapshot.state, "ready");
  assert.equal(runtime.snapshot.model?.id, "claude-sonnet-4-5");
  assert.equal(runtime.snapshot.thinkingLevel, "medium");
  await runtime.stop();
});

test("a setThinkingLevel rejected before acceptance preserves the previous selection", async () => {
  const transport = new FakeTransport(defaultResponses, {
    failCommands: { set_thinking_level: true },
  });
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);
  assert.equal(runtime.snapshot.thinkingLevel, "medium");

  await assert.rejects(runtime.setThinkingLevel("high"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "RPC_FAILURE");
    return true;
  });

  // Pi never accepted the command: the previous level is preserved and
  // nothing was published onto the ready runtime.
  assert.equal(runtime.snapshot.state, "ready");
  assert.equal(runtime.snapshot.thinkingLevel, "medium");
  await runtime.stop();
});

test("a rejected setThinkingLevel publishes the explicitly cleared level instead of retaining the stale selection", async () => {
  let getStateCalls = 0;
  const responses = (command: WireCommand): Record<string, unknown> => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "set_thinking_level":
        return {}; // success-only: no effective payload
      case "get_state":
        getStateCalls += 1;
        if (getStateCalls === 1) {
          return { sessionId: "pi-session-1", sessionFile, thinkingLevel: "medium" };
        }
        // The authoritative refresh explicitly reports no thinking level:
        // the mutation cannot confirm the switch.
        return { sessionId: "pi-session-1", sessionFile, thinkingLevel: null };
      case "get_entries":
        return { entries: [], leafId: null };
      default:
        return {};
    }
  };
  const transport = new FakeTransport(responses);
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);
  assert.equal(runtime.snapshot.thinkingLevel, "medium");

  await assert.rejects(runtime.setThinkingLevel("high"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });

  // The explicit authoritative null is published: the stale pre-mutation
  // selection never remains in the snapshot.
  assert.equal(runtime.snapshot.thinkingLevel, null);
  assert.equal(runtime.snapshot.state, "ready");
  await runtime.stop();
});

test("a rejected setModel publishes the explicitly cleared model instead of retaining the stale selection", async () => {
  let getStateCalls = 0;
  const responses = (command: WireCommand): Record<string, unknown> => {
    switch (command.type) {
      case "new_session":
      case "switch_session":
        return { sessionId: "pi-session-1" };
      case "set_model":
        return { id: "gpt-5", provider: "openai" };
      case "get_state":
        getStateCalls += 1;
        if (getStateCalls === 1) {
          return {
            sessionId: "pi-session-1",
            sessionFile,
            model: { id: "claude-sonnet-4-5", provider: "anthropic" },
            thinkingLevel: "medium",
          };
        }
        // The authoritative refresh explicitly reports no model (and no
        // level): the mutation cannot confirm the switch.
        return { sessionId: "pi-session-1", sessionFile, model: null, thinkingLevel: null };
      case "get_entries":
        return { entries: [], leafId: null };
      default:
        return {};
    }
  };
  const transport = new FakeTransport(responses);
  const runtime = new PiRuntimeController({ wsl: fakeWsl, createTransport: () => transport });
  await runtime.start(workspace);
  assert.equal(runtime.snapshot.model?.id, "claude-sonnet-4-5");

  await assert.rejects(runtime.setModel("openai", "gpt-5"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });

  // The explicit authoritative nulls are published: no stale selection
  // remains in the snapshot.
  assert.equal(runtime.snapshot.model, null);
  assert.equal(runtime.snapshot.thinkingLevel, null);
  assert.equal(runtime.snapshot.state, "ready");
  await runtime.stop();
});
