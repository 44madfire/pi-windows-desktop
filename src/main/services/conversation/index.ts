import type {
  ConversationBashRecord,
  ConversationEvent,
  ConversationMessageRecord,
  ConversationRecordStatus,
  ConversationSnapshot,
  ConversationTimelineRecord,
  ConversationToolRecord,
} from '../../../shared/conversation.ts';
import { PiRpcClient, type PiRpcEvent } from '../pi/index.ts';

export type { ConversationEvent, ConversationSnapshot } from '../../../shared/conversation.ts';

type Prompt = { id: number; message: string };
type Listener = (event: ConversationEvent) => void;

/**
 * Optional post-settle hook wired by the runtime: after `agent_settled`
 * completes the active turn, the controller keeps the queue paused while the
 * hook runs (synchronize -> reconcile -> persist), and only then dispatches
 * the next queued prompt. A rejected hook leaves the queue paused with a
 * visible error state; the reconnect handshake resumes it.
 */
export interface ConversationControllerOptions {
  readonly onSettle?: () => Promise<void>;
}

/** Streaming accumulation for the assistant message currently being produced. */
interface StreamingAssistant {
  /** content-block index -> accumulated visible text */
  textByIndex: Map<number, string>;
  /** content-block index -> accumulated thinking */
  thinkingByIndex: Map<number, string>;
  /** text deltas received before any text block was visible in a snapshot */
  pendingText: string;
  /** thinking deltas received before any thinking block was visible in a snapshot */
  pendingThinking: string;
}

function now(): string {
  return new Date().toISOString();
}

function stringValue(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : String(value);
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function messageText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((part) => {
      const item = objectValue(part);
      return item && typeof item.text === 'string' ? item.text : '';
    }).join('');
  }
  const record = objectValue(value);
  if (!record) return '';
  if (typeof record.content === 'string') return record.content;
  if (Array.isArray(record.content)) {
    return record.content.map((part) => {
      const item = objectValue(part);
      return item && typeof item.text === 'string' ? item.text : '';
    }).join('');
  }
  return typeof record.text === 'string' ? record.text : '';
}

function isBashTool(name: string, event: Record<string, unknown>): boolean {
  return name.toLowerCase() === 'bash' || name.toLowerCase() === 'shell' || Boolean(event.command);
}

/**
 * Typed adapter for current Pi tool-execution events. Current records carry
 * the call arguments under `args` (bash -> `{ command }`), the in-flight
 * output as `partialResult`, and the authoritative final output as
 * `result.content` with a top-level `isError` status. Legacy records put
 * `command`/`output`/`exitCode` at the top level; callers fall back to those.
 */
interface CurrentToolEvent {
  readonly toolCallId: string | undefined;
  readonly toolName: string | undefined;
  readonly command: string | undefined;
  readonly partialOutput: string;
  readonly resultOutput: string;
  readonly isError: boolean;
}

function currentToolEvent(event: Record<string, unknown>): CurrentToolEvent {
  const args = objectValue(event.args);
  const command = args && typeof args.command === 'string' ? args.command : undefined;
  return {
    toolCallId: stringValue(event.toolCallId),
    toolName: stringValue(event.toolName),
    command,
    partialOutput: messageText(event.partialResult),
    resultOutput: messageText(event.result),
    isError: event.isError === true,
  };
}

/** Assistant message content blocks with their array positions. */
function contentBlocks(value: unknown): Array<{ index: number; block: Record<string, unknown> }> | null {
  // Session entries carry `message.content` as the bare block array; live
  // events carry it under a message/partial record. Accept both.
  const content = Array.isArray(value) ? value : objectValue(value)?.content;
  if (!Array.isArray(content)) return null;
  const blocks: Array<{ index: number; block: Record<string, unknown> }> = [];
  for (let index = 0; index < content.length; index++) {
    const block = objectValue(content[index]);
    if (block) blocks.push({ index, block });
  }
  return blocks;
}

/**
 * Grow-only reconciliation of a cumulative block snapshot against the text
 * already accumulated for that block: snapshots may extend earlier text, but a
 * stale or truncated snapshot must never roll the known stream backward.
 */
