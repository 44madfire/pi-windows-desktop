import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationController } from './index.ts';
import type { PiRpcClient } from '../pi/index.ts';

type Event = { type: string; [key: string]: unknown };

function createClient(): {
  client: PiRpcClient;
  setState: (state: 'idle' | 'ready' | 'disconnected') => void;
  emit: (event: Event) => void;
  emitError: (error: Error) => void;
  calls: Array<{ type: string; message?: string }>;
  resolvePrompt: () => void;
  rejectPrompt: (error: Error) => void;
  failRequest: (type: string, error: Error) => void;
} {
  const eventListeners = new Set<(event: Event) => void>();
  const errorListeners = new Set<(error: Error) => void>();
  const calls: Array<{ type: string; message?: string }> = [];
  const failedRequests = new Map<string, Error>();
  let resolvePrompt!: () => void;
  let rejectPrompt!: (error: Error) => void;
  const client = {
    state: 'idle',
    onEvent(listener: (event: Event) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onError(listener: (error: Error) => void) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    request(command: { type: string; message?: string }) {
      calls.push(command);
      const failure = failedRequests.get(command.type);
      if (failure) return Promise.reject(failure);
      if (command.type === 'prompt') {
        return new Promise<void>((resolve, reject) => {
          resolvePrompt = resolve;
          rejectPrompt = reject;
        });
      }
      return Promise.resolve({ type: 'response', success: true, id: 'test' });
    },
  } as unknown as PiRpcClient;
  const mutableClient = client as unknown as { state: 'idle' | 'ready' | 'disconnected' };
  return {
    client,
    setState: (state) => {
      mutableClient.state = state;
    },
    emit: (event) => eventListeners.forEach((listener) => listener(event)),
    emitError: (error) => errorListeners.forEach((listener) => listener(error)),
    calls,
    resolvePrompt: () => resolvePrompt(),
    rejectPrompt: (error) => rejectPrompt(error),
    failRequest: (type, error) => failedRequests.set(type, error),
  };
}

test('keeps the run active until agent_settled and streams assistant deltas', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  const prompt = controller.sendPrompt('Inspect the project');

  mock.emit({ type: 'agent_start' });
  mock.emit({ type: 'message_start', message: { id: 'msg-1', role: 'assistant', content: [] } });
  mock.emit({
    type: 'message_update',
    message: { id: 'msg-1', role: 'assistant', content: [] },
    assistantMessageEvent: { type: 'text_delta', delta: 'Do' },
  });
  assert.equal(controller.snapshot.streamingText, 'Do');
  mock.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', command: 'pwd' });
  mock.emit({ type: 'tool_execution_update', toolCallId: 'tool-1', output: 'C:/project' });
  mock.emit({ type: 'tool_execution_end', toolCallId: 'tool-1', exitCode: 0 });
  mock.emit({
    type: 'message_update',
    message: { id: 'msg-1', role: 'assistant', content: [] },
    assistantMessageEvent: { type: 'text_delta', delta: 'ne' },
  });
  assert.equal(controller.snapshot.streamingText, 'Done');

  // The prompt RPC response only acknowledges acceptance; the turn stays active.
  mock.resolvePrompt();
  await prompt;
  assert.equal(controller.snapshot.executionState, 'streaming');
  assert.equal(mock.calls.length, 1);

  // message_end carries the authoritative assistant message.
  mock.emit({
    type: 'message_end',
    message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
  });
  // agent_settled completes the run.
  mock.emit({ type: 'agent_settled' });

  assert.equal(controller.snapshot.executionState, 'idle');
  assert.deepEqual(controller.snapshot.timeline.map((record) => record.type), ['message', 'bash', 'message']);
  const assistant = controller.snapshot.timeline[2];
  assert.equal(assistant.type === 'message' ? assistant.content : '', 'Done');
});

