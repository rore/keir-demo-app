import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openData, taskService } from '../src/data.mjs';
import { createApp } from '../src/app.mjs';
import { createTeamRuntime, installTeamRevision } from '../src/team-runtime.mjs';
import { teamProjectService } from '../src/team-native.mjs';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { compileTeamFixture } from '../scripts/team-native-fixture.mjs';

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'team-projects-')), path = join(directory, 'app.sqlite');
  const db = openData(path);
  const fixture = { db, path, directory, tasks: taskService(db), teams: teamProjectService(db), app: null };
  t.after(async () => { await fixture.app?.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  return fixture;
}
const rows = db => Object.fromEntries(['projects', 'project_members', 'team_selections', 'team_revisions', 'team_admissions', 'team_drafts', 'team_evidence',
  'extension_selections', 'task_create_operations'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

test('project mode defaults Personal; Team creation, membership and empty selection are atomic and survive reopen', async t => {
  const f = setup(t), before = rows(f.db);
  for (const input of [{ name: 'Personal default' }, { name: 'Personal explicit', mode: 'PERSONAL' }])
    assert.equal(f.tasks.createProject('maya', input).mode, 'PERSONAL');
  for (const mode of [null, undefined, 'team', 'OTHER', 1]) assert.throws(() => f.tasks.createProject('maya', { name: 'Invalid', mode }), { status: 400 });
  for (const field of ['ownerId', 'actorId', 'role']) assert.throws(() => f.tasks.createProject('maya', { name: 'Forged', mode: 'TEAM', [field]: 'sam' }), { status: 400 });
  const team = f.tasks.createProject('maya', { name: 'Launch team', mode: 'TEAM' });
  assert.equal(team.role, 'ADMIN'); assert.equal(team.mode, 'TEAM');
  assert.equal(f.db.prepare('SELECT owner_id FROM projects WHERE id=?').get(team.id).owner_id, 'maya');
  assert.equal(f.db.prepare('SELECT revision_id FROM team_selections WHERE project_id=?').get(team.id).revision_id, null);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM team_revisions').get().n, 0);
  f.teams.addMember('maya', team.id, { userId: 'leo' });
  f.teams.addMember('maya', team.id, { userId: 'maya' });
  assert.equal(f.teams.members('maya', team.id).project.role, 'ADMIN');
  assert.equal(f.tasks.listProjects('leo').find(project => project.id === team.id).role, 'MEMBER');
  const runtime = createTeamRuntime({ db: f.db }), tasks = taskService(f.db, { team: runtime });
  try {
    const work = await tasks.createTask('leo', { projectId: team.id, title: 'Ordinary work without a policy' }, { operationId: randomUUID() });
    assert.equal(f.db.prepare('SELECT policy_state FROM team_admissions WHERE source_task_id=?').get(work.id).policy_state, 'NO_POLICY');
    assert.equal((await tasks.completeTask('leo', work.id)).status, 'completed');
  } finally { await runtime.close(); }
  const reopened = openData(f.path);
  try {
    assert.equal(teamProjectService(reopened).members('leo', team.id).project.role, 'MEMBER');
    assert.deepEqual(reopened.prepare("SELECT * FROM extension_selections ORDER BY rowid").all(), before.extension_selections);
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 19);
    assert.deepEqual(reopened.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { reopened.close(); }
});

for (const table of ['project_members', 'team_selections', 'team_drafts']) test(`failure inserting ${table} rolls the entire Team creation back`, t => {
  const f = setup(t), before = rows(f.db);
  f.db.exec(`CREATE TEMP TRIGGER fail_team BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'Team setup failed'); END`);
  assert.throws(() => f.tasks.createProject('maya', { name: 'Must roll back', mode: 'TEAM' }), /Team setup failed/);
  assert.deepEqual(rows(f.db), before);
});

test('native membership guards preserve current authority, existing roles and policy/admission bytes', t => {
  const f = setup(t), team = f.tasks.createProject('maya', { name: 'Team', mode: 'TEAM' });
  const personal = f.tasks.listProjects('maya').find(project => project.mode === 'PERSONAL');
  const before = rows(f.db);
  assert.throws(() => f.teams.members('sam', team.id), { status: 404 });
  assert.throws(() => f.teams.members('maya', personal.id), { status: 404 });
  f.teams.addMember('maya', team.id, { userId: 'leo' });
  assert.throws(() => f.teams.addMember('leo', team.id, { userId: 'sam' }), { status: 403 });
  assert.throws(() => f.teams.addMember('maya', team.id, { userId: 'sam', role: 'ADMIN' }), { status: 400 });
  assert.throws(() => f.teams.addMember('maya', team.id, { userId: 'sam' }, () => 'leo'), { status: 401 });
  let memberChecks = 0;
  assert.throws(() => f.teams.addMember('maya', team.id, { userId: 'sam' },
    () => ++memberChecks === 1 ? 'maya' : 'leo'), { status: 401 });
  assert.equal(f.teams.members('maya', team.id).members.some(member => member.id === 'sam'), false);
  assert.throws(() => f.teams.removeMember('maya', team.id, 'maya'), { status: 409 });
  const now = new Date().toISOString(), taskId = randomUUID();
  f.db.prepare(`INSERT INTO tasks(id,owner_id,project_id,title,notes,status,created_at,updated_at,creator_id)
    VALUES (?,'maya',?,'Open work','','open',?,?,'leo')`).run(taskId, team.id, now, now);
  assert.throws(() => f.teams.removeMember('maya', team.id, 'leo'), { status: 409 });
  f.teams.assign('maya', taskId, 'maya');
  f.teams.removeMember('maya', team.id, 'leo');
  assert.throws(() => f.teams.members('leo', team.id), { status: 404 });
  for (const table of ['team_selections', 'team_revisions', 'team_admissions', 'extension_selections'])
    assert.deepEqual(rows(f.db)[table], before[table]);
  let checks = 0;
  assert.throws(() => f.tasks.createProject('maya', { name: 'Expired session', mode: 'TEAM' },
    { authorize: () => ++checks === 1 ? 'maya' : 'leo' }), { status: 401 });
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM projects WHERE name='Expired session'").get().n, 0);
});

test('member changes preserve populated policy pins, started work and real native receipts byte-for-byte', async t => {
  const f = setup(t), team = f.tasks.createProject('maya', { name: 'Existing Team work', mode: 'TEAM' });
  f.teams.addMember('maya', team.id, { userId: 'leo' });
  installTeamRevision(f.db, 'maya', team.id, 'existing-review', (await compileTeamFixture()).first);
  f.teams.setSelection('maya', team.id, 'existing-review');
  const runtime = createTeamRuntime({ db: f.db }), tasks = taskService(f.db, { team: runtime });
  try {
    const task = await tasks.createTask('maya', { projectId: team.id, title: 'Already-started work' }, { operationId: randomUUID() });
    await runtime.wake();
    const admission = f.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(task.id);
    assert.ok(admission.receipt);
    const before = rows(f.db);
    f.teams.addMember('maya', team.id, { userId: 'sam' });
    f.teams.addMember('maya', team.id, { userId: 'maya' });
    f.teams.removeMember('maya', team.id, 'sam');
    assert.throws(() => f.teams.removeMember('maya', team.id, 'leo'), { status: 409 });
    for (const table of ['team_selections', 'team_revisions', 'team_admissions', 'extension_selections', 'task_create_operations'])
      assert.deepEqual(rows(f.db)[table], before[table], table);
  } finally { await runtime.close(); }
});

test('ordinary HTTP setup enforces admin/member/outsider and session boundaries without a fixture policy', async t => {
  const f = setup(t), origin = 'http://127.0.0.1:32123';
  const app = await createApp({ db: f.db, origin, staticRoot: f.directory, authoring: { config: readAuthoringConfig({}) } });
  f.app = app;
  const call = (auth, method, url, payload) => app.inject({ method, url,
    headers: { host: '127.0.0.1:32123', origin, 'content-type': 'application/json', ...auth }, ...(payload === undefined ? {} : { payload }) });
  async function login(userId) {
    const bootstrap = await call({}, 'GET', '/api/session');
    const response = await call({ 'x-session-context': bootstrap.json().contextToken }, 'POST', '/api/session', { userId });
    assert.equal(response.statusCode, 200, response.body);
    return { cookie: `keir_demo_session=${response.cookies[0].value}`, 'x-session-context': response.json().contextToken };
  }
  const maya = await login('maya'), leo = await login('leo'), sam = await login('sam');
  const response = await call(maya, 'POST', '/api/projects', { name: 'HTTP team', mode: 'TEAM' });
  assert.equal(response.statusCode, 201, response.body);
  const team = response.json(), url = `/api/projects/${team.id}/members`;
  assert.equal((await call(maya, 'GET', url)).json().project.role, 'ADMIN');
  assert.equal((await call(sam, 'GET', url)).statusCode, 404);
  assert.equal((await call(leo, 'POST', url, { userId: 'leo' })).statusCode, 404);
  assert.equal((await call(maya, 'POST', url, { userId: 'leo' })).statusCode, 200);
  assert.equal((await call(leo, 'GET', url)).json().project.role, 'MEMBER');
  assert.equal((await call(leo, 'POST', url, { userId: 'sam' })).statusCode, 403);
  assert.equal((await call(maya, 'POST', url, { userId: 'sam', role: 'ADMIN' })).statusCode, 400);
  assert.equal((await call(maya, 'POST', url, { userId: 'unknown' })).statusCode, 404);
  assert.equal((await call(maya, 'POST', url, { userId: 'maya' })).json().project.role, 'ADMIN');
  const personal = (await call(maya, 'POST', '/api/projects', { name: 'HTTP Personal' })).json();
  assert.equal(personal.mode, 'PERSONAL');
  assert.equal((await call(maya, 'GET', `/api/projects/${personal.id}/members`)).statusCode, 404);
  f.teams.removeMember('maya', team.id, 'leo');
  assert.equal((await call(leo, 'GET', url)).statusCode, 404);
  assert.equal((await call(leo, 'POST', url, { userId: 'sam' })).statusCode, 404);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM team_revisions').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM team_admissions').get().n, 0);
  const before = rows(f.db);
  assert.equal((await call({ ...maya, 'x-session-context': leo['x-session-context'] }, 'POST', url, { userId: 'sam' })).statusCode, 401);
  assert.deepEqual(rows(f.db), before);
});
