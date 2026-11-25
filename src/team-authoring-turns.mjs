import { randomUUID } from 'node:crypto';
import { AppError, transaction } from './data.mjs';
import { digest, json } from './extension-catalog.mjs';
import { AuthoringError } from './authoring-provider.mjs';
import { createAuthoringState, loadAuthoringInstructions, runAuthoringTurn } from './keir-authoring-agent.mjs';
import { teamAuthoringHost, teamConversationTools, teamConversationHandlers } from './team-authoring-host.mjs';

const definitionId = 'daymark.team-authoring/1';
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const version = value => Number.isSafeInteger(value) && value >= 0;
const draftMatches = (a, b) => a?.revisionId === b?.revisionId && a?.draftVersion === b?.draftVersion && a?.suiteDigest === b?.suiteDigest;
const conflict = () => new AppError(409, 'The saved discussion or draft changed. Read it before continuing.');

// Use the same durable conversation, operation and spend journal as Personal.
// The project binding lives in the conversation state and is never taken from the model.
export function createTeamAuthoringTurns({ db, capability, projects, access, live, availability, provider, budget, reserve, safeMessage, codeFor }) {
  const rowFor = (actor, projectId) => db.prepare(`SELECT * FROM authoring_conversations WHERE owner_id=?
    AND json_extract(state,'$.definitionId')=? AND json_extract(state,'$.projectId')=? ORDER BY created_at DESC LIMIT 1`).get(actor, definitionId, projectId);
  transaction(db, () => {
    const interrupted = db.prepare(`SELECT id,owner_id,run_id FROM authoring_conversations
      WHERE json_extract(state,'$.definitionId')=? AND status IN ('RUNNING','CANCELLING')`).all(definitionId);
    for (const row of interrupted) {
      db.prepare(`UPDATE authoring_dispatches SET outcome='UNKNOWN' WHERE conversation_id=? AND owner_id=? AND run_id=? AND outcome IS NULL`)
        .run(row.id, row.owner_id, row.run_id);
      db.prepare(`UPDATE authoring_conversations SET cancel_requested=1,status='INTERRUPTED',view='{"code":"RUN_INTERRUPTED"}'
        WHERE id=? AND run_id=?`).run(row.id, row.run_id);
    }
  });
  const messagesFor = row => db.prepare(`SELECT payload FROM authoring_messages WHERE conversation_id=? AND owner_id=?
    ORDER BY sequence DESC LIMIT 20`).all(row.id, row.owner_id).reverse().map(item => JSON.parse(item.payload));
  function append(row, id, role, text) {
    if (!text) return;
    const sequence = db.prepare('SELECT coalesce(max(sequence),0)+1 AS n FROM authoring_messages WHERE conversation_id=?').get(row.id).n;
    db.prepare('INSERT INTO authoring_messages VALUES (?,?,?,?,?)')
      .run(row.id, row.owner_id, sequence, id, JSON.stringify({ id, role, kind: 'text', text }));
  }
  function read(actor, projectId, lease) {
    access(actor, projectId, lease);
    const row = rowFor(actor, projectId);
    if (!row) return { availability: availability(), conversation: null };
    const { proposal, ...view } = JSON.parse(row.view);
    return { availability: availability(), conversation: {
      id: row.id, version: row.version, status: row.status, runId: row.run_id, ...view, messages: messagesFor(row),
      agreement: proposal?.agreement ?? null,
    } };
  }

  async function turn(actor, projectId, input, lease) {
    access(actor, projectId, lease);
    if (!input || Object.keys(input).length !== 4 || !token(input.operationId) || !version(input.expectedVersion)
        || !version(input.expectedDraftVersion) || typeof input.text !== 'string' || !input.text.trim() || !input.text.isWellFormed()
        || Buffer.byteLength(input.text) > 8192) throw new AppError(400, 'Send a short request with its saved version.');
    const prior = rowFor(actor, projectId), hash = digest(json(input));
    const replay = prior && db.prepare('SELECT body_hash FROM authoring_operations WHERE conversation_id=? AND owner_id=? AND operation_id=?')
      .get(prior.id, actor, input.operationId);
    if (replay) {
      if (replay.body_hash !== hash) throw conflict();
      return read(actor, projectId, lease);
    }
    if (db.prepare('SELECT 1 FROM authoring_operations WHERE owner_id=? AND operation_id=? LIMIT 1').get(actor, input.operationId)) throw conflict();
    const instructions = loadAuthoringInstructions(), available = availability(Boolean(instructions));
    if (!available.available) throw new AppError(503, safeMessage(available.code));
    if (live.size >= 2 || [...live.values()].some(job => job.owner === actor || job.projectId === projectId))
      throw new AppError(429, safeMessage('AI_BUSY'));
    if (input.expectedVersion !== (prior?.version ?? 0) || ['RUNNING', 'CANCELLING'].includes(prior?.status)) throw conflict();
    const id = prior?.id ?? randomUUID(), runId = randomUUID(), controller = new AbortController();
    const authorize = () => { access(actor, projectId, lease); return actor; };
    const scoped = teamAuthoringHost({ capability, projects, actor, projectId, authorize });
    const start = scoped.readDraft();
    if (start.draftVersion !== input.expectedDraftVersion) throw conflict();
    const state = createAuthoringState({ ownerId: actor, sessionId: lease.sessionId, conversationId: id, runId });
    Object.assign(state, { version: input.expectedVersion, definitionId, projectId, handles: start, baseDraft: start });
    const encoded = () => JSON.stringify({ definitionId, projectId, sessionId: lease.sessionId, baseDraft: start, handles: state.handles });
    const row = { id, owner_id: actor };
    const previous = prior ? messagesFor(prior) : [];
    const last = previous.at(-1);
    const texts = previous.filter(message => message.role === 'user').slice(-6).map(message => message.text);
    while (Buffer.byteLength(JSON.stringify(texts)) > 8192) texts.shift();
    const history = { texts, truncated: previous.length === 20,
      ...(prior?.status === 'AWAITING_USER' && last?.role === 'assistant' && { clarification: last.text }) };
    const ctx = { owner: actor, projectId, id, runId, lease, controller, admitted: false, tracked: new Set() };
    const currentRow = () => rowFor(actor, projectId);
    const ownsRun = saved => saved?.id === id && saved.run_id === runId && saved.version === state.version;
    const current = () => {
      if (controller.signal.aborted) return false;
      try { authorize(); } catch { return false; }
      const saved = currentRow();
      return ctx.admitted ? ownsRun(saved) && JSON.parse(saved.state).sessionId === lease.sessionId && saved.cancel_requested === 0
        : (saved?.version ?? 0) === input.expectedVersion && draftMatches(start, scoped.readDraft());
    };
    const context = { ownerId: actor, sessionId: lease.sessionId, conversationId: id, runId, current,
      budget: { remainingMicros: budget() },
      checkpoint(value) {
        transaction(db, () => {
          if (!current()) throw new AuthoringError('STALE_CONTEXT');
          const cp = value.checkpoint;
          if (cp.phase === 'ADMIT') {
            const now = Date.now();
            if (prior) db.prepare(`UPDATE authoring_conversations SET version=?,run_id=?,status='RUNNING',cancel_requested=0,
              updated_at=?,state=?,view='{}' WHERE id=? AND owner_id=?`).run(value.version, runId, now, encoded(), id, actor);
            else db.prepare(`INSERT INTO authoring_conversations
              (id,owner_id,creation_operation_id,version,run_id,status,cancel_requested,updated_at,state,operations,view,created_at)
              VALUES (?,?,?,?,?,'RUNNING',0,?,?,'[]','{}',?)`).run(id, actor, input.operationId, value.version, runId, now, encoded(), now);
            db.prepare('INSERT INTO authoring_operations VALUES (?,?,?,?,?,?)').run(id, actor, input.operationId, hash, runId, value.version);
            append(row, input.operationId, 'user', input.text);
          } else if (cp.phase === 'DISPATCH') {
            const micros = cp.kind === 'provider' ? native.reserveMicros : 0;
            if (micros) reserve(micros);
            db.prepare('INSERT INTO authoring_dispatches VALUES (?,?,?,?,?,?,?,NULL)')
              .run(id, actor, runId, cp.ordinal, cp.kind, cp.callId ?? null, micros);
          } else if (cp.phase === 'RESULT') {
            if (db.prepare(`UPDATE authoring_dispatches SET outcome=? WHERE conversation_id=? AND owner_id=? AND run_id=? AND ordinal=? AND outcome IS NULL`)
                .run(cp.outcome, id, actor, runId, cp.ordinal).changes !== 1) throw new AuthoringError('CHECKPOINT_UNCERTAIN');
            db.prepare('UPDATE authoring_conversations SET state=? WHERE id=? AND run_id=?').run(encoded(), id, runId);
          }
        });
        if (value.checkpoint.phase === 'ADMIT') ctx.admitted = true;
        context.budget.remainingMicros = budget();
      },
    };
    const track = async work => {
      const pending = Promise.resolve().then(work);
      ctx.tracked.add(pending);
      try { return await pending; } finally { ctx.tracked.delete(pending); }
    };
    let native;
    try { native = provider(); } catch { throw new AppError(503, safeMessage('TOOL_FAILED')); }
    live.set(runId, ctx);
    ctx.promise = (async () => {
      try {
        const result = await runAuthoringTurn({ provider: { ...native, complete: value => track(() => native.complete(value)) },
          host: scoped, tools: teamConversationTools, hostTools: teamConversationHandlers, context, state, instructions, priorUserMessages: history,
          input: { id: input.operationId, expectedVersion: input.expectedVersion, intent: 'auto', text: input.text }, signal: controller.signal });
        await Promise.allSettled([...ctx.tracked]);
        if (!ctx.admitted) throw new AppError(409, safeMessage(codeFor(result.code)));
        transaction(db, () => {
          const saved = currentRow();
          if (!ownsRun(saved)) return;
          const cancelled = saved.cancel_requested === 1 || controller.signal.aborted;
          const accepted = !cancelled && current() && draftMatches(state.handles, scoped.readDraft());
          const status = cancelled ? 'CANCELLED' : accepted ? result.status : 'BLOCKED';
          const code = cancelled ? 'CANCELLED' : !accepted ? 'STALE_CONTEXT' : result.code ? codeFor(result.code) : null;
          const proposal = accepted ? result.proposal : undefined;
          const text = code ? safeMessage(code) : accepted ? result.message?.slice(0, 8192) : null;
          append(row, `${runId}-assistant`, 'assistant', text);
          db.prepare(`UPDATE authoring_dispatches SET outcome='UNKNOWN' WHERE conversation_id=? AND owner_id=? AND run_id=? AND outcome IS NULL`).run(id, actor, runId);
          db.prepare('UPDATE authoring_conversations SET status=?,updated_at=?,state=?,view=? WHERE id=? AND run_id=?')
            .run(status, Date.now(), encoded(), JSON.stringify({ code, proposal }), id, runId);
        });
      } finally { live.delete(runId); }
    })();
    if (!ctx.admitted) await ctx.promise;
    else void ctx.promise.catch(() => {});
    return read(actor, projectId, lease);
  }

  function cancel(actor, projectId, input, lease) {
    access(actor, projectId, lease);
    const row = rowFor(actor, projectId);
    if (!input || Object.keys(input).length !== 2 || !token(input.runId) || !version(input.expectedVersion)
        || row?.run_id !== input.runId || row?.version !== input.expectedVersion) throw conflict();
    if (row.status === 'RUNNING' || row.status === 'CANCELLING') {
      db.prepare("UPDATE authoring_conversations SET cancel_requested=1,status='CANCELLING' WHERE id=? AND run_id=?").run(row.id, row.run_id);
      live.get(row.run_id)?.controller.abort();
    }
    return read(actor, projectId, lease);
  }
  async function confirm(actor, projectId, input, lease, signal) {
    access(actor, projectId, lease);
    const row = rowFor(actor, projectId);
    if (!input || Object.keys(input).length !== 2 || !token(input.runId) || !version(input.expectedVersion)
        || row?.run_id !== input.runId || row.version !== input.expectedVersion || row.status !== 'AWAITING_USER') throw conflict();
    const { proposal } = JSON.parse(row.view), prior = JSON.parse(row.state);
    if (!proposal || [...live.values()].some(job => job.projectId === projectId)) throw conflict();
    const controller = new AbortController();
    const authorize = () => {
      access(actor, projectId, lease);
      const now = rowFor(actor, projectId);
      if (controller.signal.aborted || signal?.aborted || now?.run_id !== row.run_id || now.version !== row.version
          || now.status !== 'AWAITING_USER' || now.view !== row.view) throw conflict();
      return actor;
    };
    const host = teamAuthoringHost({ capability, projects, actor, projectId, authorize });
    if (!draftMatches(prior.handles, host.readDraft())) throw conflict();
    const job = { owner: actor, projectId, id: row.id, runId: row.run_id, controller, lease };
    live.set(row.run_id, job);
    job.promise = (async () => {
      try {
        const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        let draft;
        try { draft = await host.save(JSON.stringify(proposal), { draft: prior.handles, signal: active }); }
        catch (error) {
          if (error instanceof AuthoringError) throw new AppError(error.code === 'STALE_DRAFT' ? 409 : 422, safeMessage(error.code));
          throw error;
        }
        authorize();
        db.prepare("UPDATE authoring_conversations SET status='IDLE',view='{}',updated_at=? WHERE id=? AND run_id=?")
          .run(Date.now(), row.id, row.run_id);
        // Save already committed. An unavailable check must not ask the user to prepare it again.
        const authorizeCheck = () => {
          access(actor, projectId, lease);
          const now = rowFor(actor, projectId);
          if (active.aborted || now?.run_id !== row.run_id || now.version !== row.version || now.status !== 'IDLE') throw conflict();
          return actor;
        };
        const checkHost = teamAuthoringHost({ capability, projects, actor, projectId, authorize: authorizeCheck });
        try { await checkHost.simulate(draft.revisionId, draft.draftVersion, active); }
        catch {
          authorizeCheck();
          if (!draftMatches(draft, checkHost.readDraft())) throw conflict();
          db.prepare("UPDATE authoring_conversations SET view=? WHERE id=? AND run_id=?")
            .run(JSON.stringify({ checkUnavailable: true }), row.id, row.run_id);
        }
      } finally { live.delete(row.run_id); }
    })();
    await job.promise;
    return read(actor, projectId, lease);
  }
  return { read, turn, cancel, confirm };
}
