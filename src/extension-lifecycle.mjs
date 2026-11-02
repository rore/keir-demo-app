import { randomUUID } from 'node:crypto';
import { runReadSimulation } from '@keir/runtime-node/read-simulation';
import { AppError, notFound, transaction } from './data.mjs';
import { loadCatalog, digest, json, consumer, hook } from './extension-catalog.mjs';

const conflict = () => { throw new AppError(409, 'This advice changed. Review the current version before trying again.'); };
const suite = 'task-advice-lifecycle/1', fixtureVersion = 'task-advice-fixtures/1';
const allowedReceipts = [...['DONE', 'PENDING', 'NEEDS_ATTENTION'].map(code => ({ status: 'DISPLAYED', code })), { status: 'NOT_DISPLAYED' }];
export function simulationCases(templateId) {
  const call = { step: 'source', capability: 'tasks.get', version: '1', args: { taskId: 'sample-task' } };
  return [
    ['open', 'Open task', { kind: 'SUCCESS', value: { id: 'sample-task', status: 'OPEN' } }, 'COMPLETED', templateId === 'pending' ? 'PENDING' : 'NEEDS_ATTENTION'],
    ['completed', 'Completed task', { kind: 'SUCCESS', value: { id: 'sample-task', status: 'COMPLETED' } }, 'COMPLETED', 'DONE'],
    ['missing', 'Missing task', { kind: 'BUSINESS_REJECTION', code: 'TASK_NOT_FOUND' }, 'BUSINESS_REJECTION', 'TASK_NOT_FOUND'],
    ['business-denied', 'Task access denied', { kind: 'BUSINESS_REJECTION', code: 'ACCESS_DENIED' }, 'BUSINESS_REJECTION', 'ACCESS_DENIED'],
    ['host-denied', 'Advice permission denied', null, 'FAILED', 'AUTHORITY_DENIED'],
    ['transient', 'Read temporarily unavailable', { kind: 'TRANSIENT_FAILURE' }, 'FAILED', 'ADAPTER_TRANSIENT'],
  ].map(([id, label, response, classification, code]) => {
    const expected = { classification, code };
    const row = { format: 'keir-read-simulation/1', id, input: { taskId: 'sample-task' }, stubs: response ? [{ ...call, response }] : [],
      expect: { calls: response ? [call] : [], outcome: classification === 'COMPLETED' ? { classification, result: { classification: code } }
        : { classification, error: { code, path: id === 'host-denied' ? '' : '/steps/0' } },
      consumption: classification === 'COMPLETED' ? { status: 'DISPLAYED', code } : { status: 'NOT_DISPLAYED' } } };
    return { id, label, expected, bytes: Buffer.from(json(row)) };
  });
}

