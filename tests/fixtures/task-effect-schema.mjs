// Only current-schema fixtures use this; frozen historical databases keep their original DDL.
export function removeTaskEffectSchema(db) {
  db.exec(`DROP TABLE task_effect_receipts;
    DROP TABLE task_completion_events;
    DROP INDEX tasks_owner;
    CREATE TABLE extension_selections_legacy(owner_id TEXT PRIMARY KEY REFERENCES users(id), revision_id TEXT,
      generation INTEGER NOT NULL CHECK(generation>=0),
      FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT;
    INSERT INTO extension_selections_legacy(owner_id,revision_id,generation)
      SELECT owner_id,revision_id,generation FROM extension_selections WHERE hook_id='ClassifyTask';
    DROP TABLE extension_selections;
    ALTER TABLE extension_selections_legacy RENAME TO extension_selections;`);
}

export function legacySelections(db, asBytes = false) {
  const scoped = db.prepare('PRAGMA table_info(extension_selections)').all().some(column => column.name === 'hook_id');
  const columns = asBytes ? 'CAST(owner_id AS BLOB) AS owner_id,CAST(revision_id AS BLOB) AS revision_id,generation' : 'owner_id,revision_id,generation';
  return db.prepare(`SELECT ${columns} FROM extension_selections${scoped ? " WHERE hook_id='ClassifyTask'" : ''} ORDER BY rowid`).all();
}
