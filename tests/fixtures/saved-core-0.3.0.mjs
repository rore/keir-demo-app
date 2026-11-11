import { readFileSync } from 'node:fs';

// Captured with the unmodified 0.3.0 compiler, simulation, approval and activation.
// The JSON is durable fictional test data, not a new artifact with an old stamp.
export const savedCore030 = JSON.parse(readFileSync(new URL('./saved-core-0.3.0.json', import.meta.url)));
export function restoreSavedCore030(db) {
  db.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
  db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run(savedCore030.projectId, 'maya', 'Retained fictional project', '2026-02-02T02:40:00.000Z', '2026-02-02T02:40:00.000Z');
  try {
    for (const [table, rows] of Object.entries(savedCore030.tables)) for (const row of rows) {
      const keys = Object.keys(row);
      const values = Object.values(row).map(value => value && typeof value === 'object' && Object.hasOwn(value, 'base64')
        ? Buffer.from(value.base64, 'base64') : value);
      db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...values);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function savedRows(db) {
  return Object.fromEntries(Object.keys(savedCore030.tables).map(table => [table,
    db.prepare(`SELECT * FROM ${table} WHERE owner_id='maya' ORDER BY rowid`).all().map(row => Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? { base64: Buffer.from(value).toString('base64') } : value])))]));
}
