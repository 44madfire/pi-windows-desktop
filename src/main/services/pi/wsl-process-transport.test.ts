import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  createWslPiTransport,
  WslPiProcessStdinAdapter,
  WslPiProcessTransportInputError,
  type WslPiProcessSpawn,
  type WslPiSpawnedChild,
} from "./wsl-process-transport.ts";

class FakeReadable extends EventEmitter {}

class FakeWritable extends EventEmitter {
  readonly writes: string[] = [];
  ended = false;
  private readonly writeResult: boolean;
  private readonly pendingWriteCallbacks: Array<(error?: Error | null) => void> = [];

  constructor(writeResult = true) {
    super();
    this.writeResult = writeResult;
  }

  write(chunk: string, callback?: (error?: Error | null) => void): boolean {
    this.writes.push(chunk);
    if (callback) {
      this.pendingWriteCallbacks.push(callback);
    }
    return this.writeResult;
  }

  /** Invoke the oldest pending write callback, settling the adapter's write promise. */
  flushWrite(error?: Error): void {
    const callback = this.pendingWriteCallbacks.shift();
    callback?.(error);
  }

  end(): void {
    this.ended = true;
  }
}

class FakeChild extends EventEmitter {
  readonly stdin: FakeWritable;
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly killSignals: Array<string | undefined> = [];

  constructor(stdin: FakeWritable = new FakeWritable()) {
    super();
    this.stdin = stdin;
  }

  kill(signal?: string): boolean {
    this.killSignals.push(signal);
    return true;
  }
}

function asSpawnedChild(child: FakeChild): WslPiSpawnedChild {
  return child as unknown as WslPiSpawnedChild;
}

test("creates an argv-safe streaming WSL Pi transport", () => {
  const child = new FakeChild();
  let call:
    | {
        executable: string;
        argv: readonly string[];
        options: Parameters<WslPiProcessSpawn>[2];
      }
    | undefined;
  const spawn: WslPiProcessSpawn = (executable, argv, options) => {
    call = { executable, argv, options };
    return asSpawnedChild(child);
  };

  const linuxPath = "/mnt/c/Project With Spaces/$HOME; echo 'quoted'";
  const transport = createWslPiTransport({
    distro: "Ubuntu-24.04",
    linuxPath,
    executable: "wsl-test.exe",
    spawn,
  });

  assert.deepEqual(call, {
    executable: "wsl-test.exe",
    argv: [
      "-d",
      "Ubuntu-24.04",
      "--cd",
      linuxPath,
      "--",
      "pi",
      "--mode",
      "rpc",
    ],
    options: {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    },
  });

  assert.ok(
    transport.stdin instanceof WslPiProcessStdinAdapter,
    "stdin must be the promise-based adapter, not the raw child stdin",
  );
  assert.equal(transport.stdout, child.stdout);
  assert.equal(transport.stderr, child.stderr);

  transport.stdin.write("{\"type\":\"prompt\"}\n");
  assert.deepEqual(child.stdin.writes, ["{\"type\":\"prompt\"}\n"]);
});

test("forwards process lifecycle events and kill signals", () => {
  const child = new FakeChild();
  const spawn: WslPiProcessSpawn = () => asSpawnedChild(child);
  const transport = createWslPiTransport({ distro: "Debian", linuxPath: "/home/user/project", spawn });

  const errors: unknown[] = [];
  const exits: Array<[number | null | undefined, string | null | undefined]> = [];
  const closes: Array<[number | null | undefined, string | null | undefined]> = [];
  transport.on("error", (error) => errors.push(error));
  transport.on("exit", (code, signal) => exits.push([code, signal]));
  transport.on("close", (code, signal) => closes.push([code, signal]));

  const processError = new Error("spawn failed");
  child.emit("error", processError);
  child.emit("exit", 17, "SIGTERM");
  child.emit("close", 17, "SIGTERM");

  assert.deepEqual(errors, [processError]);
  assert.deepEqual(exits, [[17, "SIGTERM"]]);
  assert.deepEqual(closes, [[17, "SIGTERM"]]);
  assert.equal(transport.kill?.("SIGKILL"), true);
  assert.deepEqual(child.killSignals, ["SIGKILL"]);
});

