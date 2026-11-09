import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const hash = (algorithm, bytes, encoding) => createHash(algorithm).update(bytes).digest(encoding);

test('official archive, lock integrity and installed bytes match verified provenance', () => {
  const provenance = JSON.parse(readFileSync('vendor/provenance.json'));
  const lock = JSON.parse(readFileSync('package-lock.json'));
  const archive = readFileSync(`vendor/${provenance.archive}`);
  assert.equal(provenance.status, 'verified-release');
  assert.equal(provenance.release, 'v0.3.0');
  assert.equal(provenance.revision, 'b2329440dd2a25acc547f3ebfea214748d912022');
  assert.equal(provenance.archive, 'keir-runtime-node-0.3.0.tgz');
  assert.equal(provenance.sha256, 'sha256:40d71748bf142872c832e7d48aa6e8f827d0759c6ca5006c1abfd19db52935cc');
  assert.equal('sha256:' + hash('sha256', archive, 'hex'), provenance.sha256);
  assert.equal('sha512-' + hash('sha512', archive, 'base64'), provenance.integrity);
  assert.equal(lock.packages['node_modules/@keir/runtime-node'].integrity, provenance.integrity);
  assert.equal(lock.packages['node_modules/@keir/runtime-node'].resolved, `file:vendor/${provenance.archive}`);
  assert.equal(lock.packages['node_modules/@keir/runtime-node'].version, '0.3.0');
  assert.equal(lock.packages[''].dependencies['@keir/runtime-node'], `file:vendor/${provenance.archive}`);
  assert.equal(JSON.parse(readFileSync('package.json')).dependencies['@keir/runtime-node'], `file:vendor/${provenance.archive}`);
  assert.equal(JSON.parse(readFileSync('node_modules/@keir/runtime-node/package.json')).version, '0.3.0');
  assert.deepEqual(provenance.files.map(file => file.path).sort(),
    ['LICENSE', 'README.md', 'package.json', 'src/canonical.js', 'src/cel.js', 'src/index.js', 'src/model.js', 'src/validation.js']);
  for (const file of provenance.files) assert.equal('sha256:' + hash('sha256',
    readFileSync(`node_modules/@keir/runtime-node/${file.path}`), 'hex'), file.sha256, file.path);
});

test('historical runtime and compiler bytes retain their original release metadata', () => {
  const provenance = JSON.parse(readFileSync('vendor/keir-0.2.0-provenance.json'));
  const compiler = JSON.parse(readFileSync('vendor/compiler-0.2.0-provenance.json'));
  assert.equal(provenance.version, '0.2.0');
  assert.equal(provenance.status, 'verified-release');
  assert.equal(provenance.release, 'v0.2.0');
  assert.equal('sha256:' + hash('sha256', readFileSync(`vendor/${provenance.archive}`), 'hex'), provenance.sha256);
  assert.equal('sha512-' + hash('sha512', readFileSync(`vendor/${provenance.archive}`), 'base64'), provenance.integrity);
  assert.equal(compiler.compiler, 'keir-compiler-java/0.2.0');
  assert.equal(compiler.status, 'verified-release');
  assert.equal('sha256:' + hash('sha256', readFileSync(`vendor/${compiler.artifact.file}`), 'hex'), compiler.artifact.sha256);
});

test('the scenario3 schema has exact source provenance alongside historical schemas', () => {
  const provenance = JSON.parse(readFileSync('vendor/keir-verification/provenance.json'));
  assert.equal(provenance.revision, 'e5e2eb7f4bc4cc6ccd2817511793605eef88a384');
  const schema = provenance.files['scenario-v3.schema.json'];
  assert.equal(schema.status, 'verified-source');
  assert.equal(schema.revision, 'f988c2b147933fcdd8b8f74ce7920f78acd4eca5');
  assert.equal(schema.source, 'schemas/scenario-3/scenario.schema.json');
  assert.equal(schema.sha256, '80761a26039bcf8f33fdc3b16da624f665c855eba48c37fa59f4584f66609161');
  assert.equal(hash('sha256', readFileSync('vendor/keir-verification/scenario-v3.schema.json'), 'hex'), schema.sha256);
  assert.equal(hash('sha256', readFileSync('vendor/keir-verification/scenario.schema.json'), 'hex'), provenance.files['scenario.schema.json'].sha256);
});
