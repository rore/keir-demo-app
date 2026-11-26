import { randomUUID } from 'node:crypto';
import { transaction } from '../../src/data.mjs';
import { createAuthoringState } from '../../src/authoring-agent.mjs';
import { digest, json, TASK_DEFINITION } from '../../src/extension-catalog.mjs';

// Trusted test admission only: no artifact, approval, qualification, provider call or runtime authority.
export function admitTaskDraft(db, lifecycle, { owner = 'maya', name = 'Task customization', operationId = randomUUID(), extensionId = randomUUID(), createdAt } = {}) {
  const conversationId = randomUUID(), runId = randomUUID();
  const conversationState = { ...createAuthoringState({ ownerId: owner, sessionId: 'task-fixture', conversationId, runId }),
    definitionId: TASK_DEFINITION, handles: { revisionId: null, draftVersion: 0, suiteDigest: null },
    ...(createdAt === undefined ? {} : { createdAt }) };
  const hash = digest(json({ fixture: 'blank-task-admission', operationId, extensionId }));
  transaction(db, () => {
    lifecycle.admit(owner, { extensionId, operationId, hash, name }, () => {});
    db.prepare('INSERT INTO authoring_conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(conversationId, owner, operationId, 0, runId, 'IDLE', 0,
      conversationState.createdAt, JSON.stringify(conversationState), JSON.stringify([{ id: operationId, hash, runId, version: 0 }]),
      JSON.stringify({ messages: [], code: null, review: null }), conversationState.createdAt);
    db.prepare('INSERT INTO extension_conversation_links VALUES (?,?,?,?,?,?)').run(conversationId, owner, extensionId, 'CREATE', null, null);
  });
  return { extensionId, conversationId, state: lifecycle.state(owner, extensionId), conversationState };
}

export function seedEarlierTeamDiscussion(db, projectId, owner = 'maya', text = 'Earlier Team discussion') {
  const id = randomUUID(), runId = randomUUID(), now = Date.now();
  db.prepare('INSERT INTO authoring_conversations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, owner, randomUUID(), 0, runId, 'IDLE', 0,
    now, JSON.stringify({ definitionId: 'daymark.team-authoring/1', projectId }), '[]', '{}', now);
  db.prepare('INSERT INTO authoring_messages VALUES (?,?,?,?,?)')
    .run(id, owner, 1, id, JSON.stringify({ id, role: 'assistant', kind: 'text', text }));
  return id;
}
