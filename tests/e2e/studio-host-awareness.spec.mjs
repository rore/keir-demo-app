import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';
import { taskCustomizationFixture } from '../fixtures/task-customization.mjs';
import { taskTagNotesFixture } from '../fixtures/task-tag-notes.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { createCompiler } from '../../src/compiler.mjs';
import { readAuthoringConfig } from '../../src/authoring-config.mjs';
import { AuthoringError } from '../../src/authoring-provider.mjs';

// Scripted model decisions; real owner scope, tools, compiler, SQLite and browser.
const config = readAuthoringConfig({ KEIR_AI_PROVIDER: 'openai', KEIR_AI_MODEL: 'gpt-5.6-terra', KEIR_AI_MAX_USD: '20', OPENAI_API_KEY: 'synthetic-offline-key' });
const ui = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const composer = page => ui(page).getByLabel('Message to Daymark assistant', { exact: true });
const itemId = page => new URLSearchParams(new URL(page.url()).hash.slice(1)).get('customization');
const snapshot = db => Object.fromEntries(['tasks', 'projects', 'extension_revisions', 'extension_authored', 'extension_evidence',
  'extension_approvals', 'extension_selections', 'extension_history', 'task_events', 'task_effect_receipts']
  .map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));

async function fixture({ empty = false, unsolicitedMutation = false, blockedOnce = false, intents = ['discuss', 'discuss', 'prepare'] } = {}) {
  let f, first, second;
  const calls = [], turns = [];
  f = await startAuthoringFixture({ authoringOverride: { config, providerFactory: () => {
    let step = 0, text, context;
    return { reserveMicros: config.reserveMicros, maxMicros: config.maxMicros, async complete(request) {
      if (request.tools.length === 1 && request.tools[0].name === 'resolve_intent') {
        const intent = intents.shift(); expect(['discuss', 'prepare']).toContain(intent);
        return { calls: [{ id: 'intent', name: 'resolve_intent', arguments: { intent, question: '' } }], text: '', usage: { inputTokens: 2, outputTokens: 1 } };
      }
      if (request.input !== undefined) {
        const input = JSON.parse(request.input); text = input.currentUserMessage; context = input.hostContext;
        turns.push({ text, context, tools: request.tools.map(tool => tool.name) });
      }
      if (blockedOnce) { blockedOnce = false; throw new AuthoringError('PROVIDER_RATE_LIMIT'); }
      const output = request.toolResult && JSON.parse(request.toolResult.output);
      let name, args, reply;
      if (unsolicitedMutation && step === 0) {
        name = 'compile_draft'; args = { hookId: 'TaskCompleted', sourceJson: '{}', expectedDraftVersion: 0 };
      } else if (unsolicitedMutation) {
        expect(output).toEqual({ ok: false, code: 'DISCUSSION_ONLY' });
        reply = 'I can discuss your work without changing a rule. Describe the draft change you want to prepare.';
      } else if (/Open the after-completion rule/.test(text)) {
        if (step === 0) { name = 'inspect_customization'; args = { extensionId: first.extension.id }; }
        else { name = 'offer_customization'; args = { extensionId: first.extension.id }; }
      } else if (/Prepare a change/.test(text)) {
        expect(request.tools.some(tool => tool.name === 'compile_draft')).toBe(true);
        reply = 'Preparation is scoped to this opened customization. Approval and turning it on remain separate.';
      } else if (step === 0) { name = 'discover_customizations'; args = { before: '' }; }
      else if (!empty && step === 1) { name = 'inspect_customization'; args = { extensionId: first.extension.id }; }
      else if (!empty && step === 2) { name = 'inspect_customization'; args = { extensionId: second.extension.id }; }
      else if (step === (empty ? 1 : 3)) {
        name = 'search_tasks'; args = { projectId: f.metadata.projectId, query: empty ? 'not-a-saved-task' : '', tag: '', after: '', includeNotes: 'no' };
      } else {
        expect(output.ok).toBe(true);
        reply = empty
          ? 'There are no other saved customizations. No tasks matched that project search, so I do not have enough evidence to suggest a pattern. What would you like to improve?'
          : 'You have two other saved customizations, both named Task checks. The after-completion rule is on, but its newer draft is not; the before-save rule is a draft. I found unfinished tasks without due dates in The spring collection, so a missing-date check could complement them. Would you like to explore that?';
      }
      step++;
      if (name) calls.push(name);
      return { calls: name ? [{ id: 'context-call-' + step, name, arguments: args }] : [], text: reply ?? '', usage: { inputTokens: 10, outputTokens: 5 } };
    } };
  } } });
  const lifecycle = createLifecycle(f.db, { compiler: createCompiler() });
  if (!empty) {
    const id = admitTaskDraft(f.db, lifecycle, { name: 'Task checks' }).extensionId;
    const source = taskCustomizationFixture({ projectId: f.metadata.projectId, otherProjectId: f.metadata.otherProjectId, title: 'Follow up' });
    const handle = state => ({ extensionId: id, revisionId: state.draft.id, draftVersion: state.draftVersion });
    let state = await lifecycle.compile('maya', { extensionId: id, hookId: 'TaskCompleted', source: source.source, draftVersion: 0 }, () => {});
    state = await lifecycle.proposeScenarios('maya', { ...handle(state), cases: source.cases }, () => {});
    state = await lifecycle.simulate('maya', handle(state), () => {});
    state = lifecycle.approve('maya', { ...handle(state), evidenceId: state.evidence.id }, () => {});
    state = lifecycle.activate('maya', { ...handle(state), generation: state.selection.generation, evidenceId: state.approvedEvidenceId }, () => {});
    const changed = taskCustomizationFixture({ projectId: f.metadata.projectId, otherProjectId: f.metadata.otherProjectId, title: 'Review again' });
    first = await lifecycle.compile('maya', { extensionId: id, hookId: 'TaskCompleted', source: changed.source, draftVersion: state.draftVersion }, () => {});
    const other = admitTaskDraft(f.db, lifecycle, { name: 'Task checks', operationId: 'second-existing-context-rule' }).extensionId;
    const guard = taskTagNotesFixture({ projectId: f.metadata.projectId, otherProjectId: f.metadata.otherProjectId });
    second = await lifecycle.compile('maya', { extensionId: other, hookId: 'TaskBeforeCreate', source: guard.source, draftVersion: 0 }, () => {});
  }
  return Object.assign(f, { first, second, lifecycle, calls, turns });
}

