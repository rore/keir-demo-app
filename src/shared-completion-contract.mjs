import { AppError } from './data.mjs';
import { admitArtifact, BEFORE_CREATE, BEFORE_COMPLETE, TASK_CREATED, TASK_HOOK, digest, json, ownedProjectDefinition, sharedBeforeCompleteDefinition, sharedBeforeCreateDefinition, sharedCompletionDefinition, sharedCreatedDefinition } from './extension-catalog.mjs';
import { taskRuleDescription } from './task-rule-description.mjs';
import { normalizeTaskTags, normalizeWorkflowTitle } from './task-workflow-values.mjs';

export const SHARED_MANIFEST = 'daymark.shared-completion/1';
const LEGACY_CHECK = 'daymark.shared-completion-check/2';
export const SHARED_CHECK = 'daymark.shared-completion-check/3';
export const LOOKUP_CHECK = 'daymark.shared-completion-check/4';
export const PRIORITY_CHECK = 'daymark.shared-completion-check/5';
export const DUE_CHECK = 'daymark.shared-completion-check/6';
export const TAG_CHECK = 'daymark.shared-completion-check/7';
export const COMPLETED_UPDATE_CHECK = 'daymark.shared-completion-check/8';
export const GUARD_CHECK = 'daymark.shared-before-create-check/1';
export const CREATED_CHECK = 'daymark.shared-created-check/1';
export const CREATED_UPDATE_CHECK = 'daymark.shared-created-check/2';
export const OWNED_CREATED_CHECK = 'daymark.personal-owned-created-check/1';
export const OWNED_COMPLETED_CHECK = 'daymark.personal-owned-completed-check/1';
export const OWNED_CREATED_UPDATE_CHECK = 'daymark.personal-owned-created-check/2';
export const OWNED_COMPLETED_UPDATE_CHECK = 'daymark.personal-owned-completed-check/2';
export const EXACT_CREATED_CHECK = 'daymark.personal-owned-created-check/3';
export const EXACT_COMPLETED_CHECK = 'daymark.personal-owned-completed-check/3';
export const EXACT_CREATED_CREATE_CHECK = 'daymark.personal-owned-created-check/4';
export const EXACT_COMPLETED_CREATE_CHECK = 'daymark.personal-owned-completed-check/4';
export const EXACT_CREATED_LOOKUP_UPDATE_CHECK = 'daymark.personal-owned-created-check/5';
export const EXACT_COMPLETED_LOOKUP_UPDATE_CHECK = 'daymark.personal-owned-completed-check/5';
export const OWNED_GUARD_CHECK = 'daymark.shared-before-create-check/2';
const exactCreates = [EXACT_CREATED_CREATE_CHECK, EXACT_COMPLETED_CREATE_CHECK];
const exactLookupUpdates = [EXACT_CREATED_LOOKUP_UPDATE_CHECK, EXACT_COMPLETED_LOOKUP_UPDATE_CHECK];
export const exactTaskCheck = harness => [EXACT_CREATED_CHECK, EXACT_COMPLETED_CHECK, ...exactCreates, ...exactLookupUpdates].includes(harness);
export const guardCheck = harness => [GUARD_CHECK, OWNED_GUARD_CHECK].includes(harness);
const ownedUpdates = [OWNED_CREATED_UPDATE_CHECK, OWNED_COMPLETED_UPDATE_CHECK, ...exactLookupUpdates];
export const ownedProjectCheck = harness => [OWNED_CREATED_CHECK, OWNED_COMPLETED_CHECK, ...ownedUpdates, ...exactCreates].includes(harness);
export const COMPLETION_GATE_CHECK = 'daymark.shared-before-complete-check/1';
const createdChecks = [CREATED_CHECK, CREATED_UPDATE_CHECK, OWNED_CREATED_CHECK, OWNED_CREATED_UPDATE_CHECK, EXACT_CREATED_CHECK,
  EXACT_CREATED_CREATE_CHECK, EXACT_CREATED_LOOKUP_UPDATE_CHECK];
export const sharedHook = manifest => guardCheck(completionHarness(manifest)) ? BEFORE_CREATE
  : completionHarness(manifest) === COMPLETION_GATE_CHECK ? BEFORE_COMPLETE
  : createdChecks.includes(completionHarness(manifest)) ? TASK_CREATED : TASK_HOOK;
