import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionManager,
  SessionManagerError,
  type JsonValue,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcSuccessResponse,
  type SessionPiRpcClient,
} from "./session-manager.ts";

type QueuedResponse = PiRpcSuccessResponse | Error;

class FakePiRpcClient implements SessionPiRpcClient {
  readonly commands: PiRpcCommand[] = [];
  private readonly listeners = new Set<(event: PiRpcEvent) => void | Promise<void>>();
  private readonly responses: QueuedResponse[] = [];

  queueResponse(data: JsonValue = {}): void {
    this.responses.push({
      type: "response",
      id: this.responses.length + 1,
      success: true,
      data,
    });
  }

  queueError(message: string): void {
    this.responses.push(new Error(message));
  }

  async request<TData extends JsonValue = JsonValue>(
    command: PiRpcCommand,
  ): Promise<PiRpcSuccessResponse<TData>> {
    this.commands.push(command);
    const response = this.responses.shift();
    if (!response) throw new Error("fake response queue exhausted");
    if (response instanceof Error) throw response;
    return response as PiRpcSuccessResponse<TData>;
  }

  onEvent(listener: (event: PiRpcEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: PiRpcEvent): void {
    for (const listener of [...this.listeners]) {
      void listener(event);
    }
  }
}

test("models create state and persists only Pi session identity/cursor data", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ sessionId: "pi-session-1", lastEntryId: "entry-0" });
  const states: string[] = [];
  const manager = new SessionManager({ client, sessionId: "requested-session" });
  manager.onStateChange((snapshot) => {
    states.push(snapshot.state);
  });

  const created = await manager.create();
  // Agent events carry no durable cursor; only get_entries responses do.
  client.emit({ type: "message_end", entryId: "entry-1" });

  assert.deepEqual(client.commands, [{ type: "new_session" }]);
  assert.deepEqual(states, ["creating", "ready"]);
  assert.equal(created.state, "ready");
  assert.equal(created.sessionId, "pi-session-1");
  assert.equal(created.sessionFile, null);
  assert.equal(manager.lastEntryId, "entry-0");
  assert.equal(manager.lastSeenEntryId, "entry-0");
  assert.equal(manager.leafId, null);
  assert.deepEqual(Object.keys(manager.snapshot).sort(), [
    "lastEntryId",
    "lastError",
    "lastSeenEntryId",
    "leafId",
    "sessionFile",
    "sessionId",
    "state",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(manager.snapshot)), manager.snapshot);
});

test("reconnect replays records since the persisted cursor through a replacement client", async () => {
  const firstClient = new FakePiRpcClient();
  const manager = new SessionManager({
    client: firstClient,
    sessionId: "session-1",
    lastEntryId: "entry-1",
  });

  const replacement = new FakePiRpcClient();
  replacement.queueResponse({
    entries: [{ id: "entry-2", role: "user" }, { entryId: "entry-3", role: "assistant" }],
    leafId: "entry-3",
  });

  const result = await manager.reconnect(replacement);
  firstClient.emit({ type: "message_end", entryId: "stale-entry" });

  assert.deepEqual(replacement.commands, [{ type: "get_entries", since: "entry-1" }]);
  assert.equal(result?.requestedAfter, "entry-1");
  assert.equal(result?.entryCount, 2);
  assert.deepEqual(result?.entries, [
    { id: "entry-2", role: "user" },
    { entryId: "entry-3", role: "assistant" },
  ]);
  assert.equal(manager.state, "ready");
  assert.equal(manager.lastEntryId, "entry-3");
  // Stale events from the detached client must not move the durable cursor.
  assert.equal(manager.lastEntryId, "entry-3");
});

test("resume and synchronize use injectable command builders and keep Pi records raw", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ records: [{ id: "e2" }], cursor: "e2" });
  const manager = new SessionManager({
    client,
    sessionId: "session-2",
    lastEntryId: "e1",
    commands: {
      synchronize: (sessionId, cursor) => ({
        type: "session_sync",
        sessionId,
        cursor,
      }),
    },
  });

  const result = await manager.resume();

  assert.deepEqual(client.commands, [
    { type: "session_sync", sessionId: "session-2", cursor: "e1" },
  ]);
  assert.deepEqual(result.entries, []);
  assert.equal(manager.lastEntryId, "e2");
  assert.equal(manager.snapshot.lastError, null);
});

