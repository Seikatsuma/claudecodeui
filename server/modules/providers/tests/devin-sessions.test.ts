import assert from 'node:assert/strict';
import test from 'node:test';

import { DevinSessionsProvider } from '@/modules/providers/list/devin/devin-sessions.provider.js';

const provider = new DevinSessionsProvider();

test('normalizeMessage: tool_call закрывает живой текст — stream_end перед tool_use', () => {
  // У ACP нет границы текстового блока: без stream_end статусная реплика и
  // финальный ответ склеиваются в одну живую строку, и ответ встаёт в ленту
  // дважды (04.10.26).
  const messages = provider.normalizeMessage(
    { update: { sessionUpdate: 'tool_call', toolCallId: 'tc_1', title: 'exec', rawInput: { command: 'ls' } } },
    'sess-1',
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[0].kind, 'stream_end');
  assert.equal(messages[1].kind, 'tool_use');
  assert.equal(messages[1].toolId, 'tc_1');
  assert.equal(messages[1].toolName, 'exec');
  assert.deepEqual(messages[1].toolInput, { command: 'ls' });
});

test('normalizeMessage: agent_message_chunk отдаёт stream_delta с текстом без обрезки', () => {
  const messages = provider.normalizeMessage(
    { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '  padded  ' } } },
    'sess-1',
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0].kind, 'stream_delta');
  assert.equal(messages[0].content, '  padded  ');
});

test('normalizeMessage: промежуточный tool_call_update не рвёт текст и не даёт результата', () => {
  const messages = provider.normalizeMessage(
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc_1', status: 'in_progress' } },
    'sess-1',
  );
  assert.equal(messages.length, 0);
});
