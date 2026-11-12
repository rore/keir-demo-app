import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('a forced-autocrlf checkout preserves the pinned guide and the real assistant loader', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const tools = join(root, '.tools');
  mkdirSync(tools, { recursive: true });
  const checkout = mkdtempSync(join(tools, 'guide-checkout-'));
  t.after(() => {
    assert(!relative(tools, checkout).startsWith('..'));
    rmSync(checkout, { recursive: true, force: true, maxRetries: 3 });
  });
  const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };
  const git = (cwd, ...args) => {
    const result = spawnSync('git', ['-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false', '-C', cwd, ...args], { env });
    assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
    return result.stdout;
  };
  const guide = 'vendor/customer-authoring-guide-v8.md';
  const original = git(root, 'show', 'HEAD:' + guide);
  mkdirSync(join(checkout, 'vendor'));
  mkdirSync(join(checkout, 'src'));
  writeFileSync(join(checkout, guide), original);
  copyFileSync(join(root, '.gitattributes'), join(checkout, '.gitattributes'));
  for (const file of ['authoring-agent.mjs', 'authoring-provider.mjs', 'extension-catalog.mjs']) {
    copyFileSync(join(root, 'src', file), join(checkout, 'src', file));
  }
  git(checkout, 'init', '--quiet');
  git(checkout, 'add', '.gitattributes', guide);
  unlinkSync(join(checkout, guide));
  git(checkout, 'checkout-index', '--force', '--', guide);
  assert.deepEqual(readFileSync(join(checkout, guide)), original);
  const { loadAuthoringInstructions } = await import(pathToFileURL(join(checkout, 'src/authoring-agent.mjs')));
  assert.equal(typeof loadAuthoringInstructions(), 'string');
});
