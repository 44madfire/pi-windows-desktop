import { PiJsonlBuffer } from "./jsonl.ts";
import {
  isRpcRequestId,
  parsePiRpcLine,
  serializePiRpcCommand,
  type JsonObject,
  type JsonValue,
  type PiRpcCommand,
  type PiRpcEvent,
  type PiRpcFailureResponse,
  type PiRpcMessage,
  type PiRpcResponse,
  type PiRpcSuccessResponse,
  type PiRpcWireCommand,
  type RpcRequestId,
} from "./protocol.ts";
import {
  PiRpcClosedError,
  PiRpcCommandError,
  PiRpcError,
  PiRpcProtocolError,
  PiRpcTimeoutError,
  PiRpcTransportError,
  type PiRpcTransportFailureSource,
} from "./errors.ts";
import {
  type PiRpcDataChunk,
  type PiRpcProcessSignal,
  type PiRpcTransport,
  type PiRpcTransportFactory,
  type PiRpcTransportProvider,
} from "./transport.ts";

export type PiRpcClientState = "idle" | "connecting" | "ready" | "disconnected" | "closing" | "closed";

export interface PiRpcRequestOptions {
  readonly timeoutMs?: number;
  readonly requestId?: RpcRequestId;
}

export interface PiRpcCloseOptions {
  /** Bounded wait after stdin EOF before the escalation signal. Defaults to closeTimeoutMs. */
  readonly timeoutMs?: number;
  /** Shorter wait after the escalation signal before the SIGKILL fallback. */
  readonly sigkillTimeoutMs?: number;
  /** Escalation signal used when the process does not exit on stdin EOF. Defaults to SIGTERM. */
  readonly signal?: PiRpcProcessSignal;
}

export interface PiRpcClientOptions {
  readonly transportFactory: PiRpcTransportFactory | PiRpcTransportProvider;
  readonly defaultTimeoutMs?: number;
  /** Bounded wait after stdin EOF before the escalation signal during close(). */
  readonly closeTimeoutMs?: number;
  /** Shorter wait after the escalation signal before the SIGKILL fallback during close(). */
  readonly sigkillTimeoutMs?: number;
  readonly requestIdFactory?: () => RpcRequestId;
}

export type PiRpcEventListener = (event: PiRpcEvent) => void | Promise<void>;
export type PiRpcStderrListener = (chunk: string) => void | Promise<void>;
export type PiRpcErrorListener = (error: PiRpcError) => void | Promise<void>;
export type PiRpcStateListener = (state: PiRpcClientState) => void | Promise<void>;
export type PiRpcUnmatchedResponseListener = (response: PiRpcMessage) => void | Promise<void>;

interface ActiveTransport {
  readonly transport: PiRpcTransport;
  readonly stdoutBuffer: PiJsonlBuffer;
  readonly stderrDecoder: TextDecoder;
  ended: boolean;
  stopping: boolean;
  failed: boolean;
}

interface PendingRequest {
  readonly command: string;
  readonly resolve: (response: PiRpcResponse) => void;
  readonly reject: (error: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
}

type ClientOptionsWithoutFactory = Omit<PiRpcClientOptions, "transportFactory">;

export class PiRpcClient {
  private readonly transportFactory: PiRpcTransportFactory | PiRpcTransportProvider;
  private readonly defaultTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly sigkillTimeoutMs: number;
  private readonly requestIdFactory: () => RpcRequestId;

  private stateValue: PiRpcClientState = "idle";
  private activeTransport: ActiveTransport | null = null;
  private connectionPromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private generatedRequestId = 0;
  private lastErrorValue: PiRpcError | null = null;
  private stderrText = "";

  private readonly pendingRequests = new Map<RpcRequestId, PendingRequest>();
  private readonly eventListeners = new Set<PiRpcEventListener>();
  private readonly stderrListeners = new Set<PiRpcStderrListener>();
  private readonly errorListeners = new Set<PiRpcErrorListener>();
  private readonly protocolErrorListeners = new Set<PiRpcErrorListener>();
  private readonly stateListeners = new Set<PiRpcStateListener>();
  private readonly unmatchedResponseListeners = new Set<PiRpcUnmatchedResponseListener>();
  private readonly listenerErrorListeners = new Set<(error: unknown) => void | Promise<void>>();

