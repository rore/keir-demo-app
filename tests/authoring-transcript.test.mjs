import test from 'node:test';
import assert from 'node:assert/strict';
import { authoringTranscript } from '../src/authoring-transcript.mjs';

test('normal transcript preserves chronological dialogue and settled facts, not native tool history', () => {
  const messages = Array.from({ length: 45 }, (_, i) => ({ role: ['user', 'assistant', 'host'][i % 3], text: `message ${i}` }));
  const rows = values => values.slice().reverse().map(value => ({ payload: JSON.stringify(value) }));
  assert.deepEqual(authoringTranscript(rows([...messages.map(message => ({ ...message, receipt: 'private' })),
    { role: 'tool', text: 'raw tool output' }])), { messages, truncated: false });
  const long = messages.map(message => ({ ...message, text: message.text + '界'.repeat(300) }));
  const bounded = authoringTranscript(rows(long));
  assert.equal(bounded.truncated, true);
  assert.deepEqual(bounded.messages, long.slice(-bounded.messages.length));
  assert.ok(Buffer.byteLength(JSON.stringify(bounded.messages)) <= 16384);
});