test("initial synchronization requests the full entry list without a since cursor", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ entries: [{ id: "e1" }], leafId: "e1" });
  const manager = new SessionManager({ client, sessionId: "session-6" });

  const result = await manager.resume();

  assert.deepEqual(client.commands, [{ type: "get_entries" }]);
  assert.equal(result?.requestedAfter, null);
  assert.deepEqual(result?.entries, [{ id: "e1" }]);
  assert.equal(result?.lastEntryId, "e1");
  assert.equal(manager.state, "ready");
  assert.equal(manager.lastEntryId, "e1");
});

test("fork sends only the authoritative entry id and close detaches without owning Pi shutdown", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({});
  const manager = new SessionManager({ client, sessionId: "session-3" });
  await manager.reconnect(client, { synchronize: false });

  const fork = await manager.fork("  fork-entry  ");
  assert.equal(fork.entryId, "fork-entry");
  assert.deepEqual(client.commands, [{ type: "fork", entryId: "fork-entry" }]);

  const closed = await manager.close();
  assert.equal(closed.state, "closed");
  assert.equal(manager.lastEntryId, null);
  assert.equal(manager.state, "closed");
});

test("a failed sync becomes recoverable and reconnect can continue from the same cursor", async () => {
  const failedClient = new FakePiRpcClient();
  failedClient.queueError("Pi process restarted");
  const manager = new SessionManager({
    client: failedClient,
    sessionId: "session-4",
    lastEntryId: "entry-9",
  });

  await assert.rejects(manager.synchronize(), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "RPC_FAILURE");
    return true;
  });
  assert.equal(manager.state, "disconnected");
  assert.equal(manager.lastEntryId, "entry-9");

  const recoveredClient = new FakePiRpcClient();
  recoveredClient.queueResponse({ entries: [{ id: "entry-10" }], leafId: "entry-10" });
  const result = await manager.reconnect(recoveredClient);

  assert.deepEqual(recoveredClient.commands, [{ type: "get_entries", since: "entry-9" }]);
  assert.equal(result?.lastEntryId, "entry-10");
  assert.equal(manager.state, "ready");
});

test("restore from a serializable snapshot does not require a live Pi process until reconnect", async () => {
  const restored = SessionManager.fromSnapshot({
    state: "disconnected",
    sessionId: "session-5",
    sessionFile: "/home/pi/.pi/agent/sessions/session-5",
    lastSeenEntryId: "entry-12",
    leafId: null,
    lastEntryId: "entry-12",
    lastError: "previous process exited",
  });

  assert.deepEqual(restored.snapshot, {
    state: "disconnected",
    sessionId: "session-5",
    sessionFile: "/home/pi/.pi/agent/sessions/session-5",
    lastSeenEntryId: "entry-12",
    leafId: null,
    lastEntryId: "entry-12",
    lastError: "previous process exited",
  });
  assert.equal(restored.sessionFile, "/home/pi/.pi/agent/sessions/session-5");
  await assert.rejects(restored.resume(), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "NO_CLIENT");
    return true;
  });

  const client = new FakePiRpcClient();
  client.queueResponse({ lastEntryId: "entry-13" });
  await restored.reconnect(client);
  assert.equal(restored.lastEntryId, "entry-13");
  assert.equal(restored.state, "ready");
});

test("openSession resumes a persisted session file with switch_session then get_state", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ sessionId: "pi-session-1" }); // switch_session
  client.queueResponse({
    sessionId: "pi-session-1",
    sessionFile: "/home/pi/.pi/agent/sessions/pi-session-1",
  }); // get_state
  const manager = new SessionManager({
    client,
    sessionId: "pi-session-1",
    sessionFile: "/home/pi/.pi/agent/sessions/pi-session-1",
    lastEntryId: "entry-9",
  });

  const opened = await manager.openSession("/home/pi/.pi/agent/sessions/pi-session-1");

  assert.deepEqual(client.commands, [
    { type: "switch_session", sessionPath: "/home/pi/.pi/agent/sessions/pi-session-1" },
    { type: "get_state" },
  ]);
  assert.equal(opened.resumed, true);
  assert.equal(opened.sessionId, "pi-session-1");
  assert.equal(opened.sessionFile, "/home/pi/.pi/agent/sessions/pi-session-1");
  assert.equal(opened.snapshot.state, "ready");
  assert.equal(manager.sessionFile, "/home/pi/.pi/agent/sessions/pi-session-1");
});

test("openSession without a persisted file creates a fresh session then reads state", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ sessionId: "pi-session-new" }); // new_session
  client.queueResponse({
    sessionId: "pi-session-new",
    sessionFile: "/home/pi/.pi/agent/sessions/pi-session-new",
  }); // get_state
  const manager = new SessionManager({ client });

  const opened = await manager.openSession(null);

  assert.deepEqual(client.commands, [{ type: "new_session" }, { type: "get_state" }]);
  assert.equal(opened.resumed, false);
  assert.equal(opened.sessionId, "pi-session-new");
  assert.equal(opened.sessionFile, "/home/pi/.pi/agent/sessions/pi-session-new");
  assert.equal(manager.state, "ready");
});