  constructor(options: PiRpcClientOptions);
  constructor(factory: PiRpcTransportFactory, options?: ClientOptionsWithoutFactory);
  constructor(
    optionsOrFactory: PiRpcClientOptions | PiRpcTransportFactory,
    supplementalOptions: ClientOptionsWithoutFactory = {},
  ) {
    if (typeof optionsOrFactory === "function") {
      this.transportFactory = optionsOrFactory;
      this.defaultTimeoutMs = supplementalOptions.defaultTimeoutMs ?? 30_000;
      this.closeTimeoutMs = supplementalOptions.closeTimeoutMs ?? 1_000;
      this.sigkillTimeoutMs = supplementalOptions.sigkillTimeoutMs ?? 200;
      this.requestIdFactory = supplementalOptions.requestIdFactory ?? (() => `req_${++this.generatedRequestId}`);
    } else {
      this.transportFactory = optionsOrFactory.transportFactory;
      this.defaultTimeoutMs = optionsOrFactory.defaultTimeoutMs ?? 30_000;
      this.closeTimeoutMs = optionsOrFactory.closeTimeoutMs ?? 1_000;
      this.sigkillTimeoutMs = optionsOrFactory.sigkillTimeoutMs ?? 200;
      this.requestIdFactory = optionsOrFactory.requestIdFactory ?? (() => `req_${++this.generatedRequestId}`);
    }

    this.validateTimeout(this.defaultTimeoutMs, "defaultTimeoutMs");
    this.validateTimeout(this.closeTimeoutMs, "closeTimeoutMs");
    this.validateTimeout(this.sigkillTimeoutMs, "sigkillTimeoutMs");
  }

  get state(): PiRpcClientState {
    return this.stateValue;
  }

  get lastError(): PiRpcError | null {
    return this.lastErrorValue;
  }

  getStderr(): string {
    return this.stderrText;
  }

  /** Start one transport. Calling this after a clean close requires reconnect(). */
  connect(): Promise<void> {
    if (this.stateValue === "ready") {
      return Promise.resolve();
    }

    if (this.stateValue === "connecting" && this.connectionPromise) {
      return this.connectionPromise;
    }

    if (this.stateValue === "closing") {
      return Promise.reject(new PiRpcClosedError("Pi RPC client is closing"));
    }

    if (this.stateValue === "closed") {
      return Promise.reject(new PiRpcClosedError("Pi RPC client is closed; call reconnect() to recover"));
    }

    const generation = ++this.lifecycleGeneration;
    this.setState("connecting");

    let connection: Promise<void>;
    connection = Promise.resolve(this.createTransport())
      .then((transport) => {
        if (
          generation !== this.lifecycleGeneration ||
          this.stateValue === "closing" ||
          this.stateValue === "closed"
        ) {
          this.disposeDetachedTransport(transport);
          throw new PiRpcClosedError("Pi RPC connection was cancelled");
        }

        this.attachTransport(transport, generation);
        this.lastErrorValue = null;
        this.setState("ready");
      })
      .catch((error: unknown) => {
        if (generation === this.lifecycleGeneration && this.stateValue === "connecting") {
          const transportError = this.asTransportError(error, "factory");
          this.lastErrorValue = transportError;
          this.setState("disconnected");
          this.notifyError(transportError);
          throw transportError;
        }
        throw error;
      })
      .finally(() => {
        if (this.connectionPromise === connection) {
          this.connectionPromise = null;
        }
      });

    this.connectionPromise = connection;
    return connection;
  }

  /**
   * Replace the current transport. Pending requests are rejected and are not
   * replayed because Pi may have accepted a command before the transport died.
   */
  async reconnect(options: PiRpcCloseOptions = {}): Promise<void> {
    const connection = this.connectionPromise;
    if (connection) {
      await connection.catch(() => undefined);
    }

    if (this.activeTransport) {
      await this.close(options);
    }

    this.lifecycleGeneration++;
    this.setState("idle");
    await this.connect();
  }

