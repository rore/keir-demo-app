import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

test('repository archive, lock integrity and installed package bytes match recorded provenance', () => {
  const provenance = JSON.parse(readFileSync('vendor/provenance.json'));
  const lock = JSON.parse(readFileSync('package-lock.json'));
  const hash = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding);
  const archive = readFileSync(`vendor/${provenance.archive}`);
  assert.equal(provenance.archive, 'keir-runtime-node-0.1.0.tgz');
  assert.equal(provenance.sha256, 'sha256:1221c2c78e73bfa4bbc86568ef03e9fb5d4b6a513454377be931665b688590fc');
  assert.equal('sha256:' + hash('sha256', archive, 'hex'), provenance.sha256);
  assert.equal('sha512-' + hash('sha512', archive, 'base64'), provenance.integrity);
  assert.equal(lock.packages['node_modules/@keir/runtime-node'].integrity, provenance.integrity);
  assert.equal(lock.packages['node_modules/@keir/runtime-node'].resolved, `file:vendor/${provenance.archive}`);
  assert.equal(lock.packages['node_modules/@keir/runtime-node'].version, '0.1.0');
  assert.deepEqual(provenance.files.map(file => file.path).sort(),
    ['LICENSE', 'README.md', 'package.json', 'src/canonical.js', 'src/cel.js', 'src/index.js', 'src/model.js', 'src/validation.js']);
  for (const file of provenance.files) assert.equal('sha256:' + hash('sha256',
    readFileSync(`node_modules/@keir/runtime-node/${file.path}`), 'hex'), file.sha256, file.path);
});
