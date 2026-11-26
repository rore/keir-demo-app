import { randomUUID } from 'node:crypto';
import { AppError, transaction } from './data.mjs';
import { loadHost, authoringDefinition, definitionFormats, TASK_HOOKS, TASK_DEFINITION, digest, json } from './extension-catalog.mjs';
import { readAuthoringConfig, LEGACY_OPENAI_RESERVE_MICROS, OPENAI_RESERVE_MICROS } from './authoring-config.mjs';
import { AuthoringError, createAuthoringProvider, PROVIDER_REPLY_CODES } from './authoring-provider.mjs';
import { createAuthoringState, loadAuthoringInstructions, runAuthoringTurn } from './authoring-agent.mjs';
import { authoringExample, businessContext, evidenceSummary } from './authoring-example.mjs';
import { createAuthoringContext } from './authoring-context.mjs';
import { createScopedAuthoringTurns, createTeamAuthoringTurns } from './team-authoring-turns.mjs';
import { sharedCompletionAuthoring } from './shared-completion-authoring.mjs';
import { projectAccess } from './team-native.mjs';
import { authoringTranscript } from './authoring-transcript.mjs';

export const AUTHORING_CODES = Object.freeze(['AI_NOT_CONFIGURED', 'AI_CONFIG_INVALID', 'AI_CREDENTIALS_MISSING', 'HOST_UNAVAILABLE', 'LEGACY_CUSTOMIZATION_RETIRED',
  'AUTHORING_GUIDE_UNAVAILABLE',
  'SPEND_LIMIT', 'BUDGET_EXHAUSTED', 'CONVERSATION_LIMIT', 'CONFIG_CHANGED', 'BYTE_LIMIT', 'CONTEXT_LIMIT', 'TOKEN_LIMIT', 'TIME_LIMIT', 'EXPIRED',
  'RUN_INTERRUPTED', 'CANCELLED', 'STALE_CONTEXT', 'STALE_DRAFT', 'STALE_CONVERSATION', 'AI_BUSY', 'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE', 'CREDENTIALS_INVALID', 'PROVIDER_RATE_LIMIT', 'PROVIDER_REDIRECT', ...PROVIDER_REPLY_CODES,
  'HOST_RESULT_INVALID', 'INVALID_TOOL_ARGUMENTS', 'TEAM_OFFER_INVALID', 'PERSONAL_OFFER_INVALID', 'SHARED_OFFER_INVALID', 'REVIEW_NOT_READY', 'CHECKPOINT_UNCERTAIN', 'TOOL_FAILED', 'AI_CONFIG_SAVE_FAILED']);
