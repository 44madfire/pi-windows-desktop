import assert from "node:assert/strict";
import test from "node:test";

import {
  PiJsonlBuffer,
  PiRpcClient,
  PiRpcClosedError,
  PiRpcCommandError,
  PiRpcProtocolError,
  PiRpcTimeoutError,
  PiRpcTransportError,
} from "../index.ts";

class FakeReadable {
  listeners = {
    data: [],
    end: [],
    error: [],
  };

  on(event, listener) {
    this.listeners[event].push(listener);
    return this;
  }

  emitData(chunk) {
    for (const listener of this.listeners.data) listener(chunk);
  }

  emitEnd() {
    for (const listener of this.listeners.end) listener();
  }

  emitError(error) {
    for (const listener of this.listeners.error) listener(error);
  }
}

class FakeWritable {
  writes = [];
  listeners = { error: [] };
  ended = false;
  writeResult = true;
  writeHandler = undefined;
  endHandler = undefined;

  constructor(timeline = []) {
    this.timeline = timeline;
  }

  on(event, listener) {
    this.listeners[event].push(listener);
    return this;
  }

  write(chunk) {
    this.writes.push(chunk);
    this.timeline.push({ seq: this.timeline.length, op: `write:${chunk}` });
    this.writeHandler?.(chunk);
    return this.writeResult;
  }

  end() {
    this.ended = true;
    this.timeline.push({ seq: this.timeline.length, op: "end" });
    this.endHandler?.();
  }

  emitError(error) {
    for (const listener of this.listeners.error) listener(error);
  }
}

class FakeTransport {
  timeline = [];
  stdin = new FakeWritable(this.timeline);
  stdout = new FakeReadable();
  stderr = new FakeReadable();
  listeners = { error: [], exit: [], close: [] };
  killSignals = [];

  on(event, listener) {
    this.listeners[event].push(listener);
    return this;
  }

  kill(signal = "SIGTERM") {
    this.killSignals.push(signal);
    this.timeline.push({ seq: this.timeline.length, op: `kill:${signal}` });
    return true;
  }

  emitError(error) {
    for (const listener of this.listeners.error) listener(error);
  }

  emitExit(code = 0, signal = null) {
    for (const listener of this.listeners.exit) listener(code, signal);
  }