export function createLifecycle(db, { runSimulation = runReadSimulation } = {}) {
  let catalog = [];
  try { catalog = loadCatalog(); } catch { /* Invalid assets leave native CRUD usable. */ }
  const simulations = new Set();
  function template(id) { return catalog.find(item => item.id === id); }
  function revision(owner, id) {
    const row = db.prepare('SELECT * FROM extension_revisions WHERE owner_id=? AND id=?').get(owner, id);
    if (!row) throw notFound();
    return row;
  }
  function valid(row) { return !!row && template(row.template_id)?.identity === row.identity; }
  function view(row) {
    if (!row) return null;
    let pins = {};
    try { pins = JSON.parse(row.identity); } catch { /* Malformed deployment metadata is never eligible. */ }
    return { id: row.id, templateId: row.template_id, label: template(row.template_id)?.label ?? 'Unavailable advice', pins, provenance: row.provenance };
  }
  function draft(owner) {
    const state = db.prepare('SELECT * FROM extension_states WHERE owner_id=?').get(owner);
    if (!state) throw notFound();
    return state;
  }
  function selection(owner) {
    const state = db.prepare('SELECT * FROM extension_selections WHERE owner_id=?').get(owner);
    if (!state) throw notFound();
    return state;
  }
  function suiteIdentity(row) {
    return digest(json({ suite, fixtureVersion, simulator: row.identity, cases: simulationCases(row.template_id).map(item => ({ id: item.id, digest: digest(item.bytes) })) }));
  }
  function evidence(owner, id) {
    const row = db.prepare('SELECT * FROM extension_evidence WHERE owner_id=? AND id=?').get(owner, id);
    if (!row) throw notFound();
    return row;
  }
  function passing(row, proof) {
    try {
      if (!valid(row) || proof.owner_id !== row.owner_id || proof.revision_id !== row.id || proof.identity !== row.identity
          || proof.suite_identity !== suiteIdentity(row) || proof.passed !== 1 || Buffer.byteLength(proof.payload) > 131072) return false;
      const payload = JSON.parse(proof.payload), cases = simulationCases(row.template_id);
      return json(payload.identity) === json({ dependencies: JSON.parse(row.identity), suite, fixtureVersion, suiteDigest: proof.suite_identity })
        && payload.reports.length === cases.length && payload.reports.every((item, index) => {
          const expected = cases[index];
          return item.id === expected.id && item.label === expected.label && json(item.expected) === json(expected.expected)
            && item.report.status === 'PASS' && item.report.format === 'keir-read-simulation-report/1' && item.report.mismatches.length === 0
            && json(item.report.native) === json(expected.expected.classification === 'COMPLETED' ? { classification: 'COMPLETED' }
              : { classification: expected.expected.classification, code: ['missing', 'business-denied'].includes(expected.id) ? 'NATIVE_ERROR' : expected.expected.code })
            && json(item.report.identity) === json({ modelDigest: JSON.parse(row.identity).modelDigest, artifactDigest: JSON.parse(row.identity).artifactDigest })
            && json(item.report.consumption) === json(JSON.parse(expected.bytes).expect.consumption);
        });
    } catch { return false; }
  }
  function eligible(row) {
    if (!valid(row)) return false;
    if (row.provenance === 'operator') return !!db.prepare("SELECT 1 FROM extension_history WHERE owner_id=? AND revision_id=? AND operation='operator'").get(row.owner_id, row.id);
    const approval = db.prepare('SELECT * FROM extension_approvals WHERE owner_id=? AND revision_id=?').get(row.owner_id, row.id);
    return !!approval && passing(row, evidence(row.owner_id, approval.evidence_id));
  }
  function currentDraft(owner, input) {
    const state = draft(owner);
    if (state.draft_id !== input.revisionId || state.draft_version !== input.draftVersion) conflict();
    const row = revision(owner, input.revisionId);
    if (!valid(row)) conflict();
    return row;
  }
  function commit(owner, authorize, action) {
    return transaction(db, () => { authorize(); draft(owner); const result = action(); authorize(); return result; });
  }
  function change(owner, generation, row, operation) {
    if (selection(owner).generation !== generation) conflict();
    if (row && !eligible(row)) conflict();
    db.prepare('UPDATE extension_selections SET revision_id=?,generation=generation+1 WHERE owner_id=?').run(row?.id ?? null, owner);
    db.prepare('INSERT INTO extension_history(owner_id,revision_id,generation,operation) VALUES (?,?,?,?)').run(owner, row?.id ?? null, generation + 1, operation);
  }
  const api = {
    state(owner) {
      const state = draft(owner), active = selection(owner);
      const candidate = state.draft_id ? revision(owner, state.draft_id) : null;
      const latest = candidate && db.prepare('SELECT * FROM extension_evidence WHERE owner_id=? AND revision_id=? ORDER BY rowid DESC LIMIT 1').get(owner, candidate.id);
      const rows = db.prepare('SELECT id,generation,operation,revision_id AS revisionId FROM extension_history WHERE owner_id=? ORDER BY id DESC LIMIT 20').all(owner);
      const targets = db.prepare('SELECT r.* FROM extension_revisions r WHERE owner_id=? AND EXISTS(SELECT 1 FROM extension_history h WHERE h.owner_id=r.owner_id AND h.revision_id=r.id) ORDER BY rowid DESC LIMIT 20').all(owner).filter(eligible);
      const evidenceHistory = db.prepare('SELECT id,revision_id AS revisionId FROM extension_evidence WHERE owner_id=? ORDER BY rowid DESC LIMIT 20').all(owner);
      const selectedRow = active.revision_id ? revision(owner, active.revision_id) : null;
      return { owner: { id: owner, name: db.prepare('SELECT name FROM users WHERE id=?').get(owner).name },
        catalog: catalog.map(({ id, label, openCode }) => ({ id, label, openCode })), draftVersion: state.draft_version,
        draft: view(candidate), evidence: latest ? { id: latest.id, revisionId: candidate.id, passed: passing(candidate, latest) } : null,
        approved: !!candidate && eligible(candidate), selection: { generation: active.generation, revision: view(selectedRow), eligible: !!selectedRow && eligible(selectedRow) },
        restoreTargets: targets.map(view), history: rows, evidenceHistory };
    },
    load(owner, input, authorize) {
      commit(owner, authorize, () => {
        if (draft(owner).draft_version !== input.draftVersion) conflict();
        const item = template(input.templateId);
        if (!item) throw new AppError(400, 'Choose one of the available advice rules.');
        const id = randomUUID();
        db.prepare('INSERT INTO extension_revisions VALUES (?,?,?,?,?)').run(id, owner, item.id, item.identity, 'customer');
        db.prepare('UPDATE extension_states SET draft_id=?,draft_version=draft_version+1 WHERE owner_id=?').run(id, owner);
      }); return api.state(owner);
    },
    async simulate(owner, input, authorize) {
      authorize(); const row = currentDraft(owner, input), item = template(row.template_id);
      if (simulations.has(owner) || simulations.size >= 2) throw new AppError(429, 'Sample checks are busy. Try again after the current check finishes.');
      simulations.add(owner);
      try {
        const reports = [];
        for (const example of simulationCases(item.id)) {
          authorize();
          const report = await runSimulation({ dcmBytes: item.dcmBytes, artifactBytes: item.artifactBytes, modelDigest: item.pins.modelDigest,
            artifactDigest: item.pins.artifactDigest, compiler: item.pins.compiler, entrypoint: hook, consumer }, {
            scope: `demo.task-advice:${owner}`, bindings: { actorId: owner }, deadline: { clock: { nowMs: () => 0 }, expiresAtMs: 1000 },
            authorize: () => { authorize(); return example.id !== 'host-denied'; }, allowedReceipts,
            consume: outcome => outcome.classification === 'COMPLETED' ? { status: 'DISPLAYED', code: outcome.result.classification } : { status: 'NOT_DISPLAYED' },
            responseCheck: (capability, args, response) => capability === 'tasks.get' && (response.kind !== 'SUCCESS' || response.value.id === args.taskId),
          }, example.bytes);
          reports.push({ id: example.id, label: example.label, expected: example.expected, report });
        }
        const suiteDigest = suiteIdentity(row);
        const payload = json({ identity: { dependencies: item.pins, suite, fixtureVersion, suiteDigest }, reports });
        if (Buffer.byteLength(payload) > 131072) throw new AppError(413, 'Sample evidence exceeds the host limit.');
        commit(owner, authorize, () => {
          currentDraft(owner, input);
          const proof = { owner_id: owner, revision_id: row.id, identity: row.identity, suite_identity: suiteDigest, payload, passed: reports.every(entry => entry.report.status === 'PASS') ? 1 : 0 };
          db.prepare('INSERT INTO extension_evidence VALUES (?,?,?,?,?,?,?)').run(randomUUID(), owner, row.id, proof.identity, suiteDigest, payload, passing(row, proof) ? 1 : 0);
        }); return api.state(owner);
      } finally { simulations.delete(owner); }
    },
    approve(owner, input, authorize) {
      commit(owner, authorize, () => {
        const row = currentDraft(owner, input), proof = evidence(owner, input.evidenceId);
        if (!passing(row, proof)) conflict();
        db.prepare('INSERT INTO extension_approvals VALUES (?,?,?) ON CONFLICT(owner_id,revision_id) DO UPDATE SET evidence_id=excluded.evidence_id').run(owner, row.id, proof.id);
      }); return api.state(owner);
    },
    activate(owner, input, authorize) { commit(owner, authorize, () => change(owner, input.generation, currentDraft(owner, input), 'activate')); return api.state(owner); },
    disable(owner, input, authorize) { commit(owner, authorize, () => change(owner, input.generation, null, 'disable')); return api.state(owner); },
    rollback(owner, input, authorize) {
      commit(owner, authorize, () => {
        const row = revision(owner, input.revisionId);
        if (!db.prepare('SELECT 1 FROM extension_history WHERE owner_id=? AND revision_id=?').get(owner, row.id)) conflict();
        change(owner, input.generation, row, 'rollback');
      }); return api.state(owner);
    },
    evidence(owner, id) {
      const proof = evidence(owner, id), row = revision(owner, proof.revision_id);
      return { id: proof.id, revisionId: proof.revision_id, ...JSON.parse(proof.payload), passed: passing(row, proof) };
    },
    history(owner, before = Number.MAX_SAFE_INTEGER) {
      draft(owner);
      const rows = db.prepare('SELECT id,generation,operation,revision_id AS revisionId FROM extension_history WHERE owner_id=? AND id<? ORDER BY id DESC LIMIT 20').all(owner, before);
      return { rows, next: rows.length === 20 ? rows.at(-1).id : null };
    },
    capture(owner) {
      const selected = selection(owner);
      if (!selected.revision_id) return null;
      const row = revision(owner, selected.revision_id);
      return eligible(row) ? { owner, generation: selected.generation, revisionId: row.id, template: template(row.template_id) } : null;
    },
    current(captured) {
      try {
        const live = selection(captured.owner);
        return live.generation === captured.generation && live.revision_id === captured.revisionId && eligible(revision(captured.owner, captured.revisionId));
      } catch { return false; }
    },
  };
  return api;
}
