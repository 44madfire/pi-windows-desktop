export type ConversationExecutionState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'streaming'
  | 'aborting'
  | 'error';

export type ConversationRecordStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ConversationMessageRecord {
  id: string;
  type: 'message';
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
}

export interface ConversationToolRecord {
  id: string;
  type: 'tool';
  name: string;
  status: ConversationRecordStatus;
  input?: string;
  output?: string;
  error?: string;
  createdAt?: string;
}

export interface ConversationBashRecord {
  id: string;
  type: 'bash';
  command: string;
  status: ConversationRecordStatus;
  output?: string;
  error?: string;
  exitCode?: number;
  createdAt?: string;
}

export type ConversationTimelineRecord =
  | ConversationMessageRecord
  | ConversationToolRecord
  | ConversationBashRecord;

export interface ConversationSnapshot {
  timeline: ConversationTimelineRecord[];
  executionState: ConversationExecutionState;
  queuedPromptCount: number;
  streamingText?: string;
  error: string | null;
}

export type ConversationEvent = { type: 'conversation'; snapshot: ConversationSnapshot };