test("a cancelled switch_session degrades softly to new_session", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ cancelled: true }); // switch_session cancelled
  client.queueResponse({ sessionId: "pi-session-2" }); // new_session
  client.queueResponse({
    sessionId: "pi-session-2",
    sessionFile: "/sessions/pi-session-2",
  }); // get_state
  const manager = new SessionManager({ client });

  const opened = await manager.openSession("/sessions/old");

  assert.deepEqual(client.commands, [
    { type: "switch_session", sessionPath: "/sessions/old" },
    { type: "new_session" },
    { type: "get_state" },
  ]);
  assert.equal(opened.resumed, false);
  assert.equal(manager.state, "ready");
  assert.equal(manager.snapshot.lastError, null);
});

test("a failed switch_session degrades softly to new_session", async () => {
  const client = new FakePiRpcClient();
  client.queueError("session file is invalid"); // switch_session failure
  client.queueResponse({ sessionId: "pi-session-3" }); // new_session
  client.queueResponse({
    sessionId: "pi-session-3",
    sessionFile: "/sessions/pi-session-3",
  }); // get_state
  const manager = new SessionManager({ client });

  const opened = await manager.openSession("/sessions/invalid");

  assert.deepEqual(client.commands, [
    { type: "switch_session", sessionPath: "/sessions/invalid" },
    { type: "new_session" },
    { type: "get_state" },
  ]);
  assert.equal(opened.resumed, false);
  assert.equal(manager.state, "ready");
  assert.equal(manager.snapshot.lastError, null);
});
test("strict reconnect rejects a cancelled switch without creating a new session", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ cancelled: true });
  const manager = new SessionManager({
    client,
    sessionId: "pi-session-old",
    sessionFile: "/sessions/old",
    lastEntryId: "entry-old",
  });

  await assert.rejects(
    manager.openSession("/sessions/old", { force: true, fallbackToNewSession: false }),
    (error: unknown) => {
      assert.ok(error instanceof SessionManagerError);
      assert.equal(error.code, "SESSION_NOT_RESUMED");
      return true;
    },
  );
  assert.deepEqual(client.commands, [
    { type: "switch_session", sessionPath: "/sessions/old" },
  ]);
  assert.equal(manager.sessionId, "pi-session-old");
  assert.equal(manager.lastSeenEntryId, "entry-old");
});


test("a cancelled switch_session with a stale persisted cursor clears identity before fresh catch-up", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ cancelled: true }); // switch_session cancelled
  client.queueResponse({ sessionId: "pi-session-new" }); // new_session
  client.queueResponse({
    sessionId: "pi-session-new",
    sessionFile: "/sessions/pi-session-new",
  }); // get_state
  // Persisted manager state from a previous run: the stale session id, file,
  // and cursor must not leak into the fallback fresh session.
  const manager = new SessionManager({
    client,
    sessionId: "stale-session",
    sessionFile: "/sessions/stale",
    lastEntryId: "stale-entry-9",
  });

  const opened = await manager.openSession("/sessions/stale");

  assert.deepEqual(client.commands, [
    { type: "switch_session", sessionPath: "/sessions/stale" },
    { type: "new_session" },
    { type: "get_state" },
  ]);
  assert.equal(opened.resumed, false);
  // The fresh session adopts Pi's authoritative identity, not the stale one.
  assert.equal(manager.sessionId, "pi-session-new");
  assert.equal(manager.sessionFile, "/sessions/pi-session-new");
  // The stale cursor is cleared before the fresh-session catch-up.
  assert.equal(manager.lastEntryId, null);
  assert.equal(manager.state, "ready");

  // Catch-up for the fresh session is the full entry list, never a `since`
  // cursor borrowed from the abandoned persisted session.
  client.queueResponse({ entries: [{ id: "fresh-1" }], leafId: "fresh-1" });
  const synced = await manager.synchronize();

  assert.deepEqual(client.commands, [
    { type: "switch_session", sessionPath: "/sessions/stale" },
    { type: "new_session" },
    { type: "get_state" },
    { type: "get_entries" },
  ]);
  assert.equal(synced.requestedAfter, null);
  assert.equal(synced.lastEntryId, "fresh-1");
});

