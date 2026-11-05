import { randomUUID } from 'node:crypto';
import { transaction } from '../../src/data.mjs';
import { createAuthoringState } from '../../src/authoring-agent.mjs';
import { digest, json, TASK_DEFINITION } from '../../src/extension-catalog.mjs';

// Trusted test admission only: no artifact, approval, qualification, provider call or runtime authority.
export function admitTaskDraft(db, lifecycle, { owner = 'maya', name = 'Task customization', operationId = randomUUID(), extensionId = randomUUID() } = {}) {
  const conversationId = randomUUID(), runId = randomUUID();
  const conversationState = { ...createAuthoringState({ ownerId: owner, sessionId: 'task-fixture', conversationId, runId }),
    definitionId: TASK_DEFINITION, handles: { revisionId: null, draftVersion: 0, suiteDigest: null } };
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