  emitClose(code = 0, signal = null) {
    for (const listener of this.listeners.close) listener(code, signal);
  }
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

const waitFor = async (predicate, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

function responseFor(transport, index, data = {}) {
  const command = JSON.parse(transport.stdin.writes[index]);
  return JSON.stringify({
    type: "response",
    id: command.id,
    command: command.type,
    success: true,
    data,
  });
}

test("PiJsonlBuffer handles partial and multiple LF records without splitting Unicode separators", () => {
  const buffer = new PiJsonlBuffer();
  assert.deepEqual(buffer.push('{"type":"event","text":"first"}\n{"type":"event"'), [
    '{"type":"event","text":"first"}',
  ]);
  assert.deepEqual(buffer.push(' ,"text":"a\u2028b"}\r\n'), [
    '{"type":"event" ,"text":"a\u2028b"}',
  ]);
  assert.equal(buffer.finish(), undefined);
});

test("correlates out-of-order responses and dispatches stdout events asynchronously", async () => {
  const transport = new FakeTransport();
  const client = new PiRpcClient(() => transport, { defaultTimeoutMs: 100 });
  const events = [];
  client.onEvent((event) => events.push(event));
  await client.connect();

  const first = client.send({ type: "first" });
  const second = client.send({ type: "second" });

  const firstId = JSON.parse(transport.stdin.writes[0]).id;
  const secondId = JSON.parse(transport.stdin.writes[1]).id;
  transport.stdout.emitData(
    `${JSON.stringify({ type: "response", id: secondId, command: "second", success: true, data: { order: 2 } })}\n` +
      `${JSON.stringify({ type: "message_update", delta: "a\u2028b"})}\n` +
      `${JSON.stringify({ type: "response", id: firstId, command: "first", success: true, data: { order: 1 } })}\n`,
  );

  assert.deepEqual(events, []);
  assert.deepEqual((await second).data, { order: 2 });
  assert.deepEqual((await first).data, { order: 1 });
  await flushMicrotasks();
  assert.deepEqual(events, [{ type: "message_update", delta: "a\u2028b" }]);
});

test("keeps stderr out of the JSONL protocol and exposes it separately", async () => {
  const transport = new FakeTransport();
  const client = new PiRpcClient({ transportFactory: () => transport, defaultTimeoutMs: 100 });
  const events = [];
  const stderrChunks = [];
  client.onEvent((event) => events.push(event));
  client.onStderr((chunk) => stderrChunks.push(chunk));
  await client.connect();

  const pending = client.send({ type: "get_state" });
  transport.stderr.emitData("diagnostic: not JSON\n");
  assert.deepEqual(stderrChunks, []);
  transport.stdout.emitData(`${responseFor(transport, 0, { ready: true })}\n`);
  const response = await pending;

  assert.deepEqual(response.data, { ready: true });
  assert.equal(client.getStderr(), "diagnostic: not JSON\n");
  assert.deepEqual(events, []);
  await flushMicrotasks();
  assert.deepEqual(stderrChunks, ["diagnostic: not JSON\n"]);
});

test("rejects command errors and request timeouts with typed errors", async () => {
  const transport = new FakeTransport();
  const client = new PiRpcClient(() => transport, { defaultTimeoutMs: 10 });
  await client.connect();

  const failed = client.send({ type: "bad_command" });
  const failedId = JSON.parse(transport.stdin.writes[0]).id;
  transport.stdout.emitData(
    `${JSON.stringify({
      type: "response",
      id: failedId,
      command: "bad_command",
      success: false,
      error: "rejected",
    })}\n`,
  );
  await assert.rejects(failed, (error) => {
    assert.ok(error instanceof PiRpcCommandError);
    assert.equal(error.message, `Pi RPC command bad_command (${failedId}) failed: rejected`);
    return true;
  });

  const timedOut = client.send({ type: "slow_command" });
  await assert.rejects(timedOut, (error) => {
    assert.ok(error instanceof PiRpcTimeoutError);
    assert.equal(error.command, "slow_command");
    return true;
  });
  assert.equal(client.state, "ready");
});

test("reports malformed or unterminated stdout and rejects pending work", async () => {
  const transport = new FakeTransport();
  const client = new PiRpcClient(() => transport, { defaultTimeoutMs: 100 });
  const protocolErrors = [];
  client.onProtocolError((error) => protocolErrors.push(error));
  await client.connect();

  const pending = client.send({ type: "needs_protocol" });
  transport.stdout.emitData("not-json\n");

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof PiRpcProtocolError);
    assert.equal(error.code, "PROTOCOL_ERROR");
    return true;
  });
  await flushMicrotasks();
  assert.equal(protocolErrors.length, 1);
  assert.match(protocolErrors[0].message, /Invalid JSONL record/);
  assert.ok(transport.killSignals.includes("SIGTERM"));

  const secondTransport = new FakeTransport();
  const secondClient = new PiRpcClient(() => secondTransport, { defaultTimeoutMs: 100 });
  await secondClient.connect();
  const secondPending = secondClient.send({ type: "partial" });
  secondTransport.stdout.emitData('{"type":"response"');
  secondTransport.stdout.emitEnd();
  await assert.rejects(secondPending, PiRpcProtocolError);
});

test("rejects pending work on process failure and reconnects through the factory seam", async () => {
  const firstTransport = new FakeTransport();
  const secondTransport = new FakeTransport();
  const transports = [firstTransport, secondTransport];
  const client = new PiRpcClient(
    { transportFactory: { create: () => transports.shift() } },
  );
  await client.connect();

  const pending = client.send({ type: "before_crash" });
  firstTransport.emitError(new Error("Pi crashed"));
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof PiRpcTransportError);
    assert.equal(error.source, "process");
    return true;
  });
  assert.equal(client.state, "disconnected");

  await client.reconnect();
  assert.equal(client.state, "ready");
  const recovered = client.send({ type: "after_reconnect" });
  secondTransport.stdout.emitData(`${responseFor(secondTransport, 0, { recovered: true })}\n`);
  assert.deepEqual((await recovered).data, { recovered: true });
});

