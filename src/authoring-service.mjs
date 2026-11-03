import { randomUUID } from 'node:crypto';
import { AppError, transaction } from './data.mjs';
import { loadHost, digest, json } from './extension-catalog.mjs';
import { readAuthoringConfig } from './authoring-config.mjs';
import { AuthoringError, createAuthoringProvider } from './authoring-provider.mjs';
import { createAuthoringState, runAuthoringTurn } from './authoring-agent.mjs';
import { authoringExample, businessContext, evidenceSummary } from './authoring-example.mjs';

export const AUTHORING_CODES = Object.freeze(['AI_NOT_CONFIGURED', 'AI_CONFIG_INVALID', 'AI_CREDENTIALS_MISSING', 'HOST_UNAVAILABLE',
  'SPEND_LIMIT', 'BUDGET_EXHAUSTED', 'CONVERSATION_LIMIT', 'CONFIG_CHANGED', 'BYTE_LIMIT', 'TOKEN_LIMIT', 'TIME_LIMIT', 'EXPIRED',
  'RUN_INTERRUPTED', 'CANCELLED', 'STALE_CONTEXT', 'STALE_DRAFT', 'STALE_CONVERSATION', 'AI_BUSY', 'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE', 'CREDENTIALS_INVALID', 'PROVIDER_RATE_LIMIT', 'PROVIDER_REDIRECT', 'PROVIDER_RESPONSE_INVALID',
  'HOST_RESULT_INVALID', 'INVALID_TOOL_ARGUMENTS', 'REVIEW_NOT_READY', 'CHECKPOINT_UNCERTAIN', 'TOOL_FAILED', 'AI_CONFIG_SAVE_FAILED']);
