import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { navigate, openWorkspaceTool, switchPerson } from '../fixtures/workspace-ui.mjs';
import { teamProjectService } from '../../src/team-native.mjs';
import { createTeamRuntime, installTeamRevision } from '../../src/team-runtime.mjs';
import { createTeamCapability } from '../../src/team-capability.mjs';
import { taskService } from '../../src/data.mjs';
import { randomUUID } from 'node:crypto';

async function setup(page, origin) {
  await page.goto(origin);
  await page.getByRole('button', { name: /^Continue as Maya/ }).click();
  await navigate(page, 'Customizations');
  const personalId = await page.getByLabel('Customization scope', { exact: true }).inputValue();
  await page.getByRole('button', { name: 'New customization', exact: true }).click();
  await page.getByLabel('Message to Daymark assistant', { exact: true }).fill('Keep my Personal draft through separate approval and activation.');
  await navigate(page, 'Tasks');
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByLabel('Who is this for?', { exact: true }).selectOption('TEAM');
  await page.getByLabel('New project name', { exact: true }).fill('Lifecycle team');
  const created = page.waitForResponse(r => r.url().endsWith('/api/projects') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Save project', exact: true }).click();
  const project = await (await created).json();
  await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
  const menu = await openWorkspaceTool(page, '.project-tools');
  await menu.getByRole('button', { name: 'Manage members', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Existing demo person', { exact: true }).selectOption('leo');
  await dialog.getByRole('button', { name: 'Add member', exact: true }).click();
  await expect(dialog.getByText('Leo · Member', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await studio(page);
  return { project, personalId };
}
async function studio(page) {
  await navigate(page, 'Customizations');
  await page.getByRole('button', { name: 'Open Studio', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Customization Studio', exact: true })).toBeVisible();
}
async function check(page, fixture, project, version) {
  // Exercise existing saved revisions in Studio without reviving the scripted authoring form.
  const capability = createTeamCapability(fixture.db);
  try {
    await capability.propose('maya', project.id, { expectedDraftVersion: version - 1,
      reviewerId: version === 1 ? 'leo' : 'maya', title: version === 1 ? 'Review deliverable' : 'Check the revised deliverable', intent: 'Saved compatibility fixture' });
  } finally { await capability.close(); }
  await page.getByRole('button', { name: 'Back to Customizations', exact: true }).click();
  await studio(page);
  await page.getByRole('button', { name: 'Check examples', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Approve this draft', exact: true })).toBeEnabled();
}
async function choice(page, name, suffix) {
  const response = page.waitForResponse(r => r.url().endsWith('/capability/' + suffix) && r.request().method() === 'POST');
  await page.getByRole('button', { name, exact: true }).click();
  const result = await response;
  expect(result.status()).toBe(200);
  return result.json();
}
async function createTask(page, title) {
  await page.getByLabel('New task title', { exact: true }).fill(title);
  const response = page.waitForResponse(r => r.url().endsWith('/api/tasks') && r.request().method() === 'POST');
  await page.locator('.quick-add').getByRole('button', { name: /Add task/ }).click();
  const task = await (await response).json();
  await expect(page.getByRole('button', { name: title, exact: true })).toBeVisible();
  return task;
}
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`ordinary separate approval/activation, replacement pins and two-user work at ${viewport.width}`, async ({ page }, info) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    try {
      await page.setViewportSize(viewport);
      const { project, personalId } = await setup(page, fixture.origin);
      await check(page, fixture, project, 1);
      const currentUse = page.getByRole('region', { name: 'Review and current use', exact: true });
      await expect(currentUse).toContainText('Nothing is on for new tasks.');
      await currentUse.screenshot({ path: info.outputPath('separate-choice-controls.png') });
      const approved = await choice(page, 'Approve this draft', 'approvals');
      const saved = page.getByRole('region', { name: 'Saved Team action', exact: true });
      await expect(saved.getByRole('status')).toHaveText('Draft approved. It’s not on yet.');
      expect(fixture.db.prepare('SELECT revision_id,generation FROM team_selections WHERE project_id=?').get(project.id)).toEqual({ revision_id: null, generation: 0 });
      await page.screenshot({ path: info.outputPath('approved-not-active.png') });
      await currentUse.screenshot({ path: info.outputPath('approved-activation-available.png') });
      const first = await choice(page, 'Turn on for new tasks', 'activations');
      await expect(saved.getByRole('status')).toHaveText('Turned on for new tasks.');
      expect(first.receipt.approvalId).toBe(approved.receipt.id);
      expect(first.current.generation).toBe(1);
      await expect(currentUse).toContainText('On for new tasks');
      await page.screenshot({ path: info.outputPath('active-for-new-work.png') });
      await navigate(page, 'Tasks');
      const old = await createTask(page, 'A deliverable');
      await expect(page.getByRole('button', { name: 'Review deliverable', exact: true })).toBeVisible();
      const oldPin = fixture.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(old.id);
      await studio(page);
      await check(page, fixture, project, 2);
      const secondApproval = await choice(page, 'Approve this draft', 'approvals');
      expect(fixture.db.prepare('SELECT revision_id FROM team_selections WHERE project_id=?').get(project.id).revision_id).toBe(oldPin.revision_id);
      expect(secondApproval.receipt.revisionId).not.toBe(oldPin.revision_id);
      await expect(currentUse).toContainText('Approved · Not on yet');
      await expect(currentUse).toContainText('This replaces the customization in use');
      await currentUse.screenshot({ path: info.outputPath('replacement-approved-not-in-use.png') });
      const second = await choice(page, 'Turn on for new tasks', 'activations');
      expect(second.receipt.approvalId).toBe(secondApproval.receipt.id);
      expect(second.current.generation).toBe(2);
      expect(second.current.revisionId).toBe(secondApproval.receipt.revisionId);
      await expect(currentUse).toContainText('On for new tasks');
      await currentUse.screenshot({ path: info.outputPath('replacement-in-use.png') });
      expect(fixture.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(old.id)).toEqual(oldPin);
      await page.getByLabel('Customization scope', { exact: true }).selectOption(personalId);
      await page.getByRole('button', { name: 'Return to Personal Studio', exact: true }).click();
      await expect(page.getByLabel('Message to Daymark assistant', { exact: true })).toHaveValue('Keep my Personal draft through separate approval and activation.');
      await navigate(page, 'Customizations');
      await page.getByLabel('Customization scope', { exact: true }).selectOption(project.id);
      await navigate(page, 'Tasks');
      const recent = await createTask(page, 'B deliverable');
      await expect(page.getByRole('button', { name: 'Check the revised deliverable', exact: true })).toBeVisible();
      expect(fixture.db.prepare('SELECT revision_id FROM team_admissions WHERE source_task_id=?').get(recent.id).revision_id).toBe(second.receipt.revisionId);
      await page.getByRole('button', { name: 'Complete A deliverable', exact: true }).click();
      await expect(page.getByText('This task stayed open.', { exact: true })).toBeVisible();
      await switchPerson(page, 'leo');
      await expect(page.getByRole('heading', { name: project.name, exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Complete Review deliverable', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Review deliverable, completed', exact: true })).toBeDisabled();
      await navigate(page, 'Customizations');
      await expect(page.getByRole('button', { name: 'Open Studio', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Approve this draft', exact: true })).toHaveCount(0);
      await switchPerson(page, 'maya');
      await page.getByRole('button', { name: 'Complete A deliverable', exact: true }).click();
      await expect(page.getByRole('button', { name: 'A deliverable, completed', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Complete Check the revised deliverable', exact: true }).click();
      await page.getByRole('button', { name: 'Complete B deliverable', exact: true }).click();
      await expect(page.getByRole('button', { name: 'B deliverable, completed', exact: true })).toBeDisabled();
      await page.screenshot({ path: info.outputPath('old-and-new-native-work.png') });
      expect(fixture.requests).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    } finally { await page.close(); await fixture.close(); }
  });

  test(`late evidence, lost reply after native replacement and later failure at ${viewport.width}`, async ({ page }, info) => {
    const fixture = await startAuthoringFixture({ unconfigured: true });
    try {
      await page.setViewportSize(viewport);
      const { project } = await setup(page, fixture.origin);
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
      await page.route(`**/api/projects/${project.id}/capability/evidence/*`, async route => {
        const response = await route.fetch(); entered(); await gate; await route.fulfill({ response }).catch(() => {});
      }, { times: 1 });
      const checking = check(page, fixture, project, 1);
      await started;
      await expect(page.getByRole('button', { name: 'Approve this draft', exact: true })).toHaveCount(0);
      expect(fixture.db.prepare('SELECT count(*) AS n FROM team_approvals').get().n).toBe(0);
      release(); await checking;
      const approval = await choice(page, 'Approve this draft', 'approvals');
      let posts = 0;
      page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/capability/activations')) posts++; });
      await page.route(`**/api/projects/${project.id}/capability/activations`, async route => { await route.fetch(); await route.abort('failed'); }, { times: 1 });
      await page.getByRole('button', { name: 'Turn on for new tasks', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Check saved action', exact: true })).toBeVisible();
      const first = fixture.db.prepare('SELECT * FROM team_activations WHERE project_id=?').get(project.id);
      expect(first.generation).toBe(1);
      teamProjectService(fixture.db).setSelection('maya', project.id, null);
      await page.reload();
      await page.getByRole('button', { name: 'Open Studio', exact: true }).click();
      await page.getByRole('button', { name: 'Check saved action', exact: true }).click();
      const saved = page.getByRole('region', { name: 'Saved Team action', exact: true });
      await expect(saved).toContainText('That activation is historical. Current use has changed');
      await saved.locator('summary').click();
      await expect(saved.locator('pre')).toContainText(first.id);
      await expect(saved.locator('pre')).toContainText(first.operation_id);
      await expect(saved.locator('pre')).toContainText(approval.receipt.id);
      expect(posts).toBe(1);
      expect(fixture.db.prepare('SELECT generation FROM team_selections WHERE project_id=?').get(project.id).generation).toBe(2);
      await page.screenshot({ path: info.outputPath('exact-historical-activation.png') });
      const proof = fixture.db.prepare('SELECT * FROM team_evidence WHERE id=?').get(approval.receipt.evidenceId);
      const cases = JSON.parse(proof.cases); cases[0].actions[2].expect.decision = 'ALLOW';
      const session = await (await page.request.get(fixture.origin + '/api/session')).json();
      const failed = await page.request.post(`${fixture.origin}/api/projects/${project.id}/capability/simulations`, {
        headers: { origin: fixture.origin, 'x-session-context': session.contextToken },
        data: { expectedDraftVersion: 1, revisionId: first.revision_id, cases },
      });
      expect(failed.status()).toBe(200);
      const rejected = page.waitForResponse(r => r.url().endsWith('/capability/activations') && r.request().method() === 'POST');
      await page.getByRole('button', { name: 'Turn on for new tasks', exact: true }).click();
      expect((await rejected).status()).toBe(409);
      expect(fixture.db.prepare('SELECT count(*) AS n FROM team_activations').get().n).toBe(1);
      await page.getByRole('button', { name: 'Check saved action', exact: true }).click();
      await expect(saved).toContainText('The server rejected this action and no receipt is saved. Nothing was retried.');
      await expect(page.getByRole('button', { name: 'Check saved action', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Turn on for new tasks', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Approve this draft', exact: true })).toHaveCount(0);
      expect(posts).toBe(2);
      await page.screenshot({ path: info.outputPath('later-failure-blocks-new-activation.png') });
      await page.getByRole('region', { name: 'Review and current use', exact: true })
        .screenshot({ path: info.outputPath('later-failure-disabled-controls.png') });
      await switchPerson(page, 'leo');
      await navigate(page, 'Customizations');
      await expect(page.getByRole('region', { name: 'Saved Team action', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Open Studio', exact: true })).toBeDisabled();
      expect(fixture.requests).toEqual([]);
    } finally { await page.close(); await fixture.close(); }
  });

  test(`native stop controls preserve old work, revoke exactly and prepare a fresh replacement at ${viewport.width}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    const fixture = await startAuthoringFixture({ unconfigured: true });
    try {
      await page.setViewportSize(viewport);
      const { project, personalId } = await setup(page, fixture.origin);
      const currentUse = page.getByRole('region', { name: 'Review and current use', exact: true });
      await check(page, fixture, project, 1);
      await expect(page.getByRole('button', { name: 'Turn off for new tasks', exact: true })).toHaveCount(0);
      await choice(page, 'Approve this draft', 'approvals');
      const active = await choice(page, 'Turn on for new tasks', 'activations');
      await navigate(page, 'Tasks');
      const old = await createTask(page, 'Started before deactivation');
      await expect(page.getByRole('button', { name: 'Review deliverable', exact: true })).toBeVisible();
      const oldPin = fixture.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(old.id);
      await studio(page);
      await page.getByRole('button', { name: 'Turn off for new tasks', exact: true }).click();
      const confirmation = page.getByRole('group', { name: 'Confirm Team control', exact: true });
      await expect(confirmation.getByRole('heading')).toBeFocused();
      await expect(confirmation).not.toContainText(active.receipt.revisionId);
      await expect(confirmation).toContainText('Started work keeps its existing rule.');
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Turn off for new tasks', exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Turn off for new tasks', exact: true }).click();
      await confirmation.screenshot({ path: info.outputPath('deactivation-consequences.png') });
      const stopped = await choice(page, 'Confirm stop for new tasks', 'deactivations');
      expect(stopped.receipt.input.targetRevisionId).toBe(active.receipt.revisionId);
      expect(stopped.current.revisionId).toBeNull();
      expect(stopped.current.generation).toBe(2);
      expect(fixture.db.prepare('SELECT revision_id,manifest FROM team_admissions WHERE source_task_id=?').get(old.id))
        .toEqual({ revision_id: oldPin.revision_id, manifest: oldPin.manifest });
      await expect(currentUse).toContainText('Nothing is on for new tasks.');
      await currentUse.screenshot({ path: info.outputPath('deactivated-current-use.png') });
      // Personal drafts are session-scoped; verify navigation continuity before switching people.
      await page.getByLabel('Customization scope', { exact: true }).selectOption(personalId);
      await page.getByRole('button', { name: 'Return to Personal Studio', exact: true }).click();
      await expect(page.getByLabel('Message to Daymark assistant', { exact: true })).toHaveValue('Keep my Personal draft through separate approval and activation.');
      await navigate(page, 'Customizations');
      await page.getByLabel('Customization scope', { exact: true }).selectOption(project.id);
      await navigate(page, 'Tasks');
      const uncovered = await createTask(page, 'New no-policy work');
      await page.getByRole('button', { name: 'Complete New no-policy work', exact: true }).click();
      await expect(page.getByRole('button', { name: 'New no-policy work, completed', exact: true })).toBeDisabled();
      expect(fixture.db.prepare('SELECT policy_state FROM team_admissions WHERE source_task_id=?').get(uncovered.id).policy_state).toBe('NO_POLICY');
      await switchPerson(page, 'leo');
      await page.getByRole('button', { name: 'Complete Review deliverable', exact: true }).click();
      await switchPerson(page, 'maya');
      await page.getByRole('button', { name: 'Complete Started before deactivation', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Started before deactivation, completed', exact: true })).toBeDisabled();
      await studio(page);
      await choice(page, 'Turn on for new tasks', 'activations');
      await navigate(page, 'Tasks');
      const blocked = await createTask(page, 'Covered work to revoke');
      await expect(page.getByRole('button', { name: 'Complete Review deliverable', exact: true })).toBeVisible();
      await studio(page);
      await page.getByText('Emergency revocation', { exact: true }).click();
      await page.getByLabel('Exact revision to revoke', { exact: true }).selectOption(active.receipt.revisionId);
      await page.getByRole('button', { name: 'Review emergency revocation', exact: true }).click();
      await expect(confirmation).toContainText('permanently revoked');
      await confirmation.screenshot({ path: info.outputPath('revocation-consequences.png') });
      const revoked = await choice(page, 'Revoke this exact revision', 'revocations');
      expect(revoked.target.revokedAt).toBeGreaterThan(0);
      expect(revoked.current.revisionId).toBeNull();
      await expect(page.getByText('This saved draft is revoked. It cannot run, be approved or be activated. Prepare a fresh revision to replace it.', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Check examples', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Approve this draft', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Turn on for new tasks', exact: true })).toHaveCount(0);
      await page.getByRole('region', { name: 'Saved Team action', exact: true }).screenshot({ path: info.outputPath('revoked-exact-target.png') });
      await navigate(page, 'Tasks');
      await page.getByRole('button', { name: 'Complete Covered work to revoke', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('The pinned Team check is unavailable.');
      const covered = fixture.db.prepare('SELECT * FROM team_admissions WHERE source_task_id=?').get(blocked.id);
      expect(covered.revision_id).toBe(active.receipt.revisionId); expect(covered.receipt).toBeTruthy();
      await switchPerson(page, 'leo');
      await page.getByRole('button', { name: 'Complete Review deliverable', exact: true }).click();
      await switchPerson(page, 'maya');
      await studio(page);
      await check(page, fixture, project, 2);
      expect(fixture.db.prepare('SELECT revision_id FROM team_selections WHERE project_id=?').get(project.id).revision_id).toBeNull();
      await choice(page, 'Approve this draft', 'approvals');
      const next = await choice(page, 'Turn on for new tasks', 'activations');
      expect(next.receipt.revisionId).not.toBe(active.receipt.revisionId);
      await currentUse.screenshot({ path: info.outputPath('fresh-replacement-after-revocation.png') });
      expect(fixture.requests).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    } finally { await page.close(); await fixture.close(); }
  });

  test(`an older completed-root pending effect is explicitly revocable with exact lost-reply readback at ${viewport.width}`, async ({ page }, info) => {
    test.setTimeout(60_000);
    const fixture = await startAuthoringFixture({ unconfigured: true });
    let runtime;
    try {
      await page.setViewportSize(viewport);
      const { project } = await setup(page, fixture.origin);
      await check(page, fixture, project, 1);
      const source = fixture.db.prepare('SELECT * FROM team_revisions WHERE project_id=?').get(project.id);
      const manifest = JSON.parse(source.manifest), artifacts = JSON.parse(source.artifacts);
      installTeamRevision(fixture.db, 'maya', project.id, 'legacy-A', { TaskCreated: Buffer.from(artifacts[manifest.TaskCreated]), TaskBeforeComplete: null });
      teamProjectService(fixture.db).setSelection('maya', project.id, 'legacy-A');
      runtime = createTeamRuntime({ db: fixture.db });
      const tasks = taskService(fixture.db, { team: runtime });
      const old = await tasks.createTask('maya', { projectId: project.id, title: 'Completed root, pending effect' }, { operationId: randomUUID() });
      await tasks.completeTask('maya', old.id);
      expect(runtime.status('maya', old.id).state).toBe('PENDING');
      await studio(page);
      await check(page, fixture, project, 2);
      await choice(page, 'Approve this draft', 'approvals');
      const active = await choice(page, 'Turn on for new tasks', 'activations');
      await page.getByText('Emergency revocation', { exact: true }).click();
      await page.getByLabel('Exact revision to revoke', { exact: true }).selectOption('legacy-A');
      const emergency = page.getByText('Emergency revocation', { exact: true }).locator('..');
      await expect(emergency.getByRole('status')).toContainText('Not selected. Not the saved draft.');
      await expect(emergency.getByRole('status')).toContainText('Open deliverables: 0. Pending or started effects: 1.');
      await emergency.screenshot({ path: info.outputPath('older-pending-effect-target.png') });
      let posts = 0;
      page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/capability/revocations')) posts++; });
      await page.route(`**/api/projects/${project.id}/capability/revocations`, async route => { await route.fetch(); await route.abort('failed'); }, { times: 1 });
      await page.getByRole('button', { name: 'Review emergency revocation', exact: true }).click();
      await page.getByRole('button', { name: 'Revoke this exact revision', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Check saved action', exact: true })).toBeVisible();
      const savedControl = fixture.db.prepare('SELECT * FROM team_controls WHERE project_id=?').get(project.id);
      const nativeSelection = fixture.db.prepare('SELECT * FROM team_selections WHERE project_id=?').get(project.id);
      expect(nativeSelection.revision_id).toBe(active.current.revisionId);
      expect(nativeSelection.generation).toBe(active.current.generation);
      expect(JSON.parse(savedControl.result).before).toEqual(JSON.parse(savedControl.result).after);
      await runtime.wake();
      expect(tasks.getTask('maya', old.id).status).toBe('completed');
      expect(fixture.db.prepare('SELECT count(*) AS n FROM tasks WHERE parent_task_id=?').get(old.id).n).toBe(0);
      expect(fixture.db.prepare('SELECT receipt FROM team_admissions WHERE source_task_id=?').get(old.id).receipt).toBeNull();
      teamProjectService(fixture.db).setSelection('maya', project.id, null);
      teamProjectService(fixture.db).setSelection('maya', project.id, active.current.revisionId);
      await page.reload();
      await page.getByRole('button', { name: 'Open Studio', exact: true }).click();
      await page.getByRole('button', { name: 'Check saved action', exact: true }).click();
      const saved = page.getByRole('region', { name: 'Saved Team action', exact: true });
      await expect(saved).toContainText('Emergency revocation recorded for the exact revision.');
      await saved.locator('summary').click();
      await expect(saved.getByText('Target: legacy-A · Revoked', { exact: true })).toBeVisible();
      await expect(saved.locator('pre')).toContainText(savedControl.id);
      await expect(saved.locator('pre')).toContainText(savedControl.operation_id);
      await saved.screenshot({ path: info.outputPath('historical-revocation-current-target.png') });
      await page.getByText('Support diagnostics', { exact: true }).click();
      await page.getByText('Exact current-use receipt', { exact: true }).click();
      await expect(page.getByText('Exact current-use receipt', { exact: true }).locator('..').locator('pre')).toContainText('"activation": null');
      expect(fixture.db.prepare('SELECT generation FROM team_selections WHERE project_id=?').get(project.id).generation).toBe(nativeSelection.generation + 2);
      expect(posts).toBe(1);
      await switchPerson(page, 'leo');
      await navigate(page, 'Customizations');
      await expect(page.getByRole('button', { name: 'Open Studio', exact: true })).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Review emergency revocation', exact: true })).toHaveCount(0);
      expect(fixture.requests).toEqual([]);
    } finally { await runtime?.close(); await page.close(); await fixture.close(); }
  });
}