test("a disconnected client rejects requests without invoking the transport factory", async () => {
  const firstTransport = new FakeTransport();
  const secondTransport = new FakeTransport();
  const transports = [firstTransport, secondTransport];
  const createdTransports = [];
  const client = new PiRpcClient({
    transportFactory: {
      create: () => {
        const transport = transports.shift();
        createdTransports.push(transport);
        return transport;
      },
    },
    defaultTimeoutMs: 100,
  });
  await client.connect();
  assert.equal(createdTransports.length, 1);

  // The established transport exits mid-session; the client is left
  // disconnected with no active transport.
  firstTransport.emitExit(1, "SIGTERM");
  assert.equal(client.state, "disconnected");

  // A request on a disconnected client must reject instead of silently
  // spawning a replacement transport behind the caller's back: the caller
  // owns recovery, so no factory invocation may happen here.
  await assert.rejects(client.send({ type: "get_state" }), (error) => {
    assert.ok(error instanceof PiRpcTransportError);
    return true;
  });
  assert.equal(createdTransports.length, 1, "the transport factory must not be invoked");
  assert.equal(client.state, "disconnected");
});

test("connect() from disconnected rejects; only explicit reconnect() replaces the transport", async () => {
  const firstTransport = new FakeTransport();
  const secondTransport = new FakeTransport();
  const transports = [firstTransport, secondTransport];
  const createdTransports = [];
  const client = new PiRpcClient({
    transportFactory: {
      create: () => {
        const transport = transports.shift();
        createdTransports.push(transport);
        return transport;
      },
    },
  });
  await client.connect();
  assert.equal(createdTransports.length, 1);

  firstTransport.emitExit(1, "SIGTERM");
  assert.equal(client.state, "disconnected");

  // Auto-connect is only allowed from idle: calling connect() on a
  // disconnected client rejects without spawning a replacement transport.
  await assert.rejects(client.connect(), (error) => {
    assert.ok(error instanceof PiRpcTransportError);
    assert.equal(error.source, "process");
    return true;
  });
  assert.equal(createdTransports.length, 1, "the transport factory must not be invoked");
  assert.equal(client.state, "disconnected");

  // Explicit reconnect() is the only seam that replaces the transport.
  await client.reconnect();
  assert.equal(client.state, "ready");
  assert.equal(createdTransports.length, 2);
});

test("close ends stdin first, then escalates to SIGTERM and finally SIGKILL", async () => {
  const transport = new FakeTransport();
  const client = new PiRpcClient(() => transport, {
    closeTimeoutMs: 5,
    sigkillTimeoutMs: 5,
    defaultTimeoutMs: 100,
  });
  await client.connect();
  const pending = client.send({ type: "during_close" });

  const closing = client.close();

  // Pending work is rejected immediately, but no signal is sent yet: the
  // process gets a bounded window to exit on its own after stdin EOF.
  await assert.rejects(pending, PiRpcClosedError);
  assert.equal(transport.stdin.ended, true);
  assert.deepEqual(transport.killSignals, []);

  // After the grace period the escalation signal fires first...
  await waitFor(() => transport.killSignals.includes("SIGTERM"));
  assert.equal(transport.killSignals[0], "SIGTERM");

  // ...and only after the shorter fallback does SIGKILL follow.
  await waitFor(() => transport.killSignals.includes("SIGKILL"));
  await closing;
  assert.equal(client.state, "closed");
  assert.deepEqual(transport.killSignals, ["SIGTERM", "SIGKILL"]);

  const byOp = (op) => transport.timeline.find((entry) => entry.op === op);
  assert.ok(byOp("end").seq < byOp("kill:SIGTERM").seq, "stdin EOF precedes SIGTERM");
  assert.ok(byOp("kill:SIGTERM").seq < byOp("kill:SIGKILL").seq, "SIGTERM precedes SIGKILL");
});

test("close waits for a natural exit after stdin EOF without escalating", async () => {
  const transport = new FakeTransport();
  const client = new PiRpcClient(() => transport, {
    closeTimeoutMs: 1_000,
    sigkillTimeoutMs: 100,
    defaultTimeoutMs: 100,
  });
  // Pi exits on its own as soon as stdin reaches EOF.
  transport.stdin.endHandler = () => transport.emitExit(0, null);
  await client.connect();

  await client.close();
  assert.equal(client.state, "closed");
  assert.equal(transport.stdin.ended, true);
  assert.deepEqual(transport.killSignals, []);
});

