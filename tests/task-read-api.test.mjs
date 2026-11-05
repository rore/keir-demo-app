import test from 'node:test';
import assert from 'node:assert/strict';
import { openData, taskService } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';

test('retired advice endpoint rejects execution and preserves native CRUD/session isolation', async t => {
  const db = openData(':memory:');
  const service = taskService(db);
  const origin = 'http://127.0.0.1:32123';
  const app = await createApp({ db, origin });
  t.after(async () => { await app.close(); db.close(); });
  const base = { host: '127.0.0.1:32123', origin, 'content-type': 'application/json' };
  const request = (method, url, auth = {}, payload) => app.inject({ method, url, headers: { ...base, ...auth }, ...(payload === undefined ? {} : { payload }) });
  async function login(userId, auth) {
    const response = await request('POST', '/api/session', auth, { userId });
    assert.equal(response.statusCode, 200);
    return { cookie: response.headers['set-cookie'].split(';')[0], 'x-session-context': response.json().contextToken };
  }
  const bootstrap = (await request('GET', '/api/session')).json();
  const maya = await login('maya', { 'x-session-context': bootstrap.contextToken });
  const project = service.createProject('maya', { name: 'Advice' });
  const task = service.createTask('maya', { projectId: project.id, title: 'Read me' });
  const path = `/api/tasks/${task.id}/advice`;
  assert.equal((await request('POST', path, {}, {})).statusCode, 401);
  assert.equal((await request('POST', path, { ...maya, origin: 'http://foreign.invalid' }, {})).statusCode, 403);
  for (const payload of [{ ownerId: 'leo' }, { userId: 'leo' }, { program: 'leo' }, { artifact: 'leo.json' }, { scope: 'leo' }, []])
    assert.equal((await request('POST', path, maya, payload)).statusCode, 400);
  const retained = db.prepare('SELECT * FROM extension_selections WHERE owner_id=? AND hook_id=?').get('maya', 'ClassifyTask');
  const retired = await request('POST', path, maya, {});
  assert.equal(retired.statusCode, 410);
  assert.equal(retired.json().code, 'LEGACY_CUSTOMIZATION_RETIRED');
  const completed = await request('POST', `/api/tasks/${task.id}/complete`, maya, {});
  assert.equal(completed.statusCode, 200);
  assert.equal((await request('POST', path, maya, {})).statusCode, 410);
  assert.equal(service.getTask('maya', task.id).status, 'completed');
  assert.deepEqual(db.prepare('SELECT * FROM extension_selections WHERE owner_id=? AND hook_id=?').get('maya', 'ClassifyTask'), retained);
  const leo = await login('leo', maya);
  assert.equal((await request('POST', path, maya, {})).statusCode, 401);
  const foreign = await request('POST', path, leo, {});
  assert.deepEqual(foreign.json(), (await request('POST', '/api/tasks/missing/advice', leo, {})).json());
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.headers['set-cookie'], undefined);
  assert.equal((await request('GET', `/api/tasks/${task.id}`, leo)).statusCode, 404);
  const leoProject = service.createProject('leo', { name: 'Leo' });
  const leoTask = service.createTask('leo', { projectId: leoProject.id, title: 'Different source' });
  assert.equal((await request('POST', `/api/tasks/${leoTask.id}/advice`, leo, {})).statusCode, 410);
  assert.equal(service.getTask('maya', task.id).title, 'Read me');
});
