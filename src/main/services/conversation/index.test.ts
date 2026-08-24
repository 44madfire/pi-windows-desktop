import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationController } from './index.ts';
import type { PiRpcClient } from '../pi/index.ts';

type Event = { type: string; [key: string]: unknown };

function createClient(): {
  client: PiRpcClient;
  emit: (event: Event) => void;
  calls: Array<{ type: string; message?: string }>;
  resolvePrompt: () => void;
} {
  const eventListeners = new Set<(event: Event) => void>();
  const calls: Array<{ type: string; message?: string }> = [];
  let resolvePrompt!: () => void;
  const client = {
    onEvent(listener: (event: Event) => void) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onError() {
      return () => undefined;
    },
    request(command: { type: string; message?: string }) {
      calls.push(command);
      if (command.type === 'prompt') return new Promise<void>((resolve) => { resolvePrompt = resolve; });
      return Promise.resolve({ type: 'response', success: true, id: 'test' });
    },
  } as unknown as PiRpcClient;
  return {
    client,
    emit: (event) => eventListeners.forEach((listener) => listener(event)),
    calls,
    resolvePrompt: () => resolvePrompt(),
  };
}

test('builds a streamed assistant timeline and preserves tool cards', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  const prompt = controller.sendPrompt('Inspect the project');

  mock.emit({ type: 'agent_start' });
  mock.emit({ type: 'message_start', message: { role: 'assistant', content: '' } });
  mock.emit({ type: 'message_update', message: { role: 'assistant', content: 'Done' } });
  mock.emit({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', command: 'pwd' });
  mock.emit({ type: 'tool_execution_update', toolCallId: 'tool-1', output: 'C:/project' });
  mock.emit({ type: 'tool_execution_end', toolCallId: 'tool-1', exitCode: 0 });
  mock.emit({ type: 'message_end', message: { role: 'assistant', content: 'Done' } });
  mock.resolvePrompt();
  await prompt;

  assert.equal(mock.calls[0]?.type, 'prompt');
  assert.deepEqual(controller.snapshot.timeline.map((record) => record.type), ['message', 'bash', 'message']);
  assert.equal(controller.snapshot.timeline[2]?.type === 'message' ? controller.snapshot.timeline[2].content : '', 'Done');
  assert.equal(controller.snapshot.executionState, 'idle');
});

test('queues prompts FIFO and sends abort to Pi', async () => {
  const mock = createClient();
  const controller = new ConversationController(mock.client);
  const first = controller.sendPrompt('first');
  await controller.sendPrompt('second');
  assert.equal(controller.snapshot.queuedPromptCount, 1);

  await controller.abort();
  assert.deepEqual(mock.calls.map((call) => call.type), ['prompt', 'abort']);

  mock.resolvePrompt();
  await first;
  assert.equal(mock.calls[2]?.message, 'second');
  assert.equal(controller.snapshot.timeline.filter((record) => record.type === 'message').length, 2);
});