test("supports a custom Pi executable without changing argv boundaries", () => {
  const child = new FakeChild();
  let argv: readonly string[] | undefined;
  const spawn: WslPiProcessSpawn = (_executable, receivedArgv) => {
    argv = receivedArgv;
    return asSpawnedChild(child);
  };

  createWslPiTransport({
    distro: "Arch",
    linuxPath: "/home/user/project",
    piExecutable: "/opt/pi/bin/pi with spaces",
    spawn,
  });

  assert.deepEqual(argv, [
    "-d",
    "Arch",
    "--cd",
    "/home/user/project",
    "--",
    "/opt/pi/bin/pi with spaces",
    "--mode",
    "rpc",
  ]);
});

test("rejects invalid distro and non-canonical Linux workspace inputs before spawning", () => {
  let spawnCalls = 0;
  const spawn: WslPiProcessSpawn = () => {
    spawnCalls += 1;
    return asSpawnedChild(new FakeChild());
  };

  const invalidOptions = [
    { distro: "", linuxPath: "/home/user/project" },
    { distro: "Ubuntu 24.04", linuxPath: "/home/user/project" },
    { distro: "Ubuntu", linuxPath: "relative/project" },
    { distro: "Ubuntu", linuxPath: "C:\\Users\\user\\project" },
    { distro: "Ubuntu", linuxPath: "/home/user/../project" },
    { distro: "Ubuntu", linuxPath: "/home//user/project" },
    { distro: "Ubuntu", linuxPath: "/home/user/project/" },
    { distro: "Ubuntu", linuxPath: "/home/user/project\u0000" },
  ];

  for (const options of invalidOptions) {
    assert.throws(
      () => createWslPiTransport({ ...options, spawn }),
      WslPiProcessTransportInputError,
    );
  }

  assert.equal(spawnCalls, 0);
});

test("stdin write() returns a promise that stays pending until the writable callback fires", { timeout: 5000 }, async () => {
  const stdin = new FakeWritable(false);
  const child = new FakeChild(stdin);
  const spawn: WslPiProcessSpawn = () => asSpawnedChild(child);
  const transport = createWslPiTransport({
    distro: "Ubuntu-24.04",
    linuxPath: "/home/user/project",
    spawn,
  });

  const writeResult = transport.stdin.write("{\"type\":\"prompt\"}\n");
  assert.ok(
    writeResult instanceof Promise,
    "stdin write() must return a promise, not the immediate backpressure boolean",
  );
  const writePromise = writeResult as Promise<boolean | void>;

  let outcome: "pending" | "fulfilled" | "rejected" = "pending";
  writePromise.then(
    () => {
      outcome = "fulfilled";
    },
    () => {
      outcome = "rejected";
    },
  );

  // Give microtasks and a macrotask a chance: the child writable has not
  // invoked its write callback yet, so the promise must still be pending.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    outcome,
    "pending",
    "write() promise must stay pending until the writable callback fires",
  );

  stdin.flushWrite();
  await writePromise;
  assert.equal(outcome, "fulfilled", "write() promise must settle once the writable callback fires");
});

test("stdin write() promise rejects when the writable callback reports an error", { timeout: 5000 }, async () => {
  const stdin = new FakeWritable(false);
  const child = new FakeChild(stdin);
  const spawn: WslPiProcessSpawn = () => asSpawnedChild(child);
  const transport = createWslPiTransport({
    distro: "Ubuntu-24.04",
    linuxPath: "/home/user/project",
    spawn,
  });

  const writeResult = transport.stdin.write("{\"type\":\"prompt\"}\n");
  assert.ok(
    writeResult instanceof Promise,
    "stdin write() must return a promise, not the immediate backpressure boolean",
  );

  const writeError = new Error("EPIPE: WSL pi process closed its stdin");
  stdin.flushWrite(writeError);

  await assert.rejects(writeResult, (error: unknown) => error === writeError);
});
