import assert from "node:assert/strict";
import test from "node:test";

import type { PiThinkingLevel } from "../../../shared/ipc.ts";

import { PiRpcCommandError, PiRpcTransportError } from "../pi/errors.ts";
import {
  SessionManager,
  SessionManagerError,
  type JsonValue,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcSuccessResponse,
  type SessionPiRpcClient,
  type SessionSnapshot,
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

  /** Queue a pre-built failure (e.g. a PiRpcCommandError/TransportError). */
  queueFailure(error: Error): void {
    this.responses.push(error);
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
  client.queueResponse({
    sessionId: "pi-session-1",
    lastEntryId: "entry-0",
    // Even when the new_session acknowledgement carries agent-state-shaped
    // fields, they are never projected: get_state is the only authoritative
    // source for the selected model/thinking.
    model: { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
    thinkingLevel: "high",
  });
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
  // The snapshot carries identity/cursor data; the agent state stays null
  // because no get_state has been read yet.
  assert.equal(created.model, null);
  assert.equal(created.thinkingLevel, null);
  assert.deepEqual(Object.keys(manager.snapshot).sort(), [
    "lastEntryId",
    "lastError",
    "lastSeenEntryId",
    "leafId",
    "model",
    "sessionFile",
    "sessionId",
    "state",
    "thinkingLevel",
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

test("synchronize accepts an explicit since override while preserving the manager cursor", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ entries: [{ id: "entry-1" }, { id: "entry-2" }], leafId: "entry-2" });
  const manager = new SessionManager({
    client,
    sessionId: "session-8",
    lastEntryId: "entry-9",
  });

  // A cold start forces the full entry list (no `since` cursor) even though
  // the manager holds a durable cursor; the override never mutates the
  // in-memory cursor before the response.
  const result = await manager.synchronize({ since: null });

  assert.deepEqual(client.commands, [{ type: "get_entries" }]);
  assert.equal(result?.requestedAfter, null);
  assert.equal(result?.entryCount, 2);
  assert.equal(manager.lastEntryId, "entry-2");

  // The next request without an override stays incremental from the
  // (re-anchored) durable cursor.
  client.queueResponse({ entries: [{ id: "entry-3" }], leafId: "entry-3" });
  const incremental = await manager.synchronize();

  assert.deepEqual(client.commands, [
    { type: "get_entries" },
    { type: "get_entries", since: "entry-2" },
  ]);
  assert.equal(incremental?.requestedAfter, "entry-2");
  assert.equal(manager.lastEntryId, "entry-3");
});

test("synchronize with an explicit cursor override requests exactly that cursor", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ entries: [{ id: "entry-5" }], leafId: "entry-5" });
  const manager = new SessionManager({ client, sessionId: "session-9", lastEntryId: "entry-1" });

  const result = await manager.synchronize({ since: "entry-4" });

  assert.deepEqual(client.commands, [{ type: "get_entries", since: "entry-4" }]);
  assert.equal(result?.requestedAfter, "entry-4");
  assert.equal(manager.lastEntryId, "entry-5");
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

test("fork and close acknowledgements never project agent state from wrapper fields", async () => {
  const client = new FakePiRpcClient();
  // Agent-state-shaped fields on the fork and close acknowledgements must be
  // ignored: get_state is the only authoritative source for model/thinking.
  client.queueResponse({
    entryId: "fork-1",
    model: { id: "intruder-model", provider: "intruder" },
    thinkingLevel: "max",
  }); // fork
  client.queueResponse({
    cancelled: true,
    model: { id: "intruder-model", provider: "intruder" },
    thinkingLevel: "max",
  }); // close (abort)
  const manager = new SessionManager({
    client,
    sessionId: "session-3",
    commands: { close: () => ({ type: "abort" }) },
  });
  await manager.reconnect(client, { synchronize: false });

  const fork = await manager.fork("fork-1");
  assert.equal(fork.entryId, "fork-1");
  assert.equal(manager.model, null);
  assert.equal(manager.thinkingLevel, null);

  const closed = await manager.close();
  assert.equal(closed.state, "closed");
  assert.equal(manager.model, null);
  assert.equal(manager.thinkingLevel, null);
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

test("reconnect retries exactly once with full history when the since cursor is stale", async () => {
  const client = new FakePiRpcClient();
  // Pi rejects the incremental catch-up: the persisted cursor no longer
  // matches any entry id ("Entry not found: <cursor>").
  client.queueFailure(
    new PiRpcCommandError(1, "get_entries", {
      type: "response",
      id: 1,
      command: "get_entries",
      success: false,
      error: "Entry not found: stale-entry-9",
    }),
  );
  // The full-history retry (no `since` cursor) succeeds and re-anchors the
  // durable cursor and leaf from its entries.
  client.queueResponse({ entries: [{ id: "entry-10" }, { id: "entry-11" }], leafId: "entry-11" });
  const manager = new SessionManager({
    client,
    sessionId: "session-4",
    lastEntryId: "stale-entry-9",
  });

  const result = await manager.reconnect(client);

  assert.deepEqual(client.commands, [
    { type: "get_entries", since: "stale-entry-9" },
    { type: "get_entries" },
  ]);
  assert.equal(result?.entryCount, 2);
  // The successful replay was the full-history retry, so requestedAfter
  // reports null while previousLastEntryId preserves the stale cursor the
  // synchronization started from.
  assert.equal(result?.requestedAfter, null);
  assert.equal(result?.previousLastEntryId, "stale-entry-9");
  assert.equal(result?.lastSeenEntryId, "entry-11");
  assert.equal(result?.leafId, "entry-11");
  assert.equal(manager.lastSeenEntryId, "entry-11");
  assert.equal(manager.leafId, "entry-11");
  assert.equal(manager.state, "ready");
  assert.equal(manager.snapshot.lastError, null);
});

test("a stale-cursor retry that also fails surfaces the retry failure on the disconnected path", async () => {
  const client = new FakePiRpcClient();
  client.queueFailure(
    new PiRpcCommandError(1, "get_entries", {
      type: "response",
      id: 1,
      command: "get_entries",
      success: false,
      error: "Entry not found: stale-entry-9",
    }),
  );
  const retryFailure = new PiRpcTransportError("pi process exited", "process");
  client.queueFailure(retryFailure);
  const manager = new SessionManager({
    client,
    sessionId: "session-4",
    lastEntryId: "stale-entry-9",
  });

  await assert.rejects(manager.resume(), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "RPC_FAILURE");
    assert.ok(error.cause === retryFailure, "the retry's own failure is the surfaced cause");
    return true;
  });
  // Exactly one retry: the second command is the full-history request.
  assert.deepEqual(client.commands, [
    { type: "get_entries", since: "stale-entry-9" },
    { type: "get_entries" },
  ]);
  assert.equal(manager.state, "disconnected");
  assert.equal(
    manager.lastSeenEntryId,
    "stale-entry-9",
    "the durable cursor survives a failed retry unchanged",
  );
  assert.equal(manager.snapshot.lastError, "Session resume failed: pi process exited");
});

test("a transport failure during synchronization is never retried", async () => {
  const client = new FakePiRpcClient();
  const transportError = new PiRpcTransportError("pi process exited", "process");
  client.queueFailure(transportError);
  const manager = new SessionManager({
    client,
    sessionId: "session-4",
    lastEntryId: "stale-entry-9",
  });

  await assert.rejects(manager.synchronize(), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "RPC_FAILURE");
    assert.ok(error.cause === transportError);
    return true;
  });
  // A transport failure is not a cursor problem: exactly one command.
  assert.deepEqual(client.commands, [{ type: "get_entries", since: "stale-entry-9" }]);
  assert.equal(manager.state, "disconnected");
  assert.equal(manager.lastSeenEntryId, "stale-entry-9");
});