const dueChecks = [DUE_CHECK, TAG_CHECK];
const combinedUpdateChecks = [CREATED_UPDATE_CHECK, COMPLETED_UPDATE_CHECK, ...ownedUpdates, EXACT_CREATED_CHECK, EXACT_COMPLETED_CHECK];
export const hasLookupCases = harness => ownedProjectCheck(harness) || [...createdChecks, EXACT_COMPLETED_CHECK, COMPLETED_UPDATE_CHECK, LOOKUP_CHECK, PRIORITY_CHECK, ...dueChecks].includes(harness);
export const projectRefValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const sourceExpectation = value => value && ['sourceAfter', 'sourceDueAt', 'sourcePriority', 'sourceTags'].find(key => Object.hasOwn(value, key)) || null;
export const SAME_PROJECT = 'SAME_PROJECT';
const hooks = ['TaskBeforeComplete', 'TaskBeforeCreate', 'TaskCompleted', 'TaskCreated'];
const unavailable = () => new AppError(503, 'The exact shared completion revision is unavailable.');
const keys = (value, names) => value && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
// The exact installed 0.5.0 package ships the compiler-compatible JSON codec but doesn't export it at its entry point.
// Keep the private import isolated here; if the pinned layout changes, shared authoring fails closed.
const codec = await import(new URL('./canonical.js', import.meta.resolve('@keir/runtime-node'))).catch(() => null);
function canonicalSourceDigest(source) {
  if (!codec) throw unavailable();
  try {
    const bytes = Buffer.from(source);
    return digest(codec.canonicalBytes(codec.parseModelJson(bytes)));
  } catch { throw new AppError(400, 'Use Keir JSON source for shared completion.'); }
}

export function sharedHost(scope, harness) {
  if (exactTaskCheck(harness) || harness === OWNED_GUARD_CHECK) {
    if (scope !== 'PERSONAL') throw unavailable();
    return exactTaskCheck(harness) ? ownedProjectDefinition(sharedHook({ harness }),
      exactLookupUpdates.includes(harness) ? '5' : exactCreates.includes(harness) ? '4' : '3')
      : sharedBeforeCreateDefinition(scope, '2');
  }
  if (ownedProjectCheck(harness)) {
    if (scope !== 'PERSONAL') throw unavailable();
    return ownedProjectDefinition(sharedHook({ harness }), ownedUpdates.includes(harness) ? '2' : '1');
  }
  return harness === GUARD_CHECK ? sharedBeforeCreateDefinition(scope)
    : harness === COMPLETION_GATE_CHECK ? sharedBeforeCompleteDefinition(scope)
    : harness === CREATED_UPDATE_CHECK ? sharedCreatedDefinition(scope, '2')
    : harness === CREATED_CHECK ? sharedCreatedDefinition(scope)
    : sharedCompletionDefinition(scope, harness === COMPLETED_UPDATE_CHECK ? '6' : harness === TAG_CHECK ? '5' : harness === DUE_CHECK ? '4'
      : harness === PRIORITY_CHECK ? '3' : harness === LOOKUP_CHECK ? '2' : '1');
}
export function scopedCompletionManifest(scope, subject, source, artifact, cases, harness = TAG_CHECK) {
  const host = sharedHost(scope, harness), hook = host.pins.hook;
  const model = JSON.parse(host.dcmBytes);
  const binding = { ...host.pins, grants: Object.keys(model.capabilities),
     placement: hook === BEFORE_CREATE ? 'before-native-create' : hook === BEFORE_COMPLETE ? 'before-native-completion'
       : hook === TASK_CREATED ? 'after-native-create' : 'after-native-completion',
    rawSourceDigest: digest(source), artifactDigest: digest(artifact),
    compiledSourceDigest: canonicalSourceDigest(source) };
  return { format: SHARED_MANIFEST, scope, subject, caseDigest: digest(json(cases)),
    ...(harness !== LEGACY_CHECK && { harness }),
    hooks: Object.fromEntries(hooks.map(id => [id, id === hook ? binding : null])) };
}