test('queues prompts FIFO and advances only after agent_settled', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  const first = controller.sendPrompt('first');
  await controller.sendPrompt('second');
  assert.equal(controller.snapshot.queuedPromptCount, 1);

  await controller.abort();
  assert.deepEqual(mock.calls.map((call) => call.type), ['prompt', 'abort']);

  // The ACK must not complete the turn or start the queued prompt.
  mock.resolvePrompt();
  await first;
  assert.deepEqual(mock.calls.map((call) => call.type), ['prompt', 'abort']);
  assert.equal(controller.snapshot.queuedPromptCount, 1);

  // agent_settled completes the run and starts the next queued prompt.
  mock.emit({ type: 'agent_settled' });
  assert.equal(mock.calls[2]?.message, 'second');
  assert.equal(controller.snapshot.queuedPromptCount, 0);
  assert.equal(controller.snapshot.timeline.filter((record) => record.type === 'message').length, 2);
});

test('accumulates text and thinking deltas by content index without losing streamed text', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  void controller.sendPrompt('think');

  mock.emit({ type: 'agent_start' });
  mock.emit({ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } });

  // Thinking deltas must not leak into the visible streaming text.
  mock.emit({
    type: 'message_update',
    message: { id: 'm1', role: 'assistant', content: [] },
    assistantMessageEvent: { type: 'thinking_delta', delta: 'Let me ' },
  });
  mock.emit({
    type: 'message_update',
    message: { id: 'm1', role: 'assistant', content: [] },
    assistantMessageEvent: { type: 'thinking_delta', delta: 'think.' },
  });
  assert.equal(controller.snapshot.streamingText, undefined);

  // Text deltas accumulate across updates.
  mock.emit({
    type: 'message_update',
    message: { id: 'm1', role: 'assistant', content: [] },
    assistantMessageEvent: { type: 'text_delta', delta: 'Hello' },
  });
  assert.equal(controller.snapshot.streamingText, 'Hello');
  mock.emit({
    type: 'message_update',
    message: { id: 'm1', role: 'assistant', content: [] },
    assistantMessageEvent: { type: 'text_delta', delta: ' world' },
  });
  assert.equal(controller.snapshot.streamingText, 'Hello world');

  // A stale partial snapshot must not roll the stream back.
  mock.emit({
    type: 'message_update',
    message: {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Let me ' }, { type: 'text', text: 'Hello' }],
    },
  });
  assert.equal(controller.snapshot.streamingText, 'Hello world');

  // Growing snapshots and text_end extend the accumulated block.
  mock.emit({
    type: 'message_update',
    message: {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Let me think.' }, { type: 'text', text: 'Hello world!' }],
    },
    assistantMessageEvent: { type: 'text_end', content: 'Hello world!' },
  });
  assert.equal(controller.snapshot.streamingText, 'Hello world!');

  // A user echo must not disturb the assistant stream or the timeline.
  mock.emit({ type: 'message_update', message: { id: 'm-user', role: 'user', content: 'think' } });
  mock.emit({ type: 'message_end', message: { id: 'm-user', role: 'user', content: 'think' } });
  assert.equal(controller.snapshot.streamingText, 'Hello world!');
  assert.equal(controller.snapshot.timeline.filter((record) => record.type === 'message').length, 1);

  // message_end is authoritative for the final assistant message.
  mock.emit({
    type: 'message_end',
    message: {
      id: 'm1',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Let me think.' }, { type: 'text', text: 'Hello world!' }],
    },
  });
  mock.emit({ type: 'agent_settled' });

  assert.equal(controller.snapshot.executionState, 'idle');
  const assistant = controller.snapshot.timeline.filter((record) => record.type === 'message' && record.role === 'assistant');
  assert.equal(assistant.length, 1);
  const firstAssistant = assistant[0];
  assert.equal(firstAssistant?.type === 'message' ? firstAssistant.content : '', 'Hello world!');
});