test("an unrelated get_entries command failure is never retried", async () => {
  const client = new FakePiRpcClient();
  // A genuine get_entries command failure whose text is not a stale-cursor
  // signal must not trigger the full-history retry.
  client.queueFailure(
    new PiRpcCommandError(1, "get_entries", {
      type: "response",
      id: 1,
      command: "get_entries",
      success: false,
      error: "session storage is corrupted",
    }),
  );
  const manager = new SessionManager({ client, sessionId: "session-4", lastEntryId: "entry-9" });

  await assert.rejects(manager.resume(), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "RPC_FAILURE");
    return true;
  });
  assert.deepEqual(client.commands, [{ type: "get_entries", since: "entry-9" }]);
  assert.equal(manager.state, "disconnected");
});

test("a full-history synchronization is never retried after a stale-looking failure", async () => {
  const client = new FakePiRpcClient();
  client.queueFailure(
    new PiRpcCommandError(1, "get_entries", {
      type: "response",
      id: 1,
      command: "get_entries",
      success: false,
      error: "Entry not found: ghost-entry",
    }),
  );
  const manager = new SessionManager({ client, sessionId: "session-4", lastEntryId: "entry-9" });

  await assert.rejects(manager.synchronize({ since: null }), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "RPC_FAILURE");
    return true;
  });
  // The first attempt was already the full entry list: no duplicate retry.
  assert.deepEqual(client.commands, [{ type: "get_entries" }]);
  assert.equal(manager.state, "disconnected");
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
    model: { id: "claude-sonnet-4-5", provider: "anthropic" },
    thinkingLevel: "medium",
  });

  assert.deepEqual(restored.snapshot, {
    state: "disconnected",
    sessionId: "session-5",
    sessionFile: "/home/pi/.pi/agent/sessions/session-5",
    lastSeenEntryId: "entry-12",
    leafId: null,
    lastEntryId: "entry-12",
    lastError: "previous process exited",
    model: { id: "claude-sonnet-4-5", provider: "anthropic" },
    thinkingLevel: "medium",
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
    // A resumed persisted session must report the authoritative agent state.
    model: { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
    thinkingLevel: "high",
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


test("a cancelled switch response never mutates identity or cursor metadata", async () => {
  const client = new FakePiRpcClient();
  // Pi declines the switch but the response still carries identity/cursor
  // fields; those must be treated as part of the cancellation signal, never
  // as authoritative metadata to adopt.
  client.queueResponse({ cancelled: true, sessionId: "intruder-session", lastEntryId: "intruder-entry" });
  const manager = new SessionManager({
    client,
    sessionId: "old-session",
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
  assert.deepEqual(client.commands, [{ type: "switch_session", sessionPath: "/sessions/old" }]);
  // The persisted identity, file, and durable cursor survive untouched: the
  // cancelled response is not applied before strict handling decides.
  assert.equal(manager.sessionId, "old-session");
  assert.equal(manager.sessionFile, "/sessions/old");
  assert.equal(manager.lastSeenEntryId, "entry-old");
  assert.equal(manager.lastEntryId, "entry-old");
  assert.equal(manager.leafId, null);
});

test("cancelled switch metadata does not leak into the fresh-session fallback", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({
    cancelled: true,
    sessionId: "stale-id",
    sessionFile: "/sessions/stale",
    lastEntryId: "stale-entry",
  });
  client.queueResponse({ sessionId: "fresh-session" });
  client.queueResponse({ sessionId: "fresh-session", sessionFile: "/sessions/fresh" });
  const manager = new SessionManager({
    client,
    sessionId: "old-session",
    sessionFile: "/sessions/old",
    lastEntryId: "entry-old",
  });

  const opened = await manager.openSession("/sessions/old");

  assert.equal(opened.resumed, false);
  // The fresh session adopts only the fallback identity; no field from the
  // cancelled switch response survives anywhere.
  assert.equal(manager.sessionId, "fresh-session");
  assert.equal(manager.sessionFile, "/sessions/fresh");
  assert.equal(manager.lastSeenEntryId, null);
  assert.equal(manager.leafId, null);
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
  client.queueResponse({ sessionId: "custom-session" }); // switch (session_resume)
  client.queueResponse({
    sessionId: "custom-session",
    // A resumed persisted session must report the authoritative agent state.
    model: { id: "custom-model", provider: "custom-provider" },
    thinkingLevel: "low",
  }); // get_state (session_info)
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
        model: null,
        thinkingLevel: null,
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

test("get_state projects the active model and thinking level into the session snapshot", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ sessionId: "pi-session-1" }); // new_session
  client.queueResponse({
    sessionId: "pi-session-1",
    sessionFile: "/home/pi/.pi/agent/sessions/pi-session-1",
    model: { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
    thinkingLevel: "high",
  }); // get_state
  const manager = new SessionManager({ client });

  const opened = await manager.openSession(null);

  assert.deepEqual(client.commands, [{ type: "new_session" }, { type: "get_state" }]);
  assert.equal(opened.resumed, false);
  assert.equal(opened.snapshot.state, "ready");
  // The get_state handshake response seeds the authoritative agent state —
  // never fabricated by the desktop shell.
  assert.deepEqual(opened.snapshot.model, {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    name: "Claude Sonnet 4.5",
  });
  assert.equal(opened.snapshot.thinkingLevel, "high");
  assert.equal(manager.model?.id, "claude-sonnet-4-5");
  assert.equal(manager.thinkingLevel, "high");
  assert.deepEqual(JSON.parse(JSON.stringify(opened.snapshot)), opened.snapshot);
});

test("get_state projection tolerates data-nested and session-nested keys plus snake_case levels", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ sessionId: "pi-session-1" }); // new_session
  // The level arrives snake_case inside `data.session`; the model arrives at
  // the data level directly. Both are authoritative get_state projections.
  client.queueResponse({
    sessionId: "pi-session-1",
    model: { id: "gpt-5", provider: "openai" },
    session: {
      model: { id: "stale-nested", provider: "stale" },
      thinking_level: "xhigh",
    },
  }); // get_state
  const manager = new SessionManager({ client });

  const opened = await manager.openSession(null);

  // The data-level model wins over the nested session copy; the snake_case
  // thinking_level is normalized to the shared PiThinkingLevel vocabulary.
  assert.deepEqual(opened.snapshot.model, { id: "gpt-5", provider: "openai" });
  assert.equal(opened.snapshot.thinkingLevel, "xhigh");
});

test("an explicit null model/thinking level resets previously projected agent state", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ sessionId: "pi-session-1" }); // new_session
  client.queueResponse({
    sessionId: "pi-session-1",
    model: null,
    thinkingLevel: null,
  }); // get_state
  // A restored manager holds stale agent state; the authoritative handshake
  // must replace it, not retain it.
  const manager = new SessionManager({
    client,
    model: { id: "stale-model", provider: "stale-provider" },
    thinkingLevel: "low",
  });

  const opened = await manager.openSession(null);

  assert.equal(opened.snapshot.model, null);
  assert.equal(opened.snapshot.thinkingLevel, null);
  assert.equal(manager.model, null);
  assert.equal(manager.thinkingLevel, null);
});

