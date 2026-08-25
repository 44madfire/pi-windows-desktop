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
import { PiRuntimeController, sessionWorkspaceKey } from "./pi-runtime.ts";

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
  private readonly lifecycle = new EventEmitter();
  private readonly respond: (command: WireCommand) => Record<string, unknown>;
  private readonly failCommands: Readonly<Record<string, boolean>>;
  private readonly exitOnEof: boolean;

  constructor(
    respond: (command: WireCommand) => Record<string, unknown> = defaultResponses,
    options: {
      readonly failCommands?: Readonly<Record<string, boolean>>;
      readonly exitOnEof?: boolean;
    } = {},
  ) {
    this.respond = respond;
    this.failCommands = options.failCommands ?? {};
    this.exitOnEof = options.exitOnEof ?? true;
  }

  readonly stdin: PiRpcWritable = {
    write: (chunk: unknown): PiRpcWriteResult => {
      const frame = String(chunk);
      this.writes.push(frame);
      const line = frame.trim();
      if (line) {
        const command = JSON.parse(line) as WireCommand;
        this.emitResponse(command);
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

  private emitExit(code: number, signal: string | null): void {
    this.exitCount += 1;
    this.lifecycle.emit("exit", code, signal);
  }

  private emitResponse(command: WireCommand): void {
    const failed = this.failCommands[command.type] === true;
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
  return {
    saved: [],
    async load(workspaceKey: string): Promise<SessionPointer | null> {
      return pointer && pointer.workspace === workspaceKey ? pointer : null;
    },
    async save(saved: SessionPointer): Promise<void> {
      this.saved.push(saved);
    },
  };
}

test("a restored runtime resumes switch_session, catches up from the cursor, and hydrates", async () => {
  const transport = new FakeTransport();
  const store = fakeStore({
    workspace: sessionWorkspaceKey(workspace),
    sessionFile,
    sessionId: "pi-session-1",
    lastEntryId: "entry-9",
  });
  const runtime = new PiRuntimeController({
    wsl: fakeWsl,
    createTransport: () => transport,
    sessionStore: store,
  });

  const started = await runtime.start(workspace);

  const commands = transport.writtenCommands();
  assert.deepEqual(
    commands.map((command) => command.type),
    ["switch_session", "get_state", "get_entries"],
  );
  assert.equal(commands[0].sessionPath, sessionFile);
  const getEntries = commands[2];
  assert.equal(getEntries.since, "entry-9");

  // The persisted cursor drove the catch-up; the new leafId is authoritative.
  assert.equal(started.state, "ready");
  assert.equal(started.lastEntryId, "entry-10");
  assert.equal(started.sessionId, "pi-session-1");
  assert.equal(started.sessionFile, sessionFile);

  // Recovered entries hydrated the conversation timeline before ready.
  const timeline = runtime.conversationSnapshot.timeline;
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].type === "message" ? timeline[0].content : '', "recovered prompt");

  // The resulting pointer was persisted (start + synchronization both save).
  assert.ok(store.saved.length >= 1);
  const persisted = store.saved[store.saved.length - 1];
  assert.equal(persisted.workspace, sessionWorkspaceKey(workspace));
  assert.equal(persisted.sessionFile, sessionFile);
  assert.equal(persisted.lastEntryId, "entry-10");

  await runtime.stop();
  const stopped = store.saved[store.saved.length - 1];
  assert.equal(stopped.lastEntryId, "entry-10");
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
