import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('a forced-autocrlf checkout preserves new byte pins and the real assistant guide loader', async t => {
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
    const result = spawnSync('git', ['-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false', '-C', cwd, ...args],
      { env, timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 1_048_576 });
    assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message);
    return result.stdout;
  };
  const guide = 'vendor/customer-authoring-guide-v9.md';
  const bytePinned = [guide, 'vendor/keir-authoring-companion-v9-manifest.json', 'vendor/keir-authoring-companion-v9.zip',
    'extensions/task-effect/numeric/dcm.json', 'extensions/task-effect/retained/dcm.json',
    'vendor/keir-verification/scenario-v4.schema.json', 'vendor/compiler-0.5.0-notices/THIRD-PARTY.txt'];
  const originals = new Map(bytePinned.map(path => [path, git(root, 'show', 'HEAD:' + path)]));
  for (const [path, bytes] of originals) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), bytes);
  }
  mkdirSync(join(checkout, 'src'));
  copyFileSync(join(root, '.gitattributes'), join(checkout, '.gitattributes'));
  for (const file of ['authoring-agent.mjs', 'authoring-provider.mjs', 'extension-catalog.mjs']) {
    copyFileSync(join(root, 'src', file), join(checkout, 'src', file));
  }
  git(checkout, 'init', '--quiet');
  git(checkout, 'add', '.gitattributes', ...bytePinned);
  for (const path of bytePinned) unlinkSync(join(checkout, path));
  git(checkout, 'checkout-index', '--force', '--', ...bytePinned);
  for (const [path, bytes] of originals) assert.deepEqual(readFileSync(join(checkout, path)), bytes, path);
  const { loadAuthoringInstructions } = await import(pathToFileURL(join(checkout, 'src/authoring-agent.mjs')));
  assert.equal(typeof loadAuthoringInstructions(), 'string');
});