test("an unknown thinking level or malformed model projects null instead of fabricating state", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ sessionId: "pi-session-1" }); // new_session
  client.queueResponse({
    sessionId: "pi-session-1",
    thinkingLevel: "turbo",
    model: { id: "orphan-model" },
  }); // get_state: both values are outside the accepted projection
  const manager = new SessionManager({ client, thinkingLevel: "low" });

  const opened = await manager.openSession(null);

  // A level Pi does not recognize is reset (present but invalid), and a
  // model without a provider is dropped entirely — the shell never reports
  // fabricated agent state.
  assert.equal(opened.snapshot.thinkingLevel, null);
  assert.equal(opened.snapshot.model, null);
});

test("constructor validation rejects malformed model and unknown thinking levels", () => {
  assert.throws(
    () => new SessionManager({ model: { id: "m-1", provider: "" } }),
    /model requires non-empty id and provider strings/,
  );
  assert.throws(
    () => new SessionManager({ model: { id: "", provider: "anthropic" } }),
    /model requires non-empty id and provider strings/,
  );
  assert.throws(
    () =>
      new SessionManager({
        thinkingLevel: "turbo" as unknown as SessionManager["thinkingLevel"],
      }),
    /thinkingLevel must be one of/,
  );
});

test("restored snapshots keep the projected model and thinking level", async () => {
  const restored = SessionManager.fromSnapshot({
    state: "disconnected",
    sessionId: null,
    sessionFile: null,
    lastSeenEntryId: null,
    leafId: null,
    lastEntryId: null,
    lastError: null,
    model: { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
    thinkingLevel: "medium",
  });

  assert.deepEqual(restored.snapshot.model, {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    name: "Claude Sonnet 4.5",
  });
  assert.equal(restored.snapshot.thinkingLevel, "medium");
  assert.equal(restored.model?.provider, "anthropic");
  assert.equal(restored.thinkingLevel, "medium");
});

test("refreshState issues get_state, re-projects metadata, and emits exactly once", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({
    sessionId: "pi-session-1",
    sessionFile: "/sessions/pi-session-1",
    model: { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
    thinkingLevel: "high",
  });
  const manager = new SessionManager({ client, sessionId: "requested-session" });
  const snapshots: SessionSnapshot[] = [];
  manager.onStateChange((snapshot) => {
    snapshots.push(snapshot);
  });

  const snapshot = await manager.refreshState();

  assert.deepEqual(client.commands, [{ type: "get_state" }]);
  assert.equal(snapshot.state, "new", "refreshState never changes the lifecycle state");
  // The authoritative get_state replaced the stale requested identity and
  // seeded the projected agent state.
  assert.equal(snapshot.sessionId, "pi-session-1");
  assert.equal(snapshot.sessionFile, "/sessions/pi-session-1");
  assert.deepEqual(snapshot.model, {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    name: "Claude Sonnet 4.5",
  });
  assert.equal(snapshot.thinkingLevel, "high");
  // Exactly one snapshot emit per refresh.
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].sessionId, "pi-session-1");
  assert.equal(snapshots[0].thinkingLevel, "high");
});

