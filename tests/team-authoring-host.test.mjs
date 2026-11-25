import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthoringState, runAuthoringTurn } from '../src/keir-authoring-agent.mjs';
import { openData, taskService } from '../src/data.mjs';
import { createTeamCapability } from '../src/team-capability.mjs';
import { teamProjectService } from '../src/team-native.mjs';
import { teamAuthoringHost, teamAuthoringTools, teamAuthoringHandlers } from '../src/team-authoring-host.mjs';
import { triageProposal } from './fixtures/team-authored.mjs';

test('the Keir turn discovers, saves and checks an authored Team proposal through the native host', async t => {
  const db = openData(':memory:');
  const capability = createTeamCapability(db), projects = teamProjectService(db);
  t.after(async () => { await capability.close(); db.close(); });
  const { id: projectId } = taskService(db).createProject('maya', { name: 'Launch', mode: 'TEAM' });
  projects.addMember('maya', projectId, { userId: 'leo' });
  const host = teamAuthoringHost({ capability, projects, actor: 'maya', projectId, authorize: () => 'maya' });
  const context = { ownerId: 'maya', sessionId: 'session', conversationId: 'conversation', runId: 'run',
    budget: { remainingMicros: 500 }, current: () => true, checkpoint: () => {} };
  const state = createAuthoringState(context);
  const responses = [
    () => ({ name: 'discover_catalog', arguments: {} }),
    request => {
      const catalog = JSON.parse(request.toolResult.output).result;
      assert.equal(catalog.businessContext.project.id, projectId);
      assert.deepEqual(catalog.businessContext.members.map(m => m.id).sort(), ['leo', 'maya']);
      assert.ok(catalog.model.entrypoints.TaskBeforeComplete);
      return { name: 'save_draft', arguments: { proposalJson: JSON.stringify(triageProposal()) } };
    },
    request => {
      const { draftVersion, revisionId, suiteDigest } = JSON.parse(request.toolResult.output).result;
      assert.equal(draftVersion, 1);
      assert.ok(suiteDigest);
      return { name: 'simulate_draft', arguments: { expectedDraftVersion: draftVersion, revisionId } };
    },
    () => ({ name: 'offer_review', arguments: { summary: 'Review the isolated examples.' } }),
  ];
  let count = 0;
  const provider = { reserveMicros: 1, maxMicros: 500, complete: async request => ({
    calls: [{ id: `call${count}`, ...responses[count++](request) }], text: '', usage: { inputTokens: 1, outputTokens: 1 },
  }) };
  const result = await runAuthoringTurn({ provider, host, context, state, tools: teamAuthoringTools, hostTools: teamAuthoringHandlers,
    input: { id: 'request', expectedVersion: 0, text: 'Make a priority triage task for Leo when someone adds a high-priority task.' } });
  assert.equal(result.status, 'REVIEW_AVAILABLE', result.code);
  assert.equal(result.review.eligible, true);
  assert.equal(result.review.evidenceId, capability.state('maya', projectId).evidence.id);
  const saved = capability.state('maya', projectId);
  assert.equal(saved.selected, null);
  assert.equal(saved.draft.manifest.TaskBeforeComplete, null);
  assert.equal(db.prepare('SELECT count(*) AS n FROM tasks WHERE project_id=?').get(projectId).n, 0);
});
