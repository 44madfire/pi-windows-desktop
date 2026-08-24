import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  createWslPiTransport,
  WslPiProcessTransportInputError,
  type WslPiProcessSpawn,
  type WslPiSpawnedChild,
} from "./wsl-process-transport.ts";

class FakeReadable extends EventEmitter {}

class FakeWritable extends EventEmitter {
  readonly writes: string[] = [];
  ended = false;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }

  end(): void {
    this.ended = true;
  }
}

class FakeChild extends EventEmitter {
  readonly stdin = new FakeWritable();
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly killSignals: Array<string | undefined> = [];

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

  assert.equal(transport.stdin, child.stdin);
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
