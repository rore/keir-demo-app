import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireDataLock, openData } from './data.mjs';
import { createApp } from './app.mjs';

export async function start({ directory = resolve('.data'), port = 3000, staticRoot = resolve('dist') } = {}) {
  const release = acquireDataLock(directory);
  let db, app;
  try {
    db = openData(join(directory, 'app.sqlite'));
    // A test-owned OS port is selected before app creation so Host checks stay exact.
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Choose a port between 1 and 65535.');
    const origin = `http://127.0.0.1:${port}`;
    app = await createApp({ db, origin, staticRoot });
    await app.listen({ host: '127.0.0.1', port });
    let closed = false;
    return { app, db, origin, async close() {
      if (closed) return;
      closed = true;
      try { await app.close(); } finally { db.close(); release(); }
    } };
  } catch (error) { await app?.close(); db?.close(); release(); throw error; }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  try {
    const server = await start({ directory: resolve(value('--data-dir') ?? '.data'), port: Number(value('--port') ?? 3000) });
    console.log(`Keir is ready at ${server.origin}`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close().then(() => process.exit(0)).catch(error => { console.error(error.message); process.exit(1); }); });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
