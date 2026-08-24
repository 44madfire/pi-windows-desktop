import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";

export const DEFAULT_WSL_EXECUTABLE = "wsl.exe";
export const DEFAULT_WSL_TIMEOUT_MS = 15_000;
export const DEFAULT_WSL_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export const WSL_DISTRIBUTION_PATTERN = /^[A-Za-z0-9._-]+$/;

export type ProcessFailureReason = "timeout" | "max-buffer" | "spawn-error" | null;

export type ProcessEnvironment = Readonly<Record<string, string | undefined>>;

export interface ProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: ProcessEnvironment;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

export interface ProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly failure: ProcessFailureReason;
}

/**
 * The process boundary is deliberately injectable. Production uses
 * createNodeProcessRunner(); tests can return deterministic stdout/stderr
 * without requiring WSL or a Linux distribution.
 */
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export interface WslCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface WslCommandResult extends ProcessResult {
  readonly distribution: string;
  readonly command: WslCommand;
  readonly request: ProcessRequest;
  readonly ok: boolean;
}

export interface WslInvocationResult extends ProcessResult {
  readonly request: ProcessRequest;
  readonly ok: boolean;
}

export interface WslDistribution {
  readonly name: string;
}

export interface WslDistributionProbe {
  readonly distribution: string;
  readonly available: boolean;
  readonly availability: WslCommandResult;
  readonly pi: PiExecutableProbe | null;
}

export type PiProbeFailureReason = "lookup-failed" | "not-found";

export type PiExecutableProbe =
  | {
      readonly available: true;
      readonly executable: string;
      readonly version: string | null;
      readonly versionResult: WslCommandResult;
    }
  | {
      readonly available: false;
      readonly executable: null;
      readonly version: null;
      readonly reason: PiProbeFailureReason;
      readonly lookupResult: WslCommandResult;
    };

/** A seam for replacing Pi discovery with an application-specific strategy. */
export interface PiExecutableLocator {
  locate(distribution: string): Promise<PiExecutableProbe>;
}

export interface WslServiceOptions {
  readonly runner?: ProcessRunner;
  readonly wslExecutable?: string;
  readonly piLocator?: PiExecutableLocator;
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

export class WslInputError extends Error {
  readonly code = "WSL_INPUT_ERROR" as const;

  constructor(message: string) {
    super(message);
    this.name = "WslInputError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WslProcessError extends Error {
  readonly code = "WSL_PROCESS_ERROR" as const;
  readonly request: ProcessRequest;
  readonly cause: unknown;

  constructor(request: ProcessRequest, cause: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(`Unable to start ${request.executable}${detail}`);
    this.name = "WslProcessError";
    this.request = request;
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WslCommandError extends Error {
  readonly code = "WSL_COMMAND_ERROR" as const;
  readonly operation: string;
  readonly result: WslInvocationResult | WslCommandResult;

  constructor(operation: string, result: WslInvocationResult | WslCommandResult) {
    const status = result.failure
      ? result.failure
      : result.signal
        ? `signal ${result.signal}`
        : `exit code ${result.exitCode}`;
    super(`${operation} failed with ${status}`);
    this.name = "WslCommandError";
    this.operation = operation;
    this.result = result;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Decode output from the Windows WSL CLI. In particular, `wsl --list` may
 * emit UTF-16LE even though ordinary command output is UTF-8.
 */
export function decodeWslOutput(output: Uint8Array | string): string {
  if (typeof output === "string") {
    return output.replace(/^\uFEFF/, "");
  }

  const bytes = Buffer.from(output);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le").replace(/^\uFEFF/, "");
  }

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return swapUtf16Bytes(bytes.subarray(2)).toString("utf16le").replace(/^\uFEFF/, "");
  }

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.toString("utf8", 3).replace(/^\uFEFF/, "");
  }

  const byteOrder = sniffUtf16NoBom(bytes);
  if (byteOrder === "le") {
    return bytes.toString("utf16le");
  }
  if (byteOrder === "be") {
    return swapUtf16Bytes(bytes).toString("utf16le");
  }

  return bytes.toString("utf8").replace(/^\uFEFF/, "");
}

function swapUtf16Bytes(bytes: Uint8Array): Buffer {
  const swapped = Buffer.alloc(bytes.length - (bytes.length % 2));
  for (let index = 0; index + 1 < swapped.length; index += 2) {
    swapped[index] = bytes[index + 1];
    swapped[index + 1] = bytes[index];
  }
  return swapped;
}

function sniffUtf16NoBom(bytes: Uint8Array): "le" | "be" | null {
  const length = Math.min(bytes.length, 512) & ~1;
  if (length < 8) {
    return null;
  }

  const isAsciiTextByte = (value: number): boolean =>
    value === 0x09 || value === 0x0a || value === 0x0d || (value >= 0x20 && value < 0x7f);
  let littleEndianMatches = 0;
  let bigEndianMatches = 0;

  for (let index = 0; index < length; index += 2) {
    if (bytes[index + 1] === 0 && isAsciiTextByte(bytes[index])) {
      littleEndianMatches += 1;
    }
    if (bytes[index] === 0 && isAsciiTextByte(bytes[index + 1])) {
      bigEndianMatches += 1;
    }
  }

  const codeUnitCount = length / 2;
  if (littleEndianMatches >= codeUnitCount * 0.6 && littleEndianMatches > bigEndianMatches) {
    return "le";
  }
  if (bigEndianMatches >= codeUnitCount * 0.6 && bigEndianMatches > littleEndianMatches) {
    return "be";
  }
  return null;
}

/** Parse the names returned by `wsl.exe --list --quiet`. */
export function parseWslDistributionList(output: Uint8Array | string): string[] {
  const text = decodeWslOutput(output).replace(/\u0000/g, "");

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.replace(/^\*\s*/, "").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^name(?:\s+state(?:\s+version)?)?$/i.test(line))
    .filter((line) => !/^windows subsystem for linux distributions:?$/i.test(line));
}

function validateNonEmpty(value: string, label: string): void {
  if (value.length === 0 || value.trim().length === 0) {
    throw new WslInputError(`${label} must not be empty`);
  }

  if (value.includes("\u0000")) {
    throw new WslInputError(`${label} must not contain a NUL character`);
  }
}

export function isValidWslDistributionName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.startsWith("-") &&
    WSL_DISTRIBUTION_PATTERN.test(value)
  );
}

