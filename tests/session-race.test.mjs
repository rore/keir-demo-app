import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { openData, taskService } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';

test('revoked request waiting on its body cannot write, and committed A work stays with A', { timeout: 5000 }, async () => {
  const db = openData(':memory:');
  const origin = 'http://127.0.0.1:32123';
  const app = await createApp({ db, origin });
  await app.listen({ host: '127.0.0.1', port: 0 });
  let pending;
  try {
    const bootstrap = (await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:32123' } })).json();
    const login = await app.inject({ method: 'POST', url: '/api/session', headers: { host: '127.0.0.1:32123', origin, 'x-session-context': bootstrap.contextToken }, payload: { userId: 'maya' } });
    const cookie = login.headers['set-cookie'].split(';')[0], context = login.json().contextToken;
    const headers = { host: '127.0.0.1:32123', origin, cookie, 'x-session-context': context, 'content-type': 'application/json' };
    const committed = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name: 'Already committed' } });
    assert.equal(committed.statusCode, 201);
    let bodyStarted;
    const started = new Promise(resolve => { bodyStarted = resolve; });
    app.server.prependOnceListener('request', () => bodyStarted());
    const body = JSON.stringify({ name: 'Must never appear' });
    const response = new Promise((resolve, reject) => {
      pending = request({ hostname: '127.0.0.1', port: app.server.address().port, path: '/api/projects', method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode));
      });
      pending.on('error', reject); pending.setTimeout(3000, () => pending.destroy(new Error('Test request timed out.'))); pending.write(body.slice(0, 1));
    });
    await Promise.race([started, response]);
    const switched = await app.inject({ method: 'POST', url: '/api/session', headers, payload: { userId: 'leo' } });
    assert.equal(switched.statusCode, 200);
    pending.end(body.slice(1));
    assert.equal(await response, 401);
    const services = taskService(db);
    assert.ok(services.listProjects('maya').some(row => row.name === 'Already committed'));
    for (const owner of ['maya', 'leo', 'sam']) assert.ok(!services.listProjects(owner).some(row => row.name === 'Must never appear'));
    assert.ok(!services.listProjects('leo').some(row => row.id === committed.json().id));
  } finally { pending?.destroy(); app.server.closeAllConnections(); await app.close(); db.close(); }
});
