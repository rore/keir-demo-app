import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { runReadSimulation } from '@keir/runtime-node/read-simulation';
import { AppError, notFound, transaction, revokeTaskAdmissions } from './data.mjs';
import { loadCatalog, loadHost, historicalDefinitionForPins, admitArtifact, hostBindings, digest, json, consumer, hook, TASK_HOOK, TASK_DEFINITION, taskDefinitionIds } from './extension-catalog.mjs';
import { runTaskEffectSimulation, taskEffectProofMatches, validateTaskEffectScenarios } from './task-effect-simulation.mjs';

const conflict = () => { throw new AppError(409, 'This extension changed. Review the current version before trying again.'); };
const deleted = () => { const error = new AppError(410, 'This customization was deleted. Return to your customizations.'); error.code = 'CUSTOMIZATION_DELETED'; throw error; };
const retired = () => { throw Object.assign(new AppError(410, 'This earlier customization is read-only. Start a new customization to change task behavior.'), { code: 'LEGACY_CUSTOMIZATION_RETIRED' }); };
const suite = 'task-advice-lifecycle/1', fixtureVersion = 'task-advice-fixtures/1';
const authoredSuite = 'task-advice-authored/1', authoredFixture = 'task-advice-authored-fixtures/1';
const safeCodes = new Set(['AUTHORITY_DENIED', 'AUTHORITY_CHECK_FAILED', 'HOST_CONTEXT_INVALID', 'HOST_BINDING_INVALID', 'INPUT_INVALID',
  'ADAPTER_EXCEPTION', 'ADAPTER_INVALID', 'ADAPTER_TRANSIENT', 'EXPRESSION_FAILED', 'BUDGET_EXCEEDED']);
const abort = signal => { if (signal?.aborted) throw new AppError(499, 'Preparation stopped. Check saved state before trying again.'); };
const allowedReceipts = [...['DONE', 'PENDING', 'NEEDS_ATTENTION'].map(code => ({ status: 'DISPLAYED', code })), { status: 'NOT_DISPLAYED' }];
export function situation(example) {
  const reads = example?.stubs?.filter(stub => stub.capability === 'tasks.get');
  const response = reads?.length === 1 ? reads[0].response : undefined;
  return {
    taskStatus: response?.kind === 'SUCCESS' && ['OPEN', 'COMPLETED'].includes(response.value?.status) ? response.value.status : null,
    readFailure: response?.kind === 'BUSINESS_REJECTION' && ['TASK_NOT_FOUND', 'ACCESS_DENIED'].includes(response.code) ? response.code
      : response?.kind === 'TRANSIENT_FAILURE' ? 'TRANSIENT_FAILURE' : null,
  };
}
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