test('streams delta-only message updates with contentIndex (current Pi shapes) and settles on agent_settled', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  const prompt = controller.sendPrompt('Inspect the project');
  // Current Pi `message_update` records carry usage plus a delta-only
  // `assistantMessageEvent`: no top-level `message`, no `partial` snapshot,
  // and `contentIndex` addresses the content block being streamed.
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  mock.emit({ type: 'agent_start' });
  mock.emit({ type: 'message_start', message: { id: 'msg-1', role: 'assistant', content: [] } });
  mock.emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_start', contentIndex: 0 } });
  mock.emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' } });
  assert.equal(controller.snapshot.streamingText, 'Hello');

  // A thinking block streaming in parallel must not leak into visible text.
  mock.emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 1, delta: 'hidden' } });
  assert.equal(controller.snapshot.streamingText, 'Hello');

  // A second text block is assembled in content order via its own index.
  mock.emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_start', contentIndex: 2 } });
  mock.emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 2, delta: ' world' } });
  assert.equal(controller.snapshot.streamingText, 'Hello world');
  // text_end carries the block's final text.
  mock.emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_end', contentIndex: 2, content: ' world' } });
  assert.equal(controller.snapshot.streamingText, 'Hello world');

  // The prompt RPC response only acknowledges acceptance; the turn stays active.
  mock.resolvePrompt();
  await prompt;
  assert.equal(controller.snapshot.executionState, 'streaming');
  assert.equal(mock.calls.length, 1);

  // message_end carries the authoritative assistant message.
  mock.emit({
    type: 'message_end',
    message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
  });
  // agent_settled completes the run.
  mock.emit({ type: 'agent_settled' });

  assert.equal(controller.snapshot.executionState, 'idle');
  const assistant = controller.snapshot.timeline.filter((record) => record.type === 'message' && record.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0]?.type === 'message' ? assistant[0].content : '', 'Hello world');
});

test('concatenates repeated text_delta chunks at the same contentIndex literally', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  void controller.sendPrompt('repeat');
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  mock.emit({ type: 'agent_start' });
  mock.emit({ type: 'message_start', message: { id: 'msg-1', role: 'assistant', content: [] } });

  // Current Pi `text_delta` chunks are incremental stream slices, not
  // cumulative snapshots: an identical chunk at the same contentIndex is a
  // second slice and must concatenate literally, never be deduplicated.
  mock.emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ab' } });
  mock.emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ab' } });
  assert.equal(controller.snapshot.streamingText, 'abab');

  // A delta that is a strict prefix of the accumulated text is still a new
  // chunk: 'a' after 'ab' must extend the stream, not be swallowed.
  mock.emit({ type: 'message_update', usage, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'a' } });
  assert.equal(controller.snapshot.streamingText, 'ababa');

  // agent_settled completes the turn with the literal concatenation.
  mock.emit({ type: 'agent_settled' });

  assert.equal(controller.snapshot.executionState, 'idle');
  const assistant = controller.snapshot.timeline.filter((record) => record.type === 'message' && record.role === 'assistant');
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0]?.type === 'message' ? assistant[0].content : '', 'ababa');
});

test('transport failure while streaming fails the turn and leaves a recoverable error state', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  const prompt = controller.sendPrompt('first');
  mock.resolvePrompt();
  await prompt;

  mock.emit({ type: 'agent_start' });
  mock.emit({ type: 'message_start', message: { id: 'm1', role: 'assistant', content: [] } });
  mock.emit({
    type: 'message_update',
    message: { id: 'm1', role: 'assistant', content: [] },
    assistantMessageEvent: { type: 'text_delta', delta: 'partial' },
  });
  mock.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', command: 'pwd' });
  assert.equal(controller.snapshot.executionState, 'streaming');

  // The transport dies mid-turn: no pending prompt request exists, so only
  // the error listener can unblock the controller.
  mock.emitError(new Error('Pi process exited (code=1)'));

  // The failed turn is observable: error state, preserved partial text, and
  // the still-running tool settles as failed rather than hanging.
  assert.equal(controller.snapshot.executionState, 'error');
  assert.match(controller.snapshot.error ?? '', /Pi process exited/);
  assert.equal(controller.snapshot.streamingText, undefined);
  const bash = controller.snapshot.timeline.find((record) => record.id === 'tool-1');
  assert.equal(bash?.type === 'bash' ? bash.status : '', 'failed');
  const assistantRecords = controller.snapshot.timeline.filter((record) => record.type === 'message' && record.role === 'assistant');
  const lastAssistant = assistantRecords[assistantRecords.length - 1];
  assert.equal(lastAssistant?.type === 'message' ? lastAssistant.content : '', 'partial');

  // The active prompt was cleared, but the queue is paused: a later send
  // enqueues without dispatching into the disconnected client.
  const second = controller.sendPrompt('second');
  assert.equal(mock.calls[1]?.message, undefined);
  assert.equal(controller.snapshot.queuedPromptCount, 1);
  assert.equal(controller.snapshot.executionState, 'error');

  // Only the runtime reconnect handshake resumes the queue; the resumed
  // prompt is dispatched and completes normally on agent_settled.
  controller.resumeQueuedPrompts();
  assert.equal(controller.snapshot.executionState, 'starting');
  assert.equal(mock.calls[1]?.message, 'second');
  mock.resolvePrompt();
  await second;
  mock.emit({ type: 'agent_settled' });
  assert.equal(controller.snapshot.executionState, 'idle');
  assert.equal(controller.snapshot.timeline.filter((record) => record.type === 'message').length, 3);
});