test("refreshState rejects with a session failure when get_state fails", async () => {
  const client = new FakePiRpcClient();
  client.queueError("transport died");
  const manager = new SessionManager({ client, sessionId: "pi-session-1" });

  await assert.rejects(manager.refreshState(), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "RPC_FAILURE");
    return true;
  });
  assert.equal(manager.state, "disconnected");
});

test("refreshState rejects when an established session's get_state omits the cached model", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ sessionId: "pi-session-1" }); // get_state without the model
  const manager = new SessionManager({
    client,
    sessionId: "pi-session-1",
    model: { id: "claude-sonnet-4-5", provider: "anthropic" },
    thinkingLevel: "high",
  });

  await assert.rejects(manager.refreshState(), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  // The settle refresh never preserved the cached selection: the session is
  // marked disconnected instead of re-using stale agent state.
  assert.equal(manager.state, "disconnected");
});

test("a forced reconnect rejects when get_state omits an established session's cached agent state", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ sessionId: "pi-session-1" }); // switch_session
  client.queueResponse({ sessionId: "pi-session-1" }); // get_state without model/level
  const manager = new SessionManager({
    client,
    sessionId: "pi-session-1",
    sessionFile: "/sessions/pi-session-1",
    model: { id: "claude-sonnet-4-5", provider: "anthropic" },
    thinkingLevel: "high",
  });

  await assert.rejects(
    manager.openSession("/sessions/pi-session-1", { force: true }),
    (error: unknown) => {
      assert.ok(error instanceof SessionManagerError);
      assert.equal(error.code, "INVALID_RESPONSE");
      return true;
    },
  );
  assert.equal(manager.state, "failed");
});

test("a resumed persisted session rejects when get_state omits the authoritative agent state", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ sessionId: "pi-session-1" }); // switch_session
  client.queueResponse({ sessionId: "pi-session-1" }); // get_state without model/level
  // No cached agent state: the requirement comes purely from the successful
  // resume of a persisted session — a persisted session must report the
  // authoritative model and thinking level.
  const manager = new SessionManager({
    client,
    sessionId: "pi-session-1",
    sessionFile: "/sessions/pi-session-1",
  });

  await assert.rejects(
    manager.openSession("/sessions/pi-session-1"),
    (error: unknown) => {
      assert.ok(error instanceof SessionManagerError);
      assert.equal(error.code, "INVALID_RESPONSE");
      return true;
    },
  );
  assert.equal(manager.state, "failed");
});

test("getAvailableThinkingLevels issues the exact command and parses data.levels strictly", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ levels: ["off", "low", "max"] });
  const manager = new SessionManager({ client, sessionId: "pi-session-1" });

  const levels = await manager.getAvailableThinkingLevels();

  assert.deepEqual(client.commands, [{ type: "get_available_thinking_levels" }]);
  // Only what Pi reported — never the global enum.
  assert.deepEqual(levels, ["off", "low", "max"]);
});

