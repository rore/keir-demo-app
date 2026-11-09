import { test, expect } from '@playwright/test';
import { startAuthoringFixture } from '../fixtures/authoring-server.mjs';
import { createLifecycle } from '../../src/extension-lifecycle.mjs';
import { admitTaskDraft } from '../fixtures/task-authoring.mjs';

const studio = page => page.getByRole('region', { name: 'Customization Studio', exact: true });
const composer = page => studio(page).getByLabel('Message to Daymark assistant', { exact: true });
async function api(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch('/api/' + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Session-Context': session.contextToken, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    if (!response.ok) throw new Error('Synthetic request failed: ' + response.status);
    return value;
  }, { path, body });
}
function seed(fixture, name, owner = 'maya') {
  return admitTaskDraft(fixture.db, createLifecycle(fixture.db), { name, owner }).extensionId;
}
async function enter(page, fixture) {
  await page.goto(fixture.origin);
  await page.getByRole('button', { name: /^Continue as Maya/ }).click();
  await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
}
async function navigate(page, destination) {
  const mobile = page.getByLabel('Destination', { exact: true });
  if (await mobile.isVisible()) await mobile.selectOption(destination.toLowerCase());
  else await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: destination, exact: true }).click();
}
async function openItem(page, id) {
  await navigate(page, 'Customizations');
  await page.locator('#edit-' + id).click();
  await expect(composer(page)).toBeVisible();
}
async function reopen(page, id) {
  await navigate(page, 'Tasks');
  await openItem(page, id);
}
function writes(page) {
  const requests = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.startsWith('/api/') && path !== '/api/session')
      requests.push({ path, body: request.postDataJSON() });
  });
  return requests;
}

test('an unsent item draft survives task navigation and reload without leaking to another item or submitting', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const first = seed(fixture, 'First draft example'), second = seed(fixture, 'Second draft example');
    await enter(page, fixture);
    const requests = writes(page), before = await api(page, `extensions/${first}`);
    await openItem(page, first);
    const text = '  Keep this question about weekends 🌱\nExactly as typed.  ';
    await composer(page).fill(text);
    await reopen(page, first);
    await expect(composer(page)).toHaveValue(text);
    await page.reload();
    await expect(composer(page)).toHaveValue(text);
    await openItem(page, second);
    await expect(composer(page)).toHaveValue('');
    await composer(page).fill('A different item’s unsent question');
    await openItem(page, first);
    await expect(composer(page)).toHaveValue(text);
    expect(await api(page, `extensions/${first}`)).toEqual(before);
    expect(requests).toEqual([]); expect(fixture.requests).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});

test('drafts are isolated by person and auth session while same-session reload retains them', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    const first = seed(fixture, 'First person draft'), other = seed(fixture, 'Second person draft', 'leo');
    await enter(page, fixture);
    const requests = writes(page), tokens = [(await api(page, 'session')).contextToken];
    await openItem(page, first);
    await composer(page).fill('First person’s private unsent question');
    await page.reload();
    expect((await api(page, 'session')).contextToken).toBe(tokens[0]);
    await expect(composer(page)).toHaveValue('First person’s private unsent question');
    await page.getByLabel('Demo person', { exact: true }).selectOption('leo');
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('leo');
    tokens.push((await api(page, 'session')).contextToken);
    await openItem(page, other);
    await expect(composer(page)).toHaveValue('');
    await composer(page).fill('Second person’s private unsent question');
    await page.getByLabel('Demo person', { exact: true }).selectOption('maya');
    await expect(page.getByLabel('Demo person', { exact: true })).toHaveValue('maya');
    tokens.push((await api(page, 'session')).contextToken);
    expect(tokens[2]).not.toBe(tokens[0]);
    await openItem(page, first);
    await expect(composer(page)).toHaveValue('');
    await composer(page).fill('A draft for the new session');
    const renewed = await api(page, 'session', { userId: 'maya' });
    expect(renewed.contextToken).not.toBe(tokens[2]); tokens.push(renewed.contextToken);
    // Direct same-person rotation also covers a missed cross-tab notification.
    await page.reload();
    await expect(composer(page)).toHaveValue('');
    const stored = await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)));
    for (const token of tokens) expect(stored).not.toContain(token);
    expect(requests).toEqual([]); expect(fixture.requests).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});