  /**
   * Close stdin and wait for Pi to exit on its own, escalating to the
   * configured signal (SIGTERM by default) after a bounded grace period and
   * retaining a shorter SIGKILL fallback only if the process does not stop.
   */
  async close(options: PiRpcCloseOptions = {}): Promise<void> {
    const graceTimeoutMs = options.timeoutMs ?? this.closeTimeoutMs;
    const sigkillTimeoutMs = options.sigkillTimeoutMs ?? this.sigkillTimeoutMs;
    this.validateTimeout(graceTimeoutMs, "close timeoutMs");
    this.validateTimeout(sigkillTimeoutMs, "close sigkillTimeoutMs");

    const connection = this.connectionPromise;
    if (connection && !this.activeTransport) {
      this.lifecycleGeneration++;
      this.setState("closing");
      await connection.catch(() => undefined);
      this.rejectPending(new PiRpcClosedError());
      this.setState("closed");
      return;
    }

    const active = this.activeTransport;
    if (!active) {
      this.lifecycleGeneration++;
      this.rejectPending(new PiRpcClosedError());
      if (this.stateValue !== "closed") {
        this.setState("closed");
      }
      return;
    }

    this.lifecycleGeneration++;
    active.stopping = true;
    this.activeTransport = null;
    this.setState("closing");
    this.rejectPending(new PiRpcClosedError());

    try {
      const endResult = active.transport.stdin.end();
      void Promise.resolve(endResult).catch((error: unknown) => {
        if (!active.ended) {
          this.notifyError(this.asTransportError(error, "stdin"));
        }
      });
    } catch (error: unknown) {
      this.notifyError(this.asTransportError(error, "stdin"));
    }

    // Give Pi a bounded window to exit on its own after stdin EOF.
    const exitedAfterEof = await this.waitForExit(active, graceTimeoutMs);

    if (!exitedAfterEof) {
      const escalationSignal = options.signal ?? "SIGTERM";
      this.signalProcess(active, escalationSignal);

      // Retain a shorter SIGKILL fallback only when escalation did not work.
      if (escalationSignal !== "SIGKILL") {
        const exitedAfterEscalation = await this.waitForExit(active, sigkillTimeoutMs);
        if (!exitedAfterEscalation) {
          this.signalProcess(active, "SIGKILL");
        }
      }
    }

    this.setState("closed");
  }

  /** Send a Pi command and await its correlated response. */
  request<TData extends JsonValue = JsonValue>(
    command: PiRpcCommand,
    options?: PiRpcRequestOptions,
  ): Promise<PiRpcSuccessResponse<TData>>;
  request<TData extends JsonValue = JsonValue>(
    commandType: string,
    fields?: JsonObject,
    options?: PiRpcRequestOptions,
  ): Promise<PiRpcSuccessResponse<TData>>;
  request<TData extends JsonValue = JsonValue>(
    commandOrType: PiRpcCommand | string,
    fieldsOrOptions: JsonObject | PiRpcRequestOptions = {},
    maybeOptions: PiRpcRequestOptions = {},
  ): Promise<PiRpcSuccessResponse<TData>> {
    const command = this.normalizeCommand(commandOrType, fieldsOrOptions);
    const options = typeof commandOrType === "string" ? maybeOptions : (fieldsOrOptions as PiRpcRequestOptions);
    const ready = this.ensureReady();
    if (ready instanceof Promise) {
      return ready.then((active) => this.sendWhenReady<TData>(active, command, options));
    }
    return this.sendWhenReady<TData>(ready, command, options);
  }

  send<TData extends JsonValue = JsonValue>(
    command: PiRpcCommand,
    options?: PiRpcRequestOptions,
  ): Promise<PiRpcSuccessResponse<TData>> {
    return this.request<TData>(command, options);
  }