test("getAvailableThinkingLevels rejects malformed payloads without failing the session", async () => {
  const client = new FakePiRpcClient();
  // Absent `levels` key is malformed.
  client.queueResponse({});
  const manager = new SessionManager({ client, sessionId: "pi-session-1" });

  await assert.rejects(manager.getAvailableThinkingLevels(), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  // A catalog failure never fails the session: the queue stays healthy.
  assert.equal(manager.state, "new");
  assert.equal(manager.snapshot.lastError, null);

  // An unknown level entry rejects the whole list.
  client.queueResponse({ levels: ["off", "turbo"] });
  await assert.rejects(manager.getAvailableThinkingLevels(), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });

  // Pi's live contract guarantees at least one level: an empty array is
  // malformed, never an authoritative empty list.
  client.queueResponse({ levels: [] });
  await assert.rejects(manager.getAvailableThinkingLevels(), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });

  // A bare array is not the documented `{levels: [...]}` shape.
  client.queueResponse(["off", "low"]);
  await assert.rejects(manager.getAvailableThinkingLevels(), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  assert.equal(manager.state, "new");
});

test("setModel issues set_model, refreshes get_state, and exposes the effective model", async () => {
  const client = new FakePiRpcClient();
  // set_model answers with the full Model object (Pi's documented contract)…
  client.queueResponse({
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    name: "Claude Sonnet 4.5",
  });
  // …and the authoritative get_state refresh confirms it (and re-reads the
  // effective thinking level).
  client.queueResponse({
    sessionId: "pi-session-1",
    sessionFile: "/sessions/pi-session-1",
    model: { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
    thinkingLevel: "high",
  });
  const manager = new SessionManager({ client });
  await manager.reconnect(client, { synchronize: false });
  const snapshots: SessionSnapshot[] = [];
  manager.onStateChange((snapshot) => {
    snapshots.push(snapshot);
  });

  const result = await manager.setModel("anthropic", "claude-sonnet-4-5");

  assert.deepEqual(client.commands.slice(-2), [
    { type: "set_model", provider: "anthropic", modelId: "claude-sonnet-4-5" },
    { type: "get_state" },
  ]);
  assert.deepEqual(result.model, {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    name: "Claude Sonnet 4.5",
  });
  assert.equal(result.snapshot.thinkingLevel, "high");
  assert.equal(manager.model?.id, "claude-sonnet-4-5");
  assert.equal(manager.thinkingLevel, "high");
  // Exactly one snapshot emit: the final authoritative refresh.
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].model?.id, "claude-sonnet-4-5");
});

test("setModel honors the authoritative get_state over the response echo", async () => {
  const client = new FakePiRpcClient();
  // A nested model echo is applied…
  client.queueResponse({ model: { id: "echoed-model", provider: "echoed-provider" } });
  // …but the get_state refresh is authoritative and wins.
  client.queueResponse({
    sessionId: "pi-session-1",
    model: { id: "gpt-5", provider: "openai" },
    thinkingLevel: "low",
  });
  const manager = new SessionManager({ client });
  await manager.reconnect(client, { synchronize: false });

  const result = await manager.setModel("anthropic", "claude-sonnet-4-5");

  assert.deepEqual(result.model, { id: "gpt-5", provider: "openai" });
  assert.equal(result.snapshot.thinkingLevel, "low");
  assert.equal(manager.model?.provider, "openai");
  assert.equal(manager.thinkingLevel, "low");
});

test("setModel rejects when Pi reports no effective model", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({}); // set_model bare acknowledgement
  client.queueResponse({ sessionId: "pi-session-1" }); // get_state without model
  const manager = new SessionManager({ client });
  await manager.reconnect(client, { synchronize: false });

  await assert.rejects(manager.setModel("anthropic", "claude-sonnet-4-5"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  // The failed mutation never fails the session.
  assert.equal(manager.state, "ready");
  assert.equal(manager.model, null);
});

test("setThinkingLevel issues set_thinking_level, refreshes get_state, and never falls back to the requested level", async () => {
  const client = new FakePiRpcClient();
  // set_thinking_level answers success-only with no effective payload.
  client.queueResponse({});
  // The authoritative get_state reports a different effective level than the
  // one requested; it must win.
  client.queueResponse({ sessionId: "pi-session-1", thinkingLevel: "low" });
  const manager = new SessionManager({ client });
  await manager.reconnect(client, { synchronize: false });

  const result = await manager.setThinkingLevel("high");

  assert.deepEqual(client.commands.slice(-2), [
    { type: "set_thinking_level", level: "high" },
    { type: "get_state" },
  ]);
  assert.equal(result.level, "low");
  assert.equal(result.snapshot.thinkingLevel, "low");
  assert.equal(manager.thinkingLevel, "low");
});

test("setThinkingLevel rejects when Pi reports no effective level", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({}); // success-only response
  client.queueResponse({ sessionId: "pi-session-1" }); // get_state without a level
  const manager = new SessionManager({ client });
  await manager.reconnect(client, { synchronize: false });

  await assert.rejects(manager.setThinkingLevel("high"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  assert.equal(manager.state, "ready");
  assert.equal(manager.thinkingLevel, null);
});

test("setModel rejects when the get_state refresh omits the model even though set_model echoed one", async () => {
  const client = new FakePiRpcClient();
  // The set_model response echoes a full model object…
  client.queueResponse({ id: "echoed-model", provider: "echoed-provider" });
  // …but the authoritative get_state refresh omits the model entirely; the
  // echo must never stand in for the effective state.
  client.queueResponse({ sessionId: "pi-session-1", thinkingLevel: "high" });
  const manager = new SessionManager({ client });
  await manager.reconnect(client, { synchronize: false });

  await assert.rejects(manager.setModel("anthropic", "claude-sonnet-4-5"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  assert.equal(manager.state, "ready");
  // The rejected refresh applied nothing: neither the echoed model nor the
  // response's thinking level is partially confirmed without the model.
  assert.equal(manager.model, null);
  assert.equal(manager.thinkingLevel, null);
});

test("setModel rejects when the get_state refresh omits the thinking level", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ id: "gpt-5", provider: "openai" }); // set_model
  client.queueResponse({
    sessionId: "pi-session-1",
    model: { id: "gpt-5", provider: "openai" },
  }); // get_state without Pi's required thinkingLevel field
  const manager = new SessionManager({ client });
  await manager.reconnect(client, { synchronize: false });

  await assert.rejects(manager.setModel("openai", "gpt-5"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  assert.equal(manager.state, "ready");
  // The rejected refresh applied nothing: the response's model is not
  // partially confirmed without its required thinking level, so no
  // unconfirmed model/thinking leaks into the manager.
  assert.equal(manager.model, null);
  assert.equal(manager.thinkingLevel, null);
});

test("setModel with preexisting state clears the accepted-but-unconfirmed selection when the refresh omits the model", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ id: "echoed-model", provider: "echoed" }); // set_model
  client.queueResponse({ sessionId: "pi-session-1" }); // get_state: no model, no level
  const snapshots: SessionSnapshot[] = [];
  const manager = new SessionManager({
    client,
    model: { id: "stale-model", provider: "stale" },
    thinkingLevel: "low",
  });
  await manager.reconnect(client, { synchronize: false });
  manager.onStateChange((snapshot) => {
    snapshots.push(snapshot);
  });

  await assert.rejects(manager.setModel("anthropic", "claude-sonnet-4-5"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  // Pi accepted set_model but the authoritative refresh could not confirm
  // it: the accepted-but-unconfirmed selection is cleared — the stale cached
  // model and level never survive an unconfirmed mutation. The reset is
  // published as an explicit snapshot.
  assert.equal(manager.state, "ready");
  assert.equal(manager.model, null);
  assert.equal(manager.thinkingLevel, null);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].model, null);
  assert.equal(snapshots[0].thinkingLevel, null);
});