test("clean process exit rejects pending work and leaves a reconnectable disconnected state", async () => {
  const transport = new FakeTransport();
  const client = new PiRpcClient(() => transport, { defaultTimeoutMs: 100 });
  await client.connect();
  const pending = client.send({ type: "will_exit" });
  transport.emitExit(1, "SIGTERM");

  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof PiRpcTransportError);
    assert.equal(error.source, "process");
    assert.match(error.message, /code=1/);
    return true;
  });
  assert.equal(client.state, "disconnected");
});

test("write sends a JSONL command without registering a pending request", async () => {
  const transport = new FakeTransport();
  const client = new PiRpcClient(() => transport, { defaultTimeoutMs: 100 });
  const unmatched = [];
  client.onUnmatchedResponse((message) => unmatched.push(message));
  await client.connect();

  client.write({ type: "extension_ui_response", id: "ui-1", confirmed: true });

  assert.equal(transport.stdin.writes.length, 1);
  const frame = transport.stdin.writes[0];
  assert.ok(frame.endsWith("\n"), "write output is JSONL-framed");
  assert.deepEqual(JSON.parse(frame), {
    type: "extension_ui_response",
    id: "ui-1",
    confirmed: true,
  });

  // The write's id is not registered as pending, so its response arrives
  // unmatched instead of resolving a request.
  transport.stdout.emitData(
    `${JSON.stringify({ type: "response", id: "ui-1", success: true, data: {} })}\n`,
  );
  await flushMicrotasks();
  assert.equal(unmatched.length, 1);

  // Normal request/response correlation is unaffected.
  const request = client.send({ type: "get_state" });
  transport.stdout.emitData(`${responseFor(transport, 1, { ready: true })}\n`);
  assert.deepEqual((await request).data, { ready: true });
});

test("write rejects invalid commands, invalid ids, and ids already pending", async () => {
  const transport = new FakeTransport();
  const client = new PiRpcClient(() => transport, { defaultTimeoutMs: 100 });
  await client.connect();

  assert.throws(() => client.write({ type: "" }), (error) => error.code === "INVALID_COMMAND");

  const pending = client.send({ type: "slow_command" });
  pending.catch(() => undefined); // times out later; not awaited here
  const pendingId = JSON.parse(transport.stdin.writes[0]).id;
  assert.throws(
    () => client.write({ type: "extension_ui_response", id: pendingId, value: "x" }),
    (error) => error.code === "DUPLICATE_REQUEST_ID",
  );
  assert.throws(
    () => client.write({ type: "extension_ui_response", id: { nested: true } }),
    (error) => error.code === "INVALID_REQUEST_ID",
  );
});

test("write queues behind connect() when the client is not yet ready", async () => {
  const transport = new FakeTransport();
  const client = new PiRpcClient(() => transport, { defaultTimeoutMs: 100 });

  client.write({ type: "extension_ui_response", id: "ui-2", value: "ok" });

  // connect() has not resolved yet, so the frame has not been written.
  assert.equal(transport.stdin.writes.length, 0);
  await waitFor(() => transport.stdin.writes.length === 1);
  assert.equal(client.state, "ready");
  assert.ok(transport.stdin.writes[0].endsWith("\n"));
  assert.deepEqual(JSON.parse(transport.stdin.writes[0]), {
    type: "extension_ui_response",
    id: "ui-2",
    value: "ok",
  });
});

test("write surfaces asynchronous stdin write failures to the caller and error path", async () => {
  const transport = new FakeTransport();
  const client = new PiRpcClient(() => transport, { defaultTimeoutMs: 100 });
  const errors = [];
  client.onError((error) => errors.push(error));
  await client.connect();

  // Make the underlying stdin.write() fail asynchronously, the way a real
  // child-process pipe does when the peer disappears mid-write.
  const writeError = new Error("pipe broken");
  transport.stdin.writeResult = Promise.reject(writeError);

  // The caller's promise must reject with the transport error...
  await assert.rejects(
    client.write({ type: "extension_ui_response", id: "ui-3", value: "ok" }),
    (error) => {
      assert.ok(error instanceof PiRpcTransportError);
      assert.equal(error.source, "stdin");
      assert.equal(error.cause, writeError);
      return true;
    },
  );

  // ...while the client still funnels the same failure through its error path.
  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].source, "stdin");
  assert.equal(errors[0].cause, writeError);
  assert.equal(client.state, "disconnected");
  assert.ok(transport.killSignals.includes("SIGTERM"));
});