function mergeBlockSnapshot(previous: string, update: string): string {
  if (!update) return previous;
  if (!previous) return update;
  if (update === previous) return previous;
  if (update.startsWith(previous)) return update;
  if (previous.startsWith(update)) return previous;
  return previous + update;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Visible assistant text: `text` blocks in content order, thinking excluded. */
function assistantText(value: unknown): string {
  const blocks = contentBlocks(value);
  if (!blocks) return messageText(value);
  let text = "";
  for (const { block } of blocks) {
    if (block.type === "text" && typeof block.text === "string") text += block.text;
  }
  return text;
}

interface HydratedToolCall {
  readonly name: string;
  readonly input?: string;
}

/**
 * Collect assistant toolCall blocks so tool results carry their tool
 * name/command. Current Pi blocks carry `id`/`name`/`arguments` (bash command
 * under `arguments.command`); legacy blocks carry `toolCallId`/`toolName`/
 * `input`. Both shapes are accepted so hydrated history stays correct across
 * Pi versions.
 */
function collectToolCalls(entries: readonly unknown[]): Map<string, HydratedToolCall> {
  const calls = new Map<string, HydratedToolCall>();
  for (const raw of entries) {
    const entry = objectValue(raw);
    if (!entry || entry.type !== "message") continue;
    const message = objectValue(entry.message);
    if (!message || message.role !== "assistant") continue;
    const blocks = contentBlocks(message.content);
    if (!blocks) continue;
    for (const { block } of blocks) {
      if (block.type !== "toolCall") continue;
      const id = stringValue(block.id) ?? stringValue(block.toolCallId);
      if (id === undefined) continue;
      const args = objectValue(block.arguments) ?? objectValue(block.input);
      calls.set(id, {
        name: stringValue(block.name) ?? stringValue(block.toolName) ?? "Tool",
        input: args && typeof args.command === "string" ? args.command : undefined,
      });
    }
  }
  return calls;
}

/**
 * Stable identity match between a projected authoritative record and a live
 * timeline record. Messages match by role plus identical content; tool/bash
 * records match by tool identity (name, input/command, and output) when the
 * two sides do not already share the Pi toolCallId.
 */
function recordMatches(
  record: ConversationTimelineRecord,
  candidate: ConversationTimelineRecord,
): boolean {
  if (record.type === 'message') {
    return (
      candidate.type === 'message' &&
      candidate.role === record.role &&
      candidate.content === record.content
    );
  }
  if (candidate.type !== record.type) return false;
  if (record.type === 'bash') {
    if (candidate.type !== 'bash') return false;
    return candidate.command === record.command && (candidate.output ?? '') === (record.output ?? '');
  }
  if (record.type === 'tool' && candidate.type === 'tool') {
    return (
      candidate.name === record.name &&
      (candidate.input ?? '') === (record.input ?? '') &&
      (candidate.output ?? '') === (record.output ?? '')
    );
  }
  return false;
}

/**
 * Project one raw Pi session entry into a timeline record. Entries that are
 * not user/assistant message entries or tool results (compactions, model
 * changes, custom entries, ...) project to null.
 */
function projectEntry(
  raw: unknown,
  toolCalls: Map<string, HydratedToolCall>,
): ConversationTimelineRecord | null {
  const entry = objectValue(raw);
  if (!entry || entry.type !== "message") return null;
  const message = objectValue(entry.message);
  if (!message) return null;
  const entryId = stringValue(entry.id);
  const createdAt = stringValue(entry.timestamp);
  if (entryId === undefined) return null;

  switch (message.role) {
    case "user": {
      return {
        id: entryId,
        type: "message",
        role: "user",
        content: messageText(message.content),
        createdAt,
      };
    }
    case "assistant": {
      const content = assistantText(message.content);
      if (!content) return null;
      return { id: entryId, type: "message", role: "assistant", content, createdAt };
    }
    case "toolResult": {
      const toolCallId = stringValue(message.toolCallId);
      if (toolCallId === undefined) return null;
      const call = toolCalls.get(toolCallId);
      const name = stringValue(message.toolName) ?? call?.name ?? "Tool";
      const output = messageText(message.content) || undefined;
      const status = message.isError === true ? "failed" : "completed";
      if (name.toLowerCase() === "bash" || name.toLowerCase() === "shell") {
        return {
          id: toolCallId,
          type: "bash",
          command: call?.input ?? output ?? name,
          status,
          output,
          exitCode: numberValue(message.exitCode),
          createdAt,
        };
      }
      return {
        id: toolCallId,
        type: "tool",
        name,
        status,
        input: call?.input,
        output,
        createdAt,
      };
    }
    default:
      return null;
  }
}

export class ConversationController {
  private readonly client: PiRpcClient;
  private readonly listeners = new Set<Listener>();
  private readonly queue: Prompt[] = [];
  private readonly records: ConversationTimelineRecord[] = [];
  /** Entry/tool-call ids already projected by hydrate, for idempotent replays. */
  private readonly hydratedRecordIds = new Set<string>();
  private readonly hydratedToolCalls = new Map<string, HydratedToolCall>();
  /** Live record ids already matched to an authoritative Pi entry. */
  private readonly reconciledRecordIds = new Set<string>();
  private readonly onSettle: (() => Promise<void>) | null;
  private promptId = 0;
  private recordId = 0;
  private activePrompt: Prompt | null = null;
  /** Whether the active turn is being aborted by the user (affects tool settlement). */
  private abortRequested = false;
  /**
   * Auto-dispatch is paused after a transport/client failure. Prompts sent
   * while paused stay queued; only the runtime reconnect handshake resumes
   * dispatching via {@link resumeQueuedPrompts}.
   */
  private queuePaused = false;
  private activeToolId: string | null = null;
  private streamingState: StreamingAssistant | null = null;
  private snapshotValue: ConversationSnapshot = {
    timeline: [],
    executionState: 'idle',
    queuedPromptCount: 0,
    error: null,
  };

  constructor(client: PiRpcClient, options: ConversationControllerOptions = {}) {
    this.client = client;
    this.onSettle = options.onSettle ?? null;
    this.client.onEvent((event) => this.handleEvent(event));
    this.client.onError((error) => {
      const message = error instanceof Error ? error.message : String(error);
      // A transport failure must not auto-dispatch the next queued prompt
      // into a disconnected client: pause the queue and let the runtime
      // reconnect handshake resume it explicitly.
      this.pauseQueue();
      if (this.activePrompt) {
        // A transport/client failure while a turn is active must not leave
        // the controller blocked with a stuck active prompt: fail the turn
        // and publish a visible error state. The failed active prompt is
        // never replayed; queued prompts wait for the resume seam.
        this.failActiveTurn(message);
      } else {
        this.setState('error', message);
      }
    });
  }

  get snapshot(): ConversationSnapshot {
    return { ...this.snapshotValue, timeline: this.snapshotValue.timeline.map((record) => ({ ...record })) };
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    listener({ type: 'conversation', snapshot: this.snapshot });
    return () => this.listeners.delete(listener);
  }

  /**
   * Project raw Pi session entries (the `entries` of a `get_entries` response)
   * into the same timeline the live reducer appends to.
   *
   * Idempotent: entries are keyed by their Pi entry/tool-call id, so replaying
   * the same entries (a second synchronize, a reconnection) never duplicates
   * history. A live record created during this process that already represents
   * an authoritative entry (same role/content or stable tool identity) is
   * reconciled instead of appended: its Pi entry id is remembered as known and
   * only genuinely new history is appended. Hydration does not change
   * execution state, the queue, or streaming state, and a later live message
   * is a new record appended after the hydrated history.
   */
  hydrate(entries: readonly unknown[]): void {
    const toolCalls = collectToolCalls(entries);
    for (const [id, call] of toolCalls) this.hydratedToolCalls.set(id, call);

    // Live records claimed by an authoritative entry during this pass: a
    // duplicate Pi entry must never claim the same live record twice.
    const matchedLive = new Set<string>();

    let changed = false;
    for (const raw of entries) {
      const record = projectEntry(raw, this.hydratedToolCalls);
      if (!record) continue;
      if (this.hydratedRecordIds.has(record.id)) continue;

      // An identical id is already on the timeline (live tool records share
      // Pi's toolCallId; a previous hydrate appended the entry): the entry is
      // known and must never append again.
      if (this.records.some((existing) => existing.id === record.id)) {
        this.hydratedRecordIds.add(record.id);
        continue;
      }

      // A live record created during this process may already represent the
      // authoritative entry (same role/content or stable tool identity):
      // claim it, remember the Pi entry id, and never append a duplicate.
      const live = this.findUnmatchedLiveRecord(record, matchedLive);
      if (live) {
        this.hydratedRecordIds.add(record.id);
        this.reconciledRecordIds.add(live.id);
        matchedLive.add(live.id);
        continue;
      }

      // Genuinely new history: append and remember the Pi entry id.
      this.hydratedRecordIds.add(record.id);
      this.records.push(record);
      changed = true;
    }
    if (changed) this.publish();
  }

  /**
   * Find the earliest live record that represents the same authoritative
   * turn entry, so the entry is reconciled instead of appended. Only records
   * that have not already been claimed by an authoritative entry (this pass
   * or an earlier one) are eligible, so a replayed entry never matches
   * twice and a duplicate entry with identical content cannot claim a record
   * that already represents a different entry.
   */
  private findUnmatchedLiveRecord(
    record: ConversationTimelineRecord,
    matchedLive: Set<string>,
  ): ConversationTimelineRecord | undefined {
    for (const candidate of this.records) {
      if (matchedLive.has(candidate.id)) continue;
      if (this.reconciledRecordIds.has(candidate.id)) continue;
      if (this.hydratedRecordIds.has(candidate.id)) continue;
      if (recordMatches(record, candidate)) return candidate;
    }
    return undefined;
  }

  async sendPrompt(message: string): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) return;
    const prompt = { id: ++this.promptId, message: trimmed };
    this.records.push({ id: this.nextRecordId(), type: 'message', role: 'user', content: trimmed, createdAt: now() });
    this.queue.push(prompt);
    this.publish();
    if (!this.activePrompt) await this.processNext();
  }

  async abort(): Promise<void> {
    if (!this.activePrompt || this.snapshotValue.executionState === 'aborting') return;
    this.abortRequested = true;
    this.setState('aborting', null);
    try {
      await this.client.request({ type: 'abort' }, { timeoutMs: 5_000 });
    } catch (error) {
      // A failed abort request (for example the transport died) must not
      // strand the turn: fail it locally so the controller stays recoverable.
      this.failActiveTurn(error instanceof Error ? error.message : String(error));
    }
  }

  private async processNext(): Promise<void> {
    // After a transport failure (or while the client is still disconnected)
    // the queue stays paused: the prompt is retained and no command is sent
    // until the runtime reconnect handshake resumes the queue. Sending into
    // a disconnected client would only reject on the wire.
    if (this.queuePaused || this.client.state === 'disconnected') {
      if (this.client.state === 'disconnected') this.queuePaused = true;
      this.publish();
      return;
    }
    const prompt = this.queue.shift();
    if (!prompt) {
      this.publish();
      return;
    }
    this.activePrompt = prompt;
    this.abortRequested = false;
    this.streamingState = null;
    this.setState('starting', null);
    try {
      // Pi's prompt response only acknowledges acceptance; the run stays
      // active until the agent_settled event completes the turn.
      await this.client.request({ type: 'prompt', message: prompt.message }, { timeoutMs: Infinity });
    } catch (error) {
      // Transport failures are already handled by the onError listener (it
      // runs before this pending-request rejection microtask); only fail the
      // turn when it is still ours to fail.
      if (this.activePrompt?.id === prompt.id) {
        this.failActiveTurn(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private handleEvent(event: PiRpcEvent): void {
    const record = event as Record<string, unknown>;
    switch (event.type) {
      case 'agent_start':
      case 'turn_start':
        if (this.activePrompt) this.setState('running', null);
        break;
      case 'message_start': {
        const message = objectValue(record.message);
        if (message?.role === 'assistant') {
          this.streamingState = { textByIndex: new Map(), thinkingByIndex: new Map(), pendingText: '', pendingThinking: '' };
          this.setState('streaming', null);
        }
        break;
      }
      case 'message_update': {
        // Current Pi emits delta-only updates (`usage` + `assistantMessageEvent`)
        // with no top-level `message`; legacy updates carry an assistant
        // `message` with a cumulative content snapshot. Either shape feeds
        // the streaming reducer; user-role echoes are ignored.
        const message = objectValue(record.message);
        const ame = objectValue(record.assistantMessageEvent);
        if (message?.role === 'assistant' || ame) {
          this.applyAssistantDelta(record);
          this.setState('streaming', null);
        }
        break;
      }
      case 'message_end': {
        const message = objectValue(record.message);
        if (message?.role === 'assistant') {
          const text = messageText(record.message) || this.streamingText() || '';
          if (text) {
            this.records.push({ id: this.nextRecordId(), type: 'message', role: 'assistant', content: text, createdAt: now() });
          }
          this.streamingState = null;
          this.publish();
        }
        break;
      }
      case 'tool_execution_start':
        this.startTool(record);
        break;
      case 'tool_execution_update':
        this.updateTool(record);
        break;
      case 'tool_execution_end':
        this.endTool(record);
        break;
      case 'agent_settled':
        // Pi settles the run only after every event for the turn has been
        // emitted; this is the authoritative completion point.
        this.completeTurn();
        break;
      case 'agent_end':
      case 'turn_end':
        this.publish();
        break;
      default:
        break;
    }
  }

  private applyAssistantDelta(event: Record<string, unknown>): void {
    let state = this.streamingState;
    if (!state) {
      state = { textByIndex: new Map(), thinkingByIndex: new Map(), pendingText: '', pendingThinking: '' };
      this.streamingState = state;
    }
    const message = objectValue(event.message);
    const ame = objectValue(event.assistantMessageEvent);
    const blocks = contentBlocks(message) ?? (ame ? contentBlocks(ame.partial) : null);
    const hasText = blocks?.some(({ block }) => block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) ?? false;
    const hasThinking = blocks?.some(({ block }) => block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) ?? false;

    // Reconcile visible content blocks into per-index accumulators. Blocks
    // missing from a partial snapshot (stale or truncated) keep their text.
    if (blocks) {
      for (const { index, block } of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const previous = state.pendingText || state.textByIndex.get(index) || '';
          state.textByIndex.set(index, mergeBlockSnapshot(previous, block.text));
          state.pendingText = '';
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          const previous = state.pendingThinking || state.thinkingByIndex.get(index) || '';
          state.thinkingByIndex.set(index, mergeBlockSnapshot(previous, block.thinking));
          state.pendingThinking = '';
        }
      }
    }

    // Deltas address the streamed content block. Current Pi events carry a
    // `contentIndex` and no snapshot at all; legacy events omit it and are
    // applied only while no cumulative snapshot text of that kind is visible.
    if (ame) {
      const index = numberValue(ame.contentIndex);
      if (index !== undefined) {
        // Deltas are incremental chunks: append literally (a re-sent chunk is
        // still new stream text). End content is the block's cumulative text,
        // so it stays grow-only.
        if (ame.type === 'text_delta' && typeof ame.delta === 'string' && ame.delta.length > 0) {
          state.textByIndex.set(index, (state.textByIndex.get(index) ?? '') + ame.delta);
        } else if (ame.type === 'thinking_delta' && typeof ame.delta === 'string' && ame.delta.length > 0) {
          state.thinkingByIndex.set(index, (state.thinkingByIndex.get(index) ?? '') + ame.delta);
        } else if (ame.type === 'text_end' && typeof ame.content === 'string' && ame.content.length > 0) {
          state.textByIndex.set(index, mergeBlockSnapshot(state.textByIndex.get(index) ?? '', ame.content));
        } else if (ame.type === 'thinking_end' && typeof ame.content === 'string' && ame.content.length > 0) {
          state.thinkingByIndex.set(index, mergeBlockSnapshot(state.thinkingByIndex.get(index) ?? '', ame.content));
        }
        // text_start/thinking_start are markers for a new block; nothing to
        // accumulate until a delta arrives.
      } else if (ame.type === 'text_delta' && typeof ame.delta === 'string' && ame.delta.length > 0 && !hasText) {
        state.pendingText += ame.delta;
      } else if (ame.type === 'thinking_delta' && typeof ame.delta === 'string' && ame.delta.length > 0 && !hasThinking) {
        state.pendingThinking += ame.delta;
      } else if (ame.type === 'text_end' && typeof ame.content === 'string' && ame.content.length > 0) {
        const textBlock = blocks ? [...blocks].reverse().find(({ block }) => block.type === 'text') : undefined;
        if (textBlock) {
          state.textByIndex.set(textBlock.index, mergeBlockSnapshot(state.textByIndex.get(textBlock.index) ?? '', ame.content));
        } else {
          state.pendingText = mergeBlockSnapshot(state.pendingText, ame.content);
        }
      } else if (ame.type === 'thinking_end' && typeof ame.content === 'string' && ame.content.length > 0) {
        const thinkingBlock = blocks ? [...blocks].reverse().find(({ block }) => block.type === 'thinking') : undefined;
        if (thinkingBlock) {
          state.thinkingByIndex.set(thinkingBlock.index, mergeBlockSnapshot(state.thinkingByIndex.get(thinkingBlock.index) ?? '', ame.content));
        } else {
          state.pendingThinking = mergeBlockSnapshot(state.pendingThinking, ame.content);
        }
      }
    }
  }

  /** Visible assistant text: accumulated text blocks in content order. */
  private streamingText(): string {
    const state = this.streamingState;
    if (!state) return '';
    const parts: string[] = [];
    for (const index of [...state.textByIndex.keys()].sort((a, b) => a - b)) {
      const text = state.textByIndex.get(index);
      if (text) parts.push(text);
    }
    if (state.pendingText) parts.push(state.pendingText);
    return parts.join('');
  }

  private completeTurn(): void {
    if (!this.activePrompt) return;
    // A turn that settled after the user aborted must not report its still
    // active tools as completed: they were cancelled.
    const status = this.abortRequested ? 'cancelled' : 'completed';
    this.abortRequested = false;
    this.finishStreaming(status);
    this.activePrompt = null;
    this.setState('idle', null);
    void this.settleThenDispatch();
  }

  /**
   * Dispatch the next queued prompt only after the post-settled
   * synchronization. The queue stays paused while the runtime's settle hook
   * runs (synchronize -> reconcile -> persist); a rejected hook leaves the
   * queue paused with a visible error state and the reconnect handshake is
   * the recovery seam. Without a hook the pre-existing immediate dispatch is
   * preserved.
   */
  private async settleThenDispatch(): Promise<void> {
    const hook = this.onSettle;
    if (!hook) {
      void this.processNext();
      return;
    }
    this.queuePaused = true;
    try {
      await hook();
      this.queuePaused = false;
      void this.processNext();
    } catch (error) {
      this.setState('error', error instanceof Error ? error.message : String(error));
    }
  }

  private startTool(event: Record<string, unknown>): void {
    const tool = currentToolEvent(event);
    const id = tool.toolCallId ?? this.nextRecordId();
    const name = tool.toolName ?? stringValue(event.name) ?? 'Tool';
    const base = { id, name, status: 'running' as const, createdAt: now() };
    if (isBashTool(name, event)) {
      const record: ConversationBashRecord = {
        ...base,
        type: 'bash',
        command: stringValue(event.command) ?? stringValue(event.input) ?? tool.command ?? name,
      };
      this.records.push(record);
    } else {
      const record: ConversationToolRecord = {
        ...base,
        type: 'tool',
        input: stringValue(event.input) ?? tool.command ?? (typeof event.args === 'string' ? event.args : undefined),
      };
      this.records.push(record);
    }
    this.activeToolId = id;
    this.publish();
  }

  private updateTool(event: Record<string, unknown>): void {
    const tool = currentToolEvent(event);
    const id = tool.toolCallId ?? this.activeToolId;
    const target = this.records.find((record) => record.id === id);
    if (!target || (target.type !== 'tool' && target.type !== 'bash')) return;
    const output = stringValue(event.output) ?? stringValue(event.message) ?? tool.partialOutput;
    if (output) target.output = output;
    this.publish();
  }

  private endTool(event: Record<string, unknown>): void {
    const tool = currentToolEvent(event);
    const id = tool.toolCallId ?? this.activeToolId;
    const target = this.records.find((record) => record.id === id);
    if (!target || (target.type !== 'tool' && target.type !== 'bash')) return;
    // An end event landing after an abort was requested means the tool was
    // still active when the user cancelled the turn: settle it as cancelled
    // rather than completed/failed.
    target.status = this.abortRequested ? 'cancelled' : tool.isError || stringValue(event.error) ? 'failed' : 'completed';
    if (target.type === 'bash') {
      const exitCode = Number(event.exitCode);
      if (Number.isFinite(exitCode)) target.exitCode = exitCode;
    }
    // result.content (current Pi) or a top-level output is the authoritative
    // final tool output; only overwrite the accumulated partial when present.
    const finalOutput = stringValue(event.output) ?? tool.resultOutput;
    if (finalOutput) target.output = finalOutput;
    target.error = stringValue(event.error);
    this.activeToolId = null;
    this.publish();
  }

  /**
   * Fail the active turn locally after a transport/client failure or a failed
   * prompt/abort request. Clears the active prompt and publishes a visible
   * error state. The failed active prompt is never replayed, and the queue is
   * not auto-advanced here: transport failures pause the queue (see
   * {@link pauseQueue}) and only the runtime reconnect handshake resumes it
   * via {@link resumeQueuedPrompts}. A no-op when the turn was already failed
   * (the transport error listener and the pending-request rejection can both
   * surface the same failure).
   */
  private failActiveTurn(message: string): void {
    if (!this.activePrompt) return;
    const status = this.abortRequested ? 'cancelled' : 'failed';
    this.finishStreaming(status, message);
    this.activePrompt = null;
    this.abortRequested = false;
    this.setState('error', message);
  }

  /**
   * Pause auto-dispatch after a transport/client failure. Queued prompts are
   * retained; sendPrompt still enqueues while paused but nothing is sent
   * until {@link resumeQueuedPrompts} runs after the reconnect handshake.
   */
  private pauseQueue(): void {
    this.queuePaused = true;
  }

  /**
   * Resume dispatching queued prompts after the runtime reconnect handshake.
   * Clears the paused flag and the visible transport error state, then
   * dispatches the next queued prompt when the turn is idle. A prompt that
   * was already accepted (or attempted) before the failure is never replayed;
   * only still-queued prompts are dispatched from here. Safe to call
   * defensively while a turn is active: it only unpauses in that case.
   */
  resumeQueuedPrompts(): void {
    this.queuePaused = false;
    if (this.activePrompt) return;
    this.setState('idle', null);
    void this.processNext();
  }

  private finishStreaming(status: ConversationRecordStatus, error?: string): void {
    const text = this.streamingText();
    if (text) {
      this.records.push({ id: this.nextRecordId(), type: 'message', role: 'assistant', content: text, createdAt: now() });
    }
    this.streamingState = null;
    if (error) this.snapshotValue.error = error;
    for (const record of this.records) {
      if (record.type === 'tool' || record.type === 'bash') {
        if (record.status === 'running') record.status = status;
      }
    }
    this.publish();
  }

  private setState(executionState: ConversationSnapshot['executionState'], error: string | null): void {
    this.snapshotValue = { ...this.snapshotValue, executionState, error, queuedPromptCount: this.queue.length };
    this.publish();
  }

  private publish(): void {
    this.snapshotValue = {
      ...this.snapshotValue,
      timeline: this.records.map((record) => ({ ...record })),
      streamingText: this.streamingText() || undefined,
      queuedPromptCount: this.queue.length,
    };
    const event: ConversationEvent = { type: 'conversation', snapshot: this.snapshot };
    for (const listener of this.listeners) listener(event);
  }

  private nextRecordId(): string {
    return `conversation-${++this.recordId}`;
  }
}
