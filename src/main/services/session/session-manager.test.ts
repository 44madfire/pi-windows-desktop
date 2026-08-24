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
  client.emit({ type: "message_end", entryId: "entry-1" });

  assert.deepEqual(client.commands, [{ type: "new_session" }]);
  assert.deepEqual(states, ["creating", "ready", "ready"]);
  assert.equal(created.state, "ready");
  assert.equal(created.sessionId, "pi-session-1");
  assert.equal(manager.lastEntryId, "entry-1");
  assert.deepEqual(Object.keys(manager.snapshot).sort(), [
    "lastEntryId",
    "lastError",
    "sessionId",
    "state",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(manager.snapshot)), manager.snapshot);
});

test("reconnect replays records after the persisted cursor through a replacement client", async () => {
  const firstClient = new FakePiRpcClient();
  const manager = new SessionManager({
    client: firstClient,
    sessionId: "session-1",
    lastEntryId: "entry-1",
  });

  const replacement = new FakePiRpcClient();
  replacement.queueResponse({
    entries: [{ id: "entry-2", role: "user" }, { entryId: "entry-3", role: "assistant" }],
    lastEntryId: "entry-3",
  });

  const result = await manager.reconnect(replacement);
  firstClient.emit({ type: "message_end", entryId: "stale-entry" });

  assert.deepEqual(replacement.commands, [{ type: "get_messages", after: "entry-1" }]);
  assert.equal(result?.requestedAfter, "entry-1");
  assert.equal(result?.entryCount, 2);
  assert.deepEqual(result?.entries, [
    { id: "entry-2", role: "user" },
    { entryId: "entry-3", role: "assistant" },
  ]);
  assert.equal(manager.state, "ready");
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
  recoveredClient.queueResponse({ entries: [{ id: "entry-10" }] });
  const result = await manager.reconnect(recoveredClient);

  assert.deepEqual(recoveredClient.commands, [{ type: "get_messages", after: "entry-9" }]);
  assert.equal(result?.lastEntryId, "entry-10");
  assert.equal(manager.state, "ready");
});

test("restore from a serializable snapshot does not require a live Pi process until reconnect", async () => {
  const restored = SessionManager.fromSnapshot({
    state: "disconnected",
    sessionId: "session-5",
    lastEntryId: "entry-12",
    lastError: "previous process exited",
  });

  assert.deepEqual(restored.snapshot, {
    state: "disconnected",
    sessionId: "session-5",
    lastEntryId: "entry-12",
    lastError: "previous process exited",
  });
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
