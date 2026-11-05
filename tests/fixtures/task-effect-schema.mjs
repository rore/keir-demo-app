import { randomUUID } from 'node:crypto';
import { taskEffectService } from '../../src/data.mjs';
import { digest, json, loadHost, TASK_HOOK } from '../../src/extension-catalog.mjs';
import { taskEffectSyntax, taskEffectScenarioExamples } from '../../src/task-effect-simulation.mjs';

// Trusted storage setup only; these synthetic bytes are never compiled, bound or invoked.
export function seedTaskEffectBinding(db, owner = 'maya') {
  const extensionId = randomUUID(), revisionId = randomUUID(), evidenceId = randomUUID();
  const host = loadHost(TASK_HOOK), source = Buffer.from(taskEffectSyntax(host));
  const scenarios = taskEffectScenarioExamples(host), suite = json(scenarios), compiledSourceDigest = digest(json(JSON.parse(source)));
  const artifact = Buffer.from(json({ sourceDigest: compiledSourceDigest, profile: 'keir-effect/4', format: 'keir-artifact/effect-4' }));
  const identity = { ...host.pins, artifactDigest: digest(artifact), rawSourceDigest: digest(source), compiledSourceDigest,
    suiteDigest: digest(suite), fixture: 'daymark-task-effect-fixtures/1' };
  db.prepare('INSERT INTO extensions(id,owner_id,hook_id,name,created_at,draft_version) VALUES (?,?,?,?,?,0)')
    .run(extensionId, owner, 'TaskCompleted', 'Native storage fixture', Date.now());
  db.prepare('INSERT INTO extension_revisions VALUES (?,?,?,?,?)').run(revisionId, owner, 'authored', json(identity), 'customer');
  db.prepare('INSERT INTO extension_revision_links VALUES (?,?,?)').run(revisionId, owner, extensionId);
  db.prepare('UPDATE extensions SET draft_revision_id=? WHERE id=?').run(revisionId, extensionId);
  db.prepare('INSERT INTO extension_authored VALUES (?,?,?,?,?,?)').run(revisionId, owner, 'Native storage fixture', source, artifact, suite);
  const versions = { suite: 'task-effects-authored/1', fixtureVersion: 'daymark-task-effect-fixtures/1', simulator: 'daymark-task-effect-simulation/1' };
  const suiteIdentity = digest(json({ ...versions, simulator: json(identity), cases: scenarios.map(text => ({ id: JSON.parse(text).id, digest: digest(text) })) }));
  const reports = scenarios.map(text => {
    const scenario = JSON.parse(text), outcome = scenario.expect.outcome;
    return { id: scenario.id, label: scenario.id, expected: { ...scenario.expect,
      createdTasks: outcome.effects.length ? scenario.expect.calls.filter(call => call.capability === 'tasks.create').map(call => ({ projectId: call.args.projectId, title: call.args.title })) : [] },
    report: { status: 'PASS', mismatches: [], native: outcome, calls: scenario.expect.calls, consumption: scenario.expect.consumption } };
  });
  const payload = json({ identity: { dependencies: identity, ...versions, suiteDigest: suiteIdentity }, reports });
  db.prepare('INSERT INTO extension_evidence VALUES (?,?,?,?,?,?,1)').run(evidenceId, owner, revisionId, json(identity), suiteIdentity, payload);
  db.prepare('INSERT INTO extension_approvals VALUES (?,?,?)').run(owner, revisionId, evidenceId);
  return { revisionId, extensionId, pins: { ...identity, approvedEvidenceId: evidenceId } };
}

export function invocationFor(effects, owner, eventId, requestKey = effects.keyFor(owner, eventId)) {
  const event = effects.status(owner, eventId);
  return { requestKey, event: { id: eventId, source: event.sourceTaskId }, deadline: { clock: { nowMs: () => 0 }, expiresAtMs: 1000 } };
}

// Storage fixtures supply a fresh direct context; the production service has no authority callbacks.
export function nativeEffectService(db) {
  const service = taskEffectService(db);
  return { ...service,
    claim(owner, eventId, context = invocationFor(service, owner, eventId)) { return service.claim(owner, eventId, context); },
    createTaskOnce(owner, key, input, context) {
      const event = db.prepare('SELECT event_id FROM task_completion_events WHERE owner_id=? AND original_key=?').get(owner, key?.value);
      return service.createTaskOnce(owner, key, input, context ?? (event && invocationFor(service, owner, event.event_id, key)));
    },
  };
}

// Only current-schema fixtures use this; frozen historical databases keep their original DDL.
export function removeTaskEffectSchema(db) {
  db.exec(`DROP TABLE task_effect_receipts;
    DROP TABLE task_completion_events;
    DROP INDEX tasks_owner;
    CREATE TABLE extension_selections_legacy(owner_id TEXT PRIMARY KEY REFERENCES users(id), revision_id TEXT,
      generation INTEGER NOT NULL CHECK(generation>=0),
      FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT;
    INSERT INTO extension_selections_legacy(owner_id,revision_id,generation)
      SELECT owner_id,revision_id,generation FROM extension_selections WHERE hook_id='ClassifyTask';
    DROP TABLE extension_selections;
    ALTER TABLE extension_selections_legacy RENAME TO extension_selections;`);
}

export function legacySelections(db, asBytes = false) {
  const scoped = db.prepare('PRAGMA table_info(extension_selections)').all().some(column => column.name === 'hook_id');
  const columns = asBytes ? 'CAST(owner_id AS BLOB) AS owner_id,CAST(revision_id AS BLOB) AS revision_id,generation' : 'owner_id,revision_id,generation';
  return db.prepare(`SELECT ${columns} FROM extension_selections${scoped ? " WHERE hook_id='ClassifyTask'" : ''} ORDER BY rowid`).all();
}
