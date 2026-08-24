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
  const record = objectValue(value);
  if (!record) return value === undefined || value === null ? '' : String(value);
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

export class ConversationController {
  private readonly client: PiRpcClient;
  private readonly listeners = new Set<Listener>();
  private readonly queue: Prompt[] = [];
  private readonly records: ConversationTimelineRecord[] = [];
  private promptId = 0;
  private recordId = 0;
  private activePrompt: Prompt | null = null;
  private activeToolId: string | null = null;
  private streamingTextValue: string | undefined;
  private snapshotValue: ConversationSnapshot = {
    timeline: [],
    executionState: 'idle',
    queuedPromptCount: 0,
    error: null,
  };

  constructor(client: PiRpcClient) {
    this.client = client;
    this.client.onEvent((event) => this.handleEvent(event));
    this.client.onError((error) => this.setState('error', error.message));
  }

  get snapshot(): ConversationSnapshot {
    return { ...this.snapshotValue, timeline: this.snapshotValue.timeline.map((record) => ({ ...record })) };
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    listener({ type: 'conversation', snapshot: this.snapshot });
    return () => this.listeners.delete(listener);
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
    if (!this.activePrompt) return;
    this.setState('aborting', null);
    try {
      await this.client.request({ type: 'abort' }, { timeoutMs: 5_000 });
    } catch (error) {
      this.setState('error', error instanceof Error ? error.message : String(error));
    }
  }

  private async processNext(): Promise<void> {
    const prompt = this.queue.shift();
    if (!prompt) {
      this.publish();
      return;
    }
    this.activePrompt = prompt;
    this.streamingTextValue = undefined;
    this.setState('starting', null);
    try {
      await this.client.request({ type: 'prompt', message: prompt.message }, { timeoutMs: Infinity });
      if (this.activePrompt?.id === prompt.id) {
        this.finishStreaming('completed');
        this.activePrompt = null;
        this.setState('idle', null);
      }
    } catch (error) {
      if (this.activePrompt?.id === prompt.id) {
        this.finishStreaming('failed', error instanceof Error ? error.message : String(error));
        this.activePrompt = null;
        this.setState('error', error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!this.activePrompt) void this.processNext();
    }
  }

  private handleEvent(event: PiRpcEvent): void {
    const record = event as Record<string, unknown>;
    switch (event.type) {
      case 'agent_start':
      case 'turn_start':
        if (this.activePrompt) this.setState('running', null);
        break;
      case 'message_start':
        this.streamingTextValue = messageText(record.message);
        this.setState('streaming', null);
        break;
      case 'message_update':
        this.streamingTextValue = messageText(record.message);
        this.setState('streaming', null);
        break;
      case 'message_end': {
        const text = messageText(record.message) || this.streamingTextValue || '';
        if (text) this.records.push({ id: this.nextRecordId(), type: 'message', role: 'assistant', content: text, createdAt: now() });
        this.streamingTextValue = undefined;
        this.publish();
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
      case 'agent_end':
      case 'turn_end':
        this.publish();
        break;
      default:
        break;
    }
  }

  private startTool(event: Record<string, unknown>): void {
    const id = stringValue(event.toolCallId) ?? this.nextRecordId();
    const name = stringValue(event.toolName) ?? stringValue(event.name) ?? 'Tool';
    const base = { id, name, status: 'running' as const, createdAt: now() };
    if (isBashTool(name, event)) {
      const record: ConversationBashRecord = { ...base, type: 'bash', command: stringValue(event.command) ?? stringValue(event.input) ?? name };
      this.records.push(record);
    } else {
      const record: ConversationToolRecord = { ...base, type: 'tool', input: stringValue(event.input) ?? stringValue(event.args) };
      this.records.push(record);
    }
    this.activeToolId = id;
    this.publish();
  }

  private updateTool(event: Record<string, unknown>): void {
    const id = stringValue(event.toolCallId) ?? this.activeToolId;
    const target = this.records.find((record) => record.id === id);
    if (!target || (target.type !== 'tool' && target.type !== 'bash')) return;
    const output = stringValue(event.output) ?? stringValue(event.message) ?? messageText(event.partialResult);
    if (target.type === 'tool') target.output = output;
    else target.output = output;
    this.publish();
  }

  private endTool(event: Record<string, unknown>): void {
    const id = stringValue(event.toolCallId) ?? this.activeToolId;
    const target = this.records.find((record) => record.id === id);
    if (!target || (target.type !== 'tool' && target.type !== 'bash')) return;
    target.status = event.isError || event.error ? 'failed' : 'completed';
    if (target.type === 'bash') {
      const exitCode = Number(event.exitCode);
      if (Number.isFinite(exitCode)) target.exitCode = exitCode;
    }
    target.error = stringValue(event.error);
    this.activeToolId = null;
    this.publish();
  }

  private finishStreaming(status: ConversationRecordStatus, error?: string): void {
    if (this.streamingTextValue) {
      this.records.push({ id: this.nextRecordId(), type: 'message', role: 'assistant', content: this.streamingTextValue, createdAt: now() });
    }
    this.streamingTextValue = undefined;
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
      streamingText: this.streamingTextValue,
      queuedPromptCount: this.queue.length,
    };
    const event: ConversationEvent = { type: 'conversation', snapshot: this.snapshot };
    for (const listener of this.listeners) listener(event);
  }

  private nextRecordId(): string {
    return `conversation-${++this.recordId}`;
  }
}
