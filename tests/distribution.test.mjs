import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

test('repository archive, lock integrity and installed package bytes match recorded provenance', () => {
  const provenance = JSON.parse(readFileSync('vendor/provenance.json'));
  const lock = JSON.parse(readFileSync('package-lock.json'));
  const hash = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding);
  assert.equal('sha512-' + hash('sha512', readFileSync(`vendor/${provenance.archive}`), 'base64'), provenance.integrity);
  assert.equal(lock.packages['node_modules/@keir/runtime-node'].integrity, provenance.integrity);
  assert.equal(lock.packages['node_modules/@keir/runtime-node'].resolved, `file:vendor/${provenance.archive}`);
  assert.deepEqual(provenance.files.map(file => file.path).sort(),
    ['README.md', 'package.json', 'src/canonical.js', 'src/cel.js', 'src/index.js', 'src/model.js', 'src/validation.js']);
  for (const file of provenance.files) assert.equal('sha256:' + hash('sha256',
    readFileSync(`node_modules/@keir/runtime-node/${file.path}`), 'hex'), file.sha256, file.path);
});
