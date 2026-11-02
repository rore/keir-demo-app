import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runReadSimulation } from '@keir/runtime-node/read-simulation';
import { AppError, notFound, transaction } from './data.mjs';
import { loadCatalog, loadHost, admitArtifact, hostBindings, digest, json, consumer, hook } from './extension-catalog.mjs';

const conflict = () => { throw new AppError(409, 'This advice changed. Review the current version before trying again.'); };
const suite = 'task-advice-lifecycle/1', fixtureVersion = 'task-advice-fixtures/1';
const authoredSuite = 'task-advice-authored/1', authoredFixture = 'task-advice-authored-fixtures/1';
const safeCodes = new Set(['AUTHORITY_DENIED', 'AUTHORITY_CHECK_FAILED', 'HOST_CONTEXT_INVALID', 'HOST_BINDING_INVALID', 'INPUT_INVALID',
  'ADAPTER_EXCEPTION', 'ADAPTER_INVALID', 'ADAPTER_TRANSIENT', 'EXPRESSION_FAILED', 'BUDGET_EXCEEDED']);
const abort = signal => { if (signal?.aborted) throw new AppError(499, 'Preparation stopped. Check saved state before trying again.'); };
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

export function createLifecycle(db, { runSimulation = runReadSimulation, compiler } = {}) {
  let catalog = [], host;
  try { host = loadHost(); catalog = loadCatalog(); } catch { /* Invalid assets leave native CRUD usable. */ }
  const simulations = new Set();
  function template(id) { return catalog.find(item => item.id === id); }
  function content(row) { return db.prepare('SELECT * FROM extension_authored WHERE owner_id=? AND revision_id=?').get(row.owner_id, row.id); }
  function authoredPins(value) {
    if (!host) throw new Error('Host unavailable');
    const artifact = admitArtifact(value.artifact, host);
    return { ...host.pins, rawSourceDigest: digest(value.source), compiledSourceDigest: artifact.sourceDigest,
      artifactDigest: digest(value.artifact), suiteDigest: value.suite === null ? null : digest(value.suite), fixture: authoredFixture };
  }
  function executable(row) {
    if (!row) return null;
    if (row.template_id !== 'authored') return template(row.template_id) ?? null;
    try {
      const value = content(row);
      if (!value) return null;
      const pins = authoredPins(value);
      if (row.identity !== json(pins)) return null;
      return { id: row.id, kind: 'authored', label: value.label, identity: row.identity, pins,
        artifactBytes: Buffer.from(value.artifact), dcmBytes: host.dcmBytes, source: Buffer.from(value.source).toString('utf8'), suite: value.suite };
    } catch { return null; }
  }
  function revision(owner, id) {
    const row = db.prepare('SELECT * FROM extension_revisions WHERE owner_id=? AND id=?').get(owner, id);
    if (!row) throw notFound();
    return row;
  }
  function valid(row) { return !!row && executable(row)?.identity === row.identity; }
  function view(row) {
    if (!row) return null;
    let pins = {};
    try { pins = JSON.parse(row.identity); } catch { /* Malformed deployment metadata is never eligible. */ }
    const item = executable(row);
    return { id: row.id, templateId: row.template_id, kind: row.template_id === 'authored' ? 'authored' : 'prepared',
      label: item?.label ?? 'Unavailable advice', pins, provenance: row.provenance,
      suiteDigest: row.template_id === 'authored' ? item?.pins.suiteDigest ?? null : null };
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
  function cases(row, item = executable(row)) {
    if (row.template_id !== 'authored') return simulationCases(row.template_id);
    if (!item?.suite) return [];
    return JSON.parse(item.suite).map(text => {
      const value = JSON.parse(text), expected = value.expect.outcome;
      return { id: value.id, label: value.id, expected: { classification: expected.classification,
        code: expected.classification === 'COMPLETED' ? expected.result.classification : expected.error.code }, bytes: Buffer.from(text) };
    });
  }
  function versions(row) { return row.template_id === 'authored' ? { suite: authoredSuite, fixtureVersion: authoredFixture } : { suite, fixtureVersion }; }
  function suiteIdentity(row) {
    return digest(json({ ...versions(row), simulator: row.identity, cases: cases(row).map(item => ({ id: item.id, digest: digest(item.bytes) })) }));
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
      const payload = JSON.parse(proof.payload), examples = cases(row);
      return examples.length > 0 && json(payload.identity) === json({ dependencies: JSON.parse(row.identity), ...versions(row), suiteDigest: proof.suite_identity })
        && payload.reports.length === examples.length && payload.reports.every((item, index) => {
          const expected = examples[index];
          return item.id === expected.id && item.label === expected.label && json(item.expected) === json(expected.expected)
            && item.report.status === 'PASS' && item.report.format === 'keir-read-simulation-report/1' && item.report.mismatches.length === 0
            && json(item.report.native) === json(expected.expected.classification === 'COMPLETED' ? { classification: 'COMPLETED' }
              : { classification: expected.expected.classification, code: safeCodes.has(expected.expected.code) ? expected.expected.code : 'NATIVE_ERROR' })
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
  function quota(owner) {
    if (db.prepare('SELECT count(*) n FROM extension_authored WHERE owner_id=?').get(owner).n >= 32)
      throw new AppError(409, 'The 32 saved authored-revision limit is reached. Existing advice and history are retained.');
  }
  function saveAuthored(owner, value) {
    quota(owner);
    const id = randomUUID(), identity = json(authoredPins(value));
    db.prepare('INSERT INTO extension_revisions VALUES (?,?,?,?,?)').run(id, owner, 'authored', identity, 'customer');
    db.prepare('INSERT INTO extension_authored VALUES (?,?,?,?,?,?)').run(id, owner, value.label, value.source, value.artifact, value.suite);
    db.prepare('UPDATE extension_states SET draft_id=?,draft_version=draft_version+1 WHERE owner_id=?').run(id, owner);
  }
  function selectionInput(item) {
    return { dcmBytes: item.dcmBytes, artifactBytes: item.artifactBytes, modelDigest: item.pins.modelDigest,
      artifactDigest: item.pins.artifactDigest, compiler: item.pins.compiler, entrypoint: hook, consumer };
  }
  function fixture(owner, item, authorize, permitted = true) {
    const clock = { nowMs: () => Math.floor(performance.now()) };
    return { scope: `demo.task-advice:${owner}`, bindings: hostBindings(item.artifactBytes, owner),
      deadline: { clock, expiresAtMs: clock.nowMs() + 1000 }, authorize: () => { authorize(); return permitted; }, allowedReceipts,
      consume: outcome => outcome.classification === 'COMPLETED' ? { status: 'DISPLAYED', code: outcome.result.classification } : { status: 'NOT_DISPLAYED' },
      responseCheck: (capability, args, response) => capability === 'tasks.get' && (response.kind !== 'SUCCESS' || response.value.id === args.taskId) };
  }
  const api = {
    state(owner) {
      const state = draft(owner), active = selection(owner);
      const candidate = state.draft_id ? revision(owner, state.draft_id) : null;
      const latest = candidate && db.prepare('SELECT * FROM extension_evidence WHERE owner_id=? AND revision_id=? ORDER BY rowid DESC LIMIT 1').get(owner, candidate.id);
      const approval = candidate?.provenance === 'customer' && db.prepare('SELECT evidence_id FROM extension_approvals WHERE owner_id=? AND revision_id=?').get(owner, candidate.id);
      const approvedProof = approval && db.prepare('SELECT * FROM extension_evidence WHERE owner_id=? AND id=?').get(owner, approval.evidence_id);
      const rows = db.prepare('SELECT id,generation,operation,revision_id AS revisionId FROM extension_history WHERE owner_id=? ORDER BY id DESC LIMIT 20').all(owner);
      const targets = db.prepare('SELECT r.* FROM extension_revisions r WHERE owner_id=? AND EXISTS(SELECT 1 FROM extension_history h WHERE h.owner_id=r.owner_id AND h.revision_id=r.id) ORDER BY rowid DESC LIMIT 20').all(owner).filter(eligible);
      const evidenceHistory = db.prepare('SELECT id,revision_id AS revisionId FROM extension_evidence WHERE owner_id=? ORDER BY rowid DESC LIMIT 20').all(owner);
      const selectedRow = active.revision_id ? revision(owner, active.revision_id) : null;
      return { owner: { id: owner, name: db.prepare('SELECT name FROM users WHERE id=?').get(owner).name },
        catalog: catalog.map(({ id, label, openCode }) => ({ id, label, openCode })), draftVersion: state.draft_version,
        revisionId: candidate?.id ?? null, suiteDigest: candidate?.template_id === 'authored' ? executable(candidate)?.pins.suiteDigest ?? null : null,
        draft: view(candidate), evidence: latest ? { id: latest.id, revisionId: candidate.id, passed: passing(candidate, latest) } : null,
        approved: !!candidate && eligible(candidate), approvedEvidenceId: approvedProof && passing(candidate, approvedProof) ? approvedProof.id : null,
        selection: { generation: active.generation, revision: view(selectedRow), eligible: !!selectedRow && eligible(selectedRow) },
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
    async compile(owner, input, authorize, { signal } = {}) {
      authorize(); abort(signal); const state = draft(owner);
      if (state.draft_version !== input.draftVersion) conflict();
      quota(owner);
      if (typeof input.source !== 'string' || !input.source.length || Buffer.byteLength(input.source) > 65536
          || Buffer.from(input.source).toString('utf8') !== input.source) throw new AppError(400, 'Source must be 1–65,536 valid UTF-8 bytes.');
      const label = input.label ?? 'Authored advice';
      if (typeof label !== 'string' || !label.trim() || label.length > 80) throw new AppError(400, 'Use a label of 1–80 characters.');
      if (!compiler || !host) throw new AppError(503, 'Source compilation is unavailable. Native tasks and saved advice still work.');
      let result;
      try { result = await compiler.compile(Buffer.from(input.source), { signal }); }
      catch (error) {
        const messages = { 413: 'Compiler input or output exceeds the host limit.', 429: 'Compilation is busy. Try again after the current preparation settles.',
          499: 'Preparation stopped. Check saved state before trying again.', 503: 'Source compilation is unavailable. Native tasks and saved advice still work.',
          504: 'Compilation exceeded its time limit. Check saved state before trying again.' };
        const status = Object.hasOwn(messages, error?.status) ? error.status : 503;
        throw new AppError(status, messages[status]);
      }
      authorize(); abort(signal);
      if (!result.artifact) {
        const error = new AppError(422, 'The source did not compile. Check the reported fields before trying again.');
        error.diagnostics = result.diagnostics; throw error;
      }
      const value = { label: label.trim(), source: Buffer.from(input.source), artifact: Buffer.from(result.artifact), suite: null };
      try { authoredPins(value); } catch { throw new AppError(422, 'The compiled program does not match the host contract.'); }
      commit(owner, authorize, () => {
        abort(signal); if (draft(owner).draft_version !== input.draftVersion) conflict(); saveAuthored(owner, value);
      }); return api.state(owner);
    },
    async proposeScenarios(owner, input, authorize, { signal } = {}) {
      authorize(); abort(signal); const row = currentDraft(owner, input), item = executable(row);
      if (row.template_id !== 'authored') throw new AppError(400, 'Prepared examples retain their original checks.');
      if (!Array.isArray(input.cases) || input.cases.length < 1 || input.cases.length > 8
          || input.cases.some(text => typeof text !== 'string' || !text.length || Buffer.byteLength(text) > 65536 || Buffer.from(text).toString('utf8') !== text))
        throw new AppError(400, 'Supply 1–8 case JSON strings, at most 65,536 UTF-8 bytes each.');
      const suiteBytes = json(input.cases);
      if (Buffer.byteLength(suiteBytes) > 131072) throw new AppError(413, 'The complete scenario suite exceeds 128 KiB.');
      const ids = new Set();
      for (const text of input.cases) {
        abort(signal); authorize();
        // Denied entry reuses native strict case validation without dispatch or evidence creation.
        const report = await runReadSimulation(selectionInput(item), fixture(owner, item, authorize, false), Buffer.from(text));
        if (['INVALID_SCENARIO', 'SETUP_ERROR', 'CONSUMER_ERROR'].includes(report.status)) throw new AppError(400, 'A scenario is invalid for the host contract.');
        const id = JSON.parse(text).id;
        if (ids.has(id)) throw new AppError(400, 'Scenario IDs must be unique.');
        ids.add(id);
      }
      commit(owner, authorize, () => {
        abort(signal); currentDraft(owner, input);
        const value = content(row); saveAuthored(owner, { ...value, suite: suiteBytes });
      }); return api.state(owner);
    },
    source(owner, id) {
      const row = revision(owner, id), item = executable(row);
      if (!item || row.template_id !== 'authored') throw notFound();
      return { revisionId: id, source: item.source, cases: item.suite ? JSON.parse(item.suite) : [], suiteDigest: item.pins.suiteDigest };
    },
    async simulate(owner, input, authorize, { signal } = {}) {
      authorize(); abort(signal); const row = currentDraft(owner, input), item = executable(row), examples = cases(row, item);
      if (!examples.length) throw new AppError(409, 'Save independent examples for this revision before running checks.');
      if (simulations.has(owner) || simulations.size >= 2) throw new AppError(429, 'Sample checks are busy. Try again after the current check finishes.');
      simulations.add(owner);
      try {
        const reports = [];
        for (const example of examples) {
          authorize(); abort(signal);
          const permitted = row.template_id === 'authored' || example.id !== 'host-denied';
          const report = await runSimulation(selectionInput(item), fixture(owner, item, authorize, permitted), example.bytes);
          reports.push({ id: example.id, label: example.label, expected: example.expected, report });
        }
        const suiteDigest = suiteIdentity(row);
        const payload = json({ identity: { dependencies: item.pins, ...versions(row), suiteDigest }, reports });
        if (Buffer.byteLength(payload) > 131072) throw new AppError(413, 'Sample evidence exceeds the host limit.');
        commit(owner, authorize, () => {
          abort(signal); currentDraft(owner, input);
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
      return { id: proof.id, revisionId: proof.revision_id, kind: row.template_id === 'authored' ? 'authored' : 'prepared',
        ...JSON.parse(proof.payload), passed: passing(row, proof) };
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
      return eligible(row) ? { owner, generation: selected.generation, revisionId: row.id, template: executable(row) } : null;
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
