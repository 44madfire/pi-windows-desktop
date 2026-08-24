import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationController } from './index.ts';
import type { PiRpcClient } from '../pi/index.ts';

type Event = { type: string; [key: string]: unknown };

function createClient(): {
  client: PiRpcClient;
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
  return {
    client,
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
  // The active prompt was cleared: a later send is processed immediately.
  const second = controller.sendPrompt('second');
  assert.equal(mock.calls[1]?.message, 'second');
  mock.resolvePrompt();
  await second;
  mock.emit({ type: 'agent_settled' });
  assert.equal(controller.snapshot.executionState, 'idle');
  assert.equal(controller.snapshot.timeline.filter((record) => record.type === 'message').length, 3);
});

test('transport failure while a prompt request is pending advances the queue exactly once', async () => {
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

  // The error state was published, and exactly one queued prompt advanced.
  assert.ok(snapshots.some((s) => s.executionState === 'error' && /Pi process exited/.test(s.error ?? '')));
  assert.deepEqual(mock.calls.map((call) => call.type), ['prompt', 'prompt']);
  assert.equal(mock.calls[1]?.message, 'second');
  assert.equal(controller.snapshot.queuedPromptCount, 0);

  // The rejected request did not fail the newly advanced turn: it completes
  // normally on agent_settled.
  mock.resolvePrompt();
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