const codeFor = value => AUTHORING_CODES.includes(value) ? value : 'TOOL_FAILED';
const safeMessage = code => ({
  AI_NOT_CONFIGURED: 'AI authoring is not configured. Configure the assistant to create advice. Saved advice still works.',
  AI_CONFIG_INVALID: 'The operator AI configuration needs attention.', AI_CREDENTIALS_MISSING: 'The operator AI credentials are unavailable.',
  SPEND_LIMIT: 'The operator AI allowance has been reached.', AI_BUSY: 'Another authoring request is still settling. Check its saved state.',
  PROVIDER_RATE_LIMIT: 'The AI service refused this request because of a request or account limit. Any saved proposal and examples are kept. Check the provider usage and limits before retrying manually.',
  STALE_DRAFT: 'The draft changed. Read saved state before continuing.', STALE_CONVERSATION: 'The conversation changed. Read saved state before continuing.',
  RUN_INTERRUPTED: 'The previous run was interrupted. Check the current draft before explicitly continuing.',
  CANCELLED: 'Authoring stopped. Check saved state; a draft may already have been saved.',
  CONVERSATION_LIMIT: 'The owner conversation limit has been reached.', CONFIG_CHANGED: 'The AI configuration changed. Start a fresh conversation.',
  BUDGET_EXHAUSTED: 'This authoring run reached its resource limit.', REVIEW_NOT_READY: 'Run the current independent examples before offering review.',
}[code] ?? 'Authoring could not finish safely. Check saved state before continuing.');
const error = (status, code) => { const value = new AppError(status, safeMessage(code)); value.code = codeFor(code); return value; };
const stop = code => { throw new AuthoringError(code); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const token = value => typeof value === 'string' && value === value.trim() && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const encode = value => JSON.stringify(value);
const length = value => Buffer.byteLength(encode(value));
const draftHandles = value => ({ revisionId: value.revisionId, draftVersion: value.draftVersion, suiteDigest: value.suiteDigest });
const same = (a, b) => a?.revisionId === b?.revisionId && a?.draftVersion === b?.draftVersion && a?.suiteDigest === b?.suiteDigest;
const operation = (id, runId, version) => ({ id, runId, version });
const statuses = new Set(['IDLE', 'RUNNING', 'CANCELLING', 'AWAITING_USER', 'REVIEW_AVAILABLE', 'CANCELLED', 'BLOCKED', 'INTERRUPTED']);
const resourcePolicy = 'bounded-ai-authoring/2';

// One app/data owner. The database journals work; the map contains only live cancellation/settlement handles.
export function createAuthoringService({ db, lifecycle, config = readAuthoringConfig(), fetchImpl, limits,
  checkpointFault = () => {}, providerFactory = value => createAuthoringProvider(value, { fetchImpl }) }) {
  const live = new Map(); let closing = false; let definition;
  try { definition = loadHost(); } catch { /* AI setup failure never disables native tasks or saved advice. */ }
  const rowFor = (owner, id) => db.prepare('SELECT * FROM authoring_conversations WHERE id=? AND owner_id=?').get(id, owner);
  const linkFor = (owner, id) => db.prepare('SELECT * FROM extension_conversation_links WHERE owner_id=? AND conversation_id=?').get(owner, id);
  const held = () => {
    const value = db.prepare('SELECT reserved_micros FROM authoring_budget WHERE id=1').get()?.reserved_micros;
    if (!integer(value)) stop('CHECKPOINT_UNCERTAIN'); return value;
  };
  const decode = row => {
    try { return { state: JSON.parse(row.state), operations: JSON.parse(row.operations), view: JSON.parse(row.view) }; }
    catch { throw error(503, 'HOST_RESULT_INVALID'); }
  };
  const availability = () => ({ available: config.status === 'ready' && !!definition && !closing,
    code: closing ? 'HOST_UNAVAILABLE' : config.status !== 'ready' ? config.code : !definition ? 'HOST_UNAVAILABLE' : null,
    provider: config.status === 'ready' ? config.provider : null, model: config.status === 'ready' ? config.model : null });

  // Recovery is readback only. No provider, compiler or simulation is called at startup.
  transaction(db, () => {
    for (const row of db.prepare("SELECT * FROM authoring_conversations WHERE status IN ('RUNNING','CANCELLING')").all()) {
      const value = decode(row); value.state.status = 'BLOCKED'; value.state.lastResult = { status: 'BLOCKED', code: 'RUN_INTERRUPTED' };
      value.state.continuation = undefined; value.state.pending = undefined; value.state.evidenceHandle = null;
      value.view.code = 'RUN_INTERRUPTED'; value.view.review = null;
      for (const item of value.state.journal ?? []) if (!item.outcome) item.outcome = 'UNKNOWN';
      db.prepare("UPDATE authoring_conversations SET status='INTERRUPTED',cancel_requested=1,state=?,view=? WHERE id=? AND run_id=?")
        .run(encode(value.state), encode(value.view), row.id, row.run_id);
    }
  });

  function dto(row, bounded = true) {
    const { state, operations, view } = decode(row), link = row.extension_id ? { extension_id: row.extension_id, purpose: row.purpose } : linkFor(row.owner_id, row.id);
    const current = link ? lifecycle.state(row.owner_id, link.extension_id) : lifecycle.collection(row.owner_id);
    let review = view.review ?? null;
    if (review) review = { revisionId: review.revisionId, draftVersion: review.draftVersion, suiteDigest: review.suiteDigest,
      evidenceId: review.evidenceId, eligible: !!link && review.eligible === true && same(review, draftHandles(current)) };
    const result = { id: row.id, version: row.version, status: row.status, runId: row.run_id,
      operation: operation(operations.at(-1).id, operations.at(-1).runId, operations.at(-1).version), messages: view.messages,
      extensionId: link?.extension_id ?? null, purpose: link?.purpose ?? null,
      code: view.code ? codeFor(view.code) : null, review, draft: state.handles ?? { revisionId: null, draftVersion: 0, suiteDigest: null },
      selection: { revisionId: current.selection.revision?.id ?? null, generation: current.selection.generation } };
    if (bounded && length(result) > 131072) throw error(413, 'BYTE_LIMIT'); return result;
  }
  function read(owner, id) { const row = rowFor(owner, id); if (!row) throw error(404, 'STALE_CONVERSATION'); return dto(row); }
  function list(owner, extensionId) {
    if (extensionId !== undefined) lifecycle.state(owner, extensionId);
    const rows = extensionId === undefined
      ? db.prepare('SELECT * FROM authoring_conversations WHERE owner_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 8').all(owner)
      : db.prepare('SELECT c.* FROM authoring_conversations c JOIN extension_conversation_links l ON l.conversation_id=c.id AND l.owner_id=c.owner_id WHERE c.owner_id=? AND l.extension_id=? ORDER BY c.updated_at DESC,c.rowid DESC LIMIT 8').all(owner, extensionId);
    return { availability: availability(), conversations: rows.map(row => ({ id: row.id, version: row.version, status: row.status,
      extensionId: linkFor(owner, row.id)?.extension_id ?? null, purpose: linkFor(owner, row.id)?.purpose ?? null,
      runId: row.run_id, creationOperationId: row.creation_operation_id, operationId: decode(row).operations.at(-1).id })),
    current: extensionId !== undefined && rows.length ? dto(rows[0]) : null };
  }
  function assertLease(lease) { if (!lease || !token(lease.sessionId) || lease.current() !== true) stop('STALE_CONTEXT'); }
  function validate(input) {
    if (!object(input) || Object.keys(input).length !== 6 || !['conversationId', 'operationId', 'text', 'expectedVersion', 'expectedDraftVersion', 'target'].every(key => Object.hasOwn(input, key))
        || !(input.conversationId === null || token(input.conversationId)) || !token(input.operationId)
        || typeof input.text !== 'string' || !input.text.isWellFormed() || !input.text.trim() || Buffer.byteLength(input.text) > 8192
        || !integer(input.expectedVersion) || !integer(input.expectedDraftVersion)) throw error(400, 'INVALID_TOOL_ARGUMENTS');
    const target = input.target;
    if (!object(target) || !['create', 'revise', 'resume'].includes(target.kind)) throw error(400, 'INVALID_TOOL_ARGUMENTS');
    const fields = target.kind === 'create' ? ['kind'] : target.kind === 'resume' ? ['kind', 'extensionId'] : ['kind', 'extensionId', 'baseRevisionId', 'selectionGeneration'];
    if (Object.keys(target).length !== fields.length || !fields.every(key => Object.hasOwn(target, key))
        || target.kind !== 'create' && !token(target.extensionId)
        || target.kind === 'revise' && (!(target.baseRevisionId === null || token(target.baseRevisionId)) || !integer(target.selectionGeneration))
        || (target.kind === 'resume') !== (input.conversationId !== null)) throw error(400, 'INVALID_TOOL_ARGUMENTS');
  }
  function tracked(ctx, work) {
    const promise = Promise.resolve().then(work); ctx.tracked.add(promise);
    void promise.then(() => ctx.tracked.delete(promise), () => ctx.tracked.delete(promise)); return promise;
  }
  function publicView(value, state, ctx) {
    const view = structuredClone(value);
    if (state.checkpoint.phase === 'ADMIT') {
      view.messages.push({ id: ctx.input.operationId, role: 'user', text: ctx.input.text, kind: 'text' }); view.code = null; view.review = null;
    }
    if (state.checkpoint.phase === 'TERMINAL') {
      const result = state.lastResult; const id = ctx.runId + '-assistant';
      if (result && !view.messages.some(message => message.id === id)) view.messages.push({ id, role: 'assistant',
        text: result.message ?? safeMessage(codeFor(result.code)), kind: result.status === 'AWAITING_USER' ? 'clarification' : result.review ? 'review' : 'text' });
      view.code = result?.code ? codeFor(result.code) : null;
      view.review = result?.review ? { revisionId: result.review.revisionId, draftVersion: result.review.draftVersion,
        suiteDigest: result.review.suiteDigest, evidenceId: result.review.evidenceId, eligible: result.review.eligible === true } : null;
    }
    return view;
  }

  function checkpoint(ctx, state) {
    assertLease(ctx.lease);
    if (ctx.controller.signal.aborted || closing || state.ownerId !== ctx.owner || state.runId !== ctx.runId || state.conversationId !== ctx.id) stop('STALE_CONTEXT');
    const cp = state.checkpoint; if (!['ADMIT', 'DISPATCH', 'RESULT', 'TERMINAL'].includes(cp?.phase)) stop('HOST_RESULT_INVALID');
    const before = rowFor(ctx.owner, ctx.id), beforeHeld = held(); let committed = false;
    try {
      transaction(db, () => {
        assertLease(ctx.lease);
        const row = rowFor(ctx.owner, ctx.id), prior = row ? decode(row) : null;
        if (cp.phase === 'ADMIT') {
          if (ctx.admitted || row && (row.version !== ctx.input.expectedVersion || ['RUNNING', 'CANCELLING'].includes(row.status))
              || !row && ctx.input.expectedVersion !== 0 || state.version !== ctx.input.expectedVersion + 1) stop('STALE_CONVERSATION');
          if (!row && db.prepare('SELECT COUNT(*) AS n FROM authoring_conversations WHERE owner_id=?').get(ctx.owner).n >= 8) stop('CONVERSATION_LIMIT');
          if (ctx.input.target.kind === 'create') lifecycle.admit(ctx.owner,
            { extensionId: ctx.extensionId, operationId: ctx.input.operationId, hash: ctx.hash, name: Array.from(ctx.input.text.trim()).slice(0, 80).join('') }, () => assertLease(ctx.lease));
          const current = lifecycle.state(ctx.owner, ctx.extensionId); if (current.draftVersion !== ctx.input.expectedDraftVersion) stop('STALE_DRAFT');
          state.runLedger = { base: prior?.state.usage.reservedMicros ?? 0, reserved: 0, ordinal: 0 };
          state.journal = prior?.state.journal ?? [];
        } else if (!row || row.run_id !== ctx.runId || row.version !== state.version || row.cancel_requested || row.status !== 'RUNNING') stop('STALE_CONTEXT');
        const previous = cp.phase === 'ADMIT' ? prior?.state ?? state : prior.state;
        for (const group of ['counts', 'usage']) for (const [key, n] of Object.entries(state[group])) {
          if (!integer(n) || n < previous[group][key]) stop('HOST_RESULT_INVALID');
        }
        if (!integer(state.activeMs) || state.activeMs < (previous.activeMs ?? 0)) stop('HOST_RESULT_INVALID');
        const ledger = cp.phase === 'ADMIT' ? state.runLedger : prior.state.runLedger;
        if (!ledger || !integer(ledger.base) || !integer(ledger.reserved) || !integer(ledger.ordinal)
            || state.usage.reservedMicros < ledger.base + ledger.reserved) stop('HOST_RESULT_INVALID');
        const additional = state.usage.reservedMicros - ledger.base;
        const delta = additional - ledger.reserved;
        if (!integer(delta) || cp.phase !== 'DISPATCH' && delta !== 0 || cp.phase === 'DISPATCH' && cp.kind !== 'provider' && delta !== 0) stop('HOST_RESULT_INVALID');
        if (cp.phase === 'DISPATCH' && (cp.ordinal !== ledger.ordinal + 1 || !['provider', 'tool'].includes(cp.kind)
            || cp.kind === 'tool' && !token(cp.callId) || cp.kind === 'provider' && delta !== config.reserveMicros)) stop('HOST_RESULT_INVALID');
        if (cp.phase === 'RESULT' && (!prior.state.inFlight || cp.ordinal !== prior.state.inFlight.ordinal
            || cp.kind !== prior.state.inFlight.kind || cp.callId !== prior.state.inFlight.callId)) stop('HOST_RESULT_INVALID');
        const nextHeld = held() + delta;
        if (!integer(nextHeld) || nextHeld > config.maxMicros) stop('SPEND_LIMIT');
        const journal = structuredClone(cp.phase === 'ADMIT' ? state.journal : prior.state.journal);
        if (cp.phase === 'DISPATCH') journal.push({ runId: ctx.runId, ordinal: cp.ordinal, kind: cp.kind, ...(cp.callId && { callId: cp.callId }), reservedMicros: delta });
        if (cp.phase === 'RESULT') {
          const item = journal.find(entry => entry.runId === ctx.runId && entry.ordinal === cp.ordinal);
          if (!item || item.outcome || !['SUCCESS', 'REJECTED', 'UNKNOWN'].includes(cp.outcome)) stop('HOST_RESULT_INVALID'); item.outcome = cp.outcome;
        }
        if (journal.length > 16) stop('BUDGET_EXHAUSTED');
        const saved = { ...state, journal, transport: { provider: config.provider, model: config.model, policy: resourcePolicy,
          settingsRevision: config.settingsRevision ?? null },
          runLedger: { base: ledger.base, reserved: additional, ordinal: cp.phase === 'DISPATCH' ? cp.ordinal : ledger.ordinal } };
        const ops = prior?.operations ?? [];
        if (cp.phase === 'ADMIT') {
          if (ops.length >= 8 || ops.some(item => item.id === ctx.input.operationId)) stop('BUDGET_EXHAUSTED');
          ops.push({ id: ctx.input.operationId, hash: ctx.hash, runId: ctx.runId, version: state.version });
        }
        const view = publicView(prior?.view ?? { messages: [], code: null, review: null }, state, ctx);
        if (length(saved) + length(ops) + length(view) > 262144 || length(view) > 131072 || length(ops) > 16384) stop('BYTE_LIMIT');
        const status = cp.phase === 'TERMINAL' ? state.status : 'RUNNING';
        if (!statuses.has(status)) stop('HOST_RESULT_INVALID');
        // Leave room for late authoritative handles and a safe blocker without dropping intent.
        const projection = { id: ctx.id, owner_id: ctx.owner, extension_id: ctx.extensionId, purpose: ctx.purpose, version: state.version, run_id: ctx.runId, status,
          state: encode(saved), operations: encode(ops), view: encode(view) };
        if (length(dto(projection, false)) > 131072 - 1024) stop('BYTE_LIMIT');
        checkpointFault({ stage: 'beforeCommit', phase: cp.phase, runId: ctx.runId, ordinal: cp.ordinal });
        db.prepare('UPDATE authoring_budget SET reserved_micros=? WHERE id=1').run(nextHeld);
        if (!row) db.prepare('INSERT INTO authoring_conversations VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(ctx.id, ctx.owner, ctx.input.operationId,
          state.version, ctx.runId, status, 0, Date.now(), encode(saved), encode(ops), encode(view));
        else db.prepare('UPDATE authoring_conversations SET version=?,run_id=?,status=?,cancel_requested=0,updated_at=?,state=?,operations=?,view=? WHERE id=? AND owner_id=?')
          .run(state.version, ctx.runId, status, Date.now(), encode(saved), encode(ops), encode(view), ctx.id, ctx.owner);
        if (!row) db.prepare('INSERT INTO extension_conversation_links VALUES (?,?,?,?,?,?)').run(ctx.id, ctx.owner, ctx.extensionId, ctx.purpose, ctx.baseRevisionId, ctx.baseGeneration);
      });
      committed = true; ctx.admitted = true; ctx.state = state;
      ctx.context.budget.remainingMicros = Math.max(0, config.maxMicros - held());
      checkpointFault({ stage: 'afterCommit', phase: cp.phase, runId: ctx.runId, ordinal: cp.ordinal });
    } catch (cause) {
      const failure = cause instanceof AuthoringError ? cause : new AuthoringError('CHECKPOINT_UNCERTAIN');
      if (!committed) {
        try { if (held() === beforeHeld && encode(rowFor(ctx.owner, ctx.id)) === encode(before)) failure.checkpointRolledBack = true; } catch { /* Unknown commit never restores credit. */ }
      }
      throw failure;
    }
  }

  function bindings(ctx) {
    const authorize = () => { if (!ctx.context.current()) stop('STALE_CONTEXT'); };
    const mapped = () => draftHandles(lifecycle.state(ctx.owner, ctx.extensionId));
    const invoke = (work, scenario = false) => tracked(ctx, async () => {
      authorize(); try { return await work(); }
      catch (cause) {
        if (cause instanceof AuthoringError) throw cause;
        if (scenario && cause instanceof AppError && cause.status === 400 && Array.isArray(cause.diagnostics)
            && cause.diagnostics.length === 1 && cause.diagnostics.every(item => object(item) && Object.keys(item).length === 2
              && ['INVALID_SCENARIO', 'DUPLICATE_SCENARIO_ID'].includes(item.code) && typeof item.path === 'string' && /^\/cases\/[0-7]$/.test(item.path)))
          return { diagnostics: cause.diagnostics.map(({ code, path }) => ({ code, path })) };
        if (!scenario && cause?.status === 422 && Array.isArray(cause.diagnostics)) return { diagnostics: cause.diagnostics };
        stop(cause?.status === 409 ? 'STALE_DRAFT' : cause?.status === 429 ? 'AI_BUSY' : cause?.status === 499 ? 'CANCELLED' : 'TOOL_FAILED');
      }
    });
    const proofFor = handle => {
      authorize();
      if (!handle) stop('REVIEW_NOT_READY');
      const current = mapped(), proof = lifecycle.evidence(ctx.owner, handle.evidenceId, ctx.extensionId);
      if (!same(current, handle) || proof.revisionId !== handle.revisionId || proof.identity?.suiteDigest !== handle.simulationSuiteIdentity) stop('STALE_DRAFT');
      return { ...current, evidenceId: proof.id, simulationSuiteIdentity: proof.identity.suiteDigest, eligible: proof.passed,
        summary: evidenceSummary(proof, lifecycle.source(ctx.owner, proof.revisionId, ctx.extensionId).cases) };
    };
    return {
      readDraft: () => { authorize(); return mapped(); },
      discover: () => {
        authorize(); const example = authoringExample(), current = lifecycle.state(ctx.owner, ctx.extensionId);
        const baseId = current.draft?.id ?? ctx.baseRevisionId;
        const currentProposal = baseId ? { ...lifecycle.source(ctx.owner, baseId, ctx.extensionId), truncated: false } : null;
        if (currentProposal && length(currentProposal) > 65536) { currentProposal.cases = null; currentProposal.truncated = true; }
        if (currentProposal && length(currentProposal) > 65536) { currentProposal.source = null; currentProposal.truncated = true; }
        const messages = decode(rowFor(ctx.owner, ctx.id)).view.messages;
        let truncated = messages.length > 8;
        const recent = messages.slice(-8).map(({ role, text }) => {
          const points = Array.from(text); if (points.length > 1024) truncated = true;
          return { role, text: points.slice(0, 1024).join('') };
        });
        // Keep combined discovery inside the existing tool byte ceiling, including escaped text.
        while (length(recent) > 16384) { recent.shift(); truncated = true; }
        return { dcm: JSON.parse(Buffer.from(definition.dcmBytes).toString('utf8')), ...definition.pins,
          currentDraft: mapped(), currentProposal, extension: current.extension, purpose: ctx.purpose,
          supportedHooks: lifecycle.hostCatalog().hooks, conversationContext: { messages: recent, truncated },
          businessContext, sourceExample: example.source, scenarioExample: example.cases[0], scenarioExamples: example.cases };
      },
      compile: (source, version, signal) => invoke(async () => {
        const value = await lifecycle.compile(ctx.owner, { extensionId: ctx.extensionId, source: source.toString('utf8'), draftVersion: version }, authorize, { signal }); return draftHandles(value);
      }),
      proposeScenarios: (revisionId, cases, version) => invoke(async () => draftHandles(await lifecycle.proposeScenarios(ctx.owner,
        { extensionId: ctx.extensionId, revisionId, cases, draftVersion: version }, authorize, { signal: ctx.controller.signal })), true),
      simulate: (revisionId, version, signal) => invoke(async () => {
        const value = await lifecycle.simulate(ctx.owner, { extensionId: ctx.extensionId, revisionId, draftVersion: version }, authorize, { signal });
        if (value.revisionId !== revisionId || value.draftVersion !== version || !value.evidence?.id) stop('HOST_RESULT_INVALID');
        const proof = lifecycle.evidence(ctx.owner, value.evidence.id, ctx.extensionId);
        if (proof.revisionId !== revisionId) stop('HOST_RESULT_INVALID');
        return { ...draftHandles(value), evidenceId: proof.id, simulationSuiteIdentity: proof.identity.suiteDigest,
          summary: evidenceSummary(proof, lifecycle.source(ctx.owner, proof.revisionId, ctx.extensionId).cases) };
      }),
      readEvidence: () => proofFor(ctx.state.evidenceHandle),
    };
  }

  function prepare(owner, input, lease) {
    validate(input); assertLease(lease);
    let row = input.conversationId ? rowFor(owner, input.conversationId)
      : db.prepare('SELECT * FROM authoring_conversations WHERE owner_id=? AND creation_operation_id=?').get(owner, input.operationId);
    if (input.conversationId && !row) throw error(404, 'STALE_CONVERSATION');
    const prior = row ? decode(row) : null, hash = digest(Buffer.from(json(input)));
    const priorOperation = prior?.operations.find(item => item.id === input.operationId);
    if (priorOperation) {
      if (priorOperation.hash !== hash) throw error(409, 'STALE_CONVERSATION');
      return { duplicate: { operation: operation(priorOperation.id, priorOperation.runId, priorOperation.version), conversation: dto(row) } };
    }
    const link = row ? linkFor(owner, row.id) : null;
    if (row && (!link || input.target.kind !== 'resume' || input.target.extensionId !== link.extension_id)) throw error(404, 'STALE_CONVERSATION');
    const extensionId = input.target.kind === 'create' ? randomUUID() : input.target.extensionId;
    const currentState = input.target.kind === 'create'
      ? { revisionId: null, draftVersion: 0, suiteDigest: null, selection: lifecycle.collection(owner).selection }
      : lifecycle.state(owner, extensionId);
    const current = draftHandles(currentState);
    if (current.draftVersion !== input.expectedDraftVersion) throw error(409, 'STALE_DRAFT');
    if (input.target.kind === 'revise') {
      const base = input.target.baseRevisionId;
      if (input.target.selectionGeneration !== currentState.selection.generation
          || current.revisionId !== null && base !== current.revisionId
          || current.revisionId === null && base !== null && !(currentState.selection.revision?.id === base && currentState.selection.revision?.extensionId === extensionId)) throw error(409, 'STALE_DRAFT');
      if (base) lifecycle.source(owner, base, extensionId);
    }
    if (prior && !same(prior.state.handles, current)) throw error(409, 'STALE_DRAFT');
    const available = availability(); if (!available.available) throw error(503, available.code);
    if (closing || live.size >= 2 || [...live.values()].some(item => item.owner === owner)) throw error(429, 'AI_BUSY');
    if (row && (row.version !== input.expectedVersion || ['RUNNING', 'CANCELLING'].includes(row.status)) || !row && input.expectedVersion !== 0) throw error(409, 'STALE_CONVERSATION');
    if (prior?.state.transport && (prior.state.transport.provider !== config.provider || prior.state.transport.model !== config.model
        || prior.state.transport.policy !== resourcePolicy
        || (prior.state.transport.settingsRevision ?? null) !== (config.settingsRevision ?? null))) throw error(409, 'CONFIG_CHANGED');
    const id = row?.id ?? randomUUID(), runId = randomUUID(), controller = new AbortController();
    const state = prior?.state ?? createAuthoringState({ ownerId: owner, sessionId: lease.sessionId, conversationId: id, runId });
    const fresh = !row || state.sessionId !== lease.sessionId || ['CANCELLED', 'BLOCKED', 'INTERRUPTED'].includes(row.status) || !same(state.handles, current);
    Object.assign(state, { ownerId: owner, sessionId: lease.sessionId, conversationId: id, runId, status: 'IDLE', handles: current,
      dispatchOrdinal: 0, inFlight: null, checkpoint: null, lastResult: null });
    if (fresh) { state.continuation = undefined; state.pending = undefined; state.callIds = []; state.evidenceHandle = null; }
    const ctx = { owner, id, runId, lease, controller, input, hash, state, extensionId,
      purpose: link?.purpose ?? (input.target.kind === 'create' ? 'CREATE' : 'REVISE'),
      baseRevisionId: link?.base_revision_id ?? (input.target.kind === 'revise' ? input.target.baseRevisionId : null),
      baseGeneration: link?.base_generation ?? (input.target.kind === 'revise' ? input.target.selectionGeneration : null),
      tracked: new Set(), admitted: false };
    ctx.context = { ownerId: owner, sessionId: lease.sessionId, conversationId: id, runId,
      budget: { remainingMicros: Math.max(0, config.maxMicros - held()) },
      current: () => {
        if (closing || controller.signal.aborted || lease.current() !== true) return false;
        const saved = rowFor(owner, id);
        return ctx.admitted ? saved?.run_id === runId && saved.cancel_requested === 0 && linkFor(owner, id)?.extension_id === extensionId
          : !saved || saved.version === input.expectedVersion;
      }, checkpoint: value => checkpoint(ctx, value) };
    ctx.host = bindings(ctx);
    return ctx;
  }
  function finish(ctx, result) {
    try {
      transaction(db, () => {
        const row = rowFor(ctx.owner, ctx.id); if (!row || row.run_id !== ctx.runId) return;
        const value = decode(row), cancelled = row.cancel_requested === 1 || ctx.controller.signal.aborted;
        const status = cancelled ? 'CANCELLED' : statuses.has(result.status) ? result.status : 'BLOCKED';
        const code = cancelled ? 'CANCELLED' : result.code ? codeFor(result.code) : null;
        value.state.status = status;
        value.state.activeMs = Math.max(value.state.activeMs, ctx.state.activeMs);
        if (value.state.inFlight) for (const item of value.state.journal ?? []) if (item.runId === ctx.runId && !item.outcome) item.outcome = 'UNKNOWN';
        value.view.code = code;
        if (code) {
          // Blocked native chains cannot be replayed; retain intent, quotas and dispatch evidence.
          value.state.continuation = undefined; value.state.pending = undefined; value.state.evidenceHandle = null;
          value.state.lastResult = { status, code };
          value.view.review = null;
          const id = ctx.runId + '-assistant';
          if (!value.view.messages.some(item => item.id === id)) {
            value.view.messages.push({ id, role: 'assistant', kind: 'text', text: safeMessage(code) });
            if (length(dto({ ...row, status, view: encode(value.view) }, false)) > 131072
                || length(value.state) + length(value.operations) + length(value.view) > 262144) value.view.messages.pop();
          }
        }
        db.prepare('UPDATE authoring_conversations SET status=?,state=?,view=?,updated_at=? WHERE id=? AND owner_id=? AND run_id=?')
          .run(status, encode(value.state), encode(value.view), Date.now(), ctx.id, ctx.owner, ctx.runId);
      });
    } finally { if (live.get(ctx.runId) === ctx) live.delete(ctx.runId); }
  }
  async function turn(owner, input, lease) {
    const ctx = prepare(owner, input, lease); if (ctx.duplicate) return ctx.duplicate;
    let native; try { native = providerFactory(config); } catch { throw error(503, 'TOOL_FAILED'); }
    live.set(ctx.runId, ctx);
    const provider = { ...native, complete: args => tracked(ctx, () => native.complete(args)) };
    const task = runAuthoringTurn({ provider, host: ctx.host, context: ctx.context, state: ctx.state,
      input: { id: input.operationId, text: input.text, expectedVersion: input.expectedVersion }, signal: ctx.controller.signal, limits });
    ctx.promise = (async () => {
      let result;
      try { result = await task; await Promise.allSettled([...ctx.tracked]); }
      catch { result = { status: 'BLOCKED', code: 'TOOL_FAILED' }; }
      try { finish(ctx, result); } catch { live.delete(ctx.runId); }
      return result;
    })();
    if (!ctx.admitted) {
      const result = await ctx.promise; throw error(result.code?.startsWith('STALE') ? 409 : 503, codeFor(result.code));
    }
    return { operation: operation(input.operationId, ctx.runId, input.expectedVersion + 1), conversation: read(owner, ctx.id) };
  }
  function cancel(owner, id, input, lease) {
    assertLease(lease);
    if (!object(input) || Object.keys(input).length !== 2 || !token(input.runId) || !integer(input.expectedVersion)) throw error(400, 'INVALID_TOOL_ARGUMENTS');
    const row = rowFor(owner, id); if (!row) throw error(404, 'STALE_CONVERSATION');
    if (row.run_id !== input.runId || row.version !== input.expectedVersion) throw error(409, 'STALE_CONVERSATION');
    if (['RUNNING', 'CANCELLING'].includes(row.status)) {
      db.prepare("UPDATE authoring_conversations SET cancel_requested=1,status='CANCELLING' WHERE id=? AND owner_id=? AND run_id=? AND version=?")
        .run(id, owner, input.runId, input.expectedVersion);
      live.get(input.runId)?.controller.abort();
    }
    return read(owner, id);
  }
  return {
    list, read, turn, cancel, availability,
    configure(next, persist) {
      if (closing || live.size) throw error(409, 'AI_BUSY');
      if (next.status !== 'ready') throw error(400, 'AI_CONFIG_INVALID');
      if (next.maxMicros < held()) throw error(409, 'SPEND_LIMIT');
      // No await: admission, persistence and installation share one event-loop turn.
      persist(); config = next;
    },
    invalidateSession(sessionId) {
      for (const ctx of live.values()) if (ctx.lease.sessionId === sessionId) {
        db.prepare("UPDATE authoring_conversations SET cancel_requested=1,status='CANCELLING' WHERE id=? AND run_id=?").run(ctx.id, ctx.runId);
        ctx.controller.abort();
      }
    },
    async wait(owner, id) { const row = rowFor(owner, id); if (!row) throw error(404, 'STALE_CONVERSATION'); await live.get(row.run_id)?.promise; return read(owner, id); },
    async close() { closing = true; const jobs = [...live.values()]; for (const ctx of jobs) ctx.controller.abort(); await Promise.allSettled(jobs.map(ctx => ctx.promise)); },
  };
}
