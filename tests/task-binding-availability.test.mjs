import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

test('a binding diagnostic keeps native tasks and safe disable available while activation fails closed', t => {
  const root = fileURLToPath(new URL('../.tools/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, 'task-binding-unavailable-'));
  t.after(() => {
    const path = relative(resolve(root), resolve(directory));
    assert.ok(path && path !== '..' && !path.startsWith('..' + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  const child = spawnSync(process.execPath, ['--experimental-test-module-mocks',
    fileURLToPath(new URL('./fixtures/task-binding-unavailable.mjs', import.meta.url)), directory], {
    encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, TEMP: directory, TMP: directory },
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.match(child.stdout, /binding unavailable: review visible; activation and rollback refused; disable and native CRUD available/);
});
