import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run only in disposable hosted qualification with an independently installed exact baseline.
const [baseline, destination] = process.argv.slice(2);
assert.equal(process.env.CI, 'true', 'Capture is restricted to disposable hosted qualification.');
assert.ok(baseline && destination && process.argv.length === 4);
const root = resolve(baseline), output = resolve(destination);
const load = path => import(pathToFileURL(join(root, path)).href);
const metadata = JSON.parse(await readFile(join(root, 'vendor/provenance.json')));
assert.equal(metadata.version, '0.4.0');
assert.equal(metadata.revision, 'fc0601ae410e06c0be76d6f3b769abbd049b5999');
assert.equal(JSON.parse(await readFile(join(root, 'node_modules/@keir/runtime-node/package.json'))).version, '0.4.0');
const { openData, taskService } = await load('src/data.mjs');
const { createCompiler } = await load('src/compiler.mjs');
const { createLifecycle } = await load('src/extension-lifecycle.mjs');
const { loadHost, TASK_HOOKS } = await load('src/extension-catalog.mjs');
const { taskEffectSyntax, taskEffectScenarioExamples } = await load('src/task-effect-simulation.mjs');
const { taskCreateGuardFixture } = await load('tests/fixtures/task-create-guard.mjs');
const { admitTaskDraft } = await load('tests/fixtures/task-authoring.mjs');
const db = openData(':memory:');
try {
  const owner = 'maya', projectId = taskService(db).listProjects(owner)[0].id;
  const lifecycle = createLifecycle(db, { compiler: createCompiler() });
  for (const hookId of TASK_HOOKS) {
    const host = loadHost(hookId);
    const fixture = hookId === 'TaskBeforeCreate' ? taskCreateGuardFixture({ host, rule: 'client-due', projectId })
      : { source: taskEffectSyntax(host).replaceAll('"project1"', JSON.stringify(projectId)),
        cases: taskEffectScenarioExamples(host).map(text => text.replaceAll('"project1"', JSON.stringify(projectId))) };
    const { extensionId } = admitTaskDraft(db, lifecycle, { owner, extensionId: 'compat-040-' + hookId });
    let state = await lifecycle.compile(owner, { extensionId, hookId, source: fixture.source, draftVersion: 0 }, () => {});
    const input = () => ({ extensionId, revisionId: state.draft.id, draftVersion: state.draftVersion });
    assert.equal(state.draft.pins.compiler, 'keir-compiler-java/0.4.0');
    state = await lifecycle.proposeScenarios(owner, { ...input(), cases: fixture.cases }, () => {});
    state = await lifecycle.simulate(owner, input(), () => {});
    assert.equal(state.evidence.passed, true);
    state = lifecycle.approve(owner, { ...input(), evidenceId: state.evidence.id }, () => {});
    state = lifecycle.activate(owner, { ...input(), evidenceId: state.approvedEvidenceId, generation: state.selection.generation }, () => {});
    assert.equal(state.selection.revision.id, state.draft.id);
  }
  const names = ['extensions', 'extension_revisions', 'extension_revision_links', 'extension_authored', 'extension_evidence',
    'extension_approvals', 'extension_history', 'extension_selections'];
  const tables = Object.fromEntries(names.map(table => [table, db.prepare(`SELECT * FROM ${table} WHERE owner_id=? ORDER BY rowid`).all(owner)
    .map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? { base64: Buffer.from(value).toString('base64') } : value])))]));
  const bytes = JSON.stringify({ demoRevision: '77feb10032d3b63475057564ca56099b1e498faa', coreRevision: metadata.revision,
    producer: 'keir-compiler-java/0.4.0', fictional: true, projectId, tables }, null, 2) + '\n';
  assert.ok(Buffer.byteLength(bytes) <= 4 * 1024 * 1024);
  await writeFile(output, bytes, { flag: 'wx' });
  console.log(JSON.stringify({ producer: 'keir-compiler-java/0.4.0', bytes: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex') }));
} finally { db.close(); }
