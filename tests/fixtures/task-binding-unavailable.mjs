import assert from 'node:assert/strict';
import { mock } from 'node:test';

const runtime = await import('@keir/runtime-node');
let binds = 0;
mock.module('@keir/runtime-node', { namedExports: { ...runtime, bindModel() {
  binds++;
  return { boundModel: null, diagnostic: { code: 'ADMISSION_INVALID', path: '' } };
} } });

const { createApp } = await import('../../src/app.mjs');
const { openData } = await import('../../src/data.mjs');
const { createLifecycle } = await import('../../src/extension-lifecycle.mjs');
const { admitTaskDraft } = await import('./task-authoring.mjs');
const db = openData(':memory:');
let app;
try {
  // A blank conversation has no artifact, approval or executable selection.
  const { extensionId } = admitTaskDraft(db, createLifecycle(db));
  const origin = 'http://127.0.0.1:32123';
  app = await createApp({ db, origin, staticRoot: process.argv[2], compiler: {},
    authoring: { config: { status: 'unavailable', code: 'AI_NOT_CONFIGURED' } } });
  const request = (method, url, { token, cookie, body } = {}) => app.inject({ method, url,
    headers: { host: '127.0.0.1:32123', ...(token && { 'x-session-context': token }),
      ...(cookie && { cookie: `keir_demo_session=${cookie}` }),
      ...(body !== undefined && { origin, 'content-type': 'application/json' }) },
    ...(body !== undefined && { payload: JSON.stringify(body) }) });
  const bootstrap = await request('GET', '/api/session');
  const login = await request('POST', '/api/session', { token: bootstrap.json().contextToken, body: { userId: 'maya' } });
  assert.equal(login.statusCode, 200, login.body);
  const auth = { token: login.json().contextToken, cookie: login.cookies.find(value => value.name === 'keir_demo_session').value };
  assert.equal(binds, 1, 'the actual dispatcher attempts binding and receives the diagnostic');
  for (const path of ['/api/extensions', `/api/extensions/${extensionId}`]) {
    const response = await request('GET', path, auth);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().executionAvailability.available, false);
    assert.ok(response.json().executionAvailability.message);
    assert.equal(response.json().selection.eligible, false);
  }
  const before = db.prepare("SELECT * FROM extension_selections WHERE owner_id='maya' AND hook_id='TaskCompleted'").get();
  for (const operation of ['activate', 'rollback']) {
    const response = await request('POST', `/api/extensions/${extensionId}/${operation}`, { ...auth,
      body: { revisionId: 'unavailable-revision', generation: before.generation, ...(operation === 'activate' && { draftVersion: 0 }) } });
    assert.equal(response.statusCode, 503, response.body);
  }
  assert.deepEqual(db.prepare("SELECT * FROM extension_selections WHERE owner_id='maya' AND hook_id='TaskCompleted'").get(), before);

  // Existing historical selection remains safely disableable without new write authority.
  const selected = db.prepare(`SELECT l.extension_id,s.generation FROM extension_selections s
    JOIN extension_revision_links l ON l.revision_id=s.revision_id AND l.owner_id=s.owner_id
    WHERE s.owner_id='maya' AND s.hook_id='ClassifyTask'`).get();
  const disabled = await request('POST', `/api/extensions/${selected.extension_id}/disable`, { ...auth, body: { generation: selected.generation } });
  assert.equal(disabled.statusCode, 200, disabled.body);
  assert.equal(disabled.json().executionAvailability.available, false);
  assert.equal(db.prepare("SELECT revision_id FROM extension_selections WHERE owner_id='maya' AND hook_id='ClassifyTask'").get().revision_id, null);

  const projects = await request('GET', '/api/projects', auth);
  assert.equal(projects.statusCode, 200, projects.body);
  const created = await request('POST', '/api/tasks', { ...auth, body: { projectId: projects.json()[0].id, title: 'Native tasks remain available' } });
  assert.equal(created.statusCode, 201, created.body);
  const taskId = created.json().id;
  const read = await request('GET', `/api/tasks/${taskId}`, auth);
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().title, 'Native tasks remain available');
  const edited = await request('PATCH', `/api/tasks/${taskId}`, { ...auth, body: { title: 'Native edit still works', notes: '' } });
  assert.equal(edited.statusCode, 200, edited.body);
  const completed = await request('POST', `/api/tasks/${taskId}/complete`, { ...auth, body: {} });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(completed.json().status, 'completed');
  const outcome = await request('GET', `/api/tasks/${taskId}/reaction`, auth);
  assert.equal(outcome.statusCode, 200, outcome.body);
  assert.equal(outcome.json().state, 'NO_BINDING');
  assert.equal(db.prepare('SELECT count(*) AS n FROM task_effect_receipts').get().n, 0);
  console.log('binding unavailable: review visible; activation and rollback refused; disable and native CRUD available');
} finally {
  await app?.close();
  db.close();
  mock.restoreAll();
}
