/** A stdout/stderr data chunk accepted by the injectable process seam. */
export type PiRpcDataChunk = string | Uint8Array;

export type PiRpcWriteResult = boolean | void | PromiseLike<boolean | void>;

/** Minimal readable-stream surface used by the client. */
export interface PiRpcReadable {
  on(event: "data", listener: (chunk: PiRpcDataChunk) => void): unknown;
  on(event: "end", listener: () => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

/** Minimal writable-stream surface used by the client. */
export interface PiRpcWritable {
  write(chunk: string): PiRpcWriteResult;
  end(): void | PromiseLike<void>;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

export type PiRpcProcessSignal = "SIGTERM" | "SIGKILL";

/**
 * Process-like I/O supplied by the host. The client deliberately does not
 * spawn Pi; a WSL/process integration can adapt its child process to this
 * interface later, while tests can provide an in-memory fake.
 */
export interface PiRpcTransport {
  readonly stdin: PiRpcWritable;
  readonly stdout: PiRpcReadable;
  readonly stderr: PiRpcReadable;
  on(event: "error", listener: (error: unknown) => void): unknown;
  on(
    event: "exit" | "close",
    listener: (code?: number | null, signal?: string | null) => void,
  ): unknown;
  kill?(signal?: PiRpcProcessSignal): boolean | void;
}

export type PiRpcTransportFactory = () => PiRpcTransport | PromiseLike<PiRpcTransport>;

export interface PiRpcTransportProvider {
  create(): PiRpcTransport | PromiseLike<PiRpcTransport>;
}