async function enter(page, f) {
  await page.goto(f.origin + '/#new=1');
  await page.getByRole('button', { name: /^Continue as Maya/ }).click();
  await expect(composer(page)).toBeVisible();
}
async function send(page, text) {
  await composer(page).fill(text);
  await ui(page).getByRole('button', { name: 'Send', exact: true }).click();
}

test('a new discussion uses two existing rules and task evidence, then opens an exact item only on click', async ({ page }, info) => {
  const f = await fixture();
  try {
    await enter(page, f);
    const before = snapshot(f.db);
    await send(page, 'What would you suggest based on my existing work?');
    await expect(ui(page).getByText(/You have two other saved customizations/)).toBeVisible();
    expect(f.turns[0].context.otherCustomizationCount).toBe(2);
    expect(f.turns[0].context.intent).toBe('discuss');
    expect(f.turns[0].tools).not.toContain('compile_draft');
    expect(f.calls).toEqual(['discover_customizations', 'inspect_customization', 'inspect_customization', 'search_tasks']);
    expect(snapshot(f.db)).toEqual(before);
    const discussion = itemId(page);
    await send(page, 'Open the after-completion rule, not the before-save rule.');
    const open = ui(page).getByRole('button', { name: 'Open “Task checks”', exact: true });
    await expect(open).toBeVisible();
    expect(itemId(page)).toBe(discussion);
    expect(snapshot(f.db)).toEqual(before);
    await composer(page).fill('Keep this unsent idea for later.');
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 320, height: 740 }]) {
      await page.setViewportSize(viewport);
      await expect(open).toBeVisible();
      await expect(ui(page).locator('#studio-title')).toHaveText('Untitled customization');
      await expect(composer(page)).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`host-awareness-${viewport.width}.png`) });
    }
    const count = f.turns.length;
    await open.click();
    await expect(page).toHaveURL(new RegExp('#customization=' + f.first.extension.id + '$'));
    await expect(composer(page)).toHaveValue('');
    expect(f.turns.length).toBe(count);
    expect(snapshot(f.db)).toEqual(before);
    await send(page, 'Prepare a change to this opened draft.');
    await expect(ui(page).getByText(/Preparation is scoped to this opened customization/)).toBeVisible();
    expect(f.turns.at(-1).context.intent).toBe('prepare');
    expect(f.turns.at(-1).context.editingTarget.extensionId).toBe(f.first.extension.id);
    await page.goto(f.origin + '/#customization=' + discussion);
    await expect(composer(page)).toHaveValue('Keep this unsent idea for later.');
    expect(snapshot(f.db)).toEqual(before);
  } finally { await f.close(); }
});

