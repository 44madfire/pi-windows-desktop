import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DefaultPiExecutableLocator,
  WslCommandError,
  WslInputError,
  WslProcessError,
  WslService,
  createNodeProcessRunner,
  decodeWslOutput,
  isValidWslDistributionName,
  parseWslDistributionList,
  type PiExecutableLocator,
  type ProcessRequest,
  type ProcessResult,
} from "./index.ts";

interface FakeRunner {
  readonly calls: ProcessRequest[];
  readonly run: (request: ProcessRequest) => Promise<ProcessResult>;
}

function result(
  stdout = "",
  stderr = "",
  exitCode: number | null = 0,
  signal: string | null = null,
): ProcessResult {
  return { stdout, stderr, exitCode, signal, failure: null };
}

function queuedRunner(results: ProcessResult[]): FakeRunner {
  const calls: ProcessRequest[] = [];
  let index = 0;

  return {
    calls,
    run: async (request) => {
      calls.push(request);
      const next = results[index];
      index += 1;
      if (!next) {
        throw new Error("fake runner queue exhausted");
      }
      return next;
    },
  };
}

test("parses UTF-16LE and quiet-list markers without a live WSL distro", () => {
  const encoded = Buffer.from("\uFEFFUbuntu\r\n* Debian Testing\r\n", "utf16le");
  const bigEndian = Buffer.from("Ubuntu\r\n", "utf16le").swap16();

  assert.deepEqual(parseWslDistributionList(encoded), ["Ubuntu", "Debian Testing"]);
  assert.equal(decodeWslOutput(encoded), "Ubuntu\r\n* Debian Testing\r\n");
  assert.equal(decodeWslOutput(bigEndian), "Ubuntu\r\n");
  assert.equal(decodeWslOutput(Buffer.from("\uFEFFUbuntu\n", "utf8")), "Ubuntu\n");
});

test("lists distributions and forwards the WSL list arguments explicitly", async () => {
  const fake = queuedRunner([result("Ubuntu\r\n* Debian\r\n")]);
  const service = new WslService({ runner: fake.run, wslExecutable: "wsl-test.exe" });

  assert.deepEqual(await service.listDistributions(), [{ name: "Ubuntu" }, { name: "Debian" }]);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].executable, "wsl-test.exe");
  assert.deepEqual(fake.calls[0].args, ["--list", "--quiet"]);
});

test("keeps stderr separate when a listed-distributions command fails", async () => {
  const fake = queuedRunner([result("partial output", "wsl: service is unavailable\r\n", 1)]);
  const service = new WslService({ runner: fake.run });

  await assert.rejects(service.listDistributions(), (error: unknown) => {
    assert.ok(error instanceof WslCommandError);
    assert.equal(error.result.stdout, "partial output");
    assert.equal(error.result.stderr, "wsl: service is unavailable\r\n");
    assert.equal(error.result.exitCode, 1);
    return true;
  });
});

test("runs a selected distro command with exact argv entries", async () => {
  const fake = queuedRunner([result("ok", "warning from command")]);
  const service = new WslService({ runner: fake.run });
  const argumentsWithShellCharacters = ["two words", "quote\"and'apos", "$(not-a-command)"];

  const commandResult = await service.runInDistribution(
    "Ubuntu-22.04",
    "/usr/bin/printf",
    ["%s", ...argumentsWithShellCharacters],
    { timeoutMs: 2_000, maxBufferBytes: 4_096 },
  );

  assert.equal(commandResult.ok, true);
  assert.equal(commandResult.stdout, "ok");
  assert.equal(commandResult.stderr, "warning from command");
  assert.equal(fake.calls[0].timeoutMs, 2_000);
  assert.equal(fake.calls[0].maxBufferBytes, 4_096);
  assert.deepEqual(fake.calls[0].args, [
    "--distribution",
    "Ubuntu-22.04",
    "--exec",
    "/usr/bin/printf",
    "%s",
    ...argumentsWithShellCharacters,
  ]);
});

