import { resolve, join } from 'node:path';
import { acquireDataLock, openData, resetData } from '../src/data.mjs';

const args = process.argv.slice(2);
const directory = resolve(args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : '.data');
try {
  if (args[0] === 'reset') {
    const path = await resetData(directory, args.includes('--confirm'));
    console.log(`Demo reset. Verified backup: ${path}`);
  } else if (args[0] === 'seed') {
    const release = acquireDataLock(directory);
    try { const db = openData(join(directory, 'app.sqlite')); db.close(); console.log('Demo data is ready. Existing changes were retained.'); }
    finally { release(); }
  } else throw new Error('Use seed or reset --confirm.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