test('transport failure while a prompt request is pending pauses the queue and resumes exactly once', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  const snapshots: Array<{ executionState: string; error: string | null }> = [];
  controller.onEvent((event) => snapshots.push(event.snapshot));
  void controller.sendPrompt('first');
  void controller.sendPrompt('second');
  assert.equal(controller.snapshot.queuedPromptCount, 1);

  // Emulate the real client ordering: pending requests reject first (a
  // microtask), then the error listener runs synchronously.
  mock.rejectPrompt(new Error('Pi process exited (code=1)'));
  mock.emitError(new Error('Pi process exited (code=1)'));

  // The error state was published, and the queue paused: the queued prompt
  // is retained and nothing is dispatched into the disconnected client.
  assert.ok(snapshots.some((s) => s.executionState === 'error' && /Pi process exited/.test(s.error ?? '')));
  assert.deepEqual(mock.calls.map((call) => call.type), ['prompt']);
  assert.equal(controller.snapshot.queuedPromptCount, 1);

  // The runtime reconnect handshake resumes the queue, which dispatches the
  // retained prompt exactly once. The rejected active prompt is not replayed.
  controller.resumeQueuedPrompts();
  assert.deepEqual(mock.calls.map((call) => call.type), ['prompt', 'prompt']);
  assert.equal(mock.calls[1]?.message, 'second');
  assert.equal(controller.snapshot.queuedPromptCount, 0);

  // The resumed turn completes normally on agent_settled.
  mock.resolvePrompt();
  mock.emit({ type: 'agent_settled' });
  assert.equal(controller.snapshot.executionState, 'idle');
});

test('sendPrompt while the client is disconnected enqueues without sending until resumed', async () => {
  const mock = createClient();
  mock.setState('disconnected');
  const controller = new ConversationController(mock.client);

  // A prompt sent into a disconnected client is retained, never dispatched:
  // no Pi process is spawned implicitly and the queue pauses until the
  // runtime handshake resumes it.
  const prompt = controller.sendPrompt('first');
  assert.equal(mock.calls.length, 0, 'no prompt is sent while disconnected');
  assert.equal(controller.snapshot.queuedPromptCount, 1);

  mock.setState('ready');
  controller.resumeQueuedPrompts();
  assert.equal(mock.calls[0]?.message, 'first');
  assert.equal(controller.snapshot.queuedPromptCount, 0);
  mock.resolvePrompt();
  await prompt;
  mock.emit({ type: 'agent_settled' });
  assert.equal(controller.snapshot.executionState, 'idle');
});

test('aborting a running turn settles active tools as cancelled, not completed', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  const prompt = controller.sendPrompt('first');
  mock.resolvePrompt();
  await prompt;

  mock.emit({ type: 'agent_start' });
  mock.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', command: 'pwd' });
  assert.equal(controller.snapshot.executionState, 'running');

  await controller.abort();
  assert.deepEqual(mock.calls.map((call) => call.type), ['prompt', 'abort']);
  assert.equal(controller.snapshot.executionState, 'aborting');

  // The abort ACK does not complete the turn; agent_settled does — and the
  // still-running tool must settle as cancelled.
  mock.emit({ type: 'agent_settled' });
  assert.equal(controller.snapshot.executionState, 'idle');
  const bash = controller.snapshot.timeline.find((record) => record.id === 'tool-1');
  assert.equal(bash?.type === 'bash' ? bash.status : '', 'cancelled');
});

