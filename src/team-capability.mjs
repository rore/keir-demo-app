import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { AppError, notFound, transaction } from './data.mjs';
import { projectAccess } from './team-native.mjs';
import { teamModel, teamModelBytes, validateTeamBundle } from './team-runtime.mjs';
import { createCompiler } from './compiler.mjs';
import { digest, json } from './extension-catalog.mjs';
import { normalizeTeamCases, simulateTeam, TEAM_HARNESS } from './team-simulation.mjs';
import { normalizeTeamAgreement, qualifyAuthoredTeam, teamAgreementUsers, TEAM_BINDINGS, TEAM_QUALIFICATION } from './team-qualification.mjs';

const hooks = ['TaskCreated', 'TaskBeforeComplete'];
const template = readFileSync(new URL('../keir/team-review-v1.json', import.meta.url), 'utf8');
const examples = readFileSync(new URL('../keir/team-review-examples-v1.json', import.meta.url), 'utf8');
const load = name => JSON.parse(readFileSync(new URL('../vendor/' + name, import.meta.url), 'utf8'));
const conflict = () => new AppError(409, 'The Team draft or access changed. Read saved state before trying again.');
const bounded = (value, limit, label) => {
  const text = json(value);
  if (typeof text !== 'string' || Buffer.byteLength(text) > limit) throw new AppError(413, `${label} exceeds the size limit.`);
  return text;
};
const fields = (input, names) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== names.length
      || names.some(key => !Object.hasOwn(input, key))) throw new AppError(400, 'Use only the supported Team fields.');
};
const version = n => { if (!Number.isSafeInteger(n) || n < 0 || n >= Number.MAX_SAFE_INTEGER) throw conflict(); };
const id = value => { if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(value)) throw notFound(); return value; };
const operationId = value => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
    throw new AppError(400, 'Use the original action operation ID.');
  return value;
};

