import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export function prototypeServer() {
  const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/studio.mjs', ['studio.mjs', 'text/javascript; charset=utf-8']]]);
  return createServer(async (req, res) => {
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }).end(); return; }
    const asset = assets.get(req.url);
    if (!asset) { res.writeHead(404).end('Not found'); return; }
    try {
      const body = await readFile(new URL(asset[0], import.meta.url));
      res.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' }).end(body);
    } catch { res.writeHead(500).end('Prototype asset unavailable'); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 4179);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1–65535');
  const server = prototypeServer();
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Studio design prototype: http://localhost:${port}/ (scripted, no real effects)`));
}