test("setThinkingLevel with preexisting state clears the accepted-but-unconfirmed level when the refresh omits it", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({}); // success-only response
  client.queueResponse({ sessionId: "pi-session-1" }); // get_state without a level
  const manager = new SessionManager({
    client,
    model: { id: "claude-sonnet-4-5", provider: "anthropic" },
    thinkingLevel: "medium",
  });
  await manager.reconnect(client, { synchronize: false });

  await assert.rejects(manager.setThinkingLevel("high"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "INVALID_RESPONSE");
    return true;
  });
  assert.equal(manager.state, "ready");
  // The requested level is never a fallback and the accepted-but-unconfirmed
  // cached level is cleared; the model (not part of this mutation) is
  // preserved.
  assert.equal(manager.thinkingLevel, null);
  assert.deepEqual(manager.model, { id: "claude-sonnet-4-5", provider: "anthropic" });
});

test("setModel clears the accepted-but-unconfirmed selection when the get_state readback transport-fails", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ id: "gpt-5", provider: "openai" }); // set_model accepted
  client.queueError("transport died"); // get_state readback transport failure
  const snapshots: SessionSnapshot[] = [];
  const manager = new SessionManager({
    client,
    model: { id: "claude-sonnet-4-5", provider: "anthropic" },
    thinkingLevel: "low",
  });
  await manager.reconnect(client, { synchronize: false });
  manager.onStateChange((snapshot) => {
    snapshots.push(snapshot);
  });

  await assert.rejects(manager.setModel("openai", "gpt-5"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "RPC_FAILURE");
    return true;
  });
  // Pi accepted set_model but the readback could not confirm it: no stale
  // cached selection survives the unconfirmed mutation — the model and the
  // model-specific level are both cleared and the reset is published.
  assert.equal(manager.state, "ready");
  assert.equal(manager.model, null);
  assert.equal(manager.thinkingLevel, null);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].model, null);
  assert.equal(snapshots[0].thinkingLevel, null);
});

test("setThinkingLevel clears the accepted-but-unconfirmed level while preserving the model when the readback transport-fails", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({}); // set_thinking_level accepted (success-only)
  client.queueError("transport died"); // get_state readback transport failure
  const manager = new SessionManager({
    client,
    model: { id: "claude-sonnet-4-5", provider: "anthropic" },
    thinkingLevel: "low",
  });
  await manager.reconnect(client, { synchronize: false });

  await assert.rejects(manager.setThinkingLevel("high"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "RPC_FAILURE");
    return true;
  });
  // The unconfirmed level is cleared; the model (not part of this mutation)
  // is preserved.
  assert.equal(manager.state, "ready");
  assert.equal(manager.thinkingLevel, null);
  assert.deepEqual(manager.model, { id: "claude-sonnet-4-5", provider: "anthropic" });
});

