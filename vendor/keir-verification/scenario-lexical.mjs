import assert from 'node:assert/strict';

export function lexical(bytes) {
  assert.ok(bytes.length <= 65_536, 'Scenario byte limit');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { assert.fail('Invalid scenario UTF-8'); }
  assert.ok(!text.startsWith('\uFEFF'), 'Scenario BOM');
  const token = /[ \t\r\n]*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|0|[1-9][0-9]*|true|false|null|[{}[\]:,])/y;
  let next;
  function advance() {
    next = token.exec(text)?.[1];
  }
  function take(expected) {
    assert.equal(next, expected, 'Unexpected scenario token');
    advance();
  }
  function value(depth) {
    if (next === '{' || next === '[') {
      assert.ok(depth < 16, 'Scenario nesting limit');
      const object = next === '{';
      const end = object ? '}' : ']';
      const keys = new Set();
      advance();
      if (next !== end) {
        for (;;) {
          if (object) {
            assert.ok(next?.startsWith('"'), 'Expected scenario object key');
            const key = JSON.parse(next);
            assert.ok(key.isWellFormed() && !keys.has(key), 'Invalid or duplicate scenario object key');
            keys.add(key);
            advance();
            take(':');
          }
          value(depth + 1);
          if (next === end) break;
          take(',');
        }
      }
      take(end);
    } else {
      assert.ok(next && !'{}[]:,'.includes(next), 'Expected scenario value');
      if (next.startsWith('"')) assert.ok(JSON.parse(next).isWellFormed(), 'Unpaired scenario surrogate');
      if (/^[0-9]/.test(next)) assert.ok(Number.isSafeInteger(Number(next)), 'Unsafe scenario integer');
      advance();
    }
  }
  advance();
  value(0);
  // The scanner checks discarded spellings, keys and nesting. JSON.parse owns complete input syntax.
  try { return JSON.parse(text); }
  catch { assert.fail('Invalid scenario JSON'); }
}
