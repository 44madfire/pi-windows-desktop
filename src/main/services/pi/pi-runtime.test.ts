import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import type { PiEvent, WslWorkspace } from "../../../shared/ipc.ts";
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

/**
 * Default Pi behavior for the handshake commands. `get_entries` yields the
 * optional `since` cursor plus `entries`/`leafId` when supplied.
 */
const defaultResponses = (command: WireCommand): Record<string, unknown> => {
  switch (command.type) {
    case "new_session":
    case "switch_session":
      return { sessionId: "pi-session-1" };
    case "get_state":
      return { sessionId: "pi-session-1", sessionFile };
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
  /** Commands whose responses were deferred (deferResponses mode), in write order. */
  readonly deferredCommands: WireCommand[] = [];
  private readonly lifecycle = new EventEmitter();
  private readonly respond: (command: WireCommand) => Record<string, unknown>;
  private readonly failCommands: Readonly<Record<string, boolean | number>>;
  private readonly failCounters = new Map<string, number>();
  private readonly exitOnEof: boolean;
  private readonly deferResponses: boolean;

  constructor(
    respond: (command: WireCommand) => Record<string, unknown> = defaultResponses,
    options: {
      /** true = fail every occurrence; a number = fail only the Nth occurrence (1-based). */
      readonly failCommands?: Readonly<Record<string, boolean | number>>;
      readonly exitOnEof?: boolean;
      /** Hold responses until {@link flushDeferredResponses} releases them. */
      readonly deferResponses?: boolean;
    } = {},
  ) {
    this.respond = respond;
    this.failCommands = options.failCommands ?? {};
    this.exitOnEof = options.exitOnEof ?? true;
    this.deferResponses = options.deferResponses ?? false;
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
        if (this.deferResponses) {
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
        return { sessionId: "pi-session-1", sessionFile };
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
        return { sessionId: "pi-session-1", sessionFile };
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
      return { sessionId: "pi-session-1", sessionFile };
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
        return { sessionId: "pi-session-1", sessionFile };
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
    ["new_session", "get_state", "get_entries", "prompt", "get_entries", "prompt"],
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
        return { sessionId: "pi-session-1", sessionFile };
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
    ["new_session", "get_state", "get_entries", "prompt", "get_entries", "prompt"],
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