test('empty collection and insufficient query evidence remain an honest discussion without draft writes', async ({ page }) => {
  const f = await fixture({ empty: true });
  try {
    await enter(page, f); const before = snapshot(f.db);
    await composer(page).fill('What patterns can you find in my tasks?');
    await composer(page).press('Enter');
    await expect(ui(page).getByText(/No tasks matched that project search/)).toBeVisible();
    expect(f.turns[0].context.otherCustomizationCount).toBe(0);
    expect(f.turns[0].context.intent).toBe('discuss');
    expect(snapshot(f.db)).toEqual(before);
  } finally { await f.close(); }
});

test('even an unsolicited provider compile during Send cannot alter tasks, rules, approval or activation', async ({ page }) => {
  const f = await fixture({ unsolicitedMutation: true });
  try {
    await enter(page, f); const before = snapshot(f.db);
    await send(page, 'Just suggest a useful next step.');
    await expect(ui(page).getByText(/I can discuss your work without changing a rule/)).toBeVisible();
    expect(snapshot(f.db)).toEqual(before);
    expect(f.calls).toEqual(['compile_draft']);
  } finally { await f.close(); }
});

test('generic Try again resumes discussion, even after an interrupted preparation request', async ({ page }) => {
  const f = await fixture({ blockedOnce: true, intents: ['prepare'] });
  try {
    await enter(page, f); const before = snapshot(f.db);
    await send(page, 'Prepare a change to this draft.');
    const retry = ui(page).getByRole('button', { name: 'Try again from saved work', exact: true });
    await expect(retry).toBeVisible();
    expect(f.turns[0].context.intent).toBe('prepare');
    await retry.click();
    await expect(ui(page).getByText(/You have two other saved customizations/)).toBeVisible();
    expect(f.turns.at(-1).context.intent).toBe('discuss');
    expect(f.turns.at(-1).tools).not.toContain('compile_draft');
    expect(snapshot(f.db)).toEqual(before);
  } finally { await f.close(); }
});

test('a deleted offered target does not replace the discussion or discard unsent text', async ({ page }) => {
  const f = await fixture();
  try {
    await enter(page, f);
    await send(page, 'Open the after-completion rule.');
    const open = ui(page).getByRole('button', { name: 'Open “Task checks”', exact: true });
    await expect(open).toBeVisible();
    const discussion = itemId(page), count = f.turns.length;
    await composer(page).fill('Keep this question.');
    const state = f.lifecycle.state('maya', f.first.extension.id);
    f.lifecycle.delete('maya', { extensionId: state.extension.id, expectedName: state.extension.name, draftVersion: state.draftVersion, generation: state.selection.generation }, () => {});
    await open.click();
    await expect(ui(page).getByText(/That customization changed or is unavailable/)).toBeVisible();
    expect(itemId(page)).toBe(discussion);
    await expect(composer(page)).toHaveValue('Keep this question.');
    expect(f.turns.length).toBe(count);
  } finally { await f.close(); }
});

test('a delayed offer readback after switching demo person cannot navigate to the prior owner’s item', async ({ page }) => {
  const f = await fixture();
  let release;
  try {
    await enter(page, f);
    await send(page, 'Open the after-completion rule.');
    await expect(ui(page).getByRole('button', { name: 'Open “Task checks”', exact: true })).toBeVisible();
    let arrived;
    const waiting = new Promise(resolve => { arrived = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    await page.route(`**/api/extensions/${f.first.extension.id}`, async route => {
      const response = await route.fetch(); arrived(); await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await ui(page).getByRole('button', { name: 'Open “Task checks”', exact: true }).click();
    await waiting;
    await page.getByLabel('Demo person', { exact: true }).selectOption('leo');
    release();
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('leo');
    await expect(page.getByRole('heading', { name: 'Neighbourhood workshop', exact: true })).toBeVisible();
    await expect(ui(page)).toHaveCount(0);
    expect(page.url()).not.toContain(f.first.extension.id);
  } finally { release?.(); await f.close(); }
});