test('unavailable draft storage keeps the current text across route remounts in memory and reports the actual fault', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await page.addInitScript(() => {
      for (const method of ['getItem', 'setItem', 'removeItem']) {
        const original = Storage.prototype[method];
        Storage.prototype[method] = function (key, ...args) {
          if (String(key).startsWith('daymark-studio-draft:')) throw new DOMException('Synthetic draft storage failure', 'QuotaExceededError');
          return original.call(this, key, ...args);
        };
      }
    });
    const id = seed(fixture, 'Memory-only draft example');
    await enter(page, fixture);
    const requests = writes(page);
    await openItem(page, id);
    const text = 'Keep this draft even when tab storage is unavailable.';
    await composer(page).fill(text);
    await expect(studio(page).getByText(/could not keep this draft for reload/)).toBeVisible();
    await expect(composer(page)).toHaveValue(text);
    await reopen(page, id);
    await expect(composer(page)).toHaveValue(text);
    await expect(studio(page).getByText(/could not keep this draft for reload/)).toBeVisible();
    expect(requests).toEqual([]); expect(fixture.requests).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});

for (const [label, newer] of [['identical new input', 'Help me customize a task follow-up.'],
  ['a different new question', 'Would this also apply during weekends?']]) {
  test(`a held accepted creation preserves ${label} through binding, reopening and reload`, async ({ page }) => {
    const fixture = await startAuthoringFixture();
    const gate = Promise.withResolvers(), arrived = Promise.withResolvers(), delivered = Promise.withResolvers();
    try {
      await enter(page, fixture);
      const requests = writes(page);
      await navigate(page, 'Customizations');
      const selected = (await api(page, 'extensions')).selection;
      await page.getByRole('button', { name: 'New customization', exact: true }).click();
      await page.route('**/api/authoring/turn', async route => {
        const response = await route.fetch(); expect(response.status()).toBe(202);
        arrived.resolve(await response.json()); await gate.promise;
        try { await route.fulfill({ response }); } catch { /* Teardown can close the held page. */ }
        finally { delivered.resolve(); }
      }, { times: 1 });
      const submitted = 'Help me customize a task follow-up.';
      await composer(page).fill(submitted);
      await studio(page).getByRole('button', { name: 'Send', exact: true }).click();
      const accepted = await arrived.promise;
      await expect(composer(page)).toHaveValue(submitted);
      await composer(page).fill('An intermediate edit proves this is a newer draft');
      await composer(page).fill(newer);
      gate.resolve(); await delivered.promise;
      await expect(studio(page).getByText(fixture.metadata.question, { exact: true })).toBeVisible();
      await expect(composer(page)).toHaveValue(newer);
      const id = accepted.conversation.extensionId;
      expect(id).toBeTruthy(); await expect(page).toHaveURL(new RegExp('customization=' + id));
      const discussion = await api(page, 'authoring?extensionId=' + id), saved = await api(page, `extensions/${id}`);
      expect(discussion.transcript.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([submitted]);
      expect(saved.approved).toBe(false); expect((await api(page, 'extensions')).selection).toEqual(selected);
      await reopen(page, id); await expect(composer(page)).toHaveValue(newer);
      await page.reload(); await expect(composer(page)).toHaveValue(newer);
      expect((await api(page, 'authoring?extensionId=' + id)).transcript.messages).toEqual(discussion.transcript.messages);
      expect(await api(page, `extensions/${id}`)).toEqual(saved);
      expect(requests.map(request => request.path)).toEqual(['/api/authoring/turn']);
      expect(requests[0].body.text).toBe(submitted);
      expect(fixture.requests.map(request => request.name)).toEqual(['discover_catalog', 'ask_clarification']);
    } finally { gate.resolve(); await page.close(); await fixture.close(); }
  });
}

test('a held definitive rejection does not resurrect submitted text after a newer draft is deliberately emptied', async ({ page }) => {
  const fixture = await startAuthoringFixture();
  const gate = Promise.withResolvers(), arrived = Promise.withResolvers(), delivered = Promise.withResolvers();
  try {
    const id = seed(fixture, 'Rejected draft example');
    await enter(page, fixture); await openItem(page, id);
    const requests = writes(page), before = await api(page, `extensions/${id}`);
    await page.route('**/api/authoring/turn', async route => {
      arrived.resolve(); await gate.promise;
      try { await route.fulfill({ status: 409, json: { code: 'CONFIG_CHANGED', message: 'Synthetic request rejection.' } }); }
      catch { /* Teardown can close the held page. */ } finally { delivered.resolve(); }
    }, { times: 1 });
    await composer(page).fill('The original submitted question');
    await studio(page).getByRole('button', { name: 'Send', exact: true }).click(); await arrived.promise;
    await expect(composer(page)).toHaveValue('The original submitted question');
    await composer(page).fill('A newer draft'); await composer(page).fill('');
    gate.resolve(); await delivered.promise;
    await expect(studio(page).getByRole('alert').filter({ hasText: 'settings changed' })).toBeVisible();
    await expect(composer(page)).toHaveValue('');
    await reopen(page, id); await expect(composer(page)).toHaveValue('');
    expect(await api(page, `extensions/${id}`)).toEqual(before);
    expect(requests.map(request => request.path)).toEqual(['/api/authoring/turn']);
    expect(fixture.requests).toEqual([]);
  } finally { gate.resolve(); await page.close(); await fixture.close(); }
});

test('a new component recovering an accepted request keeps a restored newer identical draft', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await startAuthoringFixture();
  const gate = Promise.withResolvers(), recovering = Promise.withResolvers(), delivered = Promise.withResolvers();
  try {
    await enter(page, fixture);
    const requests = writes(page);
    await navigate(page, 'Customizations');
    await page.getByRole('button', { name: 'New customization', exact: true }).click();
    await page.route('**/api/authoring/turn', async route => {
      const response = await route.fetch(); expect(response.status()).toBe(202); await route.abort('failed');
    }, { times: 1 });
    await page.route('**/api/authoring/recover', async route => {
      const response = await route.fetch(); expect(response.ok()).toBe(true);
      recovering.resolve(await response.json()); await gate.promise;
      try { await route.fulfill({ response }); } catch { /* Reload aborts the old read. */ }
      finally { delivered.resolve(); }
    }, { times: 1 });
    const submitted = 'Keep the exact project choice for this task follow-up.';
    await composer(page).fill(submitted);
    await studio(page).getByRole('button', { name: 'Send', exact: true }).click();
    const recovered = await recovering.promise;
    await composer(page).fill('An intermediate newer edit'); await composer(page).fill(submitted);
    await page.reload();
    await expect(studio(page).getByText(fixture.metadata.question, { exact: true })).toBeVisible();
    await expect(composer(page)).toHaveValue(submitted);
    gate.resolve(); await delivered.promise;
    await expect(composer(page)).toHaveValue(submitted);
    const id = recovered.conversation.extensionId;
    const discussion = await api(page, 'authoring?extensionId=' + id);
    expect(discussion.transcript.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([submitted]);
    expect(requests.filter(request => request.path === '/api/authoring/turn')).toHaveLength(1);
    const recoveries = requests.filter(request => request.path === '/api/authoring/recover');
    expect(recoveries.length).toBeGreaterThanOrEqual(2);
    for (const request of recoveries) expect(request.body).toEqual(requests[0].body);
    expect(requests.every(request => ['/api/authoring/turn', '/api/authoring/recover'].includes(request.path))).toBe(true);
    expect(fixture.requests.map(request => request.name)).toEqual(['discover_catalog', 'ask_clarification']);
  } finally { gate.resolve(); await page.close(); await fixture.close(); }
});

test('unavailable session hashing keeps the app usable and the same-item draft in memory without storing credentials or submitting', async ({ page }) => {
  const fixture = await startAuthoringFixture({ unconfigured: true });
  try {
    await page.addInitScript(() => {
      Object.defineProperty(crypto.subtle, 'digest', { configurable: true,
        value: async () => { throw new Error('Synthetic session fingerprint failure'); } });
    });
    const id = seed(fixture, 'Session hashing unavailable example');
    await enter(page, fixture);
    const requests = writes(page), token = (await api(page, 'session')).contextToken;
    const before = await api(page, `extensions/${id}`);
    await openItem(page, id);
    const text = 'Keep this question in this tab when session hashing is unavailable.';
    await composer(page).fill(text);
    await expect(studio(page).getByText(/could not keep this draft for reload/)).toBeVisible();
    await reopen(page, id);
    await expect(composer(page)).toHaveValue(text);
    await expect(studio(page).getByText(/could not keep this draft for reload/)).toBeVisible();
    const stored = await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)));
    expect(stored).not.toContain(token);
    expect(await api(page, `extensions/${id}`)).toEqual(before);
    expect(requests).toEqual([]); expect(fixture.requests).toEqual([]);
  } finally { await page.close(); await fixture.close(); }
});

