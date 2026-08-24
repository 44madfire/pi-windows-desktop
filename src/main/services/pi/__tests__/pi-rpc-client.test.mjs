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

  on(event, listener) {
    this.listeners[event].push(listener);
    return this;
  }

  write(chunk) {
    this.writes.push(chunk);
    this.writeHandler?.(chunk);
    return this.writeResult;
  }

  end() {
    this.ended = true;
  }

  emitError(error) {
    for (const listener of this.listeners.error) listener(error);
  }
}

class FakeTransport {
  stdin = new FakeWritable();
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

test("gracefully closes stdin, rejects pending work, and falls back to SIGKILL", async () => {
  const transport = new FakeTransport();
  const client = new PiRpcClient(() => transport, { closeTimeoutMs: 5, defaultTimeoutMs: 100 });
  await client.connect();
  const pending = client.send({ type: "during_close" });

  const closing = client.close();
  await assert.rejects(pending, PiRpcClosedError);
  assert.equal(transport.stdin.ended, true);
  assert.ok(transport.killSignals.includes("SIGTERM"));
  await closing;
  assert.equal(client.state, "closed");
  assert.ok(transport.killSignals.includes("SIGKILL"));
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