test('abort request failure fails the turn instead of deadlocking', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  const prompt = controller.sendPrompt('first');
  mock.resolvePrompt();
  await prompt;

  mock.emit({ type: 'agent_start' });
  mock.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', command: 'pwd' });

  mock.failRequest('abort', new Error('Pi process exited (code=1)'));
  await controller.abort();

  // The failed abort leaves a visible error state and the aborted tool is
  // cancelled, while the controller stays recoverable.
  assert.equal(controller.snapshot.executionState, 'error');
  assert.match(controller.snapshot.error ?? '', /Pi process exited/);
  const bash = controller.snapshot.timeline.find((record) => record.id === 'tool-1');
  assert.equal(bash?.type === 'bash' ? bash.status : '', 'cancelled');

  const second = controller.sendPrompt('second');
  // Absolute index 1 is the abort request, not the prompt; assert against the
  // prompt call actually issued so the queue still advanced exactly once.
  assert.equal(mock.calls.filter((call) => call.type === 'prompt')[1]?.message, 'second');
  mock.resolvePrompt();
  await second;
  mock.emit({ type: 'agent_settled' });
  assert.equal(controller.snapshot.executionState, 'idle');
});

test('tracks current-shape tool events: args.command, partialResult, and result.content', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  const prompt = controller.sendPrompt('run pwd');
  mock.resolvePrompt();
  await prompt;

  mock.emit({ type: 'agent_start' });
  // Current Pi: tool call arguments live under `args` (bash -> { command }).
  mock.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'pwd' } });
  let bash = controller.snapshot.timeline.find((record) => record.id === 'tool-1');
  assert.equal(bash?.type === 'bash' ? bash.command : '', 'pwd');

  // partialResult carries the accumulated output as a tool-result object.
  mock.emit({
    type: 'tool_execution_update',
    toolCallId: 'tool-1',
    toolName: 'bash',
    args: { command: 'pwd' },
    partialResult: { content: [{ type: 'text', text: 'Building...' }], details: undefined },
  });
  bash = controller.snapshot.timeline.find((record) => record.id === 'tool-1');
  assert.equal(bash?.type === 'bash' ? bash.output : '', 'Building...');

  // result.content is the authoritative final output; isError is top-level.
  mock.emit({
    type: 'tool_execution_end',
    toolCallId: 'tool-1',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'C:/project' }], details: undefined },
    isError: false,
  });
  mock.emit({ type: 'agent_settled' });

  assert.equal(controller.snapshot.executionState, 'idle');
  bash = controller.snapshot.timeline.find((record) => record.id === 'tool-1');
  assert.equal(bash?.type === 'bash' ? bash.command : '', 'pwd');
  assert.equal(bash?.type === 'bash' ? bash.output : '', 'C:/project');
  assert.equal(bash?.type === 'bash' ? bash.status : '', 'completed');
});

test('settles current-shape failed tools from result.content and isError', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  const prompt = controller.sendPrompt('run false');
  mock.resolvePrompt();
  await prompt;

  mock.emit({ type: 'agent_start' });
  mock.emit({ type: 'tool_execution_start', toolCallId: 'tool-9', toolName: 'bash', args: { command: 'false' } });
  mock.emit({
    type: 'tool_execution_end',
    toolCallId: 'tool-9',
    toolName: 'bash',
    result: { content: [{ type: 'text', text: 'Command exited with code 1' }], details: {} },
    isError: true,
  });
  mock.emit({ type: 'agent_settled' });

  const bash = controller.snapshot.timeline.find((record) => record.id === 'tool-9');
  assert.equal(bash?.type === 'bash' ? bash.command : '', 'false');
  assert.equal(bash?.type === 'bash' ? bash.output : '', 'Command exited with code 1');
  assert.equal(bash?.type === 'bash' ? bash.status : '', 'failed');
  assert.equal(controller.snapshot.executionState, 'idle');
});