export const completionHarness = manifest => Object.hasOwn(manifest, 'harness') ? manifest.harness : LEGACY_CHECK;

export function readCompletionManifest(scope, subject, manifest, source, artifact, cases) {
  try {
    const harness = completionHarness(manifest);
    cases = completionCases(cases, harness);
    if (typeof source !== 'string' || !source.length || !source.isWellFormed() || Buffer.byteLength(source) > 65536
        || !(artifact instanceof Uint8Array) || !artifact.byteLength || artifact.byteLength > 1048576
        || !keys(manifest?.hooks, hooks) || json(manifest) !== json(scopedCompletionManifest(scope, subject, source, artifact, cases, harness)))
      throw unavailable();
    const host = sharedHost(scope, harness), hook = host.pins.hook;
    const checked = admitArtifact(artifact, host);
    if (checked.sourceDigest !== manifest.hooks[hook].compiledSourceDigest) throw unavailable();
    const write = checked.steps.find(step => step.op === 'CALL' && ['tasks.create', 'tasks.update'].includes(step.capability));
    return { host, artifact: Buffer.from(artifact), manifest, harness, cases, hook, write, returnedStatus: checked.return.fields.status,
      ...(harness === COMPLETION_GATE_CHECK && { usesLinkedTask: checked.steps.some(step => step.capability === 'tasks.linkedTask') }),
      executableIdentity: digest(json(manifest)) };
  } catch { throw unavailable(); }
}

export function completionOffer(input) {
  const hook = input?.bindings?.[BEFORE_CREATE] === null ? TASK_HOOK : BEFORE_CREATE;
  const source = input?.bindings?.[hook], harness = hook === BEFORE_CREATE ? GUARD_CHECK : TAG_CHECK;
  if (!keys(input, ['bindings', 'cases']) || !keys(input.bindings, hooks)
      || hooks.some(id => id !== hook && input.bindings[id] !== null)
      || typeof source !== 'string' || !source.isWellFormed() || !source.trim() || Buffer.byteLength(source) > 65536)
    throw new AppError(400, 'Supply one rule and explicitly absent unused bindings.');
  canonicalSourceDigest(source);
  return { hook, harness, source, cases: completionCases(input.cases, harness) };
}