  /**
   * Write one JSONL command without registering a pending request or waiting
   * for a response. Use this for uncorrelated outbound messages such as
   * extension UI responses (`type: "extension_ui_response"`), which Pi does
   * not answer on stdout.
   *
   * The command's `id` (if any) is preserved verbatim and is not registered
   * as pending, so any response bearing it reaches unmatched response
   * listeners. An id that is already pending in `request()` is rejected to
   * protect correlation.
   *
   * Throws synchronously for invalid commands, invalid ids, or unserializable
   * values. When the transport is not ready the write is queued behind
   * `connect()`; readiness failures and asynchronous `stdin.write()` rejections
   * reject the returned promise and also surface through the error listeners
   * with the client transitioned to disconnected.
   */
  write(command: PiRpcCommand): Promise<void> {
    const normalized = this.normalizeCommand(command);

    if (normalized.id !== undefined) {
      if (!isRpcRequestId(normalized.id)) {
        throw new PiRpcError(
          "INVALID_REQUEST_ID",
          "Pi RPC request ids must be non-empty strings or finite numbers",
        );
      }
      if (this.pendingRequests.has(normalized.id)) {
        throw new PiRpcError(
          "DUPLICATE_REQUEST_ID",
          `Pi RPC request id is already pending: ${String(normalized.id)}`,
        );
      }
    }

    const frame = serializePiRpcCommand(normalized);
    const ready = this.ensureReady();
    if (ready instanceof Promise) {
      return ready.then((active) => this.writeFrame(active, frame));
    }
    return this.writeFrame(ready, frame);
  }

