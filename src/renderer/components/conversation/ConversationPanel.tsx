import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { PI_THINKING_LEVELS, type PiModel, type PiThinkingLevel } from '../../../shared/ipc';

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

export type AgentStateControl = 'model' | 'thinking';

export type AgentStateSelectorProps = {
  model: PiModel | null;
  thinkingLevel: PiThinkingLevel | null;
  availableModels: readonly PiModel[];
  runtimeReady: boolean;
  isLoadingModels: boolean;
  pendingControl: AgentStateControl | null;
  error: string | null;
  onRetryModels?: () => void | Promise<void>;
  onSetModel: (provider: string, modelId: string) => void | Promise<void>;
  onSetThinkingLevel: (level: PiThinkingLevel) => void | Promise<void>;
};

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
  /** Agent state selectors shown in the conversation header. */
  agentState?: AgentStateSelectorProps;
  title?: string;
  placeholder?: string;
};

const THINKING_LEVEL_LABELS: Record<PiThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum',
};

function modelOptionValue(model: PiModel): string {
  return JSON.stringify([model.provider, model.id]);
}

function modelOptionLabel(model: PiModel): string {
  const name = model.name?.trim();
  return name ? `${name} · ${model.provider}` : `${model.id} · ${model.provider}`;
}

function AgentStateSelectors({
  model,
  thinkingLevel,
  availableModels,
  runtimeReady,
  isLoadingModels,
  pendingControl,
  error,
  onRetryModels,
  onSetModel,
  onSetThinkingLevel,
}: AgentStateSelectorProps): ReactElement {
  const feedbackId = useId();
  const modelOptions =
    model && !availableModels.some((availableModel) => modelOptionValue(availableModel) === modelOptionValue(model))
      ? [...availableModels, model]
      : availableModels;
  const modelValue = model ? modelOptionValue(model) : '';
  const modelPlaceholder = isLoadingModels
    ? 'Loading models…'
    : !runtimeReady
      ? 'Start Pi to choose'
      : modelOptions.length === 0
        ? 'No models available'
        : model
          ? 'Current model unavailable'
          : 'Choose a model';
  const feedback = error
    ? error
    : pendingControl === 'model'
      ? 'Updating model…'
      : pendingControl === 'thinking'
        ? 'Updating thinking level…'
        : isLoadingModels
          ? 'Loading available models…'
          : !runtimeReady
            ? 'Start Pi to adjust agent state.'
            : availableModels.length === 0
              ? 'Pi did not report any available models.'
              : null;
  const modelDisabled =
    !runtimeReady || isLoadingModels || pendingControl !== null || availableModels.length === 0;
  const thinkingDisabled = !runtimeReady || pendingControl !== null || thinkingLevel === null;

  return (
    <div className="agent-state-controls" aria-busy={isLoadingModels || pendingControl !== null}>
      <div className="agent-state-fields">
        <label className="agent-state-field" htmlFor={`${feedbackId}-model`}>
          <span className="agent-state-label">Model</span>
          <select
            id={`${feedbackId}-model`}
            className="agent-state-select"
            value={modelValue}
            onChange={(event) => {
              const selectedModel = modelOptions.find(
                (availableModel) => modelOptionValue(availableModel) === event.target.value,
              );
              if (!selectedModel) return;
              void Promise.resolve(onSetModel(selectedModel.provider, selectedModel.id)).catch(() => {
                // The parent owns the visible command error state.
              });
            }}
            disabled={modelDisabled}
            aria-describedby={feedback ? feedbackId : undefined}
          >
            <option value="" disabled>{modelPlaceholder}</option>
            {modelOptions.map((availableModel) => (
              <option key={modelOptionValue(availableModel)} value={modelOptionValue(availableModel)}>
                {modelOptionLabel(availableModel)}
              </option>
            ))}
          </select>
        </label>

        <label className="agent-state-field" htmlFor={`${feedbackId}-thinking`}>
          <span className="agent-state-label">Thinking</span>
          <select
            id={`${feedbackId}-thinking`}
            className="agent-state-select"
            value={thinkingLevel ?? ''}
            onChange={(event) => {
              const level = event.target.value as PiThinkingLevel;
              if (!level) return;
              void Promise.resolve(onSetThinkingLevel(level)).catch(() => {
                // The parent owns the visible command error state.
              });
            }}
            disabled={thinkingDisabled}
            aria-describedby={feedback ? feedbackId : undefined}
          >
            <option value="" disabled>
              {thinkingLevel === null ? 'Unavailable' : 'Select level'}
            </option>
            {PI_THINKING_LEVELS.map((level) => (
              <option key={level} value={level}>{THINKING_LEVEL_LABELS[level]}</option>
            ))}
          </select>
        </label>
      </div>

      {feedback && (
        <div
          className={error ? 'agent-state-feedback agent-state-feedback-error' : 'agent-state-feedback'}
          id={feedbackId}
          role={error ? 'alert' : 'status'}
          aria-live="polite"
          aria-atomic="true"
        >
          <span className="agent-state-feedback-icon" aria-hidden="true">{error ? '!' : '•'}</span>
          <span>{feedback}</span>
          {error && onRetryModels && (
            <button
              className="agent-state-retry"
              type="button"
              onClick={() => {
                void Promise.resolve(onRetryModels()).catch(() => {
                  // The parent owns the visible model-loading error state.
                });
              }}
              disabled={isLoadingModels || pendingControl !== null}
            >
              Try again
            </button>
          )}
        </div>
      )}
    </div>
  );
}


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
  agentState,
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
        <div className="conversation-header-main">
          <div>
            <p className="conversation-eyebrow">M1 · session</p>
            <h2 id={titleId}>{title}</h2>
          </div>
          {agentState && <AgentStateSelectors {...agentState} />}
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