export function completionCases(cases, harness = TAG_CHECK) {
  const invalid = () => new AppError(400, 'Supply independent bounded completion examples.');
  if (![LEGACY_CHECK, SHARED_CHECK, COMPLETION_GATE_CHECK].includes(harness) && !guardCheck(harness) && !hasLookupCases(harness)) throw invalid();
  const lookup = hasLookupCases(harness), full = harness !== LEGACY_CHECK, owned = ownedProjectCheck(harness);
  const exact = exactTaskCheck(harness), ownedGuard = harness === OWNED_GUARD_CHECK;
  const fields = ['title', 'dueAt', 'linked', 'assigneeId', ...(full ? ['project', 'notes', 'tags', 'priority'] : [])];
  const inputFields = ['id', 'title', 'tags', 'occurredAt', 'expect', ...(full ? ['priority'] : []),
     ...(owned ? ['projectId', 'openProjects'] : lookup && !exact ? ['openTitles'] : []), ...(exact ? ['referenceTasks'] : [])];
  const title = value => {
    try { return normalizeWorkflowTitle(value) === value; } catch { return false; }
  };
  const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value && value >= '0001-01-01';
  const priority = value => ['low', 'normal', 'high'].includes(value);
  const due = value => value === null || instant(value);
  const canonicalTags = value => {
    try { return json(normalizeTaskTags(value)) === json(value); } catch { return false; }
  };
  const titles = values => Array.isArray(values) && values.length <= 8 && new Set(values).size === values.length && values.every(title);
  const projectRows = rows => Array.isArray(rows) && rows.length <= 4
    && rows.every(row => keys(row, ['projectId', 'titles']) && projectRefValid(row.projectId) && titles(row.titles))
    && new Set(rows.map(row => row.projectId)).size === rows.length;
  const referenceTasks = (rows, required) => Array.isArray(rows) && rows.length <= 4 && (!required || rows.length > 0)
    && rows.every(row => keys(row, ['id', 'projectId', 'title', 'priority', 'tags', 'dueAt', 'status'])
      && projectRefValid(row.id) && projectRefValid(row.projectId) && title(row.title)
      && priority(row.priority) && canonicalTags(row.tags) && due(row.dueAt) && ['OPEN', 'COMPLETED'].includes(row.status))
    && new Set(rows.map(row => row.id)).size === rows.length;
  if (!Array.isArray(cases) || !cases.length || cases.length > 8) throw invalid();
  const ids = new Set();
  for (const c of cases) {
    if (ownedGuard) {
      const { referenceTasks: tasks, openProjects, ...candidate } = c ?? {};
      if (!referenceTasks(tasks, false) || !projectRows(openProjects) || Object.hasOwn(candidate, 'openTitles') || ids.has(candidate.id)) throw invalid();
      completionCases([candidate], GUARD_CHECK);
      ids.add(candidate.id);
      continue;
    }
    if (harness === COMPLETION_GATE_CHECK) {
      if (!keys(c, ['id', 'projectId', 'title', 'priority', 'tags', 'hasNotes', 'hasDueDate', 'linkedStatus', 'expect'])
          || !title(c.title) || ![null, 'MISSING', 'OPEN', 'COMPLETED'].includes(c.linkedStatus)) throw invalid();
      const { title: _title, linkedStatus, ...candidate } = c;
      completionCases([candidate], GUARD_CHECK);
      if (ids.has(c.id)) throw invalid();
      ids.add(c.id); continue;
    }
    if (harness === GUARD_CHECK) {
      const e = c?.expect;
      const openTitles = Object.hasOwn(c ?? {}, 'openTitles');
      if (!keys(c, ['id', 'projectId', 'priority', 'tags', 'hasNotes', 'hasDueDate', 'expect', ...(openTitles ? ['openTitles'] : [])]) || typeof c.id !== 'string'
          || !/^[A-Za-z0-9_-]{1,64}$/.test(c.id) || ids.has(c.id) || typeof c.projectId !== 'string'
          || !/^[A-Za-z0-9_-]{1,128}$/.test(c.projectId) || !priority(c.priority) || !canonicalTags(c.tags)
          || typeof c.hasNotes !== 'boolean' || typeof c.hasDueDate !== 'boolean'
          || openTitles && (!Array.isArray(c.openTitles) || c.openTitles.length > 8 || new Set(c.openTitles).size !== c.openTitles.length
            || c.openTitles.some(value => !title(value)))
          || !keys(e, ['decision', 'message']) || typeof e.message !== 'string' || !e.message.isWellFormed()
          || Buffer.byteLength(e.message) > 256 || (e.decision === 'ALLOW' ? e.message !== '' : e.decision !== 'DENY' || !e.message.trim())) throw invalid();
      ids.add(c.id);
      continue;
    }
    const dueInput = (owned || exact || createdChecks.includes(harness) || harness === COMPLETED_UPDATE_CHECK || dueChecks.includes(harness))
      && Object.hasOwn(c ?? {}, 'sourceDueAt');
    if (!keys(c, dueInput ? [...inputFields, 'sourceDueAt'] : inputFields) || (owned || exact) && !dueInput
        || dueInput && !due(c.sourceDueAt) || typeof c.id !== 'string'
        || !/^[A-Za-z0-9_-]{1,64}$/.test(c.id) || ids.has(c.id) || !title(c.title) || !instant(c.occurredAt)
        || full && !priority(c.priority)) throw invalid();
    if (!canonicalTags(c.tags)) throw invalid();
    if (exact && !referenceTasks(c.referenceTasks, true)) throw invalid();
    if (owned ? !projectRefValid(c.projectId) || !projectRows(c.openProjects)
       || !c.openProjects.some(row => row.projectId === c.projectId)
       : lookup && !exact && !titles(c.openTitles)) throw invalid();
    ids.add(c.id);
    const e = c.expect;
    if (combinedUpdateChecks.includes(harness) && dueInput && keys(e, ['sourceAfter'])
        && keys(e.sourceAfter, ['priority', 'dueAt', 'tags']) && priority(e.sourceAfter.priority)
        && due(e.sourceAfter.dueAt) && canonicalTags(e.sourceAfter.tags)) continue;
    if ((ownedUpdates.includes(harness) || exact && !owned) && e !== null) throw invalid();
    if ([PRIORITY_CHECK, ...dueChecks].includes(harness) && keys(e, ['sourcePriority']) && priority(e.sourcePriority)) continue;
    if (dueInput && dueChecks.includes(harness) && keys(e, ['sourceDueAt']) && due(e.sourceDueAt)) continue;
    if (harness === TAG_CHECK && keys(e, ['sourceTags']) && canonicalTags(e.sourceTags)) continue;
    if (e !== null && (!keys(e, fields) || !title(e.title)
        || e.dueAt !== null && !instant(e.dueAt) || typeof e.linked !== 'boolean'
        || e.assigneeId !== null && (typeof e.assigneeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(e.assigneeId))
         || full && ((owned ? !projectRefValid(e.project) || !c.openProjects.some(row => row.projectId === e.project) || e.linked || e.assigneeId !== null
           : e.project !== SAME_PROJECT) || typeof e.notes !== 'string' || !e.notes.isWellFormed() || e.notes.length > 4000
          || !canonicalTags(e.tags) || !priority(e.priority)))) throw invalid();
  }
  return JSON.parse(json(cases));
}