  onEvent(listener: PiRpcEventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onStderr(listener: PiRpcStderrListener): () => void {
    this.stderrListeners.add(listener);
    return () => this.stderrListeners.delete(listener);
  }

  onError(listener: PiRpcErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onProtocolError(listener: PiRpcErrorListener): () => void {
    this.protocolErrorListeners.add(listener);
    return () => this.protocolErrorListeners.delete(listener);
  }

  onStateChange(listener: PiRpcStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onUnmatchedResponse(listener: PiRpcUnmatchedResponseListener): () => void {
    this.unmatchedResponseListeners.add(listener);
    return () => this.unmatchedResponseListeners.delete(listener);
  }

  onListenerError(listener: (error: unknown) => void | Promise<void>): () => void {
    this.listenerErrorListeners.add(listener);
    return () => this.listenerErrorListeners.delete(listener);
  }

  private ensureReady(): ActiveTransport | Promise<ActiveTransport> {
    if (this.stateValue === "ready" && this.activeTransport) {
      return this.activeTransport;
    }

    return this.connect().then(() => {
      if (!this.activeTransport || this.stateValue !== "ready") {
        throw this.lastErrorValue ?? new PiRpcTransportError("Pi RPC transport is not ready", "process");
      }
      return this.activeTransport;
    });
  }

  private sendWhenReady<TData extends JsonValue>(
    active: ActiveTransport,
    command: PiRpcCommand,
    options: PiRpcRequestOptions,
  ): Promise<PiRpcSuccessResponse<TData>> {
    if (this.activeTransport !== active || this.stateValue !== "ready") {
      return Promise.reject(new PiRpcTransportError("Pi RPC transport is no longer ready", "process"));
    }

    return this.sendOnTransport<TData>(active, command, options);
  }

  private createTransport(): PiRpcTransport | PromiseLike<PiRpcTransport> {
    if (typeof this.transportFactory === "function") {
      return this.transportFactory();
    }
    return this.transportFactory.create();
  }

  private attachTransport(transport: PiRpcTransport, generation: number): void {
    const active: ActiveTransport = {
      transport,
      stdoutBuffer: new PiJsonlBuffer(),
      stderrDecoder: new TextDecoder("utf-8"),
      ended: false,
      stopping: false,
      failed: false,
    };
    this.activeTransport = active;

    transport.stdout.on("data", (chunk) => this.handleStdoutChunk(active, chunk));
    transport.stdout.on("end", () => this.handleStdoutEnd(active));
    transport.stdout.on("error", (error) => this.handleTransportFailure(active, error, "stdout"));

    transport.stderr.on("data", (chunk) => this.handleStderrChunk(active, chunk));
    transport.stderr.on("end", () => this.flushStderr(active));
    transport.stderr.on("error", (error) => this.handleTransportFailure(active, error, "stderr"));

    transport.stdin.on("error", (error) => this.handleTransportFailure(active, error, "stdin"));
    transport.on("error", (error) => this.handleTransportFailure(active, error, "process"));
    transport.on("exit", (code, signal) => this.handleTransportEnded(active, code, signal));
    transport.on("close", (code, signal) => this.handleTransportEnded(active, code, signal));
  }

  private handleStdoutChunk(active: ActiveTransport, chunk: PiRpcDataChunk): void {
    if (this.activeTransport !== active || active.failed || active.ended) {
      return;
    }

    try {
      for (const line of active.stdoutBuffer.push(chunk)) {
        if (this.activeTransport !== active || active.failed) {
          break;
        }
        this.handleLine(active, line);
      }
    } catch (error: unknown) {
      const protocolError =
        error instanceof PiRpcError
          ? error
          : new PiRpcTransportError("Unable to decode Pi stdout", "stdout", error);
      this.handleTransportFailure(active, protocolError, "stdout");
    }
  }

  private handleStdoutEnd(active: ActiveTransport): void {
    if (this.activeTransport !== active || active.failed || active.ended || active.stopping) {
      return;
    }

    try {
      const partial = active.stdoutBuffer.finish();
      if (partial !== undefined) {
        this.handleProtocolFailure(
          active,
          new Error("Pi stdout ended with an unterminated JSONL record"),
          partial,
        );
      }
    } catch (error: unknown) {
      this.handleTransportFailure(active, error, "stdout");
    }
  }

  private handleStderrChunk(active: ActiveTransport, chunk: PiRpcDataChunk): void {
    if (active.ended || active.failed || active.stopping) {
      return;
    }

    try {
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
      const text = active.stderrDecoder.decode(bytes, { stream: true });
      this.appendStderr(text);
    } catch (error: unknown) {
      this.handleTransportFailure(active, error, "stderr");
    }
  }

  private flushStderr(active: ActiveTransport): void {
    if (active.ended) {
      return;
    }

    try {
      this.appendStderr(active.stderrDecoder.decode());
    } catch (error: unknown) {
      this.handleTransportFailure(active, error, "stderr");
    }
  }

  private appendStderr(text: string): void {
    if (text.length === 0) {
      return;
    }
    this.stderrText += text;
    this.dispatch(this.stderrListeners, text);
  }

  private handleLine(active: ActiveTransport, line: string): void {
    let message: PiRpcMessage;
    try {
      message = parsePiRpcLine(line);
    } catch (error: unknown) {
      this.handleProtocolFailure(active, error, line);
      return;
    }

    if (message.type === "response") {
      if (message.id === undefined) {
        this.handleProtocolFailure(active, new Error("Pi RPC response is missing its correlation id"), line);
        return;
      }

      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        this.dispatch(this.unmatchedResponseListeners, message);
        return;
      }

      this.pendingRequests.delete(message.id);
      this.clearPendingTimer(pending);

      if (message.success) {
        pending.resolve(message as PiRpcSuccessResponse);
      } else {
        const failure = message as PiRpcFailureResponse;
        pending.reject(new PiRpcCommandError(message.id, pending.command, failure));
      }
      return;
    }

    this.dispatch(this.eventListeners, message);
  }

  private handleProtocolFailure(active: ActiveTransport, error: unknown, line?: string): void {
    const protocolError =
      error instanceof PiRpcProtocolError
        ? error
        : new PiRpcProtocolError(error instanceof Error ? error.message : String(error), line, error);

    this.dispatch(this.protocolErrorListeners, protocolError);
    this.handleTransportFailure(active, protocolError, "stdout");
  }

  private handleTransportFailure(
    active: ActiveTransport,
    error: unknown,
    source: PiRpcTransportFailureSource,
  ): void {
    if (active.failed || active.ended) {
      return;
    }

    active.failed = true;
    const rpcError = error instanceof PiRpcError ? error : this.asTransportError(error, source);
    this.lastErrorValue = rpcError;
    this.rejectPending(rpcError);

    if (this.activeTransport === active) {
      this.activeTransport = null;
      this.setState("disconnected");
    }

    this.notifyError(rpcError);

    try {
      active.transport.kill?.("SIGTERM");
    } catch (killError: unknown) {
      this.notifyError(this.asTransportError(killError, "process"));
    }
  }

  private handleTransportEnded(
    active: ActiveTransport,
    code?: number | null,
    signal?: string | null,
  ): void {
    if (active.ended) {
      return;
    }
    this.flushStderr(active);
    active.ended = true;

    if (active.stopping || active.failed) {
      return;
    }

    const codeText = code === undefined ? "unknown" : String(code);
    const signalText = signal === undefined ? "unknown" : String(signal);
    const error = new PiRpcTransportError(
      `Pi process exited (code=${codeText}, signal=${signalText})${this.stderrText ? `. Stderr: ${this.stderrText}` : ""}`,
      "process",
    );
    this.lastErrorValue = error;
    this.rejectPending(error);

    if (this.activeTransport === active) {
      this.activeTransport = null;
      this.setState("disconnected");
    }
    this.notifyError(error);
  }

  private writeFrame(active: ActiveTransport, frame: string): Promise<void> {
    if (this.activeTransport !== active || this.stateValue !== "ready") {
      // The transport went away between connect() and the write; the
      // disconnect already notified error listeners.
      return Promise.reject(
        new PiRpcTransportError("Pi RPC transport is no longer ready", "process"),
      );
    }

    try {
      const writeResult = active.transport.stdin.write(frame);
      return Promise.resolve(writeResult).then(
        () => undefined,
        (error: unknown) => {
          if (this.activeTransport === active) {
            this.handleTransportFailure(active, error, "stdin");
          }
          throw this.asTransportError(error, "stdin");
        },
      );
    } catch (error: unknown) {
      this.handleTransportFailure(active, error, "stdin");
      return Promise.reject(this.asTransportError(error, "stdin"));
    }
  }

  private sendOnTransport<TData extends JsonValue>(
    active: ActiveTransport,
    command: PiRpcCommand,
    options: PiRpcRequestOptions,
  ): Promise<PiRpcSuccessResponse<TData>> {
    const requestId = options.requestId ?? command.id ?? this.requestIdFactory();
    if (!isRpcRequestId(requestId)) {
      return Promise.reject(new PiRpcError("INVALID_REQUEST_ID", "Pi RPC request ids must be non-empty strings or finite numbers"));
    }
    if (this.pendingRequests.has(requestId)) {
      return Promise.reject(new PiRpcError("DUPLICATE_REQUEST_ID", `Pi RPC request id is already pending: ${String(requestId)}`));
    }

    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    try {
      this.validateTimeout(timeoutMs, "request timeoutMs");
    } catch (error: unknown) {
      return Promise.reject(error);
    }

    const wireCommand = { ...command, id: requestId } as PiRpcWireCommand;
    let frame: string;
    try {
      frame = serializePiRpcCommand(wireCommand);
    } catch (error: unknown) {
      return Promise.reject(error);
    }

    return new Promise<PiRpcSuccessResponse<TData>>((resolve, reject) => {
      const pending: PendingRequest = {
        command: command.type,
        resolve: (response) => resolve(response as PiRpcSuccessResponse<TData>),
        reject,
      };
      this.pendingRequests.set(requestId, pending);

      if (timeoutMs !== Infinity) {
        pending.timer = setTimeout(() => {
          if (this.pendingRequests.get(requestId) !== pending) {
            return;
          }
          this.pendingRequests.delete(requestId);
          const timeoutError = new PiRpcTimeoutError(requestId, command.type, timeoutMs, this.stderrText);
          reject(timeoutError);
        }, timeoutMs);
      }

      try {
        const writeResult = active.transport.stdin.write(frame);
        void Promise.resolve(writeResult).catch((error: unknown) => {
          if (this.pendingRequests.get(requestId) === pending) {
            this.handleTransportFailure(active, error, "stdin");
          }
        });
      } catch (error: unknown) {
        this.handleTransportFailure(active, error, "stdin");
      }
    });
  }

  private normalizeCommand(
    commandOrType: PiRpcCommand | string,
    fieldsOrOptions: JsonObject | PiRpcRequestOptions = {},
  ): PiRpcCommand {
    if (typeof commandOrType !== "string") {
      if (typeof commandOrType.type !== "string" || commandOrType.type.length === 0) {
        throw new PiRpcError("INVALID_COMMAND", "Pi RPC commands require a non-empty type field");
      }
      return { ...commandOrType };
    }

    if (commandOrType.length === 0) {
      throw new PiRpcError("INVALID_COMMAND", "Pi RPC commands require a non-empty type field");
    }

    const fields = fieldsOrOptions as JsonObject;
    return { type: commandOrType, ...fields };
  }

  private rejectPending(error: PiRpcError): void {
    for (const pending of this.pendingRequests.values()) {
      this.clearPendingTimer(pending);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private clearPendingTimer(pending: PendingRequest): void {
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
  }

  private signalProcess(active: ActiveTransport, signal: PiRpcProcessSignal): void {
    try {
      active.transport.kill?.(signal);
    } catch (error: unknown) {
      this.notifyError(this.asTransportError(error, "process"));
    }
  }

  /**
   * Resolve once the transport has ended, or after timeoutMs when it has not.
   * Returns true when the process exited, false when the wait budget elapsed.
   * With an infinite timeout the promise only resolves on exit.
   */
  private waitForExit(active: ActiveTransport, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (exited: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        resolve(exited);
      };

      if (active.ended) {
        finish(true);
        return;
      }

      try {
        active.transport.on("exit", () => finish(true));
        active.transport.on("close", () => finish(true));
      } catch {
        finish(active.ended);
        return;
      }

      if (active.ended) {
        finish(true);
        return;
      }

      if (timeoutMs !== Infinity) {
        timer = setTimeout(() => finish(false), timeoutMs);
      }
    });
  }

  private disposeDetachedTransport(transport: PiRpcTransport): void {
    try {
      transport.stdin.end();
    } catch {
      // The transport is already detached; the process kill below is the recovery path.
    }
    try {
      transport.kill?.("SIGTERM");
    } catch {
      // There is no active client state to update for a cancelled connection.
    }
  }

  private asTransportError(error: unknown, source: PiRpcTransportFailureSource): PiRpcTransportError {
    if (error instanceof PiRpcTransportError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    return new PiRpcTransportError(
      `${message}${this.stderrText ? `. Stderr: ${this.stderrText}` : ""}`,
      source,
      error,
    );
  }

  private validateTimeout(timeoutMs: number, fieldName: string): void {
    if (timeoutMs !== Infinity && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
      throw new RangeError(`${fieldName} must be a non-negative finite number or Infinity`);
    }
  }

  private setState(nextState: PiRpcClientState): void {
    if (this.stateValue === nextState) {
      return;
    }
    this.stateValue = nextState;
    this.dispatch(this.stateListeners, nextState);
  }

  private notifyError(error: PiRpcError): void {
    this.dispatch(this.errorListeners, error);
  }

  private dispatch<T>(listeners: Set<(value: T) => void | Promise<void>>, value: T): void {
    for (const listener of [...listeners]) {
      Promise.resolve()
        .then(() => listener(value))
        .catch((error: unknown) => this.dispatchListenerError(error));
    }
  }

  private dispatchListenerError(error: unknown): void {
    for (const listener of [...this.listenerErrorListeners]) {
      Promise.resolve()
        .then(() => listener(error))
        .catch(() => undefined);
    }
  }
}