const codeFor = value => AUTHORING_CODES.includes(value) ? value : 'TOOL_FAILED';
const safeMessage = code => PROVIDER_REPLY_CODES.includes(code)
  ? 'Daymark couldn’t use the assistant’s reply. It stopped without retrying. Your saved work is kept. Ask whoever manages assistant settings to check what happened before you send another request.'
  : ({
  AI_NOT_CONFIGURED: 'AI authoring is not configured. Configure the assistant to create a customization. Native tasks remain available.',
  LEGACY_CUSTOMIZATION_RETIRED: 'This earlier customization is read-only. Its saved discussion and results are kept. Start a new customization to change task behavior.',
  AI_CONFIG_INVALID: 'The operator AI configuration needs attention.', AI_CREDENTIALS_MISSING: 'The operator AI credentials are unavailable.',
  AUTHORING_GUIDE_UNAVAILABLE: 'The assistant guide is unavailable. Native tasks and saved review remain available.',
  SPEND_LIMIT: 'Daymark’s assistant has reached the spending limit. Your work is saved. You can review saved changes and keep using Tasks. Ask whoever manages assistant settings about the allowance before sending another request.', AI_BUSY: 'Another authoring request is still settling. Check its saved state.',
  PROVIDER_RATE_LIMIT: 'The AI service refused this request because of a request or account limit. Any saved proposal and examples are kept. Check the provider usage and limits before retrying manually.',
  STALE_DRAFT: 'The draft changed. Read saved state before continuing.', STALE_CONVERSATION: 'The conversation changed. Read saved state before continuing.',
  RUN_INTERRUPTED: 'The previous run was interrupted. Check the current draft before explicitly continuing.',
  CANCELLED: 'Authoring stopped. Check saved state; a draft may already have been saved.',
  CONTEXT_LIMIT: 'This request could not fit safely within the authoring limits. Saved work is kept. You can inspect its checks or send a smaller request.',
  CONVERSATION_LIMIT: 'The owner conversation limit has been reached.', CONFIG_CHANGED: 'The AI configuration changed. Check saved state before sending again.',
  BUDGET_EXHAUSTED: 'This authoring run reached its resource limit.', REVIEW_NOT_READY: 'Run the current independent examples before offering review.',
  INVALID_TOOL_ARGUMENTS: 'The assistant could not finish preparing the example checks. Saved work is kept. Continue explicitly to try again.',
  TEAM_OFFER_INVALID: 'Daymark couldn’t prepare a proposal. No draft was saved. You can send a new message with the change you want, including any details you’ve already agreed to.',
  SHARED_OFFER_INVALID: 'Daymark couldn’t prepare a proposal. Nothing was saved. Ask the assistant to try again before confirming.',
  PERSONAL_OFFER_INVALID: 'Daymark could not compile the proposed rule or validate its examples. No draft was saved. Ask the assistant to correct the proposal, then review it before confirming again.',
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
const resourcePolicy = 'continuous-ai-authoring/3';
const readableDefinition = id => id === TASK_DEFINITION || id === 'daymark.task-completed/3';

// One app/data owner. The database journals work; the map contains only live cancellation/settlement handles.
export function createAuthoringService({ db, lifecycle, teamCapability, teamProjects, config = readAuthoringConfig(), fetchImpl,
   checkpointFault = () => {}, providerFactory = value => createAuthoringProvider(value, { fetchImpl }), sharedCompletionCompiler }) {
  const live = new Map(); let closing = false; const definitions = new Map();
  for (const hook of TASK_HOOKS) {
    try { definitions.set(hook, loadHost(hook)); } catch { /* AI setup failure never disables native tasks. */ }
  }
  const rowFor = (owner, id) => db.prepare('SELECT * FROM authoring_conversations WHERE id=? AND owner_id=?').get(id, owner);
  const linkFor = (owner, id) => db.prepare('SELECT * FROM extension_conversation_links WHERE owner_id=? AND conversation_id=?').get(owner, id);
  const selectionGeneration = (owner, current, hookId) => current.extension?.hookId === hookId
    ? current.selection.generation : lifecycle.collection(owner).selections[hookId].generation;
  const held = () => {
    const value = db.prepare('SELECT reserved_micros FROM authoring_budget WHERE id=1').get()?.reserved_micros;
    if (!integer(value)) stop('CHECKPOINT_UNCERTAIN'); return value;
  };
  const allowance = () => {
    const raw = held();
    const cleared = db.prepare('SELECT cleared_estimated_micros FROM authoring_budget WHERE id=1').get()?.cleared_estimated_micros;
    const { tracked, legacy, estimated } = db.prepare(`SELECT COALESCE(SUM(coalesce(estimated_micros,reserved_micros)),0) AS tracked,
      COALESCE(SUM(estimated_micros),0) AS estimated,
      COALESCE(SUM(CASE WHEN estimated_micros IS NULL AND reserved_micros=? THEN 1 ELSE 0 END),0) AS legacy
      FROM authoring_dispatches WHERE kind='provider'`).get(LEGACY_OPENAI_RESERVE_MICROS);
    if (!integer(tracked) || !integer(cleared) || tracked > raw - cleared || !integer(legacy)) stop('CHECKPOINT_UNCERTAIN');
    const old = BigInt(LEGACY_OPENAI_RESERVE_MICROS), delta = BigInt(OPENAI_RESERVE_MICROS - LEGACY_OPENAI_RESERVE_MICROS);
    // Reset keeps spend and holds but removes dispatch history. Treat unaccounted holds as
    // legacy OpenAI at worst, without rewriting immutable receipts or refunding credit.
    const untracked = BigInt(raw - tracked - cleared);
    const total = BigInt(raw) + BigInt(legacy) * delta + (untracked * delta + old - 1n) / old;
    if (total > BigInt(Number.MAX_SAFE_INTEGER)) stop('CHECKPOINT_UNCERTAIN');
    return { estimatedMicros: estimated + cleared, heldMicros: Number(total) - estimated - cleared };
  };
  const effectiveHeld = () => { const { estimatedMicros, heldMicros } = allowance(); return estimatedMicros + heldMicros; };
  // Called inside the live checkpoint transaction. The original hold and
  // identity remain immutable; only the first definitive result can settle.
  function recordDispatchResult(id, owner, run, cp) {
    const item = db.prepare('SELECT kind,reserved_micros,outcome FROM authoring_dispatches WHERE conversation_id=? AND owner_id=? AND run_id=? AND ordinal=?')
      .get(id, owner, run, cp.ordinal);
    if (!item || item.outcome !== null || item.kind !== cp.kind || !['SUCCESS', 'REJECTED', 'UNKNOWN'].includes(cp.outcome)) stop('HOST_RESULT_INVALID');
    const estimate = cp.kind === 'provider' && cp.outcome === 'SUCCESS' && integer(cp.estimatedMicros) && cp.estimatedMicros <= item.reserved_micros
      ? cp.estimatedMicros : null;
    if (estimate !== null) {
      const next = held() - (item.reserved_micros - estimate);
      if (!integer(next)) stop('CHECKPOINT_UNCERTAIN');
      db.prepare('UPDATE authoring_budget SET reserved_micros=? WHERE id=1').run(next);
    }
    if (db.prepare(`UPDATE authoring_dispatches SET outcome=?,estimated_micros=?
      WHERE conversation_id=? AND owner_id=? AND run_id=? AND ordinal=? AND outcome IS NULL`)
      .run(cp.outcome, estimate, id, owner, run, cp.ordinal).changes !== 1) stop('CHECKPOINT_UNCERTAIN');
  }
  const decode = row => {
    try { return { state: JSON.parse(row.state), operations: JSON.parse(row.operations), view: JSON.parse(row.view) }; }
    catch { throw error(503, 'HOST_RESULT_INVALID'); }
  };
  function availability(guideReady, team = false) {
    let code = closing ? 'HOST_UNAVAILABLE' : config.status !== 'ready' ? config.code : !team && definitions.size !== TASK_HOOKS.length ? 'HOST_UNAVAILABLE' : null;
    if (code === null && !(guideReady ?? loadAuthoringInstructions())) code = 'AUTHORING_GUIDE_UNAVAILABLE';
    return { available: code === null, code, provider: config.status === 'ready' ? config.provider : null,
      model: config.status === 'ready' ? config.model : null };
  }

  // Recovery is readback only. No provider, compiler or simulation is called at startup.
  transaction(db, () => {
    for (const row of db.prepare("SELECT * FROM authoring_conversations WHERE status IN ('RUNNING','CANCELLING')").all()) {
      const value = decode(row);
      if (value.state.definitionId !== TASK_DEFINITION || !linkFor(row.owner_id, row.id)) continue;
      value.state.status = 'BLOCKED'; value.state.lastResult = { status: 'BLOCKED', code: 'RUN_INTERRUPTED' };
      value.state.continuation = undefined; value.state.pending = undefined; value.state.evidenceHandle = null;
      value.view.code = 'RUN_INTERRUPTED'; delete value.view.proposal;
      if (value.view.confirmation !== 'saved') value.view.review = null;
      if (value.view.confirmation === 'preparing') {
        value.view.confirmation = 'unsaved';
        appendMessage(row.owner_id, row.id, { id: `${row.run_id}-confirm`, role: 'host', kind: 'text', text: 'Preparation stopped before saving a draft.' });
      } else if (value.view.confirmation === 'saved') {
        const { review } = value.view;
        if (review) value.view.confirmation = review.eligible ? 'passed' : 'failed';
        appendMessage(row.owner_id, row.id, { id: `${row.run_id}-confirm`, role: 'host', kind: review ? 'review' : 'text',
          text: 'The draft was saved. Read its example checks before continuing.',
          ...(review && { receipt: { ...value.state.handles, evidenceId: review.evidenceId } }) });
      }
      db.prepare("UPDATE authoring_dispatches SET outcome='UNKNOWN' WHERE conversation_id=? AND owner_id=? AND outcome IS NULL").run(row.id, row.owner_id);
      db.prepare("UPDATE authoring_conversations SET status='INTERRUPTED',cancel_requested=1,state=?,view=? WHERE id=? AND run_id=?")
        .run(encode(value.state), encode(value.view), row.id, row.run_id);
    }
  });

  const cursor = value => Buffer.from(encode(value)).toString('base64url');
  function parseCursor(value, scope) {
    try {
      if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw 0;
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (cursor(parsed) !== value || parsed.scope !== scope) throw 0;
      return parsed;
    } catch { throw error(400, 'INVALID_TOOL_ARGUMENTS'); }
  }
  function projects(owner, before = '') {
    const scope = encode(['projects', owner]), anchor = before === '' ? null : parseCursor(before, scope);
    if (anchor && (Object.keys(anchor).length !== 3 || typeof anchor.createdAt !== 'string' || !token(anchor.id)
        || !db.prepare("SELECT 1 FROM projects WHERE owner_id=? AND id=? AND created_at=? AND mode='PERSONAL'").get(owner, anchor.id, anchor.createdAt))) throw error(400, 'INVALID_TOOL_ARGUMENTS');
    const rows = db.prepare(`SELECT id,CAST(name AS BLOB) AS name,created_at FROM projects WHERE owner_id=? AND mode='PERSONAL'${anchor ? ' AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT 21`)
      .all(owner, ...(anchor ? [anchor.createdAt, anchor.createdAt, anchor.id] : []));
    const page = rows.slice(0, 20), last = page.at(-1);
    return { projects: page.map(row => ({ id: row.id, name: Buffer.from(row.name).toString('utf8') })),
      next: rows.length > page.length ? cursor({ scope, id: last.id, createdAt: last.created_at }) : null };
  }
  function readProjects(owner, before) {
    try { return projects(owner, before); } catch (cause) {
      if (cause.code === 'INVALID_TOOL_ARGUMENTS') stop('INVALID_TOOL_ARGUMENTS');
      throw cause;
    }
  }
  function messagePage(owner, id, before, maxBytes = 262144) {
    const row = rowFor(owner, id), link = linkFor(owner, id);
    if (!row || !link || !readableDefinition(decode(row).state.definitionId)) throw error(404, 'STALE_CONVERSATION');
    lifecycle.assertAvailable(owner, link.extension_id);
    const scope = encode(['messages', owner, id]);
    const anchor = before === undefined ? null : parseCursor(before, scope);
    if (anchor && (Object.keys(anchor).length !== 3 || !integer(anchor.sequence) || typeof anchor.inclusive !== 'boolean'
        || !db.prepare('SELECT 1 FROM authoring_messages WHERE conversation_id=? AND owner_id=? AND sequence=?').get(id, owner, anchor.sequence))) throw error(400, 'INVALID_TOOL_ARGUMENTS');
    const rows = db.prepare(`SELECT sequence,payload FROM authoring_messages WHERE conversation_id=? AND owner_id=?${anchor ? ` AND sequence${anchor.inclusive ? '<=' : '<'}?` : ''} ORDER BY sequence DESC`)
      .iterate(...[id, owner, ...(anchor ? [anchor.sequence] : [])]);
    return boundedMessages(rows, row => JSON.parse(row.payload),
      (row, inclusive) => cursor({ scope, sequence: row.sequence, inclusive }), maxBytes);
  }
  // Start with the item index so a sparse item does not scan the owner's other segments.
  const linkedSegments = `FROM extension_conversation_links l CROSS JOIN authoring_conversations c
    WHERE l.owner_id=? AND l.extension_id=? AND c.id=l.conversation_id AND c.owner_id=l.owner_id`;
  const segmentOrder = ' ORDER BY c.created_at DESC,c.id DESC';
  const latestSegment = (owner, extensionId) => db.prepare(`SELECT c.* ${linkedSegments}${segmentOrder} LIMIT 1`).get(owner, extensionId);
  const running = row => ['RUNNING', 'CANCELLING'].includes(row.status);
  function transportMatches(state) {
    const transport = state.transport;
    return !transport || (transport.provider === config.provider && transport.model === config.model
      && (transport.settingsRevision ?? null) === (config.settingsRevision ?? null));
  }
  function* itemMessageRows(owner, extensionId, anchor) {
    const segments = db.prepare(`SELECT c.id,c.created_at ${linkedSegments}${anchor ? ' AND (c.created_at,c.id)<=(?,?)' : ''}${segmentOrder}`)
      .iterate(owner, extensionId, ...(anchor ? [anchor.createdAt, anchor.conversationId] : []));
    for (const segment of segments) {
      const boundary = anchor?.conversationId === segment.id ? anchor : null;
      const rows = db.prepare(`SELECT sequence,payload FROM authoring_messages WHERE conversation_id=? AND owner_id=?
        ${boundary ? `AND sequence${boundary.inclusive ? '<=' : '<'}?` : ''} ORDER BY sequence DESC`)
        .iterate(segment.id, owner, ...(boundary ? [boundary.sequence] : []));
      for (const row of rows) yield { ...row, conversationId: segment.id, createdAt: segment.created_at };
    }
  }
  function transcript(owner, extensionId, before, maxBytes = 262144) {
    lifecycle.assertAvailable(owner, extensionId);
    const scope = encode(['transcript', owner, extensionId]);
    const anchor = before === undefined ? null : parseCursor(before, scope);
    if (anchor && (Object.keys(anchor).length !== 5 || !integer(anchor.createdAt) || !token(anchor.conversationId)
        || !integer(anchor.sequence) || typeof anchor.inclusive !== 'boolean'
        || !db.prepare(`SELECT 1 ${linkedSegments} AND c.id=? AND c.created_at=? AND EXISTS (
          SELECT 1 FROM authoring_messages m WHERE m.conversation_id=c.id AND m.owner_id=c.owner_id AND m.sequence=?)`)
          .get(owner, extensionId, anchor.conversationId, anchor.createdAt, anchor.sequence))) throw error(400, 'INVALID_TOOL_ARGUMENTS');
    return boundedMessages(itemMessageRows(owner, extensionId, anchor),
      row => ({ ...JSON.parse(row.payload), conversationId: row.conversationId }),
      ({ conversationId, createdAt, sequence }, inclusive) => cursor({ scope, conversationId, createdAt, sequence, inclusive }), maxBytes);
  }
  function boundedMessages(rows, readMessage, messageCursor, maxBytes) {
    const messages = []; let next = null, first;
    for (const row of rows) {
      const message = readMessage(row);
      const candidate = messageCursor(row, false);
      if (length({ messages: [message, ...messages], next: candidate }) > maxBytes || messages.length >= 20) {
        next = messages.length ? first : messageCursor(row, true); break;
      }
      messages.unshift(message); first = candidate;
    }
    return { messages, next };
  }
  function appendMessage(owner, id, message) {
    if (db.prepare('SELECT 1 FROM authoring_messages WHERE conversation_id=? AND message_id=?').get(id, message.id)) return;
    const sequence = db.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM authoring_messages WHERE conversation_id=?').get(id).n;
    db.prepare('INSERT INTO authoring_messages VALUES (?,?,?,?,?)').run(id, owner, sequence, message.id, encode(message));
  }
  function dto(row, bounded = true) {
    const { state, operations, view } = decode(row), link = row.extension_id ? { extension_id: row.extension_id, purpose: row.purpose } : linkFor(row.owner_id, row.id);
    if (!link || !readableDefinition(state.definitionId)) throw error(404, 'STALE_CONVERSATION');
    const current = lifecycle.state(row.owner_id, link.extension_id);
    const retired = state.definitionId !== TASK_DEFINITION || current.retired;
    let review = view.review ?? null;
    if (review) review = { revisionId: review.revisionId, draftVersion: review.draftVersion, suiteDigest: review.suiteDigest,
      evidenceId: review.evidenceId, eligible: !retired && review.eligible === true && same(review, draftHandles(current)) };
    const result = { id: row.id, version: row.version, status: row.status, runId: row.run_id,
      operation: operation(operations.at(-1).id, operations.at(-1).runId, operations.at(-1).version), messages: [], messagesBefore: null,
      extensionId: link.extension_id, purpose: link.purpose, retired,
      code: view.code ? codeFor(view.code) : null, review, draft: state.handles ?? { revisionId: null, draftVersion: 0, suiteDigest: null },
      ...(view.confirmation && { confirmation: view.confirmation }),
       offer: row.status === 'AWAITING_USER' && view.proposal && !retired && same(state.handles, draftHandles(current))
         && selectionGeneration(row.owner_id, current, view.proposal.hookId) === view.proposal.selectionGeneration
        ? { digest: digest(json(view.proposal)), summary: view.proposal.summary } : null,
      selection: { revisionId: current.selection.revision?.id ?? null, generation: current.selection.generation } };
    if (bounded) {
      const page = messagePage(row.owner_id, row.id, undefined, 131072 - length(result) - 64);
      result.messages = page.messages; result.messagesBefore = page.next;
      if (length(result) > 131072) throw error(413, 'BYTE_LIMIT');
    }
    return result;
  }
  function read(owner, id) { const row = rowFor(owner, id); if (!row) throw error(404, 'STALE_CONVERSATION'); return dto(row); }
  function list(owner, extensionId, before) {
    const item = extensionId === undefined ? null : lifecycle.state(owner, extensionId);
    const scope = encode(['conversations', owner, extensionId ?? null]), anchor = before === undefined ? null : parseCursor(before, scope);
    const filter = extensionId === undefined ? '' : ' AND l.extension_id=?';
    const args = [owner, ...(extensionId === undefined ? [] : [extensionId])];
    if (anchor && (Object.keys(anchor).length !== 3 || !token(anchor.id) || !integer(anchor.createdAt)
        || !db.prepare(`SELECT 1 FROM authoring_conversations c JOIN extension_conversation_links l ON l.conversation_id=c.id AND l.owner_id=c.owner_id WHERE c.owner_id=?${filter} AND c.id=? AND c.created_at=?`).get(...args, anchor.id, anchor.createdAt))) throw error(400, 'INVALID_TOOL_ARGUMENTS');
    const query = `SELECT c.*,l.extension_id,l.purpose FROM authoring_conversations c JOIN extension_conversation_links l ON l.conversation_id=c.id AND l.owner_id=c.owner_id WHERE c.owner_id=?${filter} AND EXISTS(SELECT 1 FROM extensions e WHERE e.owner_id=l.owner_id AND e.id=l.extension_id AND e.deleted_at IS NULL)`;
    const rows = db.prepare(`${query}${anchor ? ' AND (c.created_at<? OR (c.created_at=? AND c.id<?))' : ''} ORDER BY c.created_at DESC,c.id DESC LIMIT 21`)
      .all(...args, ...(anchor ? [anchor.createdAt, anchor.createdAt, anchor.id] : []));
    const page = rows.slice(0, 20), last = page.at(-1);
    const latest = item && latestSegment(owner, extensionId), saved = latest && decode(latest).state;
    // The item transcript carries messages; the current segment supplies execution metadata.
    const current = saved?.definitionId === TASK_DEFINITION && (running(latest)
      || item.retired === false && same(saved.handles, draftHandles(item)) && transportMatches(saved)) ? dto(latest, false) : null;
    const result = { availability: availability(), conversations: page.map(row => ({ id: row.id, version: row.version, status: row.status,
      extensionId: row.extension_id, purpose: row.purpose,
      runId: row.run_id, creationOperationId: row.creation_operation_id, operationId: decode(row).operations.at(-1).id })),
    next: rows.length > page.length ? cursor({ scope, id: last.id, createdAt: last.created_at }) : null,
    current };
    if (item) result.transcript = transcript(owner, extensionId, undefined, 262144 - length({ ...result, transcript: null }) + 4);
    return result;
  }
  function assertLease(lease) { if (!lease || !token(lease.sessionId) || lease.current() !== true) stop('STALE_CONTEXT'); }
  function revisesCurrent(input, state) {
    const { baseRevisionId, selectionGeneration, extensionId } = input.target;
    const revision = state.selection.revision;
    return selectionGeneration === state.selection.generation && (state.revisionId !== null
      ? baseRevisionId === state.revisionId
      : baseRevisionId === null || revision?.id === baseRevisionId && revision.extensionId === extensionId);
  }
  function usedOperation(owner, extensionId, operationId) {
    return db.prepare(`SELECT 1 FROM extension_conversation_links l JOIN authoring_operations o
      ON o.conversation_id=l.conversation_id AND o.owner_id=l.owner_id
      WHERE l.owner_id=? AND l.extension_id=? AND o.operation_id=? LIMIT 1`).get(owner, extensionId, operationId);
  }
  function validate(input) {
    if (!object(input) || Object.keys(input).length !== (Object.hasOwn(input, 'intent') ? 7 : 6) || !['conversationId', 'operationId', 'text', 'expectedVersion', 'expectedDraftVersion', 'target'].every(key => Object.hasOwn(input, key))
        || Object.hasOwn(input, 'intent') && !['auto', 'discuss', 'prepare'].includes(input.intent)
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
    view.messages ??= [];
    if (state.checkpoint.phase === 'ADMIT') {
      view.messages.push({ id: ctx.input.operationId, role: 'user', text: ctx.input.text, kind: 'text' }); view.code = null; view.review = null;
      delete view.proposal;
      delete view.confirmation;
      delete view.confirmationDigest;
    }
    if (state.checkpoint.phase === 'TERMINAL') {
      const result = state.lastResult; const id = ctx.runId + '-assistant';
      if (result && !view.messages.some(message => message.id === id)) view.messages.push({ id, role: 'assistant',
        text: result.message ?? safeMessage(codeFor(result.code)), kind: result.status === 'AWAITING_USER' ? 'clarification' : result.review ? 'review' : 'text',
        ...(result.openCustomization && { openCustomization: result.openCustomization }),
        ...(result.review && { receipt: { revisionId: result.review.revisionId, draftVersion: result.review.draftVersion,
          suiteDigest: result.review.suiteDigest, evidenceId: result.review.evidenceId } }) });
      view.code = result?.code ? codeFor(result.code) : null;
      if (result?.proposal) view.proposal = result.proposal;
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
        if (state.definitionId !== TASK_DEFINITION || prior && prior.state.definitionId !== state.definitionId) stop('LEGACY_CUSTOMIZATION_RETIRED');
        if (cp.phase === 'ADMIT') {
          if (ctx.admitted || row && (row.version !== ctx.input.expectedVersion || ['RUNNING', 'CANCELLING'].includes(row.status))
              || !row && ctx.input.expectedVersion !== 0 || state.version !== ctx.input.expectedVersion + 1) stop('STALE_CONVERSATION');
          if (db.prepare('SELECT 1 FROM authoring_messages WHERE conversation_id=? AND message_id=?').get(ctx.id, ctx.input.operationId)) stop('STALE_CONVERSATION');
          if (ctx.input.target.kind === 'create') lifecycle.admit(ctx.owner,
            { extensionId: ctx.extensionId, operationId: ctx.input.operationId, hash: ctx.hash, name: 'Untitled customization' }, () => assertLease(ctx.lease));
          const current = lifecycle.state(ctx.owner, ctx.extensionId);
          if (!same(draftHandles(current), state.handles)
              || ctx.input.target.kind === 'revise' && !revisesCurrent(ctx.input, current)) stop('STALE_DRAFT');
          if (ctx.input.target.kind !== 'create') {
            const latest = latestSegment(ctx.owner, ctx.extensionId);
            if (usedOperation(ctx.owner, ctx.extensionId, ctx.input.operationId)
                || row && latest?.id !== row.id || latest && running(latest)) stop('STALE_CONVERSATION');
            if (!row && latest) {
              state.createdAt = Math.max(state.createdAt, latest.created_at + 1);
              if (!integer(state.createdAt)) stop('STALE_CONVERSATION');
            }
          }
          state.runLedger = { base: prior?.state.usage.reservedMicros ?? 0, reserved: 0, ordinal: 0 };
        } else {
          if (!row || row.run_id !== ctx.runId || row.version !== state.version || row.cancel_requested || row.status !== 'RUNNING') stop('STALE_CONTEXT');
          lifecycle.assertAvailable(ctx.owner, ctx.extensionId);
        }
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
        if (!integer(nextHeld) || effectiveHeld() + delta > config.maxMicros) stop('SPEND_LIMIT');
         if (cp.phase === 'DISPATCH') db.prepare('INSERT INTO authoring_dispatches VALUES (?,?,?,?,?,?,?,NULL,NULL)')
          .run(ctx.id, ctx.owner, ctx.runId, cp.ordinal, cp.kind, cp.callId ?? null, delta);
         if (cp.phase === 'RESULT') recordDispatchResult(ctx.id, ctx.owner, ctx.runId, cp);
        const saved = { ...state, transport: { provider: config.provider, model: config.model, policy: resourcePolicy,
          settingsRevision: config.settingsRevision ?? null },
          runLedger: { base: ledger.base, reserved: additional, ordinal: cp.phase === 'DISPATCH' ? cp.ordinal : ledger.ordinal } };
         delete saved.journal; delete saved.inputIds; delete saved.callIds;
         delete saved.continuation; delete saved.pending;
         if (saved.lastResult?.proposal) saved.lastResult = { status: saved.lastResult.status };
        const ops = [{ id: ctx.input.operationId, hash: ctx.hash, runId: ctx.runId, version: state.version }];
        const view = publicView(prior?.view ?? { messages: [], code: null, review: null }, state, ctx);
        const messages = view.messages; view.messages = [];
        if (length(saved) + length(ops) + length(view) > 262144) stop('CONTEXT_LIMIT');
        if (messages.some(message => length(message) > 131072)) stop('BYTE_LIMIT');
        const status = cp.phase === 'TERMINAL' ? state.status : 'RUNNING';
        if (!statuses.has(status)) stop('HOST_RESULT_INVALID');
        // Leave room for late authoritative handles and a safe blocker without dropping intent.
        const projection = { id: ctx.id, owner_id: ctx.owner, extension_id: ctx.extensionId, purpose: ctx.purpose, version: state.version, run_id: ctx.runId, status,
          state: encode(saved), operations: encode(ops), view: encode(view) };
        if (length(dto(projection, false)) > 131072 - 1024) stop('BYTE_LIMIT');
        checkpointFault({ stage: 'beforeCommit', phase: cp.phase, runId: ctx.runId, ordinal: cp.ordinal });
         if (delta) db.prepare('UPDATE authoring_budget SET reserved_micros=? WHERE id=1').run(nextHeld);
        if (!row) db.prepare('INSERT INTO authoring_conversations (id,owner_id,creation_operation_id,version,run_id,status,cancel_requested,updated_at,state,operations,view,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(ctx.id, ctx.owner, ctx.input.operationId,
          state.version, ctx.runId, status, 0, Date.now(), encode(saved), encode(ops), encode(view), state.createdAt);
        else db.prepare('UPDATE authoring_conversations SET version=?,run_id=?,status=?,cancel_requested=0,updated_at=?,state=?,operations=?,view=? WHERE id=? AND owner_id=?')
          .run(state.version, ctx.runId, status, Date.now(), encode(saved), encode(ops), encode(view), ctx.id, ctx.owner);
        if (!row) db.prepare('INSERT INTO extension_conversation_links VALUES (?,?,?,?,?,?)').run(ctx.id, ctx.owner, ctx.extensionId, ctx.purpose, ctx.baseRevisionId, ctx.baseGeneration);
        if (cp.phase === 'ADMIT') db.prepare('INSERT INTO authoring_operations VALUES (?,?,?,?,?,?)')
          .run(ctx.id, ctx.owner, ctx.input.operationId, ctx.hash, ctx.runId, state.version);
        for (const message of messages) appendMessage(ctx.owner, ctx.id, message);
      });
       committed = true; ctx.admitted = true; ctx.state = state;
      ctx.context.budget.remainingMicros = Math.max(0, config.maxMicros - effectiveHeld());
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
    const reviewFor = (current, proof) => ({ ...current, evidenceId: proof.id, simulationSuiteIdentity: proof.identity.suiteDigest, eligible: proof.passed,
      summary: Object.hasOwn(proof, 'summary') && !proof.summary ? null
        : evidenceSummary(proof, lifecycle.source(ctx.owner, proof.revisionId, ctx.extensionId).cases, { presentation: false }) });
    const proofFor = () => {
      authorize();
      const current = ctx.state.handles;
      if (!current.revisionId || !current.suiteDigest) return null;
      try {
        const proof = lifecycle.currentReviewEvidence(ctx.owner, { ...current, extensionId: ctx.extensionId });
        return proof ? reviewFor(current, proof) : null;
      } catch (cause) {
        if (cause instanceof AppError && [404, 409, 410].includes(cause.status)
          || cause instanceof SyntaxError || cause instanceof TypeError) return null;
        throw cause;
      }
    };
    const currentUse = (current, extensionId = ctx.extensionId) => {
      if (!current.extension?.hookId) return { generation: null, relation: 'none', selected: null,
        checkedSummary: null, unavailableReason: 'TRIGGER_UNRESOLVED' };
      const selection = current.selection, revision = selection.revision;
      const result = { generation: selection.generation,
        relation: !revision ? 'none' : revision.extensionId === extensionId ? 'thisitem' : 'anotheritem',
        selected: revision ? { extensionId: revision.extensionId, name: revision.extensionName, revisionId: revision.id,
          provenance: revision.provenance, eligible: selection.eligible === true, approvedEvidenceId: selection.approvedEvidenceId ?? null } : null,
        checkedSummary: null, unavailableReason: null };
      const unavailable = reason => { result.unavailableReason = reason; return result; };
      // Legacy display names may exceed current admission bounds; never truncate an exact name silently.
      if (length(result) > 16384 - 128) { result.selected.name = null; result.nameOmittedReason = 'SELECTION_METADATA_TOO_LARGE'; }
      if (!revision) return unavailable('NO_SELECTION');
      if (result.relation !== 'thisitem') return unavailable('ANOTHER_ITEM_SELECTED');
      if (!selection.eligible) return unavailable('SELECTION_INELIGIBLE');
      if (revision.provenance !== 'customer') return unavailable('NO_CUSTOMER_APPROVAL');
      if (!selection.approvedEvidenceId) return unavailable('APPROVAL_UNAVAILABLE');
      try {
        const proof = lifecycle.evidence(ctx.owner, selection.approvedEvidenceId, extensionId);
        if (proof.id !== selection.approvedEvidenceId || proof.revisionId !== revision.id) return unavailable('APPROVED_PROOF_MISMATCH');
        if (proof.passed !== true || !Array.isArray(proof.reports) || !proof.reports.length
            || proof.reports.some(item => !object(item) || typeof item.id !== 'string' || !object(item.expected) || typeof (item.expected.outcome ?? item.expected).classification !== 'string'
              || !object(item.report) || item.report.status !== 'PASS' || !object(item.report.native) || typeof item.report.native.classification !== 'string'
              || !object(item.report.consumption) || typeof item.report.consumption.status !== 'string'
              || !Array.isArray(item.report.mismatches) || item.report.mismatches.length)) return unavailable('APPROVED_PROOF_UNUSABLE');
        if (proof.reports.some(item => !object(item.report.observed)
          || !['CONFIRMED', 'NONE', 'UNKNOWN', 'NOT_OBSERVED'].includes(item.report.observed.effect)
          || !['createdTasks', 'updatedTasks'].every(key => item.report.observed[key] === null || Array.isArray(item.report.observed[key])))) return unavailable('APPROVED_PROOF_UNUSABLE');
        const source = lifecycle.source(ctx.owner, revision.id, extensionId);
        if (source.extensionId !== extensionId || source.revisionId !== revision.id || !Array.isArray(source.cases) || !source.cases.length) return unavailable('APPROVED_SOURCE_MISMATCH');
        source.cases.forEach(text => JSON.parse(text));
        if (Object.hasOwn(proof, 'summary') && !proof.summary) return unavailable('APPROVED_PROOF_UNAVAILABLE');
        result.checkedSummary = { scope: 'synthetic examples, not live task observations', evidenceId: proof.id,
          ...evidenceSummary(proof, source.cases, { presentation: false }) };
        if (length(result) > 16384) { result.checkedSummary = null; return unavailable('CHECKED_SUMMARY_TOO_LARGE'); }
        return result;
      } catch { return unavailable('APPROVED_PROOF_UNAVAILABLE'); }
    };
    return {
      ...createAuthoringContext({ db, lifecycle, owner: ctx.owner, extensionId: ctx.extensionId,
        authorize, currentUse }),
      readDraft: () => { authorize(); return mapped(); },
      offerPins(hookId) {
        authorize();
        const current = lifecycle.state(ctx.owner, ctx.extensionId);
        if (!definitions.has(hookId) || current.extension.hookId && current.extension.hookId !== hookId) stop('INVALID_TOOL_ARGUMENTS');
        const base = current.revisionId ?? ctx.baseRevisionId;
        return { modelDigest: authoringDefinition(hookId, base ? lifecycle.source(ctx.owner, base, ctx.extensionId).pins.modelDigest : undefined).pins.modelDigest,
          selectionGeneration: selectionGeneration(ctx.owner, current, hookId) };
      },
      projects: before => { authorize(); return readProjects(ctx.owner, before); },
      discover: () => {
        authorize(); const current = lifecycle.state(ctx.owner, ctx.extensionId), selectedHook = current.extension?.hookId ?? null;
        const baseId = current.draft?.id ?? ctx.baseRevisionId;
        const proposal = baseId ? lifecycle.source(ctx.owner, baseId, ctx.extensionId) : null;
        const definition = selectedHook ? authoringDefinition(selectedHook, proposal?.pins.modelDigest) : definitions.values().next().value;
        if (!definition) stop('HOST_UNAVAILABLE');
        const syntax = host => {
          const { source, cases } = authoringExample(host);
          return { sourceExample: source, scenarioExample: cases[0], scenarioExamples: cases };
        };
        // The same DCM describes both hooks. Consumer and hook pins only belong to a bound trigger.
        const { hook, consumer, ...sharedPins } = definition.pins;
        const currentProposal = proposal ? { revisionId: proposal.revisionId, source: proposal.source, cases: proposal.cases,
          suiteDigest: proposal.suiteDigest, truncated: false } : null;
        if (currentProposal && length(currentProposal) > 65536) { currentProposal.cases = null; currentProposal.truncated = true; }
        if (currentProposal && length(currentProposal) > 65536) { currentProposal.source = null; currentProposal.truncated = true; }
        const rejected = ctx.rejectedOffer;
        const rejectedOffer = rejected && same(ctx.state.handles, draftHandles(current))
          && rejected.proposal.selectionGeneration === selectionGeneration(ctx.owner, current, rejected.proposal.hookId)
          ? { diagnostics: rejected.diagnostics, ...(length([currentProposal, rejected.proposal]) <= 32768
            ? { source: rejected.proposal.sourceJson, cases: rejected.proposal.cases, hookId: rejected.proposal.hookId }
            : { truncated: true }) } : null;
        return { dcm: JSON.parse(Buffer.from(definition.dcmBytes).toString('utf8')), ...sharedPins, ...definitionFormats(definition.pins), selectedHook,
          currentDraft: draftHandles(current), currentProposal, ...(rejectedOffer && { rejectedOffer }),
          currentUse: currentUse(current), extension: current.extension, purpose: ctx.purpose,
          supportedHooks: lifecycle.hostCatalog().hooks,
          businessContext, projects: projects(ctx.owner),
          ...(selectedHook ? { hook, consumer, ...syntax(definition) } : {
            examplesByHook: Object.fromEntries([...definitions].map(([id, host]) => [id, syntax(host)])),
          }) };
      },
       readEvidence: proofFor,
    };
  }

  function prepare(owner, input, lease, continueOnly) {
    validate(input); assertLease(lease);
    let row = input.conversationId ? rowFor(owner, input.conversationId)
      : db.prepare('SELECT * FROM authoring_conversations WHERE owner_id=? AND creation_operation_id=?').get(owner, input.operationId);
    if (input.conversationId && !row) throw error(404, 'STALE_CONVERSATION');
    const prior = row ? decode(row) : null, hash = digest(Buffer.from(json(input)));
    const priorOperation = row && db.prepare('SELECT operation_id AS id,body_hash AS hash,run_id AS runId,admitted_version AS version FROM authoring_operations WHERE conversation_id=? AND owner_id=? AND operation_id=?').get(row.id, owner, input.operationId);
    if (priorOperation) {
      if (priorOperation.hash !== hash) throw error(409, 'STALE_CONVERSATION');
      const link = linkFor(owner, row.id);
      if (link) lifecycle.assertAvailable(owner, link.extension_id, true);
      return { duplicate: { operation: operation(priorOperation.id, priorOperation.runId, priorOperation.version), conversation: dto(row) } };
    }
    if (continueOnly && input.target.kind === 'create')
      throw new AppError(409, 'Start a new customization in Shared Studio.');
    if (row && prior.state.definitionId !== TASK_DEFINITION) throw error(410, 'LEGACY_CUSTOMIZATION_RETIRED');
    if (row && db.prepare('SELECT 1 FROM authoring_messages WHERE conversation_id=? AND message_id=?').get(row.id, input.operationId)) throw error(409, 'STALE_CONVERSATION');
    const link = row ? linkFor(owner, row.id) : null;
    if (row && (!link || input.target.kind !== 'resume' || input.target.extensionId !== link.extension_id)) throw error(404, 'STALE_CONVERSATION');
    const extensionId = input.target.kind === 'create' ? randomUUID() : input.target.extensionId;
    const currentState = input.target.kind === 'create'
      ? { revisionId: null, draftVersion: 0, suiteDigest: null, selection: lifecycle.collection(owner).selection }
      : lifecycle.state(owner, extensionId);
    if (currentState.sharedStudio) throw error(409, 'STALE_DRAFT');
    if (!row && input.target.kind !== 'create' && currentState.retired !== false) throw error(410, 'LEGACY_CUSTOMIZATION_RETIRED');
    const current = draftHandles(currentState);
    if (current.draftVersion !== input.expectedDraftVersion) throw error(409, 'STALE_DRAFT');
    if (input.target.kind === 'revise') {
      const base = input.target.baseRevisionId;
      if (!revisesCurrent(input, currentState)) throw error(409, 'STALE_DRAFT');
      if (base) lifecycle.source(owner, base, extensionId);
    }
    const latest = input.target.kind === 'create' ? null : latestSegment(owner, extensionId);
    if (input.target.kind !== 'create' && usedOperation(owner, extensionId, input.operationId)
        || row && latest?.id !== row.id) throw error(409, 'STALE_CONVERSATION');
    if (prior && !same(prior.state.handles, current)) throw error(409, 'STALE_DRAFT');
    const instructions = loadAuthoringInstructions();
    const available = availability(Boolean(instructions)); if (!available.available) throw error(503, available.code);
    if (closing || live.size >= 2 || [...live.values()].some(item => item.owner === owner)) throw error(429, 'AI_BUSY');
    if (latest && running(latest) || row && row.version !== input.expectedVersion || !row && input.expectedVersion !== 0) throw error(409, 'STALE_CONVERSATION');
    if (prior && !transportMatches(prior.state)) throw error(409, 'CONFIG_CHANGED');
    const id = row?.id ?? randomUUID(), runId = randomUUID(), controller = new AbortController();
    const state = prior?.state ?? createAuthoringState({ ownerId: owner, sessionId: lease.sessionId, conversationId: id, runId });
    Object.assign(state, { definitionId: TASK_DEFINITION, ownerId: owner, sessionId: lease.sessionId, conversationId: id, runId, status: 'IDLE', handles: current,
      dispatchOrdinal: 0, inFlight: null, checkpoint: null, lastResult: null });
    // Each explicit turn starts from fresh host context; old native tool chains are never replayed.
    state.continuation = undefined; state.pending = undefined; state.callIds = []; state.inputIds = []; state.evidenceHandle = null;
     delete state.contextFull; delete state.scenarioSource; delete state.resolvedIntent;
    const ctx = { owner, id, runId, lease, controller, input, hash, state, extensionId, instructions,
      purpose: link?.purpose ?? (input.target.kind === 'create' ? 'CREATE' : 'REVISE'),
      baseRevisionId: link?.base_revision_id ?? (input.target.kind === 'revise' ? input.target.baseRevisionId : null),
      baseGeneration: link?.base_generation ?? (input.target.kind === 'revise' ? input.target.selectionGeneration : null),
      tracked: new Set(), admitted: false, rejectedOffer: prior?.view.rejectedOffer };
     ctx.context = { ownerId: owner, sessionId: lease.sessionId, conversationId: id, runId,
      budget: { remainingMicros: Math.max(0, config.maxMicros - effectiveHeld()) },
      current: () => {
        if (closing || controller.signal.aborted || lease.current() !== true) return false;
        if (ctx.admitted || input.target.kind !== 'create') {
          try { lifecycle.assertAvailable(owner, extensionId); } catch { return false; }
        }
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
        if (code === 'CONTEXT_LIMIT' && same(ctx.state.handles, draftHandles(lifecycle.state(ctx.owner, ctx.extensionId)))) {
          value.state.handles = ctx.state.handles;
        }
        value.state.status = status;
        value.state.activeMs = Math.max(value.state.activeMs, ctx.state.activeMs);
        db.prepare("UPDATE authoring_dispatches SET outcome='UNKNOWN' WHERE conversation_id=? AND owner_id=? AND run_id=? AND outcome IS NULL").run(ctx.id, ctx.owner, ctx.runId);
        value.view.code = code;
        if (code) {
           // Retain dispatch evidence, not native continuation.
          value.state.continuation = undefined; value.state.pending = undefined; value.state.evidenceHandle = null;
          value.state.lastResult = { status, code };
           value.view.review = null;
           delete value.view.proposal;
          const id = ctx.runId + '-assistant';
          appendMessage(ctx.owner, ctx.id, { id, role: 'assistant', kind: 'text', text: safeMessage(code) });
        }
        db.prepare('UPDATE authoring_conversations SET status=?,state=?,view=?,updated_at=? WHERE id=? AND owner_id=? AND run_id=?')
          .run(status, encode(value.state), encode(value.view), Date.now(), ctx.id, ctx.owner, ctx.runId);
      });
    } finally { if (live.get(ctx.runId) === ctx) live.delete(ctx.runId); }
  }
  async function turn(owner, input, lease, { continueOnly = false } = {}) {
    const ctx = prepare(owner, input, lease, continueOnly); if (ctx.duplicate) return ctx.duplicate;
     const transcript = authoringTranscript(input.target.kind === 'create' ? [] : itemMessageRows(owner, ctx.extensionId));
    let native; try { native = providerFactory(config); } catch { throw error(503, 'TOOL_FAILED'); }
    live.set(ctx.runId, ctx);
    const provider = { ...native, complete: args => tracked(ctx, () => native.complete(args)) };
    const task = runAuthoringTurn({ provider, host: ctx.host, context: ctx.context, state: ctx.state,
       input: { id: input.operationId, text: input.text, expectedVersion: input.expectedVersion },
       transcript, signal: ctx.controller.signal, instructions: ctx.instructions });
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
  function confirm(owner, id, input, lease) {
    assertLease(lease);
    if (!object(input) || Object.keys(input).length !== 3 || !token(input.runId) || !integer(input.expectedVersion)
        || !/^sha256:[a-f0-9]{64}$/.test(input.offerDigest)) throw error(400, 'INVALID_TOOL_ARGUMENTS');
    const row = rowFor(owner, id), link = linkFor(owner, id);
    if (!row || !link) throw error(404, 'STALE_CONVERSATION');
    const { state, view } = decode(row), extensionId = link.extension_id;
    lifecycle.assertWritable(owner, extensionId);
    if (row.run_id !== input.runId || row.version !== input.expectedVersion || state.sessionId !== lease.sessionId
        || state.definitionId !== TASK_DEFINITION || latestSegment(owner, extensionId)?.id !== id) throw error(409, 'STALE_CONVERSATION');
    if (view.confirmationDigest === input.offerDigest) return dto(row); // Readback only, not another preparation attempt.
    if (row.status !== 'AWAITING_USER' || row.cancel_requested || !view.proposal
        || digest(json(view.proposal)) !== input.offerDigest || !transportMatches(state)) throw error(409, 'STALE_CONVERSATION');
    const base = state.handles, { proposal } = view, current = () => lifecycle.state(owner, extensionId);
    const currentIs = handles => {
      const actual = current();
      return same(handles, draftHandles(actual)) && selectionGeneration(owner, actual, proposal.hookId) === proposal.selectionGeneration;
    };
    if (!currentIs(base) || proposal.expectedDraftVersion !== base.draftVersion) throw error(409, 'STALE_DRAFT');
    if (closing || live.size >= 2 || [...live.values()].some(job => job.owner === owner)) throw error(409, 'AI_BUSY');
    const controller = new AbortController(), { signal } = controller, runId = row.run_id;
    const job = { owner, id, extensionId, runId, lease, controller };
    const startingView = { confirmation: 'preparing', confirmationDigest: input.offerDigest };
    const update = (status, value, nextView) => {
      value.status = status;
      if (db.prepare('UPDATE authoring_conversations SET status=?,state=?,view=?,updated_at=? WHERE id=? AND owner_id=? AND run_id=? AND version=?')
        .run(status, encode(value), encode(nextView), Date.now(), id, owner, runId, row.version).changes !== 1) stop('STALE_CONTEXT');
    };
    update('RUNNING', state, startingView);
    const authorize = () => {
      assertLease(lease);
      const now = rowFor(owner, id);
      if (closing || signal.aborted || now?.run_id !== runId || now.version !== row.version || now.cancel_requested
          || now.status !== 'RUNNING' || latestSegment(owner, extensionId)?.id !== id) stop('STALE_CONTEXT');
      if (!currentIs(decode(now).state.handles)) stop('STALE_DRAFT');
    };
    live.set(runId, job);
    job.promise = (async () => {
      try {
        let failure;
        try {
          const { hookId, modelDigest, sourceJson: source, cases } = proposal;
          await lifecycle.compile(owner, { extensionId, hookId, modelDigest, source, draftVersion: base.draftVersion }, authorize,
            { signal, confirmed: { cases, saved(handles) {
              // Record the exact save in the same transaction as the revision and suite.
              update('RUNNING', { ...state, handles }, { ...startingView, confirmation: 'saved' });
            } } });
          authorize();
          const saved = decode(rowFor(owner, id));
           await lifecycle.simulate(owner, { ...saved.state.handles, extensionId }, authorize, { signal, checked(proof) {
             update('RUNNING', saved.state, { ...saved.view, review: { ...saved.state.handles, ...proof } });
           } });
        } catch (cause) { failure = cause; }
        transaction(db, () => {
          const now = rowFor(owner, id);
          if (now?.run_id !== runId || now.version !== row.version) return;
          const saved = decode(now), result = saved.view, handles = saved.state.handles;
          const cancelled = now.cancel_requested || signal.aborted || lease.current() !== true;
          const committed = result.confirmation === 'saved';
          let latest;
          try { latest = current(); } catch { /* Do not guess if saved state is no longer readable. */ }
           const review = committed && result.review && same(result.review, handles) ? result.review : null;
          result.confirmation = review ? (review.eligible ? 'passed' : 'failed')
            : committed ? 'saved' : same(base, latest && draftHandles(latest)) ? 'unsaved' : 'uncertain';
          result.review = review;
          result.code = review || committed ? null : cancelled ? 'CANCELLED'
            : result.confirmation === 'unsaved' && [400, 413, 422].includes(failure?.status) ? 'PERSONAL_OFFER_INVALID' : 'CHECKPOINT_UNCERTAIN';
          if (result.code === 'PERSONAL_OFFER_INVALID') {
            const diagnostics = Array.isArray(failure.diagnostics) ? failure.diagnostics.slice(0, 4).flatMap(item =>
              typeof item?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(item.code)
              && typeof item.path === 'string' && /^\/(?:source|cases)(?:\/[a-zA-Z0-9_]+)*$/.test(item.path) && item.path.length <= 256
                ? [{ code: item.code, path: item.path }] : []) : [];
            result.rejectedOffer = { proposal, diagnostics };
          }
          const text = { passed: 'The draft was saved and its examples passed. It is not approved or turned on.',
            failed: 'The draft was saved, but some examples did not pass. It is not ready for approval.',
            saved: 'The draft was saved. Its example checks are unavailable.',
            unsaved: result.code === 'PERSONAL_OFFER_INVALID'
              ? safeMessage(result.code)
              : 'No draft was saved. Your earlier saved work is unchanged.',
            uncertain: 'Daymark could not verify the result. Read the current draft before continuing.' }[result.confirmation];
          appendMessage(owner, id, { id: `${runId}-confirm`, role: 'host', kind: review ? 'review' : 'text', text,
            ...(review && { receipt: { ...handles, evidenceId: review.evidenceId } }) });
          update(review ? 'REVIEW_AVAILABLE' : cancelled ? 'CANCELLED' : committed ? 'IDLE' : 'BLOCKED', saved.state, result);
        });
      } finally { live.delete(runId); }
    })();
    void job.promise.catch(() => {});
    return read(owner, id);
  }
  function cancel(owner, id, input, lease) {
    assertLease(lease);
    if (!object(input) || Object.keys(input).length !== 2 || !token(input.runId) || !integer(input.expectedVersion)) throw error(400, 'INVALID_TOOL_ARGUMENTS');
    const row = rowFor(owner, id), link = linkFor(owner, id);
    if (!row || !link || decode(row).state.definitionId !== TASK_DEFINITION) throw error(404, 'STALE_CONVERSATION');
    lifecycle.assertAvailable(owner, link.extension_id);
    if (row.run_id !== input.runId || row.version !== input.expectedVersion) throw error(409, 'STALE_CONVERSATION');
    if (['RUNNING', 'CANCELLING'].includes(row.status)) {
      const running = live.get(input.runId);
      db.prepare("UPDATE authoring_conversations SET cancel_requested=1,status='CANCELLING' WHERE id=? AND owner_id=? AND run_id=? AND version=?")
        .run(id, owner, input.runId, input.expectedVersion);
      running?.controller.abort();
    }
    return read(owner, id);
  }
  const scopedTurns = {
    db, live, safeMessage, codeFor,
    availability: ready => availability(ready, true),
    provider: () => providerFactory(config),
    budget: () => Math.max(0, config.maxMicros - effectiveHeld()), recordDispatchResult,
    reserve(micros) {
      if (!integer(micros) || micros !== config.reserveMicros || effectiveHeld() + micros > config.maxMicros) stop('SPEND_LIMIT');
      db.prepare('UPDATE authoring_budget SET reserved_micros=? WHERE id=1').run(held() + micros);
    },
  };
  const team = teamCapability && createTeamAuthoringTurns({
    ...scopedTurns, capability: teamCapability, projects: teamProjects,
    access(actor, projectId, lease) {
      if (closing || !lease || !token(lease.sessionId) || lease.current() !== true) throw error(401, 'STALE_CONTEXT');
      if (projectAccess(db, actor, projectId, true).mode !== 'TEAM') throw error(404, 'STALE_CONTEXT');
    },
  });
   const shared = sharedCompletionCompiler !== undefined && sharedCompletionAuthoring({ db, lifecycle, teamCapability, live, compiler: sharedCompletionCompiler,
     projects: readProjects,
    assertLease: lease => { if (closing) stop('STALE_CONTEXT'); assertLease(lease); }, fault: checkpointFault });
  return {
    list, read, turn, confirm, cancel, availability, allowance, messages: messagePage, transcript, team,
    ...(shared && { sharedCompletion: { ...createScopedAuthoringTurns({ ...scopedTurns, access: shared.access, shared,
      availability: guideReady => sharedCompletionCompiler ? availability(guideReady, true) : { available: false, code: 'HOST_UNAVAILABLE' } }),
      review: shared.review, decide: shared.decide } }),
    assertItemIdle(owner, extensionId) {
      if ([...live.values()].some(ctx => ctx.owner === owner && ctx.extensionId === extensionId)) {
        const failure = new AppError(409, 'Open this customization and use Stop, then wait for authoring to settle before deleting it.');
        failure.code = 'CUSTOMIZATION_BUSY'; throw failure;
      }
    },
    recover(owner, input) {
      validate(input);
      const row = input.conversationId ? rowFor(owner, input.conversationId)
        : db.prepare('SELECT * FROM authoring_conversations WHERE owner_id=? AND creation_operation_id=?').get(owner, input.operationId);
      const receipt = row && db.prepare('SELECT * FROM authoring_operations WHERE conversation_id=? AND owner_id=? AND operation_id=?').get(row.id, owner, input.operationId);
      if (!receipt) throw error(404, 'STALE_CONVERSATION');
      if (receipt.body_hash !== digest(Buffer.from(json(input)))) throw error(409, 'STALE_CONVERSATION');
      const link = linkFor(owner, row.id);
      if (!link || input.target.kind !== 'create' && input.target.extensionId !== link.extension_id) throw error(404, 'STALE_CONVERSATION');
      lifecycle.assertAvailable(owner, link.extension_id, true);
      return { operation: operation(receipt.operation_id, receipt.run_id, receipt.admitted_version), conversation: dto(row) };
    },
    configure(next, persist) {
      if (closing || live.size) throw error(409, 'AI_BUSY');
      if (next.status !== 'ready') throw error(400, 'AI_CONFIG_INVALID');
      if (next.maxMicros < effectiveHeld()) throw error(409, 'SPEND_LIMIT');
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