test("returns a typed unsuccessful command result while preserving stderr", async () => {
  const fake = queuedRunner([result("partial", "command failed", 17)]);
  const service = new WslService({ runner: fake.run });

  const commandResult = await service.runInDistribution("Ubuntu", "false", []);

  assert.equal(commandResult.ok, false);
  assert.equal(commandResult.exitCode, 17);
  assert.equal(commandResult.stdout, "partial");
  assert.equal(commandResult.stderr, "command failed");
  assert.equal(commandResult.failure, null);
  assert.deepEqual(commandResult.command, { executable: "false", args: [] });
});

test("probes availability and delegates Pi discovery through an injected locator", async () => {
  const fake = queuedRunner([result()]);
  const locatorCalls: string[] = [];
  const piLocator: PiExecutableLocator = {
    locate: async (distribution) => {
      locatorCalls.push(distribution);
      return {
        available: true,
        executable: "/opt/pi/bin/pi",
        version: "pi 0.1.0",
        versionResult: {
          stdout: "pi 0.1.0",
          stderr: "",
          exitCode: 0,
          signal: null,
          failure: null,
          request: {
            executable: "wsl.exe",
            args: ["--distribution", distribution, "--exec", "/opt/pi/bin/pi", "--version"],
          },
          distribution,
          command: { executable: "/opt/pi/bin/pi", args: ["--version"] },
          ok: true,
        },
      };
    },
  };
  const service = new WslService({ runner: fake.run, piLocator });

  const probe = await service.probeDistribution("Ubuntu");

  assert.equal(probe.available, true);
  assert.equal(probe.availability.command.executable, "/bin/true");
  assert.deepEqual(probe.pi?.available, true);
  assert.deepEqual(locatorCalls, ["Ubuntu"]);
  assert.deepEqual(fake.calls[0].args, ["--distribution", "Ubuntu", "--exec", "/bin/true"]);
});

test("reports an unavailable distro without attempting Pi discovery", async () => {
  const fake = queuedRunner([result("", "There is no distribution with the supplied name.", 1)]);
  let locatorCalled = false;
  const service = new WslService({
    runner: fake.run,
    piLocator: {
      locate: async () => {
        locatorCalled = true;
        throw new Error("should not be called");
      },
    },
  });

  const probe = await service.probeDistribution("Missing-Distro");

  assert.equal(probe.available, false);
  assert.equal(probe.pi, null);
  assert.equal(probe.availability.stderr, "There is no distribution with the supplied name.");
  assert.equal(locatorCalled, false);
});

test("default Pi locator finds an executable and probes its version", async () => {
  const fake = queuedRunner([result("/usr/local/bin/pi\n"), result("pi 2.4.1\n", "")]);
  const runInDistribution = async (
    distribution: string,
    executable: string,
    args: readonly string[] = [],
  ) => {
    const request: ProcessRequest = {
      executable: "wsl-test.exe",
      args: ["--distribution", distribution, "--exec", executable, ...args],
    };
    const processResult = await fake.run(request);
    return {
      ...processResult,
      distribution,
      command: { executable, args: [...args] },
      request,
      ok: processResult.exitCode === 0 && processResult.signal === null && processResult.failure === null,
    };
  };

  const probe = await new DefaultPiExecutableLocator(runInDistribution).locate("Ubuntu");

  assert.deepEqual(probe, {
    available: true,
    executable: "/usr/local/bin/pi",
    version: "pi 2.4.1",
    versionResult: {
      stdout: "pi 2.4.1\n",
      stderr: "",
      exitCode: 0,
      signal: null,
      failure: null,
      distribution: "Ubuntu",
      command: { executable: "/usr/local/bin/pi", args: ["--version"] },
      request: {
        executable: "wsl-test.exe",
        args: ["--distribution", "Ubuntu", "--exec", "/usr/local/bin/pi", "--version"],
      },
      ok: true,
    },
  });
  assert.deepEqual(fake.calls.map((call) => call.args), [
    ["--distribution", "Ubuntu", "--exec", "/bin/sh", "-c", "command -v pi"],
    ["--distribution", "Ubuntu", "--exec", "/usr/local/bin/pi", "--version"],
  ]);
});