test('transport error while idle leaves a visible error state', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  mock.emitError(new Error('Pi process exited (code=1)'));
  assert.equal(controller.snapshot.executionState, 'error');
  assert.match(controller.snapshot.error ?? '', /Pi process exited/);
});

test('hydrate projects Pi session entries into the timeline in order', () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  controller.hydrate([
    {
      type: 'message',
      id: 'user-1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Inspect the project' },
    },
    {
      type: 'message',
      id: 'assistant-1',
      parentId: 'user-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hidden' },
          { type: 'text', text: 'Done' },
          { type: 'toolCall', toolCallId: 'tool-1', toolName: 'bash', input: { command: 'pwd' } },
        ],
      },
    },
    {
      type: 'message',
      id: 'result-1',
      parentId: 'assistant-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'bash',
        content: [{ type: 'text', text: '/home/pi' }],
      },
    },
    {
      type: 'model_change',
      id: 'model-1',
      parentId: null,
      timestamp: '2026-01-01T00:00:03.000Z',
      provider: 'openai',
      modelId: 'gpt-4o',
    },
  ]);

  assert.deepEqual(
    controller.snapshot.timeline.map((record) => record.type),
    ['message', 'message', 'bash'],
  );
  assert.equal(controller.snapshot.timeline[0].type === 'message' ? controller.snapshot.timeline[0].role : '', 'user');
  assert.equal(controller.snapshot.timeline[0].type === 'message' ? controller.snapshot.timeline[0].content : '', 'Inspect the project');
  const assistant = controller.snapshot.timeline[1];
  assert.equal(assistant.type === 'message' ? assistant.content : '', 'Done');
  const bash = controller.snapshot.timeline[2];
  assert.equal(bash.type === 'bash' ? bash.command : '', 'pwd');
  assert.equal(bash.type === 'bash' ? bash.output : '', '/home/pi');
  assert.equal(bash.type === 'bash' ? bash.status : '', 'completed');
  // Hydration never touches execution state.
  assert.equal(controller.snapshot.executionState, 'idle');
});

test('hydrate is idempotent and a later live message never duplicates history', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  const entries = [
    {
      type: 'message',
      id: 'user-1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'history' },
    },
    {
      type: 'message',
      id: 'assistant-1',
      parentId: 'user-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'answered' }] },
    },
  ];

  controller.hydrate(entries);
  controller.hydrate(entries);
  assert.equal(controller.snapshot.timeline.length, 2);

  // A live prompt after hydration appends exactly one new user record.
  const prompt = controller.sendPrompt('next');
  mock.resolvePrompt();
  await prompt;
  mock.emit({ type: 'agent_settled' });
  const messages = controller.snapshot.timeline.filter((record) => record.type === 'message');
  assert.equal(messages.length, 3);
  assert.equal(messages[2].type === 'message' ? messages[2].content : '', 'next');
  assert.equal(controller.snapshot.executionState, 'idle');
});

test('hydrate marks failed tool results and skips unknown roles', () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  controller.hydrate([
    {
      type: 'message',
      id: 'user-1',
      parentId: null,
      message: { role: 'user', content: 'why' },
    },
    {
      type: 'message',
      id: 'result-1',
      parentId: 'user-1',
      message: {
        role: 'toolResult',
        toolCallId: 'tool-9',
        toolName: 'npm',
        content: [{ type: 'text', text: 'exit 1' }],
        isError: true,
      },
    },
    { type: 'message', id: 'custom-1', parentId: null, message: { role: 'custom', customType: 'x', content: '', display: false } },
    { type: 'compaction', id: 'compact-1', parentId: null, summary: 'folded' },
  ]);

  assert.deepEqual(
    controller.snapshot.timeline.map((record) => ({ type: record.type, id: record.id })),
    [
      { type: 'message', id: 'user-1' },
      { type: 'tool', id: 'tool-9' },
    ],
  );
  const tool = controller.snapshot.timeline[1];
  assert.equal(tool.type === 'tool' ? tool.status : '', 'failed');
  assert.equal(tool.type === 'tool' ? tool.output : '', 'exit 1');
});