function validateDistributionName(value: string): void {
  if (!isValidWslDistributionName(value)) {
    throw new WslInputError(`Invalid WSL distribution name: ${String(value)}`);
  }
}

function validatePositiveLimit(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 1) {
    throw new WslInputError(`${label} must be a positive finite number at least 1`);
  }
  return Math.floor(value);
}

function validateArgument(value: string, label: string): void {
  if (value.includes("\u0000")) {
    throw new WslInputError(`${label} must not contain a NUL character`);
  }
}

function firstNonEmptyLine(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const value = line.trim();
    if (value.length > 0) {
      return value;
    }
  }

  return null;
}

function combineChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return output;
}

/**
 * Spawn WSL without a shell. Every argument is handed to child_process.spawn
 * as its own argv entry, so spaces and shell metacharacters are not re-parsed.
 */
export function createNodeProcessRunner(): ProcessRunner {
  return (request) =>
    new Promise<ProcessResult>((resolve) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: request.env ? { ...request.env } : undefined,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdoutChunks: Uint8Array[] = [];
      const stderrChunks: Uint8Array[] = [];
      let settled = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const maxBufferBytes = validatePositiveLimit(
        request.maxBufferBytes ?? DEFAULT_WSL_MAX_BUFFER_BYTES,
        "maxBufferBytes",
      );
      const timeoutMs = validatePositiveLimit(
        request.timeoutMs ?? DEFAULT_WSL_TIMEOUT_MS,
        "timeoutMs",
      );
      const encoder = new TextEncoder();
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (
        failure: ProcessFailureReason,
        exitCode: number | null,
        signal: string | null,
        diagnostic = "",
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }

        const stderr = decodeWslOutput(combineChunks(stderrChunks));
        const diagnosticSuffix = diagnostic
          ? `${stderr.length > 0 && !stderr.endsWith("\n") ? "\n" : ""}${diagnostic}`
          : "";
        resolve({
          stdout: decodeWslOutput(combineChunks(stdoutChunks)),
          stderr: `${stderr}${diagnosticSuffix}`,
          exitCode,
          signal,
          failure,
        });
      };

      const appendChunk = (
        chunks: Uint8Array[],
        chunk: Uint8Array | string,
        bytesSoFar: number,
      ): { bytes: number; exceeded: boolean } => {
        const data = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
        const remaining = Math.max(0, maxBufferBytes - bytesSoFar);
        const retained = data.byteLength <= remaining ? data : data.subarray(0, remaining);
        if (retained.byteLength > 0) {
          chunks.push(retained);
        }
        return {
          bytes: bytesSoFar + retained.byteLength,
          exceeded: data.byteLength > remaining,
        };
      };

      child.stdout?.on("data", (chunk: Uint8Array | string) => {
        if (settled) {
          return;
        }
        const appended = appendChunk(stdoutChunks, chunk, stdoutBytes);
        stdoutBytes = appended.bytes;
        if (appended.exceeded) {
          child.kill();
          finish("max-buffer", null, null, "[wsl] process output exceeded maxBuffer");
        }
      });
      child.stderr?.on("data", (chunk: Uint8Array | string) => {
        if (settled) {
          return;
        }
        const appended = appendChunk(stderrChunks, chunk, stderrBytes);
        stderrBytes = appended.bytes;
        if (appended.exceeded) {
          child.kill();
          finish("max-buffer", null, null, "[wsl] process output exceeded maxBuffer");
        }
      });

      child.once("error", (error: unknown) => {
        if (!settled) {
          const message = error instanceof Error ? error.message : String(error);
          finish("spawn-error", null, null, message || "wsl spawn error");
        }
      });

      child.once("close", (exitCode: number | null, signal: string | null) => {
        if (!settled) {
          finish(null, exitCode, signal);
        }
      });

      timer = setTimeout(() => {
        if (!settled) {
          child.kill();
          finish("timeout", null, null, "[wsl] timed out");
        }
      }, timeoutMs);
    });
}