export function createTeamCapability(db, { compiler = createCompiler({ modelBytes: teamModelBytes, javaExecutable: process.env.KEIR_JAVA_BIN }) } = {},
  { simulate = simulateTeam, now = () => Math.floor(performance.now()) } = {}) {
  const operations = new Set(), simulations = new Set();
  let closed = false, simulationCount = 0;
  function access(actor, projectId, authorize) {
    if (authorize && authorize() !== actor) throw new AppError(401, 'Your demo session changed. Sign in again.');
    const project = projectAccess(db, actor, id(projectId));
    if (project.mode !== 'TEAM') throw notFound();
    if (project.role !== 'ADMIN') throw new AppError(403, 'Only a current project admin can read or prepare a capability.');
    return project;
  }
  const draft = projectId => {
    const row = db.prepare('SELECT * FROM team_drafts WHERE project_id=?').get(projectId);
    if (!row) throw conflict();
    return row;
  };
  function revision(projectId, revisionId) {
    const row = db.prepare('SELECT * FROM team_revisions WHERE project_id=? AND revision_id=?').get(projectId, id(revisionId));
    if (!row || row.source_bundle === null) throw notFound();
    return row;
  }
  function reviewer(projectId, parameters) {
    if (parameters.kind === 'authored-team/1') {
      for (const userId of teamAgreementUsers(parameters.agreement))
        if (!db.prepare('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?').get(projectId, userId)) throw conflict();
      for (const c of parameters.agreement.examples) for (const actor of c.actors)
        if (db.prepare('SELECT role FROM project_members WHERE project_id=? AND user_id=?').get(projectId, actor.userId)?.role !== actor.role) throw conflict();
      return;
    }
    if (!db.prepare('SELECT 1 FROM project_members WHERE project_id=? AND user_id=?').get(projectId, parameters.reviewerId)) throw conflict();
  }
  function current(projectId, expected, revisionId, allowRevoked = false) {
    const d = draft(projectId);
    if (d.draft_version !== expected || revisionId !== undefined && d.revision_id !== revisionId) throw conflict();
    if (d.revision_id && !allowRevoked && db.prepare('SELECT revoked_at FROM team_revisions WHERE project_id=? AND revision_id=?').get(projectId, d.revision_id)?.revoked_at !== null) throw conflict();
    return d;
  }
  const summary = row => {
    if (!row) return null;
    const parameters = row.source_bundle ? JSON.parse(row.source_bundle).parameters : null;
    return { revisionId: row.revision_id, manifest: JSON.parse(row.manifest), revoked: row.revoked_at !== null, parameters,
      ...(parameters?.kind === 'authored-team/1' ? { agreement: parameters.agreement } : {}) };
  };
  const authored = row => JSON.parse(row.source_bundle).parameters.kind === 'authored-team/1';
  const latestEvidence = (projectId, revisionId) => db.prepare('SELECT * FROM team_evidence WHERE project_id=? AND revision_id=? ORDER BY rowid DESC LIMIT 1').get(projectId, revisionId);
  const receipt = (row, includeInput = true) => ({
    kind: row.kind, id: row.id, operationId: row.operation_id, actorId: row.actor_id, createdAt: row.created_at,
    revisionId: row.revision_id,
    ...(['deactivations', 'revocations'].includes(row.kind) ? { result: JSON.parse(row.result) }
      : { evidenceId: JSON.parse(row.input).evidenceId, approvalId: row.kind === 'approvals' ? row.id : row.approval_id }),
    ...(row.kind === 'activations' ? { generation: row.generation } : {}),
    ...(includeInput ? { input: JSON.parse(row.input) } : {}),
  });
  function savedOperation(actor, projectId, op) {
    const rows = ['approvals', 'activations'].map(kind => db.prepare(`SELECT *,? AS kind FROM team_${kind}
      WHERE project_id=? AND actor_id=? AND operation_id=?`).get(kind, projectId, actor, op)).filter(Boolean);
    const control = db.prepare('SELECT * FROM team_controls WHERE project_id=? AND actor_id=? AND operation_id=?').get(projectId, actor, op);
    if (control) rows.push(control);
    if (rows.length > 1) throw new AppError(503, 'The saved action cannot be identified safely.');
    return rows[0] ?? null;
  }
  function selectionView(projectId) {
    const selected = db.prepare('SELECT * FROM team_selections WHERE project_id=?').get(projectId);
    const activation = selected && db.prepare(`SELECT *,'activations' AS kind FROM team_activations
      WHERE project_id=? AND generation=? AND revision_id=?`).get(projectId, selected.generation, selected.revision_id);
    return { available: !!selected, generation: selected?.generation ?? null, revisionId: selected?.revision_id ?? null,
      activation: activation ? receipt(activation, false) : null };
  }
  function controlTarget(projectId, revisionId) {
    const row = db.prepare('SELECT revision_id,revoked_at FROM team_revisions WHERE project_id=? AND revision_id=?').get(projectId, id(revisionId));
    if (!row) throw notFound();
    return { revisionId: row.revision_id, revokedAt: row.revoked_at };
  }
  function executable(projectId, row) {
    const source = JSON.parse(row.source_bundle), manifest = JSON.parse(row.manifest), artifacts = JSON.parse(row.artifacts);
    const compilerPins = load('compiler-provenance.json'), runtimePins = load('provenance.json');
    const runtime = { package: runtimePins.package, version: runtimePins.version, sha256: runtimePins.sha256, integrity: runtimePins.integrity };
    if (!['scripted-review/1', 'authored-team/1'].includes(source.parameters?.kind) || json(source.runtime) !== json(runtime)
        || source.compiler?.compiler !== compilerPins.compiler || source.compiler?.artifact?.sha256 !== compilerPins.artifact.sha256
        || json(source.compiler?.environment) !== json(compilerPins.environment)) throw conflict();
    if (source.parameters.kind === 'authored-team/1') {
      fields(source.sources, hooks); fields(source.hooks, hooks);
      if (source.parameters.qualificationPolicy !== TEAM_QUALIFICATION) throw conflict();
    }
    const bytes = Object.fromEntries(hooks.map(hook => {
      const text = artifacts[manifest[hook]], sourceText = source.sources?.[hook], pins = source.hooks?.[hook];
      if (source.parameters.kind === 'authored-team/1' && manifest[hook] === null) {
        if (sourceText !== null || json(pins) !== json({ present: false, rawSourceDigest: null, sourceDigest: null, artifactDigest: null, modelRef: null })
            || source.parameters.agreement.claims.some(c => c.hook === hook)) throw conflict();
        return [hook, null];
      }
      if (source.parameters.kind === 'authored-team/1' && !source.parameters.agreement.claims.some(c => c.hook === hook)) throw conflict();
      if (typeof text !== 'string' || typeof sourceText !== 'string' || Buffer.byteLength(sourceText) > 65536
          || !pins?.present || digest(text) !== manifest[hook] || pins.artifactDigest !== manifest[hook]
          || digest(sourceText) !== pins.rawSourceDigest) throw conflict();
      const artifact = JSON.parse(text);
      if (artifact.sourceDigest !== pins.sourceDigest || artifact.sourceDigest !== digest(sourceText)
          || artifact.compiler !== compilerPins.compiler || json(artifact.environment) !== json(compilerPins.environment)
          || json(artifact.modelRef) !== json(pins.modelRef) || artifact.modelRef?.digest !== digest(json(teamModel))) throw conflict();
      return [hook, Buffer.from(text)];
    }));
    const valid = validateTeamBundle(bytes);
    if (json(valid.artifacts) !== json(artifacts) || hooks.some(hook => valid.manifest[hook] !== manifest[hook])
        || manifest.modelDigest !== valid.manifest.modelDigest || json(manifest.grants) !== json(valid.manifest.grants)
        || manifest.executableIdentity !== digest(json({ projectId, modelDigest: manifest.modelDigest, grants: manifest.grants, sourceBundle: source }))) throw conflict();
    if (source.parameters.kind === 'authored-team/1'
        && json(normalizeTeamAgreement(source.parameters.agreement)) !== json(source.parameters.agreement)) throw conflict();
    return { source, manifest };
  }
  function qualify(projectId, row, proof, submitted) {
    if (!proof || proof.revision_id !== row.revision_id || proof.project_id !== projectId || row.revoked_at !== null) throw conflict();
    const { source, manifest } = executable(projectId, row);
    reviewer(projectId, source.parameters);
    const isAuthored = source.parameters.kind === 'authored-team/1';
    const cases = normalizeTeamCases(JSON.parse(proof.cases), { authored: isAuthored }), contract = normalizeTeamCases(JSON.parse(examples));
    const report = JSON.parse(proof.report);
    if (proof.passed !== 1 || proof.harness !== TEAM_HARNESS || report.harness !== TEAM_HARNESS || report.passed !== true
        || proof.executable_identity !== manifest.executableIdentity || proof.case_digest !== digest(json(cases))
        || submitted && json(submitted) !== json(cases) || !isAuthored && cases.length !== contract.length
        || !Array.isArray(report.cases) || report.cases.length !== cases.length) throw conflict();
    if (isAuthored) {
      const qualification = qualifyAuthoredTeam({ agreement: source.parameters.agreement, cases, report, manifest,
        artifacts: JSON.parse(row.artifacts), projectId });
      if (!qualification.eligible || json(report.qualification) !== json(qualification)) {
        const error = new AppError(409, qualification.unverified.join(' ') || 'The saved qualification does not match this exact revision.');
        error.code = 'TEAM_UNVERIFIED'; throw error;
      }
      return proof;
    }
    for (const [i, c] of cases.entries()) {
      const required = contract[i], result = report.cases[i];
      const structure = c => ({ actors: c.actors, fault: c.fault, initialTasks: c.initialTasks,
        actions: c.actions.map(({ expect, ...action }) => action) });
      if (json(structure(c)) !== json(structure(required)) || result.id !== c.id || result.name !== c.name
          || result.passed !== true || !Array.isArray(result.events) || result.events.length !== c.actions.length) throw conflict();
      for (const [j, action] of c.actions.entries()) {
        const event = result.events[j];
        if (event.action !== action.op || event.ref !== action.ref || json(event.expected) !== json(action.expect)
            || !Array.isArray(event.mismatches) || event.mismatches.length || !event.observed
            || !event.native?.taskId || !Number.isInteger(event.native.writeAttempts) || event.native.writeAttempts < 0 || event.native.writeAttempts > 1
            || Object.entries(required.actions[j].expect).some(([key, value]) => action.expect[key] !== value)
            || Object.entries(action.expect).some(([key, value]) => event.observed[key] !== value)) throw conflict();
        if (action.op === 'dispatch' && (event.runtime?.hook !== 'TaskCreated'
            || event.runtime.outcome?.classification !== event.observed.outcome)) throw conflict();
        if (event.observed.receipt === 'CONFIRMED') {
          const r = event.native.receipt;
          if (r?.effect !== 'CONFIRMED' || r.eventId !== event.native.eventId || r.result?.effect !== 'CONFIRMED'
              || typeof r.result.value?.id !== 'string' || JSON.parse(r.payload).parentTaskId !== event.native.taskId
              || JSON.parse(r.payload).projectId !== projectId) throw conflict();
        }
      }
    }
    return proof;
  }
  function state(actor, projectId, authorize) {
    const project = access(actor, projectId, authorize), d = draft(projectId);
    const rev = d.revision_id ? revision(projectId, d.revision_id) : null;
    const selected = db.prepare(`SELECT r.* FROM team_selections s LEFT JOIN team_revisions r
      ON r.project_id=s.project_id AND r.revision_id=s.revision_id WHERE s.project_id=?`).get(projectId);
    const evidence = rev ? db.prepare(`SELECT id,revision_id AS revisionId,executable_identity AS executableIdentity,
      case_digest AS caseDigest,passed,created_at AS createdAt FROM team_evidence WHERE project_id=? AND revision_id=?
      ORDER BY rowid DESC LIMIT 1`).get(projectId, rev.revision_id) ?? null : null;
    const approval = rev && evidence && db.prepare(`SELECT *,'approvals' AS kind FROM team_approvals
      WHERE project_id=? AND revision_id=? AND evidence_id=? ORDER BY rowid DESC LIMIT 1`).get(projectId, rev.revision_id, evidence.id);
    let eligibility = { eligible: false, reason: 'Prepare and check this draft before approving it.' };
    if (rev) {
      try { qualify(projectId, rev, latestEvidence(projectId, rev.revision_id)); eligibility = { eligible: true, reason: '' }; }
      catch (error) { eligibility = { eligible: false, reason: error.code === 'TEAM_UNVERIFIED' ? error.message
        : authored(rev) ? 'This draft needs current matching native evidence, complete agreed coverage and current project access.'
        : 'This draft needs the complete current six-example check and current reviewer access.' }; }
    }
    access(actor, projectId, authorize);
    return { project: { id: project.id, name: project.name, role: project.role }, draftVersion: d.draft_version,
      draft: summary(rev), selected: selected?.revision_id ? summary(selected) : null, evidence,
      examples: rev && authored(rev) ? JSON.parse(rev.source_bundle).parameters.agreement.examples : JSON.parse(examples),
      eligibility, approval: approval ? receipt(approval, false) : null, selection: selectionView(projectId) };
  }
  async function operation(ms, signal, action) {
    if (closed) throw conflict();
    const controller = new AbortController(), expires = now() + ms;
    let last = now();
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const lease = { signal: combined, now, remaining: () => expires - now(), check() {
      const time = now();
      if (closed || combined.aborted || !Number.isSafeInteger(time) || time < last || time >= expires) throw conflict();
      last = time;
    } };
    const timer = setTimeout(() => controller.abort(), ms);
    const entry = { controller, done: null };
    operations.add(entry);
    try {
      entry.done = Promise.resolve().then(() => { lease.check(); return action(lease); });
      return await entry.done;
    } finally { clearTimeout(timer); operations.delete(entry); }
  }
  function parameters(input) {
    fields(input, ['expectedDraftVersion', 'reviewerId', 'title', 'intent']);
    version(input.expectedDraftVersion);
    if (typeof input.reviewerId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(input.reviewerId)
        || typeof input.title !== 'string' || !input.title.isWellFormed() || !input.title.trim()
        || input.title.length > 120 || /\p{Cc}/u.test(input.title)
        || typeof input.intent !== 'string' || !input.intent.isWellFormed() || Buffer.byteLength(input.intent) > 4096 || /\p{Cc}/u.test(input.intent.replace(/[\n\r\t]/g, '')))
      throw new AppError(400, 'Choose one reviewer, a title of 1–120 characters and up to 4 KiB of recorded intent.');
    bounded(input, 16384, 'Proposal');
    return { kind: 'scripted-review/1', reviewerId: input.reviewerId, title: input.title.trim(), intent: input.intent };
  }
  async function choose(kind, actor, projectId, input, authorize, { signal } = {}) {
    access(actor, projectId, authorize);
    fields(input, ['operationId', 'expectedDraftVersion', 'revisionId', 'evidenceId', 'cases',
      ...(kind === 'activations' ? ['approvalId', 'expectedSelectionGeneration'] : [])]);
    operationId(input.operationId); version(input.expectedDraftVersion); id(input.revisionId); id(input.evidenceId);
    if (kind === 'activations') { id(input.approvalId); version(input.expectedSelectionGeneration); }
    const normalized = { kind, ...input, cases: normalizeTeamCases(input.cases, { authored: authored(revision(projectId, input.revisionId)) }) }, encoded = bounded(normalized, 40960, 'Action');
    return operation(2000, signal, lease => {
      const historical = () => {
        lease.check(); access(actor, projectId, authorize);
        const saved = savedOperation(actor, projectId, normalized.operationId);
        if (saved && saved.input !== encoded) throw new AppError(409, 'That operation ID belongs to different action details.');
        return saved;
      };
      const prior = historical();
      if (prior) return { receipt: receipt(prior), replayed: true, current: selectionView(projectId) };
      const check = () => {
        lease.check(); access(actor, projectId, authorize);
        const row = revision(projectId, normalized.revisionId);
        current(projectId, normalized.expectedDraftVersion, normalized.revisionId);
        const proof = db.prepare('SELECT * FROM team_evidence WHERE project_id=? AND revision_id=? AND id=?')
          .get(projectId, row.revision_id, normalized.evidenceId);
        if (!proof) throw notFound();
        if (latestEvidence(projectId, row.revision_id)?.id !== proof.id) throw conflict();
        qualify(projectId, row, proof, normalized.cases);
        if (kind === 'activations' && !db.prepare(`SELECT 1 FROM team_approvals
          WHERE project_id=? AND revision_id=? AND evidence_id=? AND id=?`)
          .get(projectId, row.revision_id, proof.id, normalized.approvalId)) throw notFound();
      };
      return transaction(db, () => {
        const duplicate = historical();
        if (duplicate) return { receipt: receipt(duplicate), replayed: true, current: selectionView(projectId) };
        check();
        const recordId = randomUUID(), at = new Date().toISOString();
        if (kind === 'approvals') {
          db.prepare(`INSERT INTO team_approvals(id,project_id,revision_id,evidence_id,actor_id,operation_id,input,created_at)
            VALUES (?,?,?,?,?,?,?,?)`).run(recordId, projectId, normalized.revisionId, normalized.evidenceId, actor, normalized.operationId, encoded, at);
        } else {
          if (db.prepare('UPDATE team_selections SET revision_id=? WHERE project_id=? AND generation=?')
            .run(normalized.revisionId, projectId, normalized.expectedSelectionGeneration).changes !== 1) throw conflict();
          check();
          const selected = selectionView(projectId);
          if (selected.generation !== normalized.expectedSelectionGeneration + 1 || selected.revisionId !== normalized.revisionId) throw conflict();
          db.prepare(`INSERT INTO team_activations(id,project_id,revision_id,approval_id,generation,actor_id,operation_id,input,created_at)
            VALUES (?,?,?,?,?,?,?,?,?)`).run(recordId, projectId, normalized.revisionId, normalized.approvalId,
            selected.generation, actor, normalized.operationId, encoded, at);
        }
        check();
        const saved = historical();
        if (!saved || saved.id !== recordId) throw conflict();
        if (kind === 'activations' && selectionView(projectId).activation?.id !== recordId) throw conflict();
        lease.check();
        return { receipt: receipt(saved), replayed: false, current: selectionView(projectId) };
      });
    });
  }
  async function control(kind, actor, projectId, input, authorize, { signal } = {}) {
    access(actor, projectId, authorize);
    fields(input, ['operationId', 'targetRevisionId', 'expectedSelectionRevisionId', 'expectedSelectionGeneration']);
    operationId(input.operationId); id(input.targetRevisionId);
    if (input.expectedSelectionRevisionId !== null) id(input.expectedSelectionRevisionId);
    if (!Number.isSafeInteger(input.expectedSelectionGeneration) || input.expectedSelectionGeneration < 0) throw conflict();
    const normalized = { kind, ...input }, encoded = bounded(normalized, 2048, 'Control');
    input = normalized;
    return operation(2000, signal, lease => transaction(db, () => {
      const authority = () => { lease.check(); access(actor, projectId, authorize); };
      authority();
      const prior = savedOperation(actor, projectId, input.operationId);
      if (prior && prior.input !== encoded) throw new AppError(409, 'That operation ID belongs to different action details.');
      if (prior) return { receipt: receipt(prior), replayed: true, current: selectionView(projectId),
        target: controlTarget(projectId, input.targetRevisionId) };
      const before = selectionView(projectId), target = controlTarget(projectId, input.targetRevisionId);
      if (!before.available || before.revisionId !== input.expectedSelectionRevisionId
          || before.generation !== input.expectedSelectionGeneration
          || kind === 'deactivations' && before.revisionId !== target.revisionId
          || kind === 'revocations' && target.revokedAt !== null) throw conflict();
      authority();
      const revokedAt = kind === 'revocations' ? Date.now() : target.revokedAt;
      if (kind === 'revocations' && db.prepare(`UPDATE team_revisions SET revoked_at=?
        WHERE project_id=? AND revision_id=? AND revoked_at IS NULL`).run(revokedAt, projectId, target.revisionId).changes !== 1) throw conflict();
      authority();
      const clears = before.revisionId === target.revisionId;
      if (clears && db.prepare(`UPDATE team_selections SET revision_id=NULL
        WHERE project_id=? AND revision_id=? AND generation=?`).run(projectId, target.revisionId, before.generation).changes !== 1) throw conflict();
      const after = clears ? { available: true, generation: before.generation + 1, revisionId: null, activation: null } : before;
      const resultingTarget = { revisionId: target.revisionId, revokedAt };
      const check = () => {
        authority();
        if (json(selectionView(projectId)) !== json(after) || json(controlTarget(projectId, target.revisionId)) !== json(resultingTarget)) throw conflict();
        authority();
      };
      check();
      const recordId = randomUUID(), result = bounded({ before, after, target: resultingTarget }, 8192, 'Control result');
      db.prepare(`INSERT INTO team_controls(id,kind,project_id,revision_id,actor_id,operation_id,input,result,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(recordId, kind, projectId, target.revisionId, actor, input.operationId, encoded, result, new Date().toISOString());
      check();
      const saved = savedOperation(actor, projectId, input.operationId);
      if (saved?.id !== recordId || saved.input !== encoded || saved.result !== result) throw conflict();
      authority();
      return { receipt: receipt(saved), replayed: false, current: after, target: resultingTarget };
    }));
  }
  async function compileSources(actor, projectId, params, sources, expected, authorize, { signal } = {}) {
    for (const text of Object.values(sources)) if (text !== null && Buffer.byteLength(text) > 65536) throw new AppError(413, 'Team source exceeds 64 KiB.');
    return operation(25000, signal, async lease => {
      const check = () => { lease.check(); access(actor, projectId, authorize); reviewer(projectId, params); current(projectId, expected, undefined, true); };
      check();
      const compiled = {};
      const compilerPins = load('compiler-provenance.json'), runtimePins = load('provenance.json');
      for (const hook of hooks) {
        if (sources[hook] === null) { compiled[hook] = null; continue; }
        const result = await compiler.compile(Buffer.from(sources[hook]), { signal: lease.signal });
        check();
        if (!(result.artifact instanceof Uint8Array) || !result.artifact.length || result.artifact.length > 1048576
            || !Array.isArray(result.diagnostics) || result.diagnostics.length) throw new AppError(422, 'Every present Team program must compile.');
        const artifact = JSON.parse(Buffer.from(result.artifact).toString('utf8'));
        if (artifact.compiler !== compilerPins.compiler || artifact.sourceDigest !== digest(sources[hook])
            || artifact.modelRef?.digest !== digest(json(teamModel)) || json(artifact.environment) !== json(compilerPins.environment)
            || runtimePins.version !== '0.5.0' || runtimePins.package !== '@keir/runtime-node') throw new AppError(503, 'The Team compiler identity does not match.');
        compiled[hook] = result.artifact;
      }
      const bundle = validateTeamBundle(compiled);
      const sourceBundle = { parameters: params, sources, compiler: compilerPins, runtime: {
        package: runtimePins.package, version: runtimePins.version, sha256: runtimePins.sha256, integrity: runtimePins.integrity },
        hooks: Object.fromEntries(hooks.map(hook => [hook, compiled[hook] === null
          ? { present: false, rawSourceDigest: null, sourceDigest: null, artifactDigest: null, modelRef: null }
          : { present: true, rawSourceDigest: digest(sources[hook]),
            sourceDigest: JSON.parse(Buffer.from(compiled[hook]).toString('utf8')).sourceDigest,
            artifactDigest: digest(compiled[hook]), modelRef: JSON.parse(Buffer.from(compiled[hook]).toString('utf8')).modelRef }])) };
      const sourceText = bounded(sourceBundle, 262144, 'Source bundle');
      const executableIdentity = digest(json({ projectId, modelDigest: bundle.manifest.modelDigest,
        grants: bundle.manifest.grants, sourceBundle }));
      const manifest = { ...bundle.manifest, executableIdentity };
      const manifestText = bounded(manifest, 32768, 'Manifest'), artifactText = bounded(bundle.artifacts, 2097152, 'Artifacts');
      const revisionId = randomUUID();
      transaction(db, () => {
        check();
        db.prepare('INSERT INTO team_revisions(project_id,revision_id,manifest,artifacts,source_bundle) VALUES (?,?,?,?,?)')
          .run(projectId, revisionId, manifestText, artifactText, sourceText);
        check();
        if (db.prepare('UPDATE team_drafts SET revision_id=?,draft_version=draft_version+1 WHERE project_id=? AND draft_version=?')
          .run(revisionId, projectId, expected).changes !== 1) throw conflict();
        lease.check(); access(actor, projectId, authorize); reviewer(projectId, params); current(projectId, expected + 1, revisionId);
      });
      lease.check(); return state(actor, projectId, authorize);
    });
  }
  return {
    state,
    async proposeAuthored(actor, projectId, input, authorize, context) {
      access(actor, projectId, authorize);
      fields(input, ['expectedDraftVersion', 'bindings', 'agreement']);
      version(input.expectedDraftVersion); fields(input.bindings, TEAM_BINDINGS);
      const agreement = normalizeTeamAgreement(input.agreement), sources = {};
      for (const hook of hooks) {
        const value = input.bindings[hook], required = agreement.claims.some(c => c.hook === hook);
        if (value === null) { if (required) throw new AppError(400, 'An agreed required binding cannot be absent.'); sources[hook] = null; }
        else {
          if (!required || typeof value !== 'string' || !value.isWellFormed() || Buffer.byteLength(value) > 65536) throw new AppError(400, 'Each present binding needs bounded JSON source and its own agreed claim.');
          try { sources[hook] = json(JSON.parse(value)); } catch { throw new AppError(400, 'Team authored bindings use JSON source.'); }
        }
      }
      return compileSources(actor, projectId, { kind: 'authored-team/1', qualificationPolicy: TEAM_QUALIFICATION, agreement }, sources, input.expectedDraftVersion, authorize, context);
    },
    approve(actor, projectId, input, authorize, context) { return choose('approvals', actor, projectId, input, authorize, context); },
    activate(actor, projectId, input, authorize, context) { return choose('activations', actor, projectId, input, authorize, context); },
    deactivate(actor, projectId, input, authorize, context) { return control('deactivations', actor, projectId, input, authorize, context); },
    revoke(actor, projectId, input, authorize, context) { return control('revocations', actor, projectId, input, authorize, context); },
    revisions(actor, projectId, query, authorize) {
      access(actor, projectId, authorize);
      if (!query || Object.keys(query).some(key => key !== 'after')) throw new AppError(400, 'Use only the revision cursor.');
      const after = Object.hasOwn(query, 'after') ? id(query.after) : '';
      const rows = db.prepare(`SELECT r.revision_id AS revisionId,r.revoked_at AS revokedAt,
         substr(coalesce(json_extract(r.source_bundle,'$.parameters.agreement.summary'),
           json_extract(r.source_bundle,'$.parameters.title')),1,160) AS behavior,
        r.revision_id IS s.revision_id AS current,r.revision_id IS d.revision_id AS draft,
        (SELECT count(*) FROM team_admissions a JOIN tasks t ON t.id=a.source_task_id
          WHERE a.project_id=r.project_id AND a.revision_id=r.revision_id AND t.status='open') AS openRoots,
        (SELECT count(*) FROM team_admissions a WHERE a.project_id=r.project_id AND a.revision_id=r.revision_id
          AND a.state IN ('PENDING','STARTED')) AS pendingEffects
        FROM team_revisions r LEFT JOIN team_selections s ON s.project_id=r.project_id
        LEFT JOIN team_drafts d ON d.project_id=r.project_id
        WHERE r.project_id=? AND r.revision_id>? ORDER BY r.revision_id LIMIT 21`).all(projectId, after);
      const items = rows.slice(0, 20).map(r => ({ ...r, current: !!r.current, draft: !!r.draft, revoked: r.revokedAt !== null }));
      const current = selectionView(projectId);
      access(actor, projectId, authorize);
      return { items, next: rows.length > 20 ? items.at(-1).revisionId : null, selection: current };
    },
    readOperation(actor, projectId, op, authorize) {
      access(actor, projectId, authorize);
      const saved = savedOperation(actor, projectId, operationId(op));
      const current = selectionView(projectId);
      access(actor, projectId, authorize);
      return { receipt: saved ? receipt(saved) : null, current,
        ...(saved && ['deactivations', 'revocations'].includes(saved.kind) ? { target: controlTarget(projectId, saved.revision_id) } : {}) };
    },
    source(actor, projectId, revisionId, authorize) {
      access(actor, projectId, authorize);
      const row = revision(projectId, revisionId);
      const value = { ...summary(row), sourceBundle: JSON.parse(row.source_bundle), artifacts: JSON.parse(row.artifacts) };
      bounded(value, 2400000, 'Source response'); access(actor, projectId, authorize);
      return value;
    },
    evidence(actor, projectId, evidenceId, authorize) {
      access(actor, projectId, authorize);
      const row = db.prepare('SELECT * FROM team_evidence WHERE project_id=? AND id=?').get(projectId, id(evidenceId));
      if (!row) throw notFound();
      const value = { id: row.id, revisionId: row.revision_id, executableIdentity: row.executable_identity,
        caseDigest: row.case_digest, harness: row.harness, cases: JSON.parse(row.cases), report: JSON.parse(row.report), passed: Boolean(row.passed) };
      bounded(value, 300000, 'Evidence response'); access(actor, projectId, authorize);
      return value;
    },
    async propose(actor, projectId, input, authorize, { signal } = {}) {
      access(actor, projectId, authorize);
      const params = parameters(input), expected = input.expectedDraftVersion;
      const programs = JSON.parse(template), domain = { ...teamModel.domain, fingerprint: digest(json(teamModel)) };
      programs[0].steps[1].args.assigneeId.literal = params.reviewerId;
      programs[0].steps[1].args.title.literal = params.title;
      const sources = Object.fromEntries(programs.map(p => [p.entrypoint, json({ language: 'keir/3', domain, ...p })]));
      return compileSources(actor, projectId, params, sources, expected, authorize, { signal });
    },
    async simulate(actor, projectId, input, authorize, { signal } = {}) {
      access(actor, projectId, authorize);
      fields(input, ['expectedDraftVersion', 'revisionId', 'cases']);
      version(input.expectedDraftVersion); id(input.revisionId);
      const isAuthored = authored(revision(projectId, input.revisionId));
      const cases = normalizeTeamCases(input.cases, { authored: isAuthored }), expected = input.expectedDraftVersion, revisionId = input.revisionId;
      bounded({ expectedDraftVersion: expected, revisionId, cases }, 32768, 'Simulation');
      current(projectId, expected, revisionId);
      const row = revision(projectId, revisionId), manifest = JSON.parse(row.manifest), source = JSON.parse(row.source_bundle);
      reviewer(projectId, source.parameters);
      if (simulations.has(projectId) || simulationCount >= 2) throw new AppError(409, 'A Team simulation is already running. Read saved state before trying again.');
      if (closed || signal?.aborted) throw conflict();
      simulations.add(projectId); simulationCount++;
      try {
        return await operation(15000, signal, async lease => {
          const check = () => {
            lease.check(); access(actor, projectId, authorize); reviewer(projectId, source.parameters); current(projectId, expected, revisionId);
            if (revision(projectId, revisionId).revoked_at !== null) throw conflict();
          };
          check();
          if (isAuthored) executable(projectId, row);
          const report = await simulate({ projectId, revisionId, manifest, artifacts: JSON.parse(row.artifacts), parameters: source.parameters, cases },
            { ...lease, check });
          check();
          if (isAuthored) executable(projectId, revision(projectId, revisionId));
          if (!report || report.harness !== TEAM_HARNESS || typeof report.passed !== 'boolean'
              || report.cases?.length !== cases.length || report.passed !== report.cases.every(c => c.passed === true)) throw conflict();
          if (isAuthored) report.qualification = qualifyAuthoredTeam({ agreement: source.parameters.agreement, cases, report, manifest,
            artifacts: JSON.parse(row.artifacts), projectId });
          const reportText = bounded(report, 262144, 'Simulation report'), casesText = bounded(cases, 32768, 'Cases');
          const evidenceId = randomUUID(), caseDigest = digest(casesText);
          transaction(db, () => {
            check();
            db.prepare(`INSERT INTO team_evidence(id,project_id,revision_id,executable_identity,case_digest,harness,cases,report,passed,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`).run(evidenceId, projectId, revisionId, manifest.executableIdentity,
              caseDigest, TEAM_HARNESS, casesText, reportText, Number(report.passed), new Date().toISOString());
            check();
          });
          lease.check();
          return { ...state(actor, projectId, authorize), evidenceId };
        });
      } finally { simulations.delete(projectId); simulationCount--; }
    },
    async close() {
      closed = true;
      const pending = [...operations];
      for (const op of pending) op.controller.abort();
      await Promise.allSettled(pending.map(op => op.done));
    },
  };
}
