import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const action = process.argv[2];
if (!['install', 'test'].includes(action)) throw new Error('Use install or test.');
const result = spawnSync(process.execPath, ['node_modules/@playwright/test/cli.js', ...(action === 'install' ? ['install', 'chromium'] : ['test', ...process.argv.slice(3)])], {
  stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: resolve('.tools/playwright') },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
