import { spawn as nodeSpawn } from "node:child_process";

import type {
  PiRpcProcessSignal,
  PiRpcReadable,
  PiRpcTransport,
  PiRpcWritable,
} from "./transport.ts";

export const DEFAULT_WSL_PI_EXECUTABLE = "wsl.exe";
export const WSL_PI_DISTRIBUTION_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface WslPiProcessSpawnOptions {
  readonly shell: false;
  readonly windowsHide: true;
  readonly stdio: ["pipe", "pipe", "pipe"];
}

/** The subset of a spawned child process needed by PiRpcTransport. */
export type WslPiSpawnedChild = Pick<
  PiRpcTransport,
  "stdin" | "stdout" | "stderr" | "on"
> & {
  kill: NonNullable<PiRpcTransport["kill"]>;
};

/** Injectable process boundary used to test the adapter without WSL. */
export type WslPiProcessSpawn = (
  executable: string,
  argv: readonly string[],
  options: WslPiProcessSpawnOptions,
) => WslPiSpawnedChild;

export interface WslPiProcessTransportOptions {
  /** Selected WSL distribution name, for example `Ubuntu-24.04`. */
  readonly distro: string;
  /** Canonical absolute Linux path used as the WSL working directory. */
  readonly linuxPath: string;
  /** Pi executable passed after the WSL `--` separator. Defaults to `pi`. */
  readonly piExecutable?: string;
  /** Defaults to `wsl.exe`; injectable so tests do not require WSL. */
  readonly executable?: string;
  /** Defaults to Node's child_process.spawn implementation. */
  readonly spawn?: WslPiProcessSpawn;
}

export class WslPiProcessTransportInputError extends TypeError {
  readonly code = "WSL_PI_TRANSPORT_INPUT_ERROR" as const;

  constructor(message: string) {
    super(message);
    this.name = "WslPiProcessTransportInputError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function validateWslPiDistribution(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.startsWith("-") ||
    !WSL_PI_DISTRIBUTION_PATTERN.test(value)
  ) {
    throw new WslPiProcessTransportInputError(
      `Invalid WSL distribution name: ${String(value)}`,
    );
  }

  return value;
}

export function validateCanonicalLinuxWorkspacePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new WslPiProcessTransportInputError("Linux workspace path must not be empty");
  }

  if (value.includes("\u0000")) {
    throw new WslPiProcessTransportInputError(
      "Linux workspace path must not contain a NUL character",
    );
  }

  if (!value.startsWith("/")) {
    throw new WslPiProcessTransportInputError(
      `Linux workspace path must be absolute: ${value}`,
    );
  }

  if (value !== "/" && (value.includes("\\") || value.includes("//") || value.endsWith("/"))) {
    throw new WslPiProcessTransportInputError(
      `Linux workspace path must be canonical: ${value}`,
    );
  }

  const segments = value.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new WslPiProcessTransportInputError(
      `Linux workspace path must not contain dot segments: ${value}`,
    );
  }

  return value;
}

function validateExecutable(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim().length === 0) {
    throw new WslPiProcessTransportInputError("WSL executable must not be empty");
  }

  if (value.includes("\u0000")) {
    throw new WslPiProcessTransportInputError(
      "WSL executable must not contain a NUL character",
    );
  }

  return value;
}

/**
 * The Node-style writable surface the stdin adapter needs. The real child
 * stdin is a Node `Writable`: `write()` reports backpressure synchronously as
 * a boolean and settles the actual I/O through its callback. Test fakes mirror
 * this shape so the adapter can be exercised without WSL.
 */
export interface WslPiProcessStdinWritable {
  write(
    chunk: string,
    callback?: (error?: Error | null) => void,
  ): boolean;
  end(): void | PromiseLike<void>;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

/**
 * Adapts the raw child stdin to the client-facing {@link PiRpcWritable}
 * boundary. Node's `Writable#write` hands back a backpressure boolean and only
 * reports completion/errors through its callback; this adapter converts each
 * write into a Promise settled by that callback, so callers can await the
 * actual I/O instead of polling a boolean.
 */
export class WslPiProcessStdinAdapter implements PiRpcWritable {
  private readonly stdin: WslPiProcessStdinWritable;

  constructor(stdin: WslPiProcessStdinWritable) {
    this.stdin = stdin;
  }

  write(chunk: string): Promise<boolean | void> {
    return new Promise<boolean | void>((resolve, reject) => {
      this.stdin.write(chunk, (error?: Error | null) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  end(): void | PromiseLike<void> {
    return this.stdin.end();
  }

  on(event: "error", listener: (error: unknown) => void): unknown {
    return this.stdin.on(event, listener);
  }
}

const defaultSpawn: WslPiProcessSpawn = (executable, argv, options) =>
  nodeSpawn(executable, [...argv], {
    shell: options.shell,
    windowsHide: options.windowsHide,
    stdio: options.stdio,
  }) as unknown as WslPiSpawnedChild;

export class WslPiProcessTransport implements PiRpcTransport {
  readonly stdin: PiRpcWritable;
  readonly stdout: PiRpcReadable;
  readonly stderr: PiRpcReadable;

  private readonly child: WslPiSpawnedChild;

  constructor(options: WslPiProcessTransportOptions) {
    const distro = validateWslPiDistribution(options?.distro);
    const linuxPath = validateCanonicalLinuxWorkspacePath(options?.linuxPath);
    const executable = validateExecutable(options?.executable ?? DEFAULT_WSL_PI_EXECUTABLE);
    const piExecutable = validateExecutable(options?.piExecutable ?? "pi");
    const spawnProcess = options?.spawn ?? defaultSpawn;
    const argv = [
      "-d",
      distro,
      "--cd",
      linuxPath,
      "--",
      piExecutable,
      "--mode",
      "rpc",
    ];

    const child = spawnProcess(executable, argv, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!child || !child.stdin || !child.stdout || !child.stderr) {
      throw new WslPiProcessTransportInputError(
        "The WSL Pi process must expose piped stdin, stdout, and stderr",
      );
    }

    this.child = child;
    // The spawn seam types stdin as the client-facing PiRpcWritable, but the
    // real child stdin (and the test fakes) expose Node-style callback
    // writes. The adapter converts the synchronous backpressure boolean into
    // a callback-driven Promise without leaking the raw stream to the client.
    this.stdin = new WslPiProcessStdinAdapter(
      child.stdin as unknown as WslPiProcessStdinWritable,
    );
    this.stdout = child.stdout;
    this.stderr = child.stderr;
  }

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
    return this.child.on(event as never, listener as never);
  }

  kill(signal?: PiRpcProcessSignal): boolean | void {
    return signal === undefined ? this.child.kill() : this.child.kill(signal);
  }
}

export function createWslPiProcessTransport(
  options: WslPiProcessTransportOptions,
): WslPiProcessTransport {
  return new WslPiProcessTransport(options);
}

/** Create a streaming Pi transport backed by `wsl.exe`. */
export function createWslPiTransport(
  options: WslPiProcessTransportOptions,
): PiRpcTransport {
  return new WslPiProcessTransport(options);
}
