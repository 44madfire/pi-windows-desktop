/** JSON values accepted by Pi's line-oriented RPC protocol. */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue | undefined }
  | JsonValue[];

export type JsonObject = { [key: string]: JsonValue | undefined };

export type RpcRequestId = string | number;

/** A command body before the client adds or preserves its correlation id. */
export interface PiRpcCommand extends JsonObject {
  readonly type: string;
  readonly id?: RpcRequestId;
}

export type PiRpcWireCommand = PiRpcCommand & { readonly id: RpcRequestId };

export interface PiRpcSuccessResponse<TData extends JsonValue = JsonValue> extends JsonObject {
  readonly type: "response";
  readonly id: RpcRequestId;
  readonly command?: string;
  readonly success: true;
  readonly data?: TData;
}

export interface PiRpcFailureResponse extends JsonObject {
  readonly type: "response";
  readonly id: RpcRequestId;
  readonly command?: string;
  readonly success: false;
  readonly error?: string;
  readonly data?: JsonValue;
}

export type PiRpcResponse<TData extends JsonValue = JsonValue> =
  | PiRpcSuccessResponse<TData>
  | PiRpcFailureResponse;

/** A response as it appears on stdout before correlation validation. */
export interface PiRpcWireResponse extends JsonObject {
  readonly type: "response";
  readonly id?: RpcRequestId;
  readonly command?: string;
  readonly success: boolean;
  readonly data?: JsonValue;
  readonly error?: string;
}

/** Agent events and extension UI requests are forwarded without reshaping. */
export interface PiRpcEvent extends JsonObject {
  readonly type: string;
  readonly id?: RpcRequestId;
}

export type PiRpcMessage = PiRpcWireResponse | PiRpcEvent;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRpcRequestId(value: unknown): value is RpcRequestId {
  return (
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

export function parsePiRpcLine(line: string): PiRpcMessage {
  let value: unknown;

  try {
    value = JSON.parse(line) as unknown;
  } catch (error: unknown) {
    throw new PiRpcProtocolError(
      `Invalid JSONL record${line.length > 0 ? `: ${line}` : ""}`,
      line,
      error,
    );
  }

  if (!isJsonObject(value)) {
    throw new PiRpcProtocolError("Pi RPC records must be JSON objects", line);
  }

  if (value.type === "response") {
    if (typeof value.success !== "boolean") {
      throw new PiRpcProtocolError("Pi RPC responses require a boolean success field", line);
    }

    if (value.id !== undefined && !isRpcRequestId(value.id)) {
      throw new PiRpcProtocolError("Pi RPC response ids must be non-empty strings or finite numbers", line);
    }

    if (value.command !== undefined && typeof value.command !== "string") {
      throw new PiRpcProtocolError("Pi RPC response command must be a string", line);
    }

    if (value.error !== undefined && typeof value.error !== "string") {
      throw new PiRpcProtocolError("Pi RPC response error must be a string", line);
    }

    return value as PiRpcWireResponse;
  }

  if (typeof value.type !== "string" || value.type.length === 0) {
    throw new PiRpcProtocolError("Pi RPC events require a non-empty type field", line);
  }

  if (value.id !== undefined && !isRpcRequestId(value.id)) {
    throw new PiRpcProtocolError("Pi RPC event ids must be non-empty strings or finite numbers", line);
  }

  return value as PiRpcEvent;
}

export function serializePiRpcCommand(command: PiRpcWireCommand): string {
  let serialized: string | undefined;

  try {
    serialized = JSON.stringify(command);
  } catch (error: unknown) {
    throw new PiRpcProtocolError("Pi RPC command could not be serialized", undefined, error);
  }

  if (serialized === undefined) {
    throw new PiRpcProtocolError("Pi RPC command could not be serialized");
  }

  return `${serialized}\n`;
}

import { PiRpcProtocolError } from "./errors.ts";

export { PiRpcProtocolError } from "./errors.ts";