test("openSession fails when the new_session fallback also fails", async () => {
  const client = new FakePiRpcClient();
  client.queueError("switch rejected");
  client.queueError("new_session rejected");
  const manager = new SessionManager({ client, sessionFile: "/sessions/old" });

  await assert.rejects(manager.openSession("/sessions/old"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "RPC_FAILURE");
    return true;
  });
  assert.equal(manager.state, "failed");
});

test("get_state identity falls back from sessionFile to sessionId", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ sessionId: "pi-session-4" }); // new_session
  client.queueResponse({ sessionId: "pi-session-4" }); // get_state without sessionFile
  const manager = new SessionManager({ client });

  const opened = await manager.openSession(null);

  assert.equal(opened.resumed, false);
  assert.equal(opened.sessionId, "pi-session-4");
  assert.equal(opened.sessionFile, null);
  assert.equal(manager.sessionId, "pi-session-4");
});

test("openSession injectable commands build switch and state through the factory", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ sessionId: "custom-session" });
  client.queueResponse({ sessionId: "custom-session" });
  const commands: PiRpcCommand[] = [];
  const manager = new SessionManager({
    client,
    commands: {
      switchSession: (sessionFile) => {
        const command = { type: "session_resume", sessionFile };
        commands.push(command);
        return command;
      },
      getState: () => {
        const command = { type: "session_info" };
        commands.push(command);
        return command;
      },
    },
  });

  const opened = await manager.openSession("/sessions/custom");

  assert.deepEqual(commands, [
    { type: "session_resume", sessionFile: "/sessions/custom" },
    { type: "session_info" },
  ]);
  assert.equal(opened.resumed, true);
  assert.equal(opened.sessionId, "custom-session");
  assert.equal(manager.state, "ready");
});

test("openSession rejects malformed session files before issuing any command", async () => {
  const client = new FakePiRpcClient();
  const manager = new SessionManager({ client });
  const malformed = [
    "relative/path",
    "../etc/passwd",
    ".hidden",
    "..\\..\\windows\\evil",
    "C:\\Users\\pi\\sessions\\x",
    "/a\\b",
    "/a//b",
    "//etc/passwd",
    "/a/../b",
    "/a/./b",
    "/a/",
    "/a/\u0000b",
    "/a/\u0001b",
    "/a/\u007f",
  ];
  for (const path of malformed) {
    await assert.rejects(manager.openSession(path), TypeError);
  }
  // A malformed path never reached Pi and never wedged the handshake state.
  assert.deepEqual(client.commands, []);
  assert.equal(manager.state, "new");
});

test("a malformed persisted session file is rejected at construction", () => {
  assert.throws(() => new SessionManager({ sessionFile: "/a//b" }), TypeError);
  assert.throws(() => new SessionManager({ sessionFile: "/a/../b" }), TypeError);
  assert.throws(() => new SessionManager({ sessionFile: "/a/" }), TypeError);
  assert.throws(() => new SessionManager({ sessionFile: "..\\evil" }), TypeError);
  assert.throws(
    () =>
      SessionManager.fromSnapshot({
        state: "disconnected",
        sessionId: null,
        sessionFile: "/a/./b",
        lastSeenEntryId: null,
        leafId: null,
        lastEntryId: null,
        lastError: null,
      }),
    TypeError,
  );
});

test("synchronization keeps the append cursor distinct from the active leaf", async () => {
  const client = new FakePiRpcClient();
  // Pi's get_entries answers append-ordered entries plus the current active
  // leaf. The leaf pins the branch tip and may lag the append end, so it is
  // never the durable catch-up cursor: the append cursor is the last entry id
  // observed in append order.
  client.queueResponse({
    entries: [
      { id: "entry-1", role: "user" },
      { id: "entry-2", role: "assistant" },
    ],
    leafId: "entry-1",
  });
  const manager = new SessionManager({ client, sessionId: "session-7" });

  const result = await manager.resume();

  // The append cursor is the last entry id in append order...
  assert.equal(result.lastSeenEntryId, "entry-2");
  assert.equal(manager.lastSeenEntryId, "entry-2");
  assert.equal(manager.snapshot.lastSeenEntryId, "entry-2");
  // ...while leafId is the current active leaf, exposed separately.
  assert.equal(result.leafId, "entry-1");
  assert.equal(manager.leafId, "entry-1");
  assert.equal(manager.snapshot.leafId, "entry-1");

  // The next incremental request resumes from the append cursor, not the
  // active leaf, so no append-ordered record is skipped.
  client.queueResponse({ entries: [], leafId: "entry-2" });
  await manager.synchronize();

  assert.deepEqual(client.commands, [
    { type: "get_entries" },
    { type: "get_entries", since: "entry-2" },
  ]);
});