const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

test('reconcile matches live records to authoritative entries without duplicating history', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  const prompt = controller.sendPrompt('Inspect the project');
  mock.resolvePrompt();
  await prompt;
  mock.emit({ type: 'message_start', message: { id: 'msg-1', role: 'assistant', content: [] } });
  mock.emit({
    type: 'message_end',
    message: { id: 'msg-1', role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
  });
  mock.emit({ type: 'agent_settled' });

  const before = controller.snapshot.timeline.filter((record) => record.type === 'message');
  assert.equal(before.length, 2);

  // Pi's authoritative history for the settled turn arrives on the next
  // get_entries; the live user/assistant records already represent it.
  const entries = [
    {
      type: 'message',
      id: 'user-1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Inspect the project' },
    },
    {
      type: 'message',
      id: 'assistant-1',
      parentId: 'user-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] },
    },
  ];
  controller.hydrate(entries);
  // A replay of the same authoritative history (a second synchronize, a
  // reconnection) must be equally idempotent.
  controller.hydrate(entries);

  const messages = controller.snapshot.timeline.filter((record) => record.type === 'message');
  assert.equal(messages.length, 2, 'live user/assistant records must not be duplicated by authoritative entries');
  assert.equal(messages.filter((record) => record.role === 'user').length, 1);
  assert.equal(messages.filter((record) => record.role === 'assistant').length, 1);

  // Genuinely new history still appends after reconciliation.
  controller.hydrate([
    {
      type: 'message',
      id: 'user-2',
      parentId: null,
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'user', content: 'next' },
    },
  ]);
  const after = controller.snapshot.timeline.filter((record) => record.type === 'message');
  assert.equal(after.length, 3);
  assert.equal(after[2].type === 'message' ? after[2].content : '', 'next');
});

test('reconcile matches live tool records by stable tool identity', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  const prompt = controller.sendPrompt('run pwd');
  mock.resolvePrompt();
  await prompt;
  // Legacy-shaped tool events without a Pi toolCallId create a local id.
  mock.emit({ type: 'tool_execution_start', toolName: 'bash', command: 'pwd' });
  mock.emit({ type: 'tool_execution_end', toolName: 'bash', command: 'pwd', output: '/home/pi', exitCode: 0 });
  mock.emit({ type: 'agent_settled' });
  const liveBash = controller.snapshot.timeline.find((record) => record.type === 'bash');
  assert.ok(liveBash && liveBash.type === 'bash' && liveBash.id.startsWith('conversation-'));

  controller.hydrate([
    {
      type: 'message',
      id: 'user-1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'run pwd' },
    },
    {
      type: 'message',
      id: 'assistant-1',
      parentId: 'user-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'pwd' } }],
      },
    },
    {
      type: 'message',
      id: 'result-1',
      parentId: 'assistant-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'bash',
        content: [{ type: 'text', text: '/home/pi' }],
      },
    },
  ]);

  assert.equal(controller.snapshot.timeline.length, 2);
  assert.equal(controller.snapshot.timeline.filter((record) => record.type === 'bash').length, 1);
  assert.equal(controller.snapshot.timeline.filter((record) => record.type === 'message').length, 1);
});

