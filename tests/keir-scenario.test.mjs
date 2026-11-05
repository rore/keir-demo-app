import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeKeirScenario } from '../src/keir-scenario.mjs';

const read = path => readFileSync(new URL('../vendor/keir-verification/' + path, import.meta.url));

function vectorBytes(vector) {
  if (Object.hasOwn(vector, 'utf8')) return Buffer.from(vector.utf8);
  if (Object.hasOwn(vector, 'base64')) return Buffer.from(vector.base64, 'base64');
  let bytes = read('scenarios/' + vector.scenario + '.json');
  if (vector.replace) {
    const [search, template] = vector.replace;
    const replacement = vector.expand ? template.replace('@', vector.expand[0].repeat(vector.expand[1])) : template;
    const text = bytes.toString('utf8');
    assert.ok(text.includes(search), vector.id);
    bytes = Buffer.from(text.replace(search, () => replacement));
  }
  if (vector.padToBytes) bytes = Buffer.concat([bytes, Buffer.alloc(vector.padToBytes - bytes.length, 0x20)]);
  return bytes;
}

test('exact Core assets produce the expected shared preflight dispositions for all 45 raw vectors', () => {
  const { files } = JSON.parse(read('provenance.json'));
  for (const [file, { sha256 }] of Object.entries(files)) {
    assert.equal(createHash('sha256').update(read(file)).digest('hex'), sha256, file);
  }
  const { vectors } = JSON.parse(read('scenario-vectors.json'));
  assert.equal(vectors.length, 45);
  for (const vector of vectors) {
    const bytes = vectorBytes(vector);
    if (['lexical', 'structural', 'byte-fields'].includes(vector.expect)) {
      assert.throws(() => decodeKeirScenario(bytes), error => {
        assert.ok(error instanceof assert.AssertionError);
        const phase = error.message === 'Scenario schema' ? 'structural'
          : error.message === 'Scenario byte field' ? 'byte-fields' : 'lexical';
        assert.equal(phase, vector.expect, vector.id);
        return true;
      }, vector.id);
    } else assert.doesNotThrow(() => decodeKeirScenario(bytes), vector.id);
  }
});