test("set commands rejected before acceptance preserve the previous selected state", async () => {
  const client = new FakePiRpcClient();
  client.queueError("set_model rejected"); // Pi never accepted the command
  const manager = new SessionManager({
    client,
    model: { id: "claude-sonnet-4-5", provider: "anthropic" },
    thinkingLevel: "low",
  });
  await manager.reconnect(client, { synchronize: false });

  await assert.rejects(manager.setModel("openai", "gpt-5"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "RPC_FAILURE");
    return true;
  });
  // No acceptance, no clearing: the previous selection is preserved.
  assert.equal(manager.state, "ready");
  assert.deepEqual(manager.model, { id: "claude-sonnet-4-5", provider: "anthropic" });
  assert.equal(manager.thinkingLevel, "low");

  client.queueError("set_thinking_level rejected"); // Pi never accepted the command
  await assert.rejects(manager.setThinkingLevel("high"), (error: unknown) => {
    assert.ok(error instanceof SessionManagerError);
    assert.equal(error.code, "RPC_FAILURE");
    return true;
  });
  assert.equal(manager.state, "ready");
  assert.deepEqual(manager.model, { id: "claude-sonnet-4-5", provider: "anthropic" });
  assert.equal(manager.thinkingLevel, "low");
});

test("the setModel result snapshot reflects the compatible display-name enrichment", async () => {
  const client = new FakePiRpcClient();
  // The set_model response carries the full model object including the
  // display name…
  client.queueResponse({ id: "gpt-5", provider: "openai", name: "GPT-5" });
  // …and the authoritative get_state confirms the SAME identity without the
  // optional name; the compatible display metadata survives.
  client.queueResponse({
    sessionId: "pi-session-1",
    model: { id: "gpt-5", provider: "openai" },
    thinkingLevel: "low",
  });
  const manager = new SessionManager({ client });
  await manager.reconnect(client, { synchronize: false });

  const result = await manager.setModel("openai", "gpt-5");

  // The result snapshot is taken after the enrichment: it reflects the same
  // effective model the result exposes — never the pre-enrichment refresh.
  assert.deepEqual(result.model, { id: "gpt-5", provider: "openai", name: "GPT-5" });
  assert.deepEqual(result.snapshot.model, { id: "gpt-5", provider: "openai", name: "GPT-5" });
  assert.deepEqual(manager.model, { id: "gpt-5", provider: "openai", name: "GPT-5" });
  assert.equal(result.snapshot.thinkingLevel, "low");
});

test("setModel preserves the compatible display name from the set_model response when get_state omits it", async () => {
  const client = new FakePiRpcClient();
  // The set_model response carries the full model object including the
  // display name…
  client.queueResponse({ id: "gpt-5", provider: "openai", name: "GPT-5" });
  // …and the authoritative get_state confirms the SAME identity without the
  // optional name; the compatible display metadata survives.
  client.queueResponse({
    sessionId: "pi-session-1",
    model: { id: "gpt-5", provider: "openai" },
    thinkingLevel: "low",
  });
  const manager = new SessionManager({ client });
  await manager.reconnect(client, { synchronize: false });

  const result = await manager.setModel("openai", "gpt-5");

  // The identity and effective level come from get_state; the name is the
  // compatible echo enrichment.
  assert.deepEqual(result.model, { id: "gpt-5", provider: "openai", name: "GPT-5" });
  assert.equal(result.snapshot.thinkingLevel, "low");
  assert.deepEqual(manager.model, { id: "gpt-5", provider: "openai", name: "GPT-5" });
});

test("setModel never uses the echoed name when get_state reports a different identity", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ id: "echoed-model", provider: "echoed-provider", name: "Echoed" });
  client.queueResponse({
    sessionId: "pi-session-1",
    model: { id: "gpt-5", provider: "openai" },
    thinkingLevel: "medium",
  });
  const manager = new SessionManager({ client });
  await manager.reconnect(client, { synchronize: false });

  const result = await manager.setModel("openai", "gpt-5");

  // get_state identity/effective values are authoritative: the echo's name
  // never attaches to a different model.
  assert.deepEqual(result.model, { id: "gpt-5", provider: "openai" });
  assert.deepEqual(manager.model, { id: "gpt-5", provider: "openai" });
});

test("a later get_state keeps the preserved display name for the same identity", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ id: "gpt-5", provider: "openai", name: "GPT-5" }); // set_model
  client.queueResponse({
    sessionId: "pi-session-1",
    model: { id: "gpt-5", provider: "openai" },
    thinkingLevel: "low",
  }); // get_state refresh without the name
  const manager = new SessionManager({ client });
  await manager.reconnect(client, { synchronize: false });
  await manager.setModel("openai", "gpt-5");

  // A settle-style refresh re-reporting the same identity without the name
  // keeps the compatible display name; a different identity or an explicit
  // null would replace it.
  client.queueResponse({
    sessionId: "pi-session-1",
    model: { id: "gpt-5", provider: "openai" },
    thinkingLevel: "low",
  });
  const snapshot = await manager.refreshState();

  assert.deepEqual(snapshot.model, { id: "gpt-5", provider: "openai", name: "GPT-5" });
  assert.equal(snapshot.thinkingLevel, "low");
});

test("setModel ignores identity and cursor fields on the set_model response", async () => {
  const client = new FakePiRpcClient();
  // The set_model response carries intruder identity/cursor/model fields…
  client.queueResponse({
    sessionId: "intruder-session",
    lastEntryId: "intruder-entry",
    model: { id: "echoed", provider: "echoed" },
  });
  // …and the authoritative get_state refresh owns identity and agent state.
  client.queueResponse({
    sessionId: "pi-session-1",
    model: { id: "gpt-5", provider: "openai" },
    thinkingLevel: "low",
  });
  const manager = new SessionManager({
    client,
    sessionId: "pi-session-1",
    lastEntryId: "entry-1",
  });
  await manager.reconnect(client, { synchronize: false });

  const result = await manager.setModel("openai", "gpt-5");

  // Identity/cursor from the mutation response never poisoned the manager.
  assert.equal(manager.sessionId, "pi-session-1");
  assert.equal(manager.lastSeenEntryId, "entry-1");
  assert.deepEqual(result.model, { id: "gpt-5", provider: "openai" });
  assert.equal(result.snapshot.thinkingLevel, "low");
});