test("returns a typed not-found Pi probe when lookup produces no path", async () => {
  const fake = queuedRunner([result("\n", "")]);
  const locator = new DefaultPiExecutableLocator(async (distribution, executable, args = []) => {
    const processResult = await fake.run({
      executable: "wsl-test.exe",
      args: ["--distribution", distribution, "--exec", executable, ...args],
    });
    return {
      ...processResult,
      distribution,
      command: { executable, args: [...args] },
      request: {
        executable: "wsl-test.exe",
        args: ["--distribution", distribution, "--exec", executable, ...args],
      },
      ok: processResult.exitCode === 0 && processResult.signal === null && processResult.failure === null,
    };
  });

  const probe = await locator.locate("Ubuntu");

  assert.equal(probe.available, false);
  if (!probe.available) {
    assert.equal(probe.reason, "not-found");
    assert.equal(probe.lookupResult.stderr, "");
  }
});

test("validates distro names before invoking WSL", () => {
  assert.equal(isValidWslDistributionName("Ubuntu-22.04"), true);
  assert.equal(isValidWslDistributionName("Ubuntu Test"), false);
  assert.equal(isValidWslDistributionName("--exec"), false);
  assert.equal(isValidWslDistributionName(""), false);
});

test("preserves typed timeout and max-buffer outcomes from the injected runner", async () => {
  const timeoutRunner = queuedRunner([
    { stdout: "partial", stderr: "still running", exitCode: null, signal: null, failure: "timeout" },
  ]);
  const timeoutService = new WslService({ runner: timeoutRunner.run });
  const timeoutResult = await timeoutService.runInDistribution("Ubuntu", "sleep", ["10"]);
  assert.equal(timeoutResult.ok, false);
  assert.equal(timeoutResult.failure, "timeout");
  assert.equal(timeoutResult.stderr, "still running");

  const bufferRunner = queuedRunner([
    { stdout: "partial", stderr: "too much", exitCode: null, signal: null, failure: "max-buffer" },
  ]);
  const bufferService = new WslService({ runner: bufferRunner.run });
  const bufferResult = await bufferService.runInDistribution("Ubuntu", "printf", ["x"]);
  assert.equal(bufferResult.ok, false);
  assert.equal(bufferResult.failure, "max-buffer");
  assert.equal(bufferResult.stderr, "too much");
});

test("default process runner enforces independent output limits and timeout", async () => {
  const runner = createNodeProcessRunner();
  const outputResult = await runner({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('0123456789'); process.stderr.write('diagnostic')"],
    timeoutMs: 2_000,
    maxBufferBytes: 4,
  });

  assert.equal(outputResult.failure, "max-buffer");
  assert.equal(outputResult.stdout, "0123");
  assert.match(outputResult.stderr, /process output exceeded maxBuffer/);

  const timeoutResult = await runner({
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1_000)"],
    timeoutMs: 100,
    maxBufferBytes: 1_024,
  });

  assert.equal(timeoutResult.failure, "timeout");
  assert.match(timeoutResult.stderr, /timed out/);
});

test("wraps process-launch failures in a typed error with the original request", async () => {
  const runner = async (_request: ProcessRequest): Promise<ProcessResult> => {
    throw new Error("wsl.exe was not found");
  };
  const service = new WslService({ runner });

  await assert.rejects(service.listDistributions(), (error: unknown) => {
    assert.ok(error instanceof WslProcessError);
    assert.deepEqual(error.request.args, ["--list", "--quiet"]);
    assert.match(error.message, /wsl\.exe was not found/);
    return true;
  });
});

test("rejects empty and unsafe arguments before invoking the process runner", async () => {
  const fake = queuedRunner([]);
  const service = new WslService({ runner: fake.run });

  await assert.rejects(service.runInDistribution("", "true"), WslInputError);
  await assert.rejects(service.runInDistribution("Ubuntu", ""), WslInputError);
  await assert.rejects(service.runInDistribution("Ubuntu", "true", ["bad\u0000arg"]), WslInputError);
  assert.equal(fake.calls.length, 0);
});