const updateChanges = c => sourceExpectation(c.expect) === 'sourceAfter'
  ? json(c.expect.sourceAfter) !== json({ priority: c.priority, dueAt: c.sourceDueAt, tags: c.tags })
  : sourceExpectation(c.expect) === 'sourceTags' ? json(c.expect.sourceTags) !== json(c.tags)
  : sourceExpectation(c.expect) === 'sourceDueAt' ? c.expect.sourceDueAt !== c.sourceDueAt : c.expect.sourcePriority !== c.priority;

export function completionChecksPass(binding, checks) {
  return Array.isArray(checks) && checks.length === binding.cases.length && binding.cases.every((c, index) => {
    const entry = checks[index], write = binding.write;
    if (binding.harness === COMPLETION_GATE_CHECK) return entry?.id === c.id && entry.classification === 'COMPLETED'
      && entry.effect === 'NONE' && entry.branch === c.expect.decision && json(entry.observed) === json(c.expect)
      && entry.linkedStatus === c.linkedStatus;
    if (binding.harness === GUARD_CHECK) return entry?.id === c.id && entry.classification === 'COMPLETED'
      && entry.effect === 'NONE' && entry.branch === c.expect.decision && json(entry.observed) === json(c.expect)
      && Array.isArray(entry.openMatches) && entry.openMatches.every(match => keys(match, ['title', 'matches'])
         && typeof match.title === 'string' && match.matches === (c.openTitles ?? []).includes(match.title));
    if (binding.harness === OWNED_GUARD_CHECK || exactTaskCheck(binding.harness)) {
      if (!Array.isArray(entry?.taskReads) || !entry.taskReads.every(task => c.referenceTasks.some(row => json(row) === json(task)))) return false;
      if (binding.harness === OWNED_GUARD_CHECK) return entry.id === c.id && entry.classification === 'COMPLETED' && entry.effect === 'NONE'
        && entry.branch === c.expect.decision && json(entry.observed) === json(c.expect)
        && Array.isArray(entry.openMatches) && entry.openMatches.every(match => keys(match, ['projectId', 'title', 'matches'])
          && typeof match.title === 'string' && c.openProjects.some(p => p.projectId === match.projectId
            && match.matches === (p.titles.includes(match.title) || c.referenceTasks.some(task =>
              task.projectId === p.projectId && task.title === match.title && task.status === 'OPEN'))));
    }
    const update = sourceExpectation(c.expect);
    return entry?.id === c.id && entry.classification === 'COMPLETED' && json(entry.observed) === json(c.expect)
      && entry.effect === (c.expect ? 'CONFIRMED' : 'NONE')
      && entry.status === (update ? 'UPDATED' : c.expect ? 'CREATED' : 'NO_OP')
      && entry.branch === (update ? updateChanges(c) ? 'UPDATED' : 'UNCHANGED'
        : c.expect ? 'CREATED' : write ? 'SKIPPED' : 'NO_WRITE')
       && (ownedProjectCheck(binding.harness) ? Array.isArray(entry.openMatches) && entry.openMatches.every(match =>
         keys(match, ['projectId', 'title', 'matches']) && typeof match.title === 'string'
         && c.openProjects.some(project => project.projectId === match.projectId && match.matches ===
            (project.titles.includes(match.title) || binding.hook === TASK_CREATED && c.projectId === match.projectId && c.title === match.title
              || exactTaskCheck(binding.harness) && c.referenceTasks.some(task =>
                task.projectId === match.projectId && task.title === match.title && task.status === 'OPEN'))))
        : exactTaskCheck(binding.harness) ? Array.isArray(entry.openMatches) && !entry.openMatches.length
        : !hasLookupCases(binding.harness) || Array.isArray(entry.openMatches) && entry.openMatches.every(match =>
        keys(match, ['title', 'matches']) && typeof match.title === 'string'
         && match.matches === (c.openTitles.includes(match.title) || createdChecks.includes(binding.harness) && c.title === match.title)));
  });
}