test("setThinkingLevel ignores identity and cursor fields on the success-only response", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ sessionId: "intruder-session", lastEntryId: "intruder-entry" });
  client.queueResponse({ sessionId: "pi-session-1", thinkingLevel: "max" });
  const manager = new SessionManager({
    client,
    sessionId: "pi-session-1",
    lastEntryId: "entry-1",
  });
  await manager.reconnect(client, { synchronize: false });

  const result = await manager.setThinkingLevel("high");

  assert.equal(manager.sessionId, "pi-session-1");
  assert.equal(manager.lastSeenEntryId, "entry-1");
  assert.equal(result.level, "max");
  assert.equal(result.snapshot.thinkingLevel, "max");
});

test("synchronization never overwrites the projected agent state from get_entries wrapper fields", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({
    entries: [{ id: "entry-1" }],
    leafId: "entry-1",
    // Arbitrary wrapper fields that must never touch the selected agent
    // state: get_state is the only authoritative source for model/thinking.
    model: { id: "intruder-model", provider: "intruder" },
    thinkingLevel: "max",
  });
  const manager = new SessionManager({
    client,
    sessionId: "session-10",
    model: { id: "selected-model", provider: "anthropic" },
    thinkingLevel: "low",
  });

  const result = await manager.resume();

  assert.equal(result.lastSeenEntryId, "entry-1");
  assert.equal(manager.lastSeenEntryId, "entry-1");
  assert.deepEqual(manager.model, { id: "selected-model", provider: "anthropic" });
  assert.equal(manager.thinkingLevel, "low");
});

test("setModel then synchronize preserves the selected model and thinking level", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ id: "claude-sonnet-4-5", provider: "anthropic" }); // set_model
  client.queueResponse({
    sessionId: "pi-session-1",
    model: { id: "claude-sonnet-4-5", provider: "anthropic" },
    thinkingLevel: "high",
  }); // get_state refresh
  client.queueResponse({ entries: [{ id: "entry-1" }], leafId: "entry-1" }); // get_entries
  const manager = new SessionManager({ client });
  await manager.reconnect(client, { synchronize: false });

  await manager.setModel("anthropic", "claude-sonnet-4-5");
  assert.equal(manager.model?.id, "claude-sonnet-4-5");
  assert.equal(manager.thinkingLevel, "high");

  // The settle synchronization (get_entries) must not regress the selected
  // model/thinking: Pi stays authoritative and the manager keeps the values
  // it projected from get_state.
  const synced = await manager.synchronize();
  assert.equal(synced.lastSeenEntryId, "entry-1");
  assert.equal(manager.model?.id, "claude-sonnet-4-5");
  assert.equal(manager.thinkingLevel, "high");
});

test("setModel and setThinkingLevel validate inputs before issuing commands", async () => {
  const client = new FakePiRpcClient();
  const manager = new SessionManager({ client });
  await manager.reconnect(client, { synchronize: false });

  await assert.rejects(manager.setModel("", "m"), /provider must be a non-empty string/);
  await assert.rejects(manager.setModel("anthropic", "   "), /modelId must be a non-empty string/);
  await assert.rejects(
    manager.setThinkingLevel("turbo" as unknown as PiThinkingLevel),
    /thinkingLevel must be one of/,
  );
  // No rejected payload ever became a Pi command.
  assert.deepEqual(client.commands, []);
});

test("mutation and catalog commands are injectable through the factory", async () => {
  const client = new FakePiRpcClient();
  client.queueResponse({ levels: ["off"] }); // getAvailableThinkingLevels
  client.queueResponse({ id: "custom-model", provider: "custom" }); // set_model
  client.queueResponse({
    sessionId: "custom-session",
    model: { id: "custom-model", provider: "custom" },
    thinkingLevel: "low",
  }); // get_state refresh
  client.queueResponse({}); // set_thinking_level
  client.queueResponse({ sessionId: "custom-session", thinkingLevel: "max" }); // get_state refresh
  const commands: PiRpcCommand[] = [];
  const manager = new SessionManager({
    client,
    commands: {
      getAvailableThinkingLevels: () => {
        const command = { type: "thinking_levels" };
        commands.push(command);
        return command;
      },
      setModel: (provider, modelId) => {
        const command = { type: "model_switch", provider, modelId };
        commands.push(command);
        return command;
      },
      setThinkingLevel: (level) => {
        const command = { type: "level_switch", level };
        commands.push(command);
        return command;
      },
    },
  });
  await manager.reconnect(client, { synchronize: false });

  const levels = await manager.getAvailableThinkingLevels();
  assert.deepEqual(levels, ["off"]);

  const modelResult = await manager.setModel("p", "m");
  assert.equal(modelResult.model.id, "custom-model");

  const levelResult = await manager.setThinkingLevel("low");
  assert.equal(levelResult.level, "max");

  assert.deepEqual(commands, [
    { type: "thinking_levels" },
    { type: "model_switch", provider: "p", modelId: "m" },
    { type: "level_switch", level: "low" },
  ]);
});
