import { DatabaseSync } from 'node:sqlite';

// Frozen V4 schema and representative rows: intentionally independent of openData,
// which upgrades fixtures as soon as it opens them.
export function createLegacyV4(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(`
    CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;
    CREATE TABLE projects(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(id,owner_id)) STRICT;
    CREATE TABLE tasks(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, project_id TEXT NOT NULL, title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 120), notes TEXT NOT NULL CHECK(length(notes)<=4000), status TEXT NOT NULL CHECK(status IN ('open','completed')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, FOREIGN KEY(project_id,owner_id) REFERENCES projects(id,owner_id), CHECK((status='open' AND completed_at IS NULL) OR (status='completed' AND completed_at IS NOT NULL))) STRICT;
    CREATE TABLE extension_revisions(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), template_id TEXT NOT NULL, identity TEXT NOT NULL, provenance TEXT NOT NULL CHECK(provenance IN ('operator','customer')), UNIQUE(id,owner_id)) STRICT;
    CREATE TABLE extension_states(owner_id TEXT PRIMARY KEY REFERENCES users(id), draft_version INTEGER NOT NULL CHECK(draft_version>=0), draft_id TEXT, FOREIGN KEY(draft_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT;
    CREATE TABLE extension_selections(owner_id TEXT PRIMARY KEY REFERENCES users(id), revision_id TEXT, generation INTEGER NOT NULL CHECK(generation>=0), FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT;
    CREATE TABLE extension_evidence(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), revision_id TEXT NOT NULL, identity TEXT NOT NULL, suite_identity TEXT NOT NULL, payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB))<=131072), passed INTEGER NOT NULL CHECK(passed IN (0,1)), UNIQUE(id,owner_id), FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT;
    CREATE TABLE extension_approvals(owner_id TEXT NOT NULL REFERENCES users(id), revision_id TEXT NOT NULL, evidence_id TEXT NOT NULL, PRIMARY KEY(owner_id,revision_id), FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id), FOREIGN KEY(evidence_id,owner_id) REFERENCES extension_evidence(id,owner_id)) STRICT;
    CREATE TABLE extension_history(id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id TEXT NOT NULL REFERENCES users(id), revision_id TEXT, generation INTEGER NOT NULL, operation TEXT NOT NULL, FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT;
    CREATE INDEX extension_history_owner ON extension_history(owner_id,id);
    CREATE INDEX extension_evidence_revision ON extension_evidence(owner_id,revision_id);
    CREATE TABLE extension_authored(revision_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80), source BLOB NOT NULL CHECK(length(source) BETWEEN 1 AND 65536), artifact BLOB NOT NULL CHECK(length(artifact) BETWEEN 1 AND 1048576), suite TEXT CHECK(suite IS NULL OR length(CAST(suite AS BLOB))<=131072), FOREIGN KEY(revision_id,owner_id) REFERENCES extension_revisions(id,owner_id)) STRICT;
    CREATE TABLE authoring_budget(id INTEGER PRIMARY KEY CHECK(id=1), reserved_micros INTEGER NOT NULL CHECK(reserved_micros BETWEEN 0 AND 9007199254740991)) STRICT;
    CREATE TABLE authoring_conversations(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), creation_operation_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version BETWEEN 0 AND 9007199254740991), run_id TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('IDLE','RUNNING','CANCELLING','AWAITING_USER','REVIEW_AVAILABLE','CANCELLED','BLOCKED','INTERRUPTED')), cancel_requested INTEGER NOT NULL CHECK(cancel_requested IN (0,1)), updated_at INTEGER NOT NULL CHECK(updated_at>=0), state TEXT NOT NULL, operations TEXT NOT NULL, view TEXT NOT NULL, UNIQUE(id,owner_id), UNIQUE(owner_id,creation_operation_id), CHECK(length(CAST(state AS BLOB))+length(CAST(operations AS BLOB))+length(CAST(view AS BLOB))<=262144), CHECK(length(CAST(view AS BLOB))<=131072), CHECK(length(CAST(operations AS BLOB))<=16384)) STRICT;
    CREATE INDEX authoring_conversations_owner ON authoring_conversations(owner_id,updated_at);
    PRAGMA user_version=4;
  `);
  db.prepare('INSERT INTO users VALUES (?,?)').run('owner-a', 'Owner A');
  db.prepare('INSERT INTO users VALUES (?,?)').run('owner-b', 'Owner B');
  db.prepare('INSERT INTO users VALUES (?,?)').run('owner-empty', 'Owner Empty');
  db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').run('project-a', 'owner-a', 'Example', 't0', 't0');
  db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)').run('task-a', 'owner-a', 'project-a', 'Keep native row', 'n-note', 'open', 't0', 't0', null);
  for (const [id, owner, template, provenance] of [
    ['rev-a-active', 'owner-a', 'pending', 'operator'],
    ['rev-a-draft', 'owner-a', 'authored', 'customer'],
    ['rev-b-active', 'owner-b', 'attention', 'operator'],
  ]) db.prepare('INSERT INTO extension_revisions VALUES (?,?,?,?,?)').run(id, owner, template, `identity:${id}`, provenance);
  db.prepare('INSERT INTO extension_states VALUES (?,?,?)').run('owner-a', 7, 'rev-a-draft');
  db.prepare('INSERT INTO extension_states VALUES (?,?,?)').run('owner-b', 2, 'rev-b-active');
  db.prepare('INSERT INTO extension_states VALUES (?,?,?)').run('owner-empty', 0, null);
  db.prepare('INSERT INTO extension_selections VALUES (?,?,?)').run('owner-a', 'rev-a-active', 9);
  db.prepare('INSERT INTO extension_selections VALUES (?,?,?)').run('owner-b', 'rev-b-active', 3);
  db.prepare('INSERT INTO extension_selections VALUES (?,?,?)').run('owner-empty', null, 0);
  db.prepare('INSERT INTO extension_authored VALUES (?,?,?,?,?,?)').run('rev-a-draft', 'owner-a', 'Draft A', Buffer.from([0, 255, 1, 10]), Buffer.from([123, 0, 255, 125]), '{"cases":["expected"]}');
  db.prepare('INSERT INTO extension_evidence VALUES (?,?,?,?,?,?,?)').run('proof-a', 'owner-a', 'rev-a-draft', 'proof-identity', 'suite-identity', '{"source":"fixture"}', 1);
  db.prepare('INSERT INTO extension_approvals VALUES (?,?,?)').run('owner-a', 'rev-a-draft', 'proof-a');
  db.prepare('INSERT INTO extension_history(owner_id,revision_id,generation,operation) VALUES (?,?,?,?)').run('owner-a', 'rev-a-active', 9, 'activate');
  db.prepare('INSERT INTO extension_history(owner_id,revision_id,generation,operation) VALUES (?,?,?,?)').run('owner-a', 'rev-a-draft', 9, 'save');
  db.prepare('INSERT INTO extension_history(owner_id,revision_id,generation,operation) VALUES (?,?,?,?)').run('owner-a', null, 10, 'disable');
  db.prepare('INSERT INTO extension_history(owner_id,revision_id,generation,operation) VALUES (?,?,?,?)').run('owner-b', 'rev-b-active', 3, 'activate');
  db.prepare('INSERT INTO authoring_budget VALUES (1, 1370000)');
  const conversation = db.prepare('INSERT INTO authoring_conversations VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const chats = [
    ['chat-a-revise-handle', 'owner-a', 'op-a-revise-handle', '{"handles":{"revisionId":"rev-a-draft","draftVersion":7},"evidenceHandle":{"revisionId":"rev-a-draft","evidenceId":"proof-a"}}'],
    ['chat-a-revise-review', 'owner-a', 'op-a-revise-review', '{"messages":[]}'],
    ['chat-a-active', 'owner-a', 'op-a-active', '{"selection":{"revisionId":"rev-a-active","generation":9}}'],
    ['chat-a-null-history', 'owner-a', 'op-a-null', '{"history":[{"revisionId":null,"generation":10}]}'],
    ['chat-a-ambiguous', 'owner-a', 'op-a-ambiguous', '{"messages":["Old conversation"]}'],
    ['chat-b-one', 'owner-b', 'op-b-one', '{"draft":{"revisionId":"rev-b-active","draftVersion":2}}'],
    ['chat-b-two', 'owner-b', 'op-b-two', '{"messages":["Older work"]}'],
    ['chat-empty', 'owner-empty', 'op-empty', '{"messages":[]}'],
  ];
  chats.forEach(([id, owner, op, state], i) => conversation.run(id, owner, op, 2, `run-${i}`, 'IDLE', 0, 100 + i, state, '[]', JSON.stringify({
    messages: [], ...(id === 'chat-a-revise-review' ? { review: { revisionId: 'rev-a-draft', evidenceId: 'proof-a' } } : {}),
  })));
  return db;
}
