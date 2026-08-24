import type { PiRpcFailureResponse, RpcRequestId } from "./protocol.ts";

export class PiRpcError extends Error {
  readonly code: string;
  readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "PiRpcError";
    this.code = code;
    this.cause = cause;
  }
}

export type PiRpcTransportFailureSource = "factory" | "process" | "stdin" | "stdout" | "stderr";

export class PiRpcTransportError extends PiRpcError {
  readonly source: PiRpcTransportFailureSource;

  constructor(
    message: string,
    source: PiRpcTransportFailureSource,
    cause?: unknown,
  ) {
    super("TRANSPORT_ERROR", message, cause);
    this.name = "PiRpcTransportError";
    this.source = source;
  }
}

export class PiRpcProtocolError extends PiRpcError {
  readonly line?: string;

  constructor(message: string, line?: string, cause?: unknown) {
    super("PROTOCOL_ERROR", message, cause);
    this.name = "PiRpcProtocolError";
    this.line = line;
  }
}

export class PiRpcTimeoutError extends PiRpcError {
  readonly requestId: RpcRequestId;
  readonly command: string;
  readonly timeoutMs: number;

  constructor(requestId: RpcRequestId, command: string, timeoutMs: number, stderr?: string) {
    const stderrSuffix = stderr ? ` Stderr: ${stderr}` : "";
    super(
      "TIMEOUT",
      `Timed out waiting ${timeoutMs}ms for Pi RPC command ${command} (${String(requestId)}).${stderrSuffix}`,
    );
    this.name = "PiRpcTimeoutError";
    this.requestId = requestId;
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

export class PiRpcCommandError extends PiRpcError {
  readonly requestId: RpcRequestId;
  readonly command: string;
  readonly response: PiRpcFailureResponse;

  constructor(requestId: RpcRequestId, command: string, response: PiRpcFailureResponse) {
    super(
      "COMMAND_ERROR",
      `Pi RPC command ${command} (${String(requestId)}) failed: ${response.error ?? "unknown error"}`,
    );
    this.name = "PiRpcCommandError";
    this.requestId = requestId;
    this.command = command;
    this.response = response;
  }
}

export class PiRpcClosedError extends PiRpcError {
  constructor(message = "Pi RPC client is closed") {
    super("CLOSED", message);
    this.name = "PiRpcClosedError";
  }
}
