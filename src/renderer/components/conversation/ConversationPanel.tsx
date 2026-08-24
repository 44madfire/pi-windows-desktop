import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import './ConversationPanel.css';

export type ConversationExecutionState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'streaming'
  | 'aborting'
  | 'error';

export type ConversationRecordStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ConversationMessageRecord = {
  id: string;
  type: 'message';
  role: 'user' | 'assistant';
  content: string;
  createdAt?: string;
};

export type ConversationToolRecord = {
  id: string;
  type: 'tool';
  name: string;
  status: ConversationRecordStatus;
  input?: string;
  output?: string;
  error?: string;
  createdAt?: string;
};

export type ConversationBashRecord = {
  id: string;
  type: 'bash';
  command: string;
  status: ConversationRecordStatus;
  output?: string;
  error?: string;
  exitCode?: number;
  createdAt?: string;
};

/**
 * The timeline is deliberately JSON-shaped so it can be passed across the
 * renderer/host boundary without carrying React elements or class instances.
 */
export type ConversationTimelineRecord =
  | ConversationMessageRecord
  | ConversationToolRecord
  | ConversationBashRecord;

export type ConversationPanelProps = {
  timeline: readonly ConversationTimelineRecord[];
  executionState: ConversationExecutionState;
  queuedPromptCount: number;
  onSendPrompt: (prompt: string) => void | Promise<void>;
  onAbort: () => void | Promise<void>;
  /** Text received for the assistant response that is currently streaming. */
  streamingText?: string;
  /** Set while the initial session/timeline is being fetched. */
  isLoading?: boolean;
  /** A host/session error to announce above the timeline. */
  error?: string | null;
  title?: string;
  placeholder?: string;
};

const EXECUTING_STATES: ReadonlySet<ConversationExecutionState> = new Set([
  'starting',
  'running',
  'streaming',
  'aborting',
]);

function isExecuting(state: ConversationExecutionState): boolean {
  return EXECUTING_STATES.has(state);
}

function executionLabel(state: ConversationExecutionState): string {
  switch (state) {
    case 'starting':
      return 'Starting Pi';
    case 'running':
      return 'Pi is working';
    case 'streaming':
      return 'Pi is responding';
    case 'aborting':
      return 'Stopping Pi';
    case 'error':
      return 'Execution needs attention';
    default:
      return 'Ready';
  }
}