export function completionReportBound(binding, revisionId, report) {
  return report?.harness === binding.harness && report.revisionId === revisionId
    && report.executableIdentity === binding.executableIdentity && report.caseDigest === binding.manifest.caseDigest
    && Array.isArray(report.checks) && report.checks.length === binding.cases.length
    && binding.cases.every((c, i) => report.checks[i]?.id === c.id);
}

export function completionReportMatches(binding, revisionId, report) {
  return completionReportBound(binding, revisionId, report) && report.passed === true && completionChecksPass(binding, report.checks);
}

export function completionProofMatches(binding, revisionId, report) {
  const { write, cases } = binding;
  if (binding.harness === OWNED_GUARD_CHECK || exactTaskCheck(binding.harness)) {
    const guard = binding.harness === OWNED_GUARD_CHECK, create = exactCreates.includes(binding.harness);
    const lookupUpdate = exactLookupUpdates.includes(binding.harness);
    const description = taskRuleDescription(JSON.parse(binding.artifact), binding.host);
    const destination = description.action?.fields.projectId;
    if (description.coverage !== 'complete' || !completionReportMatches(binding, revisionId, report)
      || (!guard && (create ? write?.capability !== 'tasks.create' || !destination
        || description.action.fields.priority?.kind === 'taskField' && !cases.some(c => c.expect && c.priority !== 'normal')
        : write?.capability !== 'tasks.update' || !cases.some(c => c.expect && updateChanges(c))))) return false;
    const conditions = guard ? description.guard.conditions : description.conditions;
    const taskId = conditions.find(c => c.taskId)?.taskId;
    const lookup = (guard || create || lookupUpdate) && conditions.find(c => ['openMatch', 'noOpenMatch'].includes(c.field));
    if (lookupUpdate && (!taskId || !lookup?.projectId)) return false;
    const fixedSameProject = lookupUpdate && conditions.some(c => c.field === 'projectId' && c.value === lookup.projectId);
    const witnesses = cases.map(({ id, expect, referenceTasks, openProjects, ...input }, i) => {
      const { taskReads, openMatches } = report.checks[i];
      if (create) {
        const target = destination.kind === 'literal' ? destination.value : input.projectId;
        if (!openProjects.some(p => p.projectId === target) || expect && expect.project !== target) return null;
      }
      const selected = referenceTasks.find(task => task.id === taskId);
      if (taskId ? taskReads.length !== 1 || !selected || json(selected) !== json(taskReads[0]) : taskReads.length) return null;
      const [match] = openMatches;
      const lookupId = lookup && (lookup.projectId ?? input.projectId), lookupTitle = lookup && (lookup.title ?? lookup.value);
      if (lookup ? openMatches.length !== 1 || match.projectId !== lookupId || match.title !== lookupTitle : openMatches.length) return null;
      const projects = openProjects?.map(p => ({ ...p, titles: [...p.titles].sort() })).sort((a, b) => a.projectId.localeCompare(b.projectId));
      const titlesWithoutMatch = projects?.map(p => p.projectId === lookupId ? { ...p, titles: p.titles.filter(t => t !== lookupTitle) } : p);
      const facts = [input, referenceTasks.filter(task => task.id !== taskId).sort((a, b) => a.id.localeCompare(b.id))];
      return { applies: guard ? expect.decision === 'DENY' : !!expect, changed: guard || create || !expect || updateChanges(cases[i]),
        taskFacts: json([facts, projects, ...(create || lookupUpdate ? [match?.matches] : [])]), lookupFacts: json([facts, selected, titlesWithoutMatch]),
        selected: json(selected ?? null), match: match?.matches, external: input.projectId !== lookupId };
    });
    if (witnesses.some(row => !row)) return false;
    const pair = (facts, variable, allowed) => witnesses.some(a => a.applies && a.changed && allowed(a)
      && witnesses.some(b => !b.applies && allowed(b) && a[facts] === b[facts] && a[variable] !== b[variable]));
    return (!taskId || pair('taskFacts', 'selected', () => true))
      && (!lookup || pair('lookupFacts', 'match', row => create || (fixedSameProject ? !row.external : row.external)));
  }
  if (ownedProjectCheck(binding.harness)) {
    const description = taskRuleDescription(JSON.parse(binding.artifact), binding.host);
    const update = ownedUpdates.includes(binding.harness);
    const destination = description.action?.fields.projectId;
    const lookup = description.conditions?.find(c => ['noOpenMatch', 'openMatch'].includes(c.field));
    if (description.coverage !== 'complete'
        || (update ? write?.capability !== 'tasks.update' || !lookup?.projectId || !cases.some(c => c.expect && updateChanges(c))
          : write?.capability !== 'tasks.create' || !destination)
        || !cases.some(c => c.expect) || Object.hasOwn(write, 'when') && !cases.some(c => c.expect === null)
        || description.action.fields.priority?.kind === 'taskField' && !cases.some(c => c.expect && c.priority !== 'normal')
        || !completionReportMatches(binding, revisionId, report)) return false;
    const hits = new Set(), misses = new Set();
    for (const [i, { id, expect, openProjects, ...source }] of cases.entries()) {
      if (!update) {
        const target = destination.kind === 'literal' ? destination.value : source.projectId;
        if (!openProjects.some(p => p.projectId === target) || expect && expect.project !== target) return false;
      }
      const [observed] = report.checks[i].openMatches;
      if (!lookup) {
        if (observed) return false;
        continue;
      }
      const projectId = lookup.projectId ?? source.projectId;
      if (!observed || report.checks[i].openMatches.length !== 1 || observed.projectId !== projectId || observed.title !== lookup.title) return false;
      if (update && (projectId === source.projectId || expect && !updateChanges(cases[i]))) continue;
      // Match independent case pairs with every other fact, including other projects' titles, held constant.
      const facts = json([source, openProjects.map(p => ({ ...p, titles: p.titles.filter(t => p.projectId !== projectId || t !== lookup.title).sort() }))
        .sort((a, b) => a.projectId.localeCompare(b.projectId))]);
      if (observed.matches && Boolean(expect) === (lookup.field === 'openMatch')) hits.add(facts);
      if (!observed.matches && Boolean(expect) !== (lookup.field === 'openMatch')) misses.add(facts);
    }
    return !lookup || [...hits].some(facts => misses.has(facts));
  }
  if (binding.harness === COMPLETION_GATE_CHECK) {
    const gate = taskRuleDescription(JSON.parse(binding.artifact), binding.host).gate;
    if (!gate || !completionReportMatches(binding, revisionId, report)
        || new Set(cases.map(c => c.expect.decision)).size !== 2) return false;
    if (!gate.linked) return cases.every(c => c.linkedStatus === null);
    if (cases.some(c => c.linkedStatus === null)) return false;
    const groups = new Map();
    for (const { id, expect, linkedStatus, ...facts } of cases) {
      const key = json(facts);
      if (!groups.has(key)) groups.set(key, new Map());
      groups.get(key).set(linkedStatus, expect.decision);
    }
    return [...groups.values()].some(states => states.size === 3 && new Set(states.values()).size === 2);
  }
  if (binding.harness === GUARD_CHECK) {
    const description = taskRuleDescription(JSON.parse(binding.artifact), binding.host);
    if (description.coverage !== 'complete' || !completionReportMatches(binding, revisionId, report)
        || binding.manifest.scope === 'TEAM' && cases.some(c => c.projectId !== binding.manifest.subject)) return false;
    const lookup = description.guard.conditions.find(c => c.field === 'openMatch');
    const allow = new Set(), deny = new Set();
    for (const [i, { id, expect, openTitles, ...input }] of cases.entries()) {
      const matches = report.checks[i].openMatches;
      if (!lookup) {
        if (matches.length) return false;
        (expect.decision === 'ALLOW' ? allow : deny).add(json(input));
        continue;
      }
      if (!openTitles || matches.length !== 1 || matches[0].title !== lookup.value) return false;
      if (matches[0].matches !== (expect.decision === 'DENY')) continue;
      (expect.decision === 'ALLOW' ? allow : deny).add(json({ input, other: openTitles.filter(value => value !== lookup.value).sort() }));
    }
    return lookup ? [...deny].some(value => allow.has(value)) : allow.size > 0 && deny.size > 0;
  }
  // Retained reports must never qualify arguments their original checks could not observe.
  if (write && (binding.harness === LEGACY_CHECK && Object.keys(write.args).some(key =>
    !['projectId', 'title', 'dueAt', 'parentTaskId', 'assigneeId'].includes(key))
    || !cases.some(c => c.expect !== null) || Object.hasOwn(write, 'when') && !cases.some(c => c.expect === null))) return false;
  if (hasLookupCases(binding.harness) || write && binding.harness === SHARED_CHECK) {
    const description = taskRuleDescription(JSON.parse(binding.artifact), binding.host);
    if (description.coverage !== 'complete') return false;
    const fields = description.action?.fields;
    if (write?.capability === 'tasks.update' && combinedUpdateChecks.includes(binding.harness)) {
      if (cases.some(c => !Object.hasOwn(c, 'sourceDueAt') || c.expect && sourceExpectation(c.expect) !== 'sourceAfter')
        || !cases.some(c => c.expect && updateChanges(c))) return false;
    } else if (write?.capability === 'tasks.update') {
      const due = dueChecks.includes(binding.harness) && !!fields?.dueAt;
      const tags = binding.harness === TAG_CHECK && fields?.addTag?.kind === 'literal';
      const key = tags ? 'sourceTags' : due ? 'sourceDueAt' : 'sourcePriority';
      if (!tags && !due && fields?.priority?.kind !== 'literal' || due && cases.some(c => !Object.hasOwn(c, key))
        || !cases.some(c => sourceExpectation(c.expect) === key && updateChanges(c))) return false;
    } else if (write && (fields?.projectId?.kind !== 'taskField'
      || fields.priority?.kind === 'taskField' && !cases.some(c => c.expect && c.priority !== 'normal')
      || fields.dueAt?.kind === 'taskField')) return false;
    if (hasLookupCases(binding.harness)) {
      const lookup = description.conditions.find(c => c.field === 'noOpenMatch');
      if (!completionReportMatches(binding, revisionId, report)) return false;
      if (!lookup) return report.checks.every(c => c.openMatches.length === 0);
      if (!report.checks.every(c => c.openMatches.length === 1 && c.openMatches[0].title === lookup.title)) return false;
      const withMatch = new Set(), withoutMatch = new Set();
      for (const [i, { id, expect, openTitles, ...source }] of cases.entries()) {
        const matched = report.checks[i].openMatches[0].matches;
        const facts = json({ source, otherTitles: openTitles.filter(title => title !== lookup.title).sort() });
        if (matched && !expect) withMatch.add(facts);
        if (!matched && expect && (!sourceExpectation(expect) || updateChanges(cases[i]))) withoutMatch.add(facts);
      }
      return [...withMatch].some(facts => withoutMatch.has(facts));
    }
  }
  // A read-only rule may only claim no effect. Do not infer that from a subset of example inputs.
  if (!write && (binding.returnedStatus?.literal !== 'NO_OP' || cases.some(c => c.expect !== null))) return false;
  return completionReportMatches(binding, revisionId, report);
}