/** Default discovery strategy for a Pi executable inside a selected distro. */
export class DefaultPiExecutableLocator implements PiExecutableLocator {
  private readonly runInDistribution: RunInDistribution;

  constructor(runInDistribution: RunInDistribution) {
    this.runInDistribution = runInDistribution;
  }

  async locate(distribution: string): Promise<PiExecutableProbe> {
    const lookupResult = await this.runInDistribution(distribution, "/bin/sh", [
      "-c",
      "command -v pi",
    ]);

    const executable = lookupResult.ok ? firstNonEmptyLine(lookupResult.stdout) : null;
    if (!lookupResult.ok) {
      return {
        available: false,
        executable: null,
        version: null,
        reason: "lookup-failed",
        lookupResult,
      };
    }

    if (executable === null) {
      return {
        available: false,
        executable: null,
        version: null,
        reason: "not-found",
        lookupResult,
      };
    }

    const versionResult = await this.runInDistribution(distribution, executable, ["--version"]);
    return {
      available: true,
      executable,
      version: versionResult.ok
        ? firstNonEmptyLine(versionResult.stdout) ?? firstNonEmptyLine(versionResult.stderr)
        : null,
      versionResult,
    };
  }
}

export type RunInDistribution = (
  distribution: string,
  executable: string,
  args?: readonly string[],
) => Promise<WslCommandResult>;

export class WslService {
  private readonly runner: ProcessRunner;
  private readonly wslExecutable: string;
  private readonly piLocator: PiExecutableLocator;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;

  constructor(options: WslServiceOptions = {}) {
    this.runner = options.runner ?? createNodeProcessRunner();
    this.wslExecutable = options.wslExecutable ?? DEFAULT_WSL_EXECUTABLE;
    validateNonEmpty(this.wslExecutable, "wslExecutable");
    this.timeoutMs = validatePositiveLimit(
      options.timeoutMs ?? DEFAULT_WSL_TIMEOUT_MS,
      "timeoutMs",
    );
    this.maxBufferBytes = validatePositiveLimit(
      options.maxBufferBytes ?? DEFAULT_WSL_MAX_BUFFER_BYTES,
      "maxBufferBytes",
    );

    const runInDistribution: RunInDistribution = (distribution, executable, args = []) =>
      this.runInDistribution(distribution, executable, args);
    this.piLocator = options.piLocator ?? new DefaultPiExecutableLocator(runInDistribution);
  }

  async listDistributions(): Promise<readonly WslDistribution[]> {
    const result = await this.invoke(["--list", "--quiet"]);
    if (!result.ok) {
      throw new WslCommandError("Listing WSL distributions", result);
    }

    return parseWslDistributionList(result.stdout).map((name) => ({ name }));
  }

  async probeDistribution(distribution: string): Promise<WslDistributionProbe> {
    const availability = await this.runInDistribution(distribution, "/bin/true");

    return {
      distribution,
      available: availability.ok,
      availability,
      pi: availability.ok ? await this.piLocator.locate(distribution) : null,
    };
  }

  /**
   * Run one executable in a distro. The executable and args remain distinct
   * argv entries; this method never constructs or evaluates a shell command.
   */
  async runInDistribution(
    distribution: string,
    executable: string,
    args: readonly string[] = [],
    options: WslRunOptions = {},
  ): Promise<WslCommandResult> {
    validateDistributionName(distribution);
    validateNonEmpty(executable, "executable");
    validateArgument(executable, "executable");
    args.forEach((arg, index) => validateArgument(arg, `args[${index}]`));

    const command: WslCommand = {
      executable,
      args: [...args],
    };
    const result = await this.invoke([
      "--distribution",
      distribution,
      "--exec",
      command.executable,
      ...command.args,
    ], options);

    return {
      ...result,
      distribution,
      command,
      ok: result.ok,
    };
  }

  private async invoke(
    args: readonly string[],
    options: WslRunOptions = {},
  ): Promise<WslInvocationResult> {
    args.forEach((arg, index) => validateArgument(arg, `wsl args[${index}]`));

    const timeoutMs = validatePositiveLimit(
      options.timeoutMs ?? this.timeoutMs,
      "timeoutMs",
    );
    const maxBufferBytes = validatePositiveLimit(
      options.maxBufferBytes ?? this.maxBufferBytes,
      "maxBufferBytes",
    );

    const request: ProcessRequest = {
      executable: this.wslExecutable,
      args: [...args],
      timeoutMs,
      maxBufferBytes,
    };

    let result: ProcessResult;
    try {
      result = await this.runner(request);
    } catch (cause) {
      throw new WslProcessError(request, cause);
    }

    const exitCode = result.exitCode ?? null;
    const signal = result.signal ?? null;
    const failure = result.failure ?? null;
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode,
      signal,
      failure,
      request,
      ok: exitCode === 0 && signal === null && failure === null,
    };
  }
}

export interface WslRunOptions {
  readonly timeoutMs?: number;
  readonly maxBufferBytes?: number;
}

export { WslService as WslManager };
