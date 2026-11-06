import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { taskEffectService } from '../../src/data.mjs';
import { digest, json, loadHost, TASK_HOOK } from '../../src/extension-catalog.mjs';
import { taskEffectSyntax, taskEffectScenarioExamples, TASK_EFFECT_VERSIONS as versions } from '../../src/task-effect-simulation.mjs';

// Compiled from taskEffectSyntax with the pinned CLI so storage checks can admit the exact proof without launching Java.
const artifact = readFileSync(new URL('./current-task-workflow-artifact.json', import.meta.url));
const reports = JSON.parse(readFileSync(new URL('./current-task-workflow-reports.json', import.meta.url), 'utf8'));
export function seedTaskEffectBinding(db, owner = 'maya') {
  const extensionId = randomUUID(), revisionId = randomUUID(), evidenceId = randomUUID();
  const host = loadHost(TASK_HOOK), source = Buffer.from(taskEffectSyntax(host));
  const scenarios = taskEffectScenarioExamples(host), suite = json(scenarios), compiledSourceDigest = JSON.parse(artifact).sourceDigest;
  const identity = { ...host.pins, artifactDigest: digest(artifact), rawSourceDigest: digest(source), compiledSourceDigest,
    suiteDigest: digest(suite), fixture: versions.fixtureVersion };
  db.prepare('INSERT INTO extensions(id,owner_id,hook_id,name,created_at,draft_version) VALUES (?,?,?,?,?,0)')
    .run(extensionId, owner, 'TaskCompleted', 'Native storage fixture', Date.now());
  db.prepare('INSERT INTO extension_revisions VALUES (?,?,?,?,?)').run(revisionId, owner, 'authored', json(identity), 'customer');
  db.prepare('INSERT INTO extension_revision_links VALUES (?,?,?)').run(revisionId, owner, extensionId);
  db.prepare('UPDATE extensions SET draft_revision_id=? WHERE id=?').run(revisionId, extensionId);
  db.prepare('INSERT INTO extension_authored VALUES (?,?,?,?,?,?)').run(revisionId, owner, 'Native storage fixture', source, artifact, suite);
  const suiteIdentity = digest(json({ ...versions, simulator: json(identity), cases: scenarios.map(text => ({ id: JSON.parse(text).id, digest: digest(text) })) }));
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
      const event = db.prepare('SELECT event_id FROM task_events WHERE owner_id=? AND original_key=?').get(owner, key?.value);
      return service.createTaskOnce(owner, key, input, context ?? (event && invocationFor(service, owner, event.event_id, key)));
    },
  };
}