test('a remounted deliberately empty draft survives definitive rejection of an explicitly retried unconfirmed request', async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await startAuthoringFixture();
  const gate = Promise.withResolvers(), recovering = Promise.withResolvers(), delivered = Promise.withResolvers();
  let turns = 0, reads = 0;
  try {
    const id = seed(fixture, 'Empty draft recovery example');
    await enter(page, fixture); await openItem(page, id);
    const requests = writes(page), before = await api(page, `extensions/${id}`);
    await page.route('**/api/authoring/turn', async route => {
      if (++turns === 1) { await route.abort('failed'); return; }
      await route.fulfill({ status: 409, json: { code: 'CONFIG_CHANGED', message: 'Synthetic request rejection.' } });
    });
    await page.route('**/api/authoring/recover', async route => {
      const held = ++reads === 1;
      if (held) { recovering.resolve(); await gate.promise; }
      try { await route.fulfill({ status: 404, json: { message: 'Synthetic request was not admitted.' } }); }
      catch { /* Reload aborts the old read. */ } finally { if (held) delivered.resolve(); }
    });
    const submitted = 'The original request must not return to my deliberately empty draft.';
    await composer(page).fill(submitted);
    await studio(page).getByRole('button', { name: 'Send', exact: true }).click();
    await recovering.promise;
    await composer(page).fill('A newer draft before deliberately clearing it');
    await composer(page).fill('');
    await page.reload();
    const retry = studio(page).getByRole('button', { name: 'Retry submitted request', exact: true });
    await expect(retry).toBeEnabled();
    await expect(composer(page)).toHaveValue('');
    expect(requests.filter(request => request.path === '/api/authoring/turn')).toHaveLength(1);
    await retry.click();
    await expect(studio(page).getByRole('alert').filter({ hasText: 'settings changed' })).toBeVisible();
    await expect(composer(page)).toHaveValue('');
    gate.resolve(); await delivered.promise;
    await expect(composer(page)).toHaveValue('');
    await reopen(page, id); await expect(composer(page)).toHaveValue('');
    const submittedRequests = requests.filter(request => request.path === '/api/authoring/turn');
    expect(submittedRequests).toHaveLength(2);
    expect(submittedRequests[0].body.text).toBe(submitted);
    expect(submittedRequests[1].body).toEqual(submittedRequests[0].body);
    const recoveries = requests.filter(request => request.path === '/api/authoring/recover');
    expect(recoveries.length).toBeGreaterThanOrEqual(2);
    for (const request of recoveries) expect(request.body).toEqual(submittedRequests[0].body);
    expect(requests.every(request => ['/api/authoring/turn', '/api/authoring/recover'].includes(request.path))).toBe(true);
    expect(await api(page, `extensions/${id}`)).toEqual(before);
    expect(fixture.requests).toEqual([]);
  } finally { gate.resolve(); await page.close(); await fixture.close(); }
});