export function createLifecycle(db, { runSimulation = runReadSimulation, runTaskSimulation = runTaskEffectSimulation, compiler } = {}) {
  let catalog = [], legacyHost;
  const taskHosts = new Map();
  try { legacyHost = loadHost(); catalog = loadCatalog(); } catch { /* Historical assets may be unavailable. */ }
  for (const id of taskDefinitionIds) {
    try { taskHosts.set(id, loadHost(TASK_HOOK, id)); } catch { /* One unavailable model does not disable the other. */ }
  }
  const host = taskHosts.get(TASK_DEFINITION);
  const simulations = new Set();
  function template(id) { return catalog.find(item => item.id === id); }
  function content(row) { return db.prepare('SELECT * FROM extension_authored WHERE owner_id=? AND revision_id=?').get(row.owner_id, row.id); }
  function authoredPins(value, definition = host) {
    if (!definition) throw new Error('Host unavailable');
    // Status reads verify host-owned byte pins; compile, simulation and live preparation perform native admission.
    const artifact = JSON.parse(Buffer.from(value.artifact).toString('utf8'));
    if (!/^sha256:[0-9a-f]{64}$/.test(artifact.sourceDigest)) throw new Error('Invalid source identity');
    return { ...definition.pins, rawSourceDigest: digest(value.source), compiledSourceDigest: artifact.sourceDigest,
      artifactDigest: digest(value.artifact), suiteDigest: value.suite === null ? null : digest(value.suite),
      fixture: definition.pins.hook === TASK_HOOK ? 'daymark-task-effect-fixtures/1' : authoredFixture };
  }
  function executableHost(pins) {
    const candidate = taskHosts.get(pins.definitionId);
    return candidate && Object.entries(candidate.pins).every(([key, value]) => json(pins[key]) === json(value)) ? candidate : null;
  }
  function definition(row) {
    const pins = JSON.parse(row.identity);
    if (pins.hook !== TASK_HOOK) return { ...legacyHost, pins };
    return executableHost(pins) ?? historicalDefinitionForPins(pins);
  }
  const taskRevision = row => { try { return JSON.parse(row.identity).hook === TASK_HOOK; } catch { return false; } };
  function stored(row) {
    if (!row) return null;
    if (row.template_id !== 'authored') {
      const item = template(row.template_id);
      try {
        const pins = JSON.parse(row.identity);
        return item && digest(item.artifactBytes) === pins.artifactDigest && digest(Buffer.from(item.source)) === pins.sourceDigest
          ? { ...item, pins, identity: row.identity } : null;
      } catch { return null; }
    }
    try {
      const value = content(row);
      if (!value) return null;
      const savedPins = JSON.parse(row.identity), selected = historicalDefinitionForPins(savedPins);
      const pins = authoredPins(value, { pins: savedPins });
      if (row.identity !== json(pins)) return null;
      return { id: row.id, kind: 'authored', label: value.label, identity: row.identity, pins,
        artifactBytes: Buffer.from(value.artifact), dcmBytes: selected.dcmBytes, source: Buffer.from(value.source).toString('utf8'), suite: value.suite };
    } catch { return null; }
  }
  function executable(row) {
    const item = stored(row);
    if (!item || !taskRevision(row)) return item;
    return executableHost(item.pins) ? item : null;
  }
  function revision(owner, id, extensionId) {
    const row = extensionId === undefined
      ? db.prepare('SELECT * FROM extension_revisions WHERE owner_id=? AND id=?').get(owner, id)
      : db.prepare('SELECT r.* FROM extension_revisions r JOIN extension_revision_links l ON l.revision_id=r.id AND l.owner_id=r.owner_id WHERE r.owner_id=? AND r.id=? AND l.extension_id=?').get(owner, id, extensionId);
    if (!row) throw notFound();
    return row;
  }
  function valid(row) { return !!row && executable(row)?.identity === row.identity; }
  function view(row) {
    if (!row) return null;
    let pins = {};
    try { pins = JSON.parse(row.identity); } catch { /* Malformed deployment metadata is never eligible. */ }
    const item = stored(row);
    const extension = db.prepare('SELECT e.id,CAST(e.name AS BLOB) AS name FROM extensions e JOIN extension_revision_links l ON l.extension_id=e.id AND l.owner_id=e.owner_id WHERE l.owner_id=? AND l.revision_id=?').get(row.owner_id, row.id);
    return { id: row.id, extensionId: extension?.id ?? null, extensionName: extension ? Buffer.from(extension.name).toString('utf8') : null, templateId: row.template_id, kind: row.template_id === 'authored' ? 'authored' : 'prepared',
      label: item?.label ?? 'Unavailable saved change', pins, provenance: row.provenance,
      suiteDigest: row.template_id === 'authored' ? item?.pins.suiteDigest ?? null : null };
  }
  function draft(owner, extensionId, terminal = false) {
    if (typeof extensionId !== 'string' || !extensionId) throw notFound();
    // BLOB reads preserve embedded NUL in legacy names; SQLite TEXT readback truncates it.
    const state = db.prepare('SELECT *,CAST(name AS BLOB) AS name_bytes,draft_revision_id AS draft_id FROM extensions WHERE owner_id=? AND id=?').get(owner, extensionId);
    if (!state) throw notFound();
    if (state.deleted_at !== null) { if (terminal) deleted(); throw notFound(); }
    return { ...state, name: Buffer.from(state.name_bytes).toString('utf8') };
  }
  function taskItem(owner, extensionId) {
    const item = draft(owner, extensionId);
    if (item.hook_id !== null && item.hook_id !== TASK_HOOK) return false;
    if (item.draft_id) {
      try {
        const pins = JSON.parse(revision(owner, item.draft_id, extensionId).identity);
        if (pins.profile === 'keir-effect/4' && taskDefinitionIds.includes(pins.definitionId)) return true;
      } catch { /* The original conversation can still identify a repairable current draft. */ }
    }
    return !!db.prepare(`SELECT 1 FROM extension_conversation_links l JOIN authoring_conversations c ON c.id=l.conversation_id AND c.owner_id=l.owner_id
      WHERE l.owner_id=? AND l.extension_id=? AND l.purpose='CREATE'
        AND CASE WHEN json_valid(c.state) THEN json_extract(c.state,'$.definitionId') END IN (?,?)`).get(owner, extensionId, ...taskDefinitionIds);
  }
  const requireTask = (owner, extensionId) => { if (!taskItem(owner, extensionId)) retired(); };
  function selection(owner, hookId = TASK_HOOK) {
    const state = db.prepare('SELECT * FROM extension_selections WHERE owner_id=? AND hook_id=?').get(owner, hookId);
    if (!state) throw notFound();
    return state;
  }
  function cases(row, item = stored(row)) {
    if (row.template_id !== 'authored') return simulationCases(row.template_id);
    if (!item?.suite) return [];
    return JSON.parse(item.suite).map(text => {
      const value = JSON.parse(text), expected = value.expect.outcome;
      if (taskRevision(row)) return { id: value.id, label: value.id, expected: { outcome: expected, calls: value.expect.calls, consumption: value.expect.consumption,
        createdTasks: expected.effects?.some(effect => effect.state === 'UNKNOWN') ? null
          : expected.effects?.some(effect => effect.state === 'CONFIRMED')
            ? value.expect.calls.filter(call => call.capability === 'tasks.create').map(call => ({ projectId: call.args.projectId, title: call.args.title })) : [] }, bytes: Buffer.from(text) };
      return { id: value.id, label: value.id, expected: { classification: expected.classification,
        code: expected.classification === 'COMPLETED' ? expected.result.classification : expected.error.code }, bytes: Buffer.from(text) };
    });
  }
  function versions(row) { return taskRevision(row) ? { suite: 'task-effects-authored/1', fixtureVersion: 'daymark-task-effect-fixtures/1', simulator: 'daymark-task-effect-simulation/1' }
    : row.template_id === 'authored' ? { suite: authoredSuite, fixtureVersion: authoredFixture } : { suite, fixtureVersion }; }
  function suiteIdentity(row) {
    return digest(json({ ...versions(row), simulator: row.identity, cases: cases(row).map(item => ({ id: item.id, digest: digest(item.bytes) })) }));
  }
  function evidence(owner, id, extensionId) {
    const row = db.prepare('SELECT * FROM extension_evidence WHERE owner_id=? AND id=?').get(owner, id);
    if (!row) throw notFound();
    if (extensionId !== undefined) revision(owner, row.revision_id, extensionId);
    return row;
  }
  function passing(row, proof) {
    if (taskRevision(row)) return taskEffectProofMatches(row, content(row), proof);
    try {
      if (!stored(row) || proof.owner_id !== row.owner_id || proof.revision_id !== row.id || proof.identity !== row.identity
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
    if (!row || !taskRevision(row)) return false;
    if (row && !db.prepare('SELECT 1 FROM extensions e JOIN extension_revision_links l ON l.extension_id=e.id AND l.owner_id=e.owner_id WHERE l.owner_id=? AND l.revision_id=? AND e.deleted_at IS NULL').get(row.owner_id, row.id)) return false;
    if (!valid(row)) return false;
    if (row.provenance === 'operator') return !!db.prepare("SELECT 1 FROM extension_history WHERE owner_id=? AND revision_id=? AND operation='operator'").get(row.owner_id, row.id);
    const approval = db.prepare('SELECT * FROM extension_approvals WHERE owner_id=? AND revision_id=?').get(row.owner_id, row.id);
    return !!approval && passing(row, evidence(row.owner_id, approval.evidence_id));
  }
  function approved(row) {
    if (!row) return false;
    const approval = db.prepare('SELECT evidence_id FROM extension_approvals WHERE owner_id=? AND revision_id=?').get(row.owner_id, row.id);
    return !!approval && passing(row, evidence(row.owner_id, approval.evidence_id));
  }
  function currentDraft(owner, input) {
    requireTask(owner, input.extensionId);
    const state = draft(owner, input.extensionId);
    if (state.draft_id !== input.revisionId || state.draft_version !== input.draftVersion) conflict();
    const row = revision(owner, input.revisionId, input.extensionId);
    if (!valid(row)) conflict();
    return row;
  }
  function commit(owner, extensionId, authorize, action, taskOnly = true) {
    return transaction(db, () => { authorize(); draft(owner, extensionId); if (taskOnly) requireTask(owner, extensionId); const result = action(); authorize(); return result; });
  }
  function change(owner, generation, row, operation, hookId = TASK_HOOK) {
    const selected = selection(owner, hookId), outgoing = selected.revision_id;
    if (selected.generation !== generation) conflict();
    if (row && !eligible(row)) conflict();
    let pins = null;
    if (row) {
      const item = executable(row), approved = db.prepare('SELECT evidence_id FROM extension_approvals WHERE owner_id=? AND revision_id=?').get(owner, row.id);
      pins = json({ ...item.pins, approvedEvidenceId: approved?.evidence_id ?? null });
    }
    db.prepare('UPDATE extension_selections SET revision_id=?,generation=generation+1,binding_pins=? WHERE owner_id=? AND hook_id=?').run(row?.id ?? null, pins, owner, hookId);
    db.prepare('INSERT INTO extension_history(owner_id,revision_id,generation,operation) VALUES (?,?,?,?)').run(owner, row?.id ?? outgoing, generation + 1, operation);
  }
  function saveAuthored(owner, extensionId, value, definition = host) {
    const id = randomUUID(), identity = json(authoredPins(value, definition));
    db.prepare('INSERT INTO extension_revisions VALUES (?,?,?,?,?)').run(id, owner, 'authored', identity, 'customer');
    db.prepare('INSERT INTO extension_authored VALUES (?,?,?,?,?,?)').run(id, owner, value.label, value.source, value.artifact, value.suite);
    saveHead(owner, extensionId, id);
    return id;
  }
  function saveHead(owner, extensionId, revisionId) {
    const state = draft(owner, extensionId);
    if (state.hook_id !== null && state.hook_id !== TASK_HOOK) conflict();
    db.prepare('INSERT INTO extension_revision_links VALUES (?,?,?)').run(revisionId, owner, extensionId);
    const result = db.prepare('UPDATE extensions SET draft_revision_id=?,draft_version=draft_version+1,hook_id=? WHERE owner_id=? AND id=? AND draft_version=?').run(revisionId, TASK_HOOK, owner, extensionId, state.draft_version);
    if (result.changes !== 1) conflict();
  }
  function ownerView(owner) {
    const row = db.prepare('SELECT id,name FROM users WHERE id=?').get(owner);
    if (!row) throw notFound();
    return row;
  }
  function requestExcerpt(owner, extensionId) {
    const rows = db.prepare(`SELECT c.id,c.creation_operation_id,e.creation_operation_id AS item_operation_id
      FROM extensions e JOIN extension_conversation_links l ON l.extension_id=e.id AND l.owner_id=e.owner_id
      JOIN authoring_conversations c ON c.id=l.conversation_id AND c.owner_id=l.owner_id
      WHERE e.owner_id=? AND e.id=? AND l.purpose='CREATE' LIMIT 2`).all(owner, extensionId);
    if (rows.length !== 1 || !rows[0].item_operation_id || rows[0].creation_operation_id !== rows[0].item_operation_id) return;
    try {
      const messages = db.prepare('SELECT message_id,CAST(payload AS BLOB) AS payload FROM authoring_messages WHERE owner_id=? AND conversation_id=? ORDER BY sequence').iterate(owner, rows[0].id);
      let first;
      for (const row of messages) {
        const message = JSON.parse(Buffer.from(row.payload).toString('utf8'));
        if (message?.role === 'user') { first = message.id === row.message_id ? message : null; break; }
      }
      if (first?.id === rows[0].item_operation_id && typeof first.text === 'string' && first.text.isWellFormed() && first.text.trim())
        return Array.from(first.text.trim()).slice(0, 160).join('');
    } catch { /* Missing or uncertain original intent has no excerpt. */ }
  }
  function selectionView(owner, hookId = TASK_HOOK) {
    const active = selection(owner, hookId), row = active.revision_id ? revision(owner, active.revision_id) : null;
    let approvedEvidenceId = null;
    try {
      const id = JSON.parse(active.binding_pins)?.approvedEvidenceId, proof = id && evidence(owner, id);
      if (row && proof && passing(row, proof)) approvedEvidenceId = proof.id;
    } catch { /* Missing captured proof never borrows a later approval. */ }
    const available = !!row && eligible(row) && (row.provenance === 'operator' || approvedEvidenceId !== null);
    return { generation: active.generation, revision: view(row), eligible: available, approvedEvidenceId };
  }
  function choices() { return []; }
  const pageRows = 20, pageBytes = 262144;
  const invalidCursor = () => { throw new AppError(400, 'Use a valid history cursor for this owner and item.'); };
  function cursor(kind, owner, extensionId, row) {
    return Buffer.from(json([kind, owner, extensionId ?? null, row.at, row.id])).toString('base64url');
  }
  function readCursor(before, kind, owner, extensionId) {
    if (before === undefined) return null;
    try {
      if (typeof before !== 'string' || before.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(before)) invalidCursor();
      const bytes = Buffer.from(before, 'base64url'), value = JSON.parse(bytes.toString('utf8'));
      if (bytes.toString('base64url') !== before || !Array.isArray(value) || value.length !== 5
          || value[0] !== kind || value[1] !== owner || value[2] !== (extensionId ?? null)
          || !Number.isSafeInteger(value[3]) || value[3] < 0 || typeof value[4] !== 'string' || !value[4]) invalidCursor();
      return { at: value[3], id: value[4] };
    } catch { invalidCursor(); }
  }
  function boundedPage(candidates, project, nextCursor, base = {}, field = 'rows') {
    const rows = [];
    for (const [index, row] of candidates.entries()) {
      if (rows.length === pageRows) break;
      const value = project(row), next = index < candidates.length - 1 ? nextCursor(row) : null;
      if (Buffer.byteLength(json({ ...base, [field]: [...rows, value], next })) > pageBytes) {
        if (!rows.length) throw new AppError(413, 'This history entry exceeds the response limit.');
        break;
      }
      rows.push(value);
    }
    const more = candidates.length > rows.length;
    const result = { ...base, [field]: rows, next: more && rows.length ? nextCursor(candidates[rows.length - 1]) : null };
    if (Buffer.byteLength(json(result)) > pageBytes) throw new AppError(413, 'This history response exceeds the host limit.');
    return result;
  }
  function revisionRows(owner, extensionId, before, restore = false) {
    draft(owner, extensionId);
    const kind = restore ? 'restore' : 'revisions', anchor = readCursor(before, kind, owner, extensionId);
    const linked = 'FROM extension_revisions r JOIN extension_revision_links l ON l.revision_id=r.id AND l.owner_id=r.owner_id WHERE r.owner_id=? AND l.extension_id=?';
    const history = restore ? " AND EXISTS(SELECT 1 FROM extension_history h WHERE h.owner_id=r.owner_id AND h.revision_id=r.id AND h.operation IN ('operator','activate','rollback'))" : '';
    if (anchor && !db.prepare(`SELECT 1 ${linked}${history} AND r.rowid=? AND r.id=?`).get(owner, extensionId, anchor.at, anchor.id)) invalidCursor();
    const rows = [], statement = db.prepare(`SELECT r.*,r.rowid AS at ${linked}${history} AND r.rowid<? ORDER BY r.rowid DESC`);
    for (const row of statement.iterate(owner, extensionId, anchor?.at ?? Number.MAX_SAFE_INTEGER)) {
      if (!restore || eligible(row)) rows.push(row);
      if (rows.length > pageRows) break;
    }
    return boundedPage(rows, view, row => cursor(kind, owner, extensionId, row));
  }
  function creation(owner, operationId, hash) {
    const row = db.prepare('SELECT id,creation_hash FROM extensions WHERE owner_id=? AND creation_operation_id=?').get(owner, operationId);
    if (row && row.creation_hash !== hash) conflict();
    if (row) draft(owner, row.id, true);
    return row;
  }
  function creationInput(operationId, hash, name) {
    if (typeof operationId !== 'string' || !operationId || operationId.length > 128
        || typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) throw new AppError(400, 'Use a valid creation operation.');
    if (typeof name !== 'string' || !name.trim() || Array.from(name).length > 80) throw new AppError(400, 'Use a name of 1–80 characters.');
  }
  async function compileValue(input, authorize, signal) {
    if (typeof input.source !== 'string' || !input.source.length || Buffer.byteLength(input.source) > 65536
        || Buffer.from(input.source).toString('utf8') !== input.source) throw new AppError(400, 'Source must be 1–65,536 valid UTF-8 bytes.');
    const label = input.label ?? 'Authored extension';
    if (typeof label !== 'string' || !label.trim() || label.length > 80) throw new AppError(400, 'Use a label of 1–80 characters.');
    if (!compiler || !host) throw new AppError(503, 'Source compilation is unavailable. Native tasks and saved extensions still work.');
    let result;
    try { result = await compiler.compile(Buffer.from(input.source), { definition: host, signal }); }
    catch (error) {
      const messages = { 413: 'Compiler input or output exceeds the host limit.', 429: 'Compilation is busy. Try again after the current preparation settles.',
        499: 'Preparation stopped. Check saved state before trying again.', 503: 'Source compilation is unavailable. Native tasks and saved extensions still work.',
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
    try { admitArtifact(value.artifact, host); authoredPins(value); } catch { throw new AppError(422, 'The compiled program does not match the host contract.'); }
    return value;
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
    assertAvailable(owner, extensionId, terminal = false) { draft(owner, extensionId, terminal); },
    assertWritable(owner, extensionId) { requireTask(owner, extensionId); },
    executionAvailability() {
      const available = !!host;
      return { available, message: available ? null : 'Task customizations cannot run in this installation yet. Your tasks still work.' };
    },
    hostCatalog() {
      return host ? { ...host.catalog, model: { dcm: host.dcmBytes.toString('utf8'), digest: host.pins.modelDigest,
        profile: host.pins.profile, hook: host.pins.hook, consumer: host.pins.consumer, compiler: host.pins.compiler } } : { hooks: [] };
    },
    collection(owner, { before } = {}) {
      const base = { owner: ownerView(owner), selection: selectionView(owner), catalog: choices(), hostCatalog: host?.catalog ?? { hooks: [] }, executionAvailability: api.executionAvailability() };
      const anchor = readCursor(before, 'collection', owner);
      if (anchor && !db.prepare('SELECT 1 FROM extensions WHERE owner_id=? AND created_at=? AND id=?').get(owner, anchor.at, anchor.id)) invalidCursor();
      const rows = db.prepare(`SELECT id,created_at AS at FROM extensions WHERE owner_id=? AND deleted_at IS NULL
        ${anchor ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT 21`)
        .all(owner, ...(anchor ? [anchor.at, anchor.at, anchor.id] : []));
      return boundedPage(rows, row => {
        const state = draft(owner, row.id), candidate = state.draft_id ? revision(owner, state.draft_id, row.id) : null;
        const excerpt = requestExcerpt(owner, row.id);
        return { retired: !taskItem(owner, state.id), extension: { id: state.id, name: state.name, hookId: state.hook_id, creationOperationId: state.creation_operation_id },
          draftVersion: state.draft_version, draft: view(candidate), approved: approved(candidate),
          ...(excerpt === undefined ? {} : { requestExcerpt: excerpt }) };
      }, row => cursor('collection', owner, undefined, row), base, 'items');
    },
    findCreation(owner, operationId) {
      ownerView(owner);
      if (typeof operationId !== 'string' || !operationId || operationId.length > 128) throw new AppError(400, 'Use a valid creation operation.');
      const row = db.prepare('SELECT id FROM extensions WHERE owner_id=? AND creation_operation_id=?').get(owner, operationId);
      if (!row) throw notFound();
      draft(owner, row.id, true);
      return api.state(owner, row.id);
    },
    evidencePage(owner, extensionId, before) {
      draft(owner, extensionId);
      const anchor = readCursor(before, 'evidence', owner, extensionId);
      const linked = 'FROM extension_evidence e JOIN extension_revision_links l ON l.revision_id=e.revision_id AND l.owner_id=e.owner_id WHERE e.owner_id=? AND l.extension_id=?';
      if (anchor && !db.prepare(`SELECT 1 ${linked} AND e.rowid=? AND e.id=?`).get(owner, extensionId, anchor.at, anchor.id)) invalidCursor();
      const rows = db.prepare(`SELECT e.id,e.revision_id AS revisionId,e.rowid AS at ${linked} AND e.rowid<? ORDER BY e.rowid DESC LIMIT 21`)
        .all(owner, extensionId, anchor?.at ?? Number.MAX_SAFE_INTEGER);
      return boundedPage(rows, row => ({ id: row.id, revisionId: row.revisionId }), row => cursor('evidence', owner, extensionId, row));
    },
    revisionPage(owner, extensionId, before) { return revisionRows(owner, extensionId, before); },
    restorePage(owner, extensionId, before) { return revisionRows(owner, extensionId, before, true); },
    state(owner, extensionId) {
      const state = draft(owner, extensionId);
      const candidate = state.draft_id ? revision(owner, state.draft_id, extensionId) : null;
      const latest = candidate && db.prepare('SELECT * FROM extension_evidence WHERE owner_id=? AND revision_id=? ORDER BY rowid DESC LIMIT 1').get(owner, candidate.id);
      const approval = candidate?.provenance === 'customer' && db.prepare('SELECT evidence_id FROM extension_approvals WHERE owner_id=? AND revision_id=?').get(owner, candidate.id);
      const approvedProof = approval && evidence(owner, approval.evidence_id, extensionId);
      const targets = api.restorePage(owner, extensionId), proofs = api.evidencePage(owner, extensionId), history = api.history(owner, undefined, extensionId);
      const first = state.creation_operation_id && db.prepare('SELECT revision_id FROM extension_revision_links WHERE owner_id=? AND extension_id=? ORDER BY rowid LIMIT 1').get(owner, extensionId);
      return { retired: !taskItem(owner, state.id), executionAvailability: api.executionAvailability(), owner: ownerView(owner), extension: { id: state.id, name: state.name, hookId: state.hook_id, creationOperationId: state.creation_operation_id },
        creationRevisionId: first?.revision_id ?? null, creationReceipt: first ? { extensionId, revisionId: first.revision_id, draftVersion: 1 } : null,
        catalog: choices(), hostCatalog: host?.catalog ?? { hooks: [] }, draftVersion: state.draft_version,
        revisionId: candidate?.id ?? null, suiteDigest: candidate?.template_id === 'authored' ? stored(candidate)?.pins.suiteDigest ?? null : null,
        draft: view(candidate), evidence: latest ? { id: latest.id, revisionId: candidate.id, passed: passing(candidate, latest) } : null,
        approved: approved(candidate), approvedEvidenceId: approvedProof && passing(candidate, approvedProof) ? approvedProof.id : null,
        selection: selectionView(owner, state.hook_id ?? TASK_HOOK), restoreTargets: targets.rows, restoreTargetsNext: targets.next,
        history: history.rows, historyNext: history.next, evidenceHistory: proofs.rows, evidenceHistoryNext: proofs.next };
    },
    admit(owner, { extensionId, operationId, hash, name }, authorize) {
      authorize();
      if (!db.isTransaction) conflict();
      ownerView(owner); creationInput(operationId, hash, name);
      const existing = creation(owner, operationId, hash);
      if (existing) return api.state(owner, existing.id);
      if (typeof extensionId !== 'string' || !extensionId || extensionId.length > 128) throw new AppError(400, 'Use a valid extension identity.');
      if (db.prepare('SELECT 1 FROM extensions WHERE id=?').get(extensionId)) conflict();
      db.prepare('INSERT INTO extensions(id,owner_id,hook_id,name,created_at,creation_operation_id,creation_hash,draft_version,draft_revision_id) VALUES (?,?,NULL,?,?,?,?,0,NULL)').run(extensionId, owner, name.trim(), Date.now(), operationId, hash);
      authorize(); return api.state(owner, extensionId);
    },
    async createFromSource(owner, input, authorize, { signal } = {}) {
      authorize(); abort(signal); ownerView(owner);
      const name = input.label ?? 'Authored extension', hash = digest(json({ operationId: input.operationId, source: input.source, label: input.label }));
      creationInput(input.operationId, hash, name);
      const existing = creation(owner, input.operationId, hash);
      if (existing) return api.state(owner, existing.id);
      retired();
    },
    delete(owner, input, authorize, assertIdle = () => {}) {
      return transaction(db, () => {
        authorize();
        if (typeof input.expectedName !== 'string' || !input.expectedName.isWellFormed()
            || !Number.isSafeInteger(input.draftVersion) || input.draftVersion < 0
            || !Number.isSafeInteger(input.generation) || input.generation < 0) throw new AppError(400, 'Use the exact name, draft version and selection generation.');
        const retained = db.prepare('SELECT deleted_at FROM extensions WHERE owner_id=? AND id=?').get(owner, input.extensionId);
        if (!retained) throw notFound();
        if (retained.deleted_at !== null) return { extensionId: input.extensionId, deletedAt: retained.deleted_at };
        const state = draft(owner, input.extensionId), active = selection(owner, state.hook_id ?? TASK_HOOK);
        if (state.name !== input.expectedName || state.draft_version !== input.draftVersion || active.generation !== input.generation) conflict();
        assertIdle();
        if (db.prepare("SELECT 1 FROM authoring_conversations c JOIN extension_conversation_links l ON l.conversation_id=c.id AND l.owner_id=c.owner_id WHERE l.owner_id=? AND l.extension_id=? AND c.status IN ('RUNNING','CANCELLING')").get(owner, input.extensionId)) {
          const error = new AppError(409, 'Open this customization and use Stop, then wait for authoring to settle before deleting it.'); error.code = 'CUSTOMIZATION_BUSY'; throw error;
        }
        if (active.revision_id && db.prepare('SELECT 1 FROM extension_revision_links WHERE owner_id=? AND extension_id=? AND revision_id=?').get(owner, input.extensionId, active.revision_id)) change(owner, active.generation, null, 'disable', state.hook_id ?? TASK_HOOK);
        const deletedAt = Date.now();
        revokeTaskAdmissions(db, owner, input.extensionId);
        db.prepare('UPDATE extensions SET deleted_at=? WHERE owner_id=? AND id=?').run(deletedAt, owner, input.extensionId);
        authorize();
        return { extensionId: input.extensionId, deletedAt };
      });
    },
    rename(owner, input, authorize) {
      commit(owner, input.extensionId, authorize, () => {
        for (const [field, value] of Object.entries({ name: input.name, expectedName: input.expectedName })) {
          if (typeof value !== 'string' || !value.isWellFormed() || field === 'name' && value.includes('\0') || !value.trim() || Array.from(field === 'name' ? value.trim() : value).length > 80)
            throw new AppError(400, 'Use a name of 1–80 characters.');
        }
        const state = draft(owner, input.extensionId);
        if (state.name !== input.expectedName) conflict();
        const name = input.name.trim();
        if (state.name !== name) db.prepare('UPDATE extensions SET name=? WHERE owner_id=? AND id=?').run(name, owner, input.extensionId);
      }); return api.state(owner, input.extensionId);
    },
    load(owner, input, authorize) {
      authorize(); draft(owner, input.extensionId); retired();
    },
    async compile(owner, input, authorize, { signal } = {}) {
      authorize(); abort(signal); const state = draft(owner, input.extensionId);
      requireTask(owner, input.extensionId);
      if (input.hookId !== TASK_HOOK || state.hook_id !== null && state.hook_id !== input.hookId) throw new AppError(400, 'Choose the discovered task-completion definition.');
      if (state.draft_version !== input.draftVersion) conflict();
      const value = await compileValue(input, authorize, signal);
      commit(owner, input.extensionId, authorize, () => {
        abort(signal); if (draft(owner, input.extensionId).draft_version !== input.draftVersion) conflict(); saveAuthored(owner, input.extensionId, value);
      }); return api.state(owner, input.extensionId);
    },
    restart(owner, input, authorize) {
      commit(owner, input.extensionId, authorize, () => {
        const state = draft(owner, input.extensionId), active = selection(owner);
        if (state.draft_version !== input.draftVersion || active.generation !== input.generation || active.revision_id !== input.revisionId) conflict();
        const row = revision(owner, input.revisionId, input.extensionId);
        if (!eligible(row)) conflict();
        if (state.draft_id && state.draft_id !== row.id) db.prepare('INSERT INTO extension_history(owner_id,revision_id,generation,operation) VALUES (?,?,?,?)')
          .run(owner, state.draft_id, active.generation, 'draft-superseded');
        if (row.template_id === 'authored') saveAuthored(owner, input.extensionId, content(row), definition(row));
        else {
          const id = randomUUID();
          db.prepare('INSERT INTO extension_revisions VALUES (?,?,?,?,?)').run(id, owner, row.template_id, row.identity, 'customer');
          saveHead(owner, input.extensionId, id);
        }
      }); return api.state(owner, input.extensionId);
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
      for (const [index, text] of input.cases.entries()) {
        abort(signal); authorize();
        if (taskRevision(row)) {
          try { validateTaskEffectScenarios(definition(row), [text]); }
          catch { const error = new AppError(400, 'A scenario is invalid for the task-completion contract.');
            error.diagnostics = [{ code: 'INVALID_SCENARIO', path: `/cases/${index}` }]; throw error; }
        } else {
        // Denied entry reuses native strict case validation without dispatch or evidence creation.
        const report = await runReadSimulation(selectionInput(item), fixture(owner, item, authorize, false), Buffer.from(text));
        if (report.status === 'INVALID_SCENARIO') {
          const error = new AppError(400, 'A scenario is invalid for the host contract.');
          error.diagnostics = [{ code: 'INVALID_SCENARIO', path: `/cases/${index}` }]; throw error;
        }
        if (['SETUP_ERROR', 'CONSUMER_ERROR'].includes(report.status)) throw new AppError(400, 'A scenario is invalid for the host contract.');
        }
        const id = JSON.parse(text).id;
        if (ids.has(id)) {
          const error = new AppError(400, 'Scenario IDs must be unique.');
          error.diagnostics = [{ code: 'DUPLICATE_SCENARIO_ID', path: `/cases/${index}` }]; throw error;
        }
        ids.add(id);
      }
      commit(owner, input.extensionId, authorize, () => {
        abort(signal); currentDraft(owner, input);
        const value = content(row); saveAuthored(owner, input.extensionId, { ...value, suite: suiteBytes }, definition(row));
      }); return api.state(owner, input.extensionId);
    },
    source(owner, id, extensionId) {
      draft(owner, extensionId);
      const row = revision(owner, id, extensionId), item = stored(row);
      if (!item || item.identity !== row.identity) throw notFound();
      const prepared = row.template_id !== 'authored';
      return { extensionId, revisionId: id, source: item.source, artifact: item.artifactBytes.toString('utf8'), pins: JSON.parse(row.identity),
        cases: prepared ? cases(row).filter(example => example.id !== 'host-denied').map(example => example.bytes.toString('utf8')) : item.suite ? JSON.parse(item.suite) : [],
        suiteDigest: prepared ? null : item.pins.suiteDigest,
        hostCases: prepared ? cases(row).filter(example => example.id === 'host-denied').map(example => ({ case: example.bytes.toString('utf8'), editable: false, authority: 'host' })) : [] };
    },
    async simulate(owner, input, authorize, { signal } = {}) {
      authorize(); abort(signal); const row = currentDraft(owner, input), item = executable(row), examples = cases(row, item);
      if (!examples.length) throw new AppError(409, 'Save independent examples for this revision before running checks.');
      if (simulations.has(owner) || simulations.size >= 2) throw new AppError(429, 'Sample checks are busy. Try again after the current check finishes.');
      simulations.add(owner);
      try {
        let reports = [];
        if (taskRevision(row)) {
          const result = await runTaskSimulation({ artifactBytes: item.artifactBytes, host: definition(row), scenarios: examples.map(example => example.bytes.toString('utf8')), signal });
          authorize(); abort(signal);
          reports = result.reports;
        } else {
        for (const example of examples) {
          authorize(); abort(signal);
          const permitted = row.template_id === 'authored' || example.id !== 'host-denied';
          const report = await runSimulation(selectionInput(item), fixture(owner, item, authorize, permitted), example.bytes);
          reports.push({ id: example.id, label: example.label, expected: example.expected, report });
        }
        }
        const suiteDigest = suiteIdentity(row);
        const payload = json({ identity: { dependencies: item.pins, ...versions(row), suiteDigest }, reports });
        if (Buffer.byteLength(payload) > 131072) throw new AppError(413, 'Sample evidence exceeds the host limit.');
        commit(owner, input.extensionId, authorize, () => {
          abort(signal); currentDraft(owner, input);
          const proof = { owner_id: owner, revision_id: row.id, identity: row.identity, suite_identity: suiteDigest, payload, passed: reports.length === examples.length && reports.every(entry => entry.report.status === 'PASS') ? 1 : 0 };
          db.prepare('INSERT INTO extension_evidence VALUES (?,?,?,?,?,?,?)').run(randomUUID(), owner, row.id, proof.identity, suiteDigest, payload, passing(row, proof) ? 1 : 0);
        }); return api.state(owner, input.extensionId);
      } finally { simulations.delete(owner); }
    },
    approve(owner, input, authorize) {
      commit(owner, input.extensionId, authorize, () => {
        const row = currentDraft(owner, input), proof = evidence(owner, input.evidenceId, input.extensionId);
        if (!passing(row, proof)) conflict();
        db.prepare('INSERT INTO extension_approvals VALUES (?,?,?) ON CONFLICT(owner_id,revision_id) DO UPDATE SET evidence_id=excluded.evidence_id').run(owner, row.id, proof.id);
      }); return api.state(owner, input.extensionId);
    },
    activate(owner, input, authorize) { commit(owner, input.extensionId, authorize, () => change(owner, input.generation, currentDraft(owner, input), 'activate')); return api.state(owner, input.extensionId); },
    disable(owner, input, authorize) {
      commit(owner, input.extensionId, authorize, () => {
        const state = draft(owner, input.extensionId), active = selection(owner, state.hook_id ?? TASK_HOOK);
        if (!active.revision_id) conflict();
        revision(owner, active.revision_id, input.extensionId);
        change(owner, input.generation, null, 'disable', state.hook_id ?? TASK_HOOK);
        revokeTaskAdmissions(db, owner, input.extensionId);
      }, false); return api.state(owner, input.extensionId);
    },
    rollback(owner, input, authorize) {
      commit(owner, input.extensionId, authorize, () => {
        const row = revision(owner, input.revisionId, input.extensionId);
        if (!db.prepare("SELECT 1 FROM extension_history WHERE owner_id=? AND revision_id=? AND operation IN ('operator','activate','rollback')").get(owner, row.id)) conflict();
        change(owner, input.generation, row, 'rollback');
      }); return api.state(owner, input.extensionId);
    },
    evidence(owner, id, extensionId) {
      draft(owner, extensionId);
      const proof = evidence(owner, id, extensionId), row = revision(owner, proof.revision_id, extensionId);
      const payload = JSON.parse(proof.payload);
      let originals = [];
      try { if (proof.suite_identity === suiteIdentity(row)) originals = cases(row); }
      catch { /* Historical proof remains readable without borrowing current scenario metadata. */ }
      const reports = payload.reports.map(item => {
        const original = originals.find(example => example.id === item.id);
        if (!original) return item;
        const example = JSON.parse(original.bytes);
        if (taskRevision(row)) {
          const projectName = id => typeof id === 'string'
            ? db.prepare('SELECT name FROM projects WHERE owner_id=? AND id=?').get(owner, id)?.name ?? 'Example project' : undefined;
          const decorate = rows => rows === null ? null : rows?.map(value => ({ ...value, projectName: projectName(value.projectId) }));
          return { ...item, expected: { ...item.expected, createdTasks: decorate(item.expected.createdTasks) },
            report: { ...item.report, scenario: item.report.scenario ? { task: { ...item.report.scenario.task,
              projectName: projectName(item.report.scenario.task.projectId) } } : undefined,
              observed: item.report.observed ? { ...item.report.observed, createdTasks: decorate(item.report.observed.createdTasks) } : undefined } };
        }
        return { ...item, ...situation(example), expected: { ...item.expected, consumption: example.expect.consumption } };
      });
      return { id: proof.id, revisionId: proof.revision_id, kind: row.template_id === 'authored' ? 'authored' : 'prepared',
        ...payload, reports, passed: passing(row, proof) };
    },
    history(owner, before, extensionId) {
      ownerView(owner);
      if (extensionId !== undefined) draft(owner, extensionId);
      if (before !== undefined) {
        if (!Number.isSafeInteger(before) || before <= 0) invalidCursor();
        const anchor = extensionId === undefined
          ? db.prepare('SELECT 1 FROM extension_history WHERE owner_id=? AND id=?').get(owner, before)
          : db.prepare('SELECT 1 FROM extension_history h JOIN extension_revision_links l ON l.revision_id=h.revision_id AND l.owner_id=h.owner_id WHERE h.owner_id=? AND h.id=? AND l.extension_id=?').get(owner, before, extensionId);
        if (!anchor) invalidCursor();
      }
      const rows = extensionId === undefined
        ? db.prepare('SELECT h.id,h.generation,h.operation,h.revision_id AS revisionId FROM extension_history h WHERE h.owner_id=? AND h.id<? AND (h.revision_id IS NULL OR EXISTS(SELECT 1 FROM extension_revision_links l JOIN extensions e ON e.id=l.extension_id AND e.owner_id=l.owner_id WHERE l.owner_id=h.owner_id AND l.revision_id=h.revision_id AND e.deleted_at IS NULL)) ORDER BY h.id DESC LIMIT 21').all(owner, before ?? Number.MAX_SAFE_INTEGER)
        : db.prepare('SELECT h.id,h.generation,h.operation,h.revision_id AS revisionId FROM extension_history h JOIN extension_revision_links l ON l.revision_id=h.revision_id AND l.owner_id=h.owner_id WHERE h.owner_id=? AND h.id<? AND l.extension_id=? ORDER BY h.id DESC LIMIT 21').all(owner, before ?? Number.MAX_SAFE_INTEGER, extensionId);
      return boundedPage(rows, row => ({ ...row, label: row.revisionId ? view(revision(owner, row.revisionId, extensionId)).label : null }), row => row.id);
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
    execution(owner, revisionId, extensionId) {
      const row = revision(owner, revisionId, extensionId);
      if (!taskRevision(row) || !taskItem(owner, extensionId)) retired();
      const item = executable(row);
      if (!item) throw new AppError(503, 'The exact saved execution dependencies are unavailable.');
      return { artifactBytes: item.artifactBytes, host: definition(row), pins: item.pins };
    },
    admissionCurrent(context) {
      try {
        const state = draft(context.owner, context.itemId), row = revision(context.owner, context.revisionId, context.itemId), item = executable(row);
        if (state.hook_id !== TASK_HOOK || !item || !eligible(row) || !executableHost(context.pins)) return false;
        if (!Object.entries(item.pins).every(([key, value]) => json(context.pins[key]) === json(value))) return false;
        const capturedProof = context.pins.approvedEvidenceId && evidence(context.owner, context.pins.approvedEvidenceId, context.itemId);
        return !!capturedProof && capturedProof.revision_id === row.id && passing(row, capturedProof);
      } catch { return false; }
    },
  };
  return api;
}