function recordStatusLabel(status: ConversationRecordStatus): string {
  switch (status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'completed':
      return 'Complete';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

function formatTimestamp(timestamp?: string): string | null {
  if (!timestamp) return null;

  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;

  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function StatusBadge({ status }: { status: ConversationRecordStatus }): ReactElement {
  return (
    <span className={`conversation-status conversation-status-${status}`}>
      <span className="conversation-status-dot" aria-hidden="true" />
      <span>{recordStatusLabel(status)}</span>
    </span>
  );
}

function MessageRecord({ record }: { record: ConversationMessageRecord }): ReactElement {
  const timestamp = formatTimestamp(record.createdAt);
  const roleLabel = record.role === 'user' ? 'You' : 'Assistant';

  return (
    <article className={`conversation-message conversation-message-${record.role}`} aria-label={`${roleLabel} message`}>
      <div className="conversation-message-meta">
        <span className="conversation-message-role">{roleLabel}</span>
        {timestamp && <time dateTime={record.createdAt}>{timestamp}</time>}
      </div>
      <div className="conversation-message-body">
        {record.content ? record.content : <span className="conversation-empty-content">(empty message)</span>}
      </div>
    </article>
  );
}

function ToolRecord({ record }: { record: ConversationToolRecord }): ReactElement {
  const timestamp = formatTimestamp(record.createdAt);

  return (
    <details className="conversation-card conversation-tool-card" open={record.status === 'running' || record.status === 'failed'}>
      <summary className="conversation-card-summary">
        <span className="conversation-card-icon" aria-hidden="true">◆</span>
        <span className="conversation-card-title">
          <span className="conversation-card-kind">Tool</span>
          <strong>{record.name || 'Unnamed tool'}</strong>
        </span>
        <StatusBadge status={record.status} />
        {timestamp && <time dateTime={record.createdAt}>{timestamp}</time>}
      </summary>
      <div className="conversation-card-details">
        {record.input && (
          <div className="conversation-card-section">
            <span className="conversation-card-label">Input</span>
            <pre>{record.input}</pre>
          </div>
        )}
        {record.output && (
          <div className="conversation-card-section">
            <span className="conversation-card-label">Output</span>
            <pre>{record.output}</pre>
          </div>
        )}
        {record.error && (
          <div className="conversation-card-section conversation-card-error">
            <span className="conversation-card-label">Error</span>
            <pre>{record.error}</pre>
          </div>
        )}
        {!record.input && !record.output && !record.error && (
          <p className="conversation-card-placeholder">
            {record.status === 'running' ? 'Waiting for tool output…' : 'No tool details supplied.'}
          </p>
        )}
      </div>
    </details>
  );
}

function BashRecord({ record }: { record: ConversationBashRecord }): ReactElement {
  const timestamp = formatTimestamp(record.createdAt);
  const exitCode = record.exitCode === undefined ? null : `exit ${record.exitCode}`;

  return (
    <details className="conversation-card conversation-bash-card" open={record.status === 'running' || record.status === 'failed'}>
      <summary className="conversation-card-summary">
        <span className="conversation-card-icon conversation-bash-icon" aria-hidden="true">$</span>
        <span className="conversation-card-title">
          <span className="conversation-card-kind">Bash</span>
          <strong>{record.command || 'Shell command'}</strong>
        </span>
        <StatusBadge status={record.status} />
        {exitCode && <span className="conversation-exit-code">{exitCode}</span>}
        {timestamp && <time dateTime={record.createdAt}>{timestamp}</time>}
      </summary>
      <div className="conversation-card-details">
        <div className="conversation-card-section">
          <span className="conversation-card-label">Command</span>
          <pre>{record.command || '(empty command)'}</pre>
        </div>
        {record.output && (
          <div className="conversation-card-section">
            <span className="conversation-card-label">Output</span>
            <pre>{record.output}</pre>
          </div>
        )}
        {record.error && (
          <div className="conversation-card-section conversation-card-error">
            <span className="conversation-card-label">Error</span>
            <pre>{record.error}</pre>
          </div>
        )}
        {!record.output && !record.error && (
          <p className="conversation-card-placeholder">
            {record.status === 'running' ? 'Waiting for command output…' : 'No command output.'}
          </p>
        )}
      </div>
    </details>
  );
}

function TimelineRecord({ record }: { record: ConversationTimelineRecord }): ReactElement {
  switch (record.type) {
    case 'message':
      return <MessageRecord record={record} />;
    case 'tool':
      return <ToolRecord record={record} />;
    case 'bash':
      return <BashRecord record={record} />;
  }
}

function StreamingMessage({ text }: { text: string }): ReactElement {
  return (
    <article className="conversation-message conversation-message-assistant conversation-message-streaming" aria-label="Assistant message, streaming">
      <div className="conversation-message-meta">
        <span className="conversation-message-role">Assistant</span>
        <span className="conversation-streaming-label">
          <span className="conversation-streaming-dot" aria-hidden="true" />
          Streaming
        </span>
      </div>
      <div className="conversation-message-body">
        {text || <span className="conversation-typing-indicator" aria-label="Assistant is typing">•••</span>}
        <span className="conversation-caret" aria-hidden="true" />
      </div>
    </article>
  );
}

function ConversationPanel({
  timeline,
  executionState,
  queuedPromptCount,
  onSendPrompt,
  onAbort,
  streamingText,
  isLoading = false,
  error = null,
  title = 'Conversation',
  placeholder = 'Ask Pi to make a change…',
}: ConversationPanelProps): ReactElement {
  const [draft, setDraft] = useState('');
  const timelineEndRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const composerId = useId();
  const helpId = useId();
  const errorId = useId();
  const running = isExecuting(executionState);
  const aborting = executionState === 'aborting';
  const normalizedQueuedCount = Number.isFinite(queuedPromptCount)
    ? Math.max(0, Math.floor(queuedPromptCount))
    : 0;
  const hasStreamingMessage = streamingText !== undefined;
  const canSubmit = draft.trim().length > 0 && !isLoading && !aborting;
  const statusLabel = isLoading ? 'Loading conversation' : executionLabel(executionState);

  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [timeline.length, streamingText]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || !canSubmit) return;

    setDraft('');
    void Promise.resolve(onSendPrompt(prompt)).catch(() => {
      // The parent owns the session error state; avoid an unhandled rejection here.
    });
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  };

  return (
    <section
      className="conversation-panel"
      aria-busy={isLoading || running}
      aria-labelledby={titleId}
    >
      <header className="conversation-header">
        <div>
          <p className="conversation-eyebrow">M1 · session</p>
          <h2 id={titleId}>{title}</h2>
        </div>
        <div className="conversation-header-status" role="status" aria-live="polite" aria-atomic="true">
          <span className={`conversation-execution-dot conversation-execution-dot-${executionState}`} aria-hidden="true" />
          <span>{statusLabel}</span>
        </div>
      </header>

      {error && (
        <div className="conversation-error" id={errorId} role="alert">
          <span className="conversation-error-icon" aria-hidden="true">!</span>
          <div>
            <strong>Conversation error</strong>
            <p>{error}</p>
          </div>
        </div>
      )}

      <div className="conversation-timeline" role="log" aria-label="Conversation timeline" aria-live="polite">
        {isLoading && timeline.length === 0 && (
          <div className="conversation-loading" role="status" aria-live="polite">
            <span className="conversation-spinner" aria-hidden="true" />
            <span>Loading conversation…</span>
          </div>
        )}

        {isLoading && timeline.length > 0 && (
          <div className="conversation-working" role="status" aria-live="polite">
            <span className="conversation-spinner" aria-hidden="true" />
            <span>Refreshing conversation…</span>
          </div>
        )}

        {!isLoading && timeline.length === 0 && !hasStreamingMessage && (
          <div className="conversation-empty-state">
            <span className="conversation-empty-mark" aria-hidden="true">✦</span>
            <p>No messages yet</p>
            <span>Start with a prompt below.</span>
          </div>
        )}

        {timeline.map((record) => (
          <div className="conversation-timeline-item" key={record.id}>
            <TimelineRecord record={record} />
          </div>
        ))}

        {hasStreamingMessage && (
          <div className="conversation-timeline-item" key="streaming-assistant">
            <StreamingMessage text={streamingText} />
          </div>
        )}

        {running && !hasStreamingMessage && (
          <div className="conversation-working" role="status" aria-live="polite">
            <span className="conversation-spinner" aria-hidden="true" />
            <span>{statusLabel}…</span>
          </div>
        )}

        <div ref={timelineEndRef} aria-hidden="true" />
      </div>

      <footer className="conversation-composer-wrap">
        <div className="conversation-queue-row">
          <span className="conversation-queue-icon" aria-hidden="true">↗</span>
          <span role="status" aria-live="polite" aria-atomic="true">
            {normalizedQueuedCount > 0
              ? `${normalizedQueuedCount} prompt${normalizedQueuedCount === 1 ? '' : 's'} queued`
              : running
                ? 'Your next prompt will join the queue'
                : 'Ready for your next prompt'}
          </span>
          {running && (
            <button
              className="conversation-abort-button"
              type="button"
              onClick={() => {
                void Promise.resolve(onAbort()).catch(() => {
                  // The parent owns the session error state; avoid an unhandled rejection here.
                });
              }}
              disabled={aborting}
              aria-label={aborting ? 'Stopping Pi' : 'Abort current execution'}
            >
              {aborting ? 'Stopping…' : 'Abort'}
            </button>
          )}
        </div>

        <form className="conversation-composer" onSubmit={handleSubmit} aria-describedby={error ? `${helpId} ${errorId}` : helpId}>
          <label className="conversation-composer-label" htmlFor={composerId}>Prompt Pi</label>
          <div className="conversation-composer-row">
            <textarea
              id={composerId}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={placeholder}
              rows={3}
              disabled={isLoading || aborting}
              spellCheck
            />
            <button className="conversation-send-button" type="submit" disabled={!canSubmit}>
              <span>{running ? 'Queue prompt' : 'Send prompt'}</span>
              <span className="conversation-send-shortcut" aria-hidden="true">↵</span>
            </button>
          </div>
          <div className="conversation-composer-help" id={helpId}>
            <span>Enter to send · Shift+Enter for a new line</span>
            {running && <span>Prompts are kept in order</span>}
          </div>
        </form>
      </footer>
    </section>
  );
}

export default ConversationPanel;