test('a settle hook synchronizes before the next queued prompt dispatches', async () => {
  const mock = createClient();
  let settleCalls = 0;
  const controller = new ConversationController(mock.client, {
    onSettle: async () => {
      settleCalls += 1;
      // The runtime handshake: get_entries returns the settled turn's
      // authoritative entry, which the live user record already represents.
      controller.hydrate([
        {
          type: 'message',
          id: 'user-1',
          parentId: null,
          timestamp: '2026-01-01T00:00:00.000Z',
          message: { role: 'user', content: 'first' },
        },
      ]);
    },
  });
  void controller.sendPrompt('first');
  await controller.sendPrompt('second');
  assert.equal(controller.snapshot.queuedPromptCount, 1);
  mock.resolvePrompt();
  assert.equal(mock.calls.length, 1);

  // agent_settled completes the turn; the queued prompt must not dispatch
  // before the settle hook ran and reconciled the authoritative entry.
  mock.emit({ type: 'agent_settled' });
  assert.equal(settleCalls, 1);
  assert.equal(
    mock.calls.filter((call) => call.type === 'prompt').length,
    1,
    'no prompt may dispatch before the settle hook resolved',
  );
  assert.equal(
    controller.snapshot.timeline.filter((record) => record.type === 'message' && record.content === 'first').length,
    1,
    'the authoritative user entry reconciled, not duplicated',
  );
  assert.equal(controller.snapshot.queuedPromptCount, 1);

  // The hook resolved: the queued prompt dispatches now.
  await flushMicrotasks();
  assert.equal(mock.calls.filter((call) => call.type === 'prompt')[1]?.message, 'second');
  assert.equal(controller.snapshot.queuedPromptCount, 0);
  mock.resolvePrompt();
  mock.emit({ type: 'agent_settled' });
  assert.equal(settleCalls, 2);
  await flushMicrotasks();
  assert.equal(controller.snapshot.executionState, 'idle');
});

test('a rejected settle hook pauses the queue with a visible error state', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client, {
    onSettle: async () => {
      throw new Error('get_entries failed');
    },
  });
  void controller.sendPrompt('first');
  await controller.sendPrompt('second');
  mock.resolvePrompt();
  assert.equal(mock.calls.filter((call) => call.type === 'prompt').length, 1);

  mock.emit({ type: 'agent_settled' });
  await flushMicrotasks();

  // The failed post-settled sync leaves the queue paused with a visible
  // error; the reconnect handshake is the recovery seam.
  assert.equal(controller.snapshot.executionState, 'error');
  assert.match(controller.snapshot.error ?? '', /get_entries failed/);
  assert.equal(controller.snapshot.queuedPromptCount, 1);
  assert.equal(mock.calls.filter((call) => call.type === 'prompt').length, 1);

  controller.resumeQueuedPrompts();
  assert.equal(mock.calls.filter((call) => call.type === 'prompt')[1]?.message, 'second');
  assert.equal(controller.snapshot.queuedPromptCount, 0);
  mock.resolvePrompt();
  // The resumed turn settles; the hook still fails, so the error state is
  // republished and the (now empty) queue stays paused.
  mock.emit({ type: 'agent_settled' });
  await flushMicrotasks();
  assert.equal(controller.snapshot.executionState, 'error');
});

test('hydrate reads current Pi toolCall blocks (id/name/arguments) and attaches result output/status', () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  controller.hydrate([
    {
      type: 'message',
      id: 'user-1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Check repo status' },
    },
    {
      type: 'message',
      id: 'assistant-1',
      parentId: 'user-1',
      timestamp: '2026-01-01T00:00:01.000Z',
      // Current Pi hydration shape: toolCall content blocks carry
      // id/name/arguments, with the bash command under arguments.command.
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'git status' } }],
      },
    },
    {
      type: 'message',
      id: 'result-1',
      parentId: 'assistant-1',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'toolResult',
        toolCallId: 'tool-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'On branch main\nnothing to commit, working tree clean' }],
      },
    },
  ]);

  assert.deepEqual(
    controller.snapshot.timeline.map((record) => record.type),
    ['message', 'bash'],
  );
  const user = controller.snapshot.timeline[0];
  assert.equal(user.type === 'message' ? user.role : '', 'user');
  assert.equal(user.type === 'message' ? user.content : '', 'Check repo status');
  const bash = controller.snapshot.timeline[1];
  // The toolCall block is the authority: its id names the record and its
  // name/arguments.command survive into the bash record.
  assert.equal(bash.type, 'bash');
  assert.equal(bash.type === 'bash' ? bash.id : '', 'tool-1');
  assert.equal(bash.type === 'bash' ? bash.command : '', 'git status');
  // The toolResult entry contributes the final output and status.
  assert.equal(bash.type === 'bash' ? bash.output : '', 'On branch main\nnothing to commit, working tree clean');
  assert.equal(bash.type === 'bash' ? bash.status : '', 'completed');
  assert.equal(controller.snapshot.executionState, 'idle');
});