test('accepted text stays cleared across route remounts when removing its persisted draft fails', async ({ page }) => {
  const fixture = await startAuthoringFixture();
  try {
    const id = seed(fixture, 'Submitted draft removal failure example');
    await enter(page, fixture); await openItem(page, id);
    const requests = writes(page), submitted = 'Ask me before choosing this task follow-up project.';
    await composer(page).fill(submitted);
    const stored = await page.evaluate(text => Object.entries(sessionStorage)
      .filter(([key, value]) => key.startsWith('daymark-studio-draft:') && value === text), submitted);
    expect(stored).toHaveLength(1);
    await page.evaluate(() => {
      const original = Storage.prototype.removeItem;
      Storage.prototype.removeItem = function (key) {
        if (String(key).startsWith('daymark-studio-draft:')) throw new DOMException('Synthetic draft removal failure', 'QuotaExceededError');
        return original.call(this, key);
      };
    });
    await studio(page).getByRole('button', { name: 'Send', exact: true }).click();
    await expect(studio(page).getByText(fixture.metadata.question, { exact: true })).toBeVisible();
    await expect(composer(page)).toHaveValue('');
    expect(await page.evaluate(key => sessionStorage.getItem(key), stored[0][0])).toBe(submitted);
    await reopen(page, id);
    await expect(composer(page)).toHaveValue('');
    const discussion = await api(page, 'authoring?extensionId=' + id);
    expect(discussion.transcript.messages.filter(message => message.role === 'user').map(message => message.text)).toEqual([submitted]);
    expect(requests.map(request => request.path)).toEqual(['/api/authoring/turn']);
    expect(requests[0].body.text).toBe(submitted);
    expect(fixture.requests.map(request => request.name)).toEqual(['discover_catalog', 'ask_clarification']);
  } finally { await page.close(); await fixture.close(); }
});
