import { fromBinary } from '@bufbuild/protobuf';
import { CheckedExprSchema } from '@bufbuild/cel-spec/cel/expr/checked_pb.js';
import { digest, json, definitionFormats, exactLookupUpdate, exactOwnedCreate, exactSourceUpdate, OWNED_GUARD_DEFINITION, ownedProjectDefinitionId, ownedSourceUpdate, TASK_DEFINITION, SHARED_COMPLETION_DEFINITION, SHARED_CREATED_DEFINITION, SHARED_COMPLETED_UPDATE, SHARED_LOOKUP_DEFINITION, SHARED_DUE_DEFINITION, SHARED_TAG_DEFINITION, combinedSourceUpdate, sharedSourceUpdate } from './extension-catalog.mjs';
import { taskDueAt } from './data.mjs';
import { normalizeTaskTag, normalizeWorkflowTitle, parseWorkflowTagsText, validOpenMatchInput } from './task-workflow-values.mjs';

const literal = value => ({ kind: 'literal', value });
const call = (node, name, count) => node?.kind === 'call' && node.name === name && !node.target && node.args.length === count;
const field = (node, record, name) => node?.kind === 'field' && !node.testOnly && node.record?.kind === 'ident'
  && node.record.name === record && (name === undefined || node.name === name);
const keys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));

// Saved source/artifact digests are checked by the caller; this verifies the selected host definition.
export function taskRuleDescription(artifact, definition) {
  const hook = definition?.pins?.hook;
  const unavailable = reason => ({ coverage: 'unavailable', hook, reason });
  try {
    const pins = definition.pins, model = JSON.parse(Buffer.from(definition.dcmBytes).toString());
    const combinedUpdate = combinedSourceUpdate(pins.definitionId);
    const sourceUpdate = combinedUpdate || sharedSourceUpdate(pins.definitionId), tagUpdate = combinedUpdate || pins.definitionId === SHARED_TAG_DEFINITION;
    const dueUpdate = tagUpdate || pins.definitionId === SHARED_DUE_DEFINITION;
    const lookupUpdate = exactLookupUpdate(pins.definitionId);
    const ownedUpdate = lookupUpdate || ownedSourceUpdate(pins.definitionId);
    const exactUpdate = exactSourceUpdate(pins.definitionId);
    const exactCreate = exactOwnedCreate(pins.definitionId), exact = exactUpdate || exactCreate;
    const owned = ownedUpdate || exactCreate || pins.definitionId === ownedProjectDefinitionId(hook);
    const scopedLookup = owned || sourceUpdate || [SHARED_LOOKUP_DEFINITION, SHARED_CREATED_DEFINITION].includes(pins.definitionId);
    const shared = scopedLookup || pins.definitionId === SHARED_COMPLETION_DEFINITION;
    if (digest(definition.dcmBytes) !== pins.modelDigest || !artifact
      || artifact.format !== definitionFormats(pins).artifact
      || artifact.entrypoint !== hook || artifact.compiler !== pins.compiler
      || json(artifact.environment) !== json(pins.environment) || json(artifact.modelRef) !== json(pins.modelRef)
      || !/^sha256:[0-9a-f]{64}$/.test(artifact.sourceDigest ?? '')) return unavailable('The checked rule does not match its host definition.');
    if (!['TaskCreated', 'TaskCompleted', 'TaskBeforeCreate', 'TaskBeforeComplete'].includes(hook)) return unavailable('This hook is not described yet.');
    if (!Array.isArray(artifact.steps) || artifact.steps.length > 64 || !keys(artifact.expressions, Object.keys(artifact.expressions ?? {})))
      return unavailable('The checked rule is malformed or exceeds description limits.');
    const steps = artifact.steps, indices = new Map();
    for (const [index, step] of steps.entries()) {
      if (!step || typeof step.id !== 'string' || indices.has(step.id)) return unavailable('The checked steps are malformed.');
      indices.set(step.id, index);
    }
    const used = new Set(), decoded = new Map();
    let checkedBytes = 0;
    function expression(value, before, depth = 0, inline = true) {
      if (depth >= 32 || !keys(value, ['literal', 'expr', 'type'])) return;
      if (Object.hasOwn(value, 'literal')) {
        if (Object.hasOwn(value, 'expr')) return;
        if (model.format === 'keir-dcm/4' && value.type === 'Integer' && typeof value.literal === 'string'
          && /^(?:0|-[1-9][0-9]*|[1-9][0-9]*)$/.test(value.literal) && Number.isSafeInteger(Number(value.literal)))
          return literal(Number(value.literal));
        return literal(value.literal);
      }
      if (typeof value.expr !== 'string') return;
      if (artifact.expressions[value.expr]?.resultType !== value.type) return;
      if (!decoded.has(value.expr)) {
        const encoded = artifact.expressions[value.expr]?.checked;
        if (typeof encoded !== 'string' || encoded.length > 22_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return;
        checkedBytes += encoded.length;
        if (checkedBytes > 256_000) return;
        decoded.set(value.expr, fromBinary(CheckedExprSchema, Uint8Array.from(atob(encoded), char => char.charCodeAt(0))));
      }
      const checked = decoded.get(value.expr);
      return node(checked.expr, before, depth + 1, inline, checked.referenceMap);
    }
    function node(expr, before, depth, inline, references) {
      if (depth >= 32) return;
      const kind = expr?.exprKind;
      if (kind?.case === 'constExpr') {
        const constant = kind.value.constantKind;
        if (['stringValue', 'boolValue', 'doubleValue'].includes(constant.case)) return literal(constant.value);
        if (constant.case === 'int64Value' && Number.isSafeInteger(Number(constant.value))) return literal(Number(constant.value));
        return;
      }
      if (kind?.case === 'identExpr') {
        const name = kind.value.name, index = indices.get(name), binding = steps[index];
        if (inline && index < before && binding?.op === 'BIND' && !Object.hasOwn(binding, 'when')) {
          used.add(name);
          return expression(binding.value, index, depth + 1, inline);
        }
        return { kind: 'ident', name };
      }
      if (kind?.case === 'selectExpr') return { kind: 'field', name: kind.value.field, testOnly: kind.value.testOnly,
        record: node(kind.value.operand, before, depth + 1, inline, references) };
      if (kind?.case === 'callExpr') return { kind: 'call', name: kind.value.function,
        overloads: references?.[String(expr.id)]?.overloadId,
        target: kind.value.target ? node(kind.value.target, before, depth + 1, inline, references) ?? {} : undefined,
        args: kind.value.args.map(arg => node(arg, before, depth + 1, inline, references)) };
    }
    if (hook === 'TaskBeforeComplete') {
      const lookup = steps[0]?.op === 'CALL' ? steps[0] : null;
      if (lookup && (lookup.capability !== 'tasks.linkedTask' || Object.hasOwn(lookup, 'when')
          || Object.keys(lookup.args).sort().join() !== 'originEventId,parentTaskId'
          || !field(expression(lookup.args.parentTaskId, 0), 'input', 'taskId')
          || !field(expression(lookup.args.originEventId, 0), 'input', 'creationEventId'))
          || steps.some(step => step !== lookup && (step.op !== 'BIND' || Object.hasOwn(step, 'when'))))
        return unavailable('The completion reads could not be fully described.');
      const decision = expression(artifact.return.fields.decision, steps.length), message = expression(artifact.return.fields.message, steps.length);
      if (!call(decision, '_?_:_', 3) || decision.args[1]?.value !== 'DENY' || decision.args[2]?.value !== 'ALLOW'
          || !call(message, '_?_:_', 3) || json(decision.args[0]) !== json(message.args[0]) || typeof message.args[1]?.value !== 'string'
          || !message.args[1].value.trim() || Buffer.byteLength(message.args[1].value) > 256 || message.args[2]?.value !== '')
        return unavailable('The completion decision could not be fully described.');
      function condition(expr) {
        if (call(expr, '_&&_', 2) || call(expr, '_||_', 2)) {
          const children = expr.args.map(condition);
          if (children.every(Boolean)) return { op: expr.name === '_&&_' ? 'all' : 'any', children };
        }
        if (call(expr, '!_', 1)) {
          const child = condition(expr.args[0]);
          if (child) return { op: 'not', children: [child] };
        }
        if (call(expr, '@in', 2) && typeof expr.args[0]?.value === 'string' && field(expr.args[1], 'input', 'tags'))
          return { field: 'tag', value: expr.args[0].value };
        if (field(expr, 'input') && ['hasNotes', 'hasDueDate'].includes(expr.name))
          return { field: expr.name, value: true };
        if (call(expr, '_==_', 2) || call(expr, '_!=_', 2)) for (const [selected, literal] of [expr.args, [...expr.args].reverse()]) {
          if (literal?.kind !== 'literal' || typeof literal.value !== 'string') continue;
          const name = field(selected, 'input') && ['priority', 'title', 'projectId'].includes(selected.name) ? selected.name
            : lookup && field(selected, lookup.id, 'status') ? 'linkedStatus' : null;
          if (!name || name === 'linkedStatus' && !['MISSING', 'OPEN', 'COMPLETED'].includes(literal.value)) continue;
          if (name === 'linkedStatus') used.add(lookup.id);
          const exact = { field: name, value: literal.value };
          return expr.name === '_==_' ? exact : { op: 'not', children: [exact] };
        }
      }
      const when = condition(decision.args[0]);
      if (!when || steps.some(step => !used.has(step.id))) return unavailable('The completion conditions could not be fully described.');
      return { coverage: 'complete', hook, gate: { when, linked: !!lookup, message: message.args[1].value } };
    }
    function exactRead(step, index) {
      if (step?.op !== 'CALL' || step.capability !== 'tasks.get' || step.version !== '3'
          || step.resultType !== model.capabilities['tasks.get']?.result
          || !keys(step, ['id', 'op', 'capability', 'version', 'resultType', 'args'])
          || Object.keys(step.args ?? {}).join() !== 'taskId') return;
      const taskId = expression(step.args.taskId, index)?.value;
      if (typeof taskId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(taskId)) return taskId;
    }
    function exactTaskCondition(expr, readId, taskId) {
      if (!taskId) return;
      if (call(expr, '_==_', 2)) for (const [selected, value] of [expr.args, [...expr.args].reverse()]) {
        if (field(selected, readId) && ['title', 'priority', 'status'].includes(selected.name) && typeof value?.value === 'string') {
          used.add(readId);
          return { field: selected.name, value: value.value, taskId };
        }
      }
      if (call(expr, '@in', 2) && typeof expr.args[0]?.value === 'string' && field(expr.args[1], readId, 'tags')) {
        used.add(readId);
        return { field: 'tag', value: expr.args[0].value, taskId };
      }
      if (call(expr, '!_', 1) && expr.args[0]?.kind === 'field' && expr.args[0].testOnly
          && expr.args[0].name === 'dueAt' && expr.args[0].record?.name === readId) {
        used.add(readId);
        return { field: 'dueAbsent', taskId };
      }
    }
    if (hook === 'TaskBeforeCreate') {
      const returned = artifact.return, output = model.types[model.entrypoints[hook].output]?.fields;
      const ownedReads = pins.definitionId === OWNED_GUARD_DEFINITION;
      const read = ownedReads && steps.find(step => step.capability === 'tasks.get');
      const taskId = read && exactRead(read, indices.get(read.id));
      if (read && !taskId) return unavailable('The before-save task ID could not be fully described.');
      const lookup = ownedReads ? steps.find(step => step.capability === 'tasks.openMatch')
        : pins.definitionId !== TASK_DEFINITION && steps[0]?.op === 'CALL' && steps[0].capability === 'tasks.openMatch' ? steps[0] : null;
      const lookupIndex = indices.get(lookup?.id);
      const lookupTitle = lookup && expression(lookup.args?.title, lookupIndex);
      const lookupProject = lookup && expression(lookup.args?.projectId, lookupIndex);
      const lookupId = ownedReads && lookupProject?.kind === 'literal' ? lookupProject.value : null;
      if (lookup && (!keys(lookup, ['id', 'op', 'capability', 'version', 'resultType', 'args'])
          || lookup.version !== model.capabilities['tasks.openMatch']?.version || lookup.resultType !== model.capabilities['tasks.openMatch']?.result
          || Object.keys(lookup.args ?? {}).sort().join() !== 'projectId,title'
          || (!ownedReads && !field(lookupProject, 'input', 'projectId'))
          || lookupTitle?.kind !== 'literal' || !validOpenMatchInput(ownedReads ? lookupId : 'example', lookupTitle.value)))
        return unavailable('The before-save lookup could not be fully described.');
      if (!keys(artifact, ['format', 'compiler', 'environment', 'expressions', 'entrypoint', 'modelRef', 'return', 'sourceDigest', 'steps'])
        || !keys(returned, ['fields', 'type']) || returned.type !== model.entrypoints[hook].output
        || Object.keys(returned.fields ?? {}).sort().join() !== 'decision,message'
        || returned.fields.decision.type !== output.decision || returned.fields.message.type !== output.message
         || steps.some(step => step !== lookup && step !== read && (step.op !== 'BIND' || !keys(step, ['id', 'op', 'resultType', 'value'])
           || step.value?.type !== step.resultType))) return unavailable('The before-save decision could not be fully described.');
      const decision = expression(returned.fields.decision, steps.length), message = expression(returned.fields.message, steps.length);
      if (!call(decision, '_?_:_', 3) || decision.args[1]?.kind !== 'literal' || decision.args[1].value !== 'DENY'
        || decision.args[2]?.kind !== 'literal' || decision.args[2].value !== 'ALLOW'
        || !call(message, '_?_:_', 3) || json(decision.args[0]) !== json(message.args[0])
        || message.args[1]?.kind !== 'literal' || typeof message.args[1].value !== 'string'
        || !message.args[1].value.isWellFormed() || Buffer.byteLength(message.args[1].value) > 256
         || !message.args[1].value.trim() || pins.definitionId !== TASK_DEFINITION && message.args[1].value.trim() !== message.args[1].value
         || message.args[2]?.kind !== 'literal' || message.args[2].value !== '')
        return unavailable('The before-save outcomes could not be fully described.');
      function guardConditions(expr) {
        if (call(expr, '_&&_', 2)) {
          const left = guardConditions(expr.args[0]), right = guardConditions(expr.args[1]);
          return left && right ? [...left, ...right] : undefined;
        }
        if (model.format === 'keir-dcm/4' && call(expr, '_>_', 2)
          && json(expr.overloads) === json(['greater_int64']) && call(expr.args[0], 'size', 1)
          && json(expr.args[0].overloads) === json(['size_list']) && field(expr.args[0].args[0], 'input', 'tags')
          && expr.args[1]?.kind === 'literal' && Number.isSafeInteger(expr.args[1].value)
          && expr.args[1].value >= 0 && expr.args[1].value <= model.types.Tags.maxItems)
          return [{ field: 'tagCount', value: expr.args[1].value }];
        if (call(expr, '_==_', 2)) {
          for (const [selected, value] of [expr.args, [...expr.args].reverse()]) {
            if (!field(selected, 'input') || value?.kind !== 'literal') continue;
            if (['projectId', 'priority'].includes(selected.name) && typeof value.value === 'string'
              && (selected.name === 'projectId' ? !!value.value : ['low', 'normal', 'high'].includes(value.value)))
              return [{ field: selected.name, value: value.value }];
            if (['hasNotes', 'hasDueDate'].includes(selected.name) && typeof value.value === 'boolean')
              return [{ field: selected.name, value: value.value }];
          }
        }
        if (call(expr, '@in', 2) && expr.args[0]?.kind === 'literal' && typeof expr.args[0].value === 'string'
          && field(expr.args[1], 'input', 'tags')) return [{ field: 'tag', value: expr.args[0].value }];
        if (field(expr, 'input') && ['hasNotes', 'hasDueDate'].includes(expr.name)) return [{ field: expr.name, value: true }];
        if (lookup && field(expr, lookup.id, 'matches')) {
          used.add(lookup.id);
          return [{ field: 'openMatch', value: lookupTitle.value, ...(lookupId && { projectId: lookupId }) }];
        }
        const taskCondition = exactTaskCondition(expr, read?.id, taskId);
        if (taskCondition) return [taskCondition];
        if (call(expr, '!_', 1)) {
          const nested = guardConditions(expr.args[0]);
          if (nested?.length === 1 && ['hasNotes', 'hasDueDate'].includes(nested[0].field))
            return [{ ...nested[0], value: !nested[0].value }];
          if (nested?.length === 1 && nested[0].field === 'tag') return [{ ...nested[0], negated: !nested[0].negated }];
        }
      }
      const conditions = guardConditions(decision.args[0]);
      if (!conditions || steps.some(step => !used.has(step.id)) || ownedReads && !read && !lookup)
        return unavailable('The before-save conditions could not be fully described.');
      return { coverage: 'complete', hook, ...(ownedReads && { ownedReads: true }), guard: { conditions, message: message.args[1].value.trim() } };
    }
    const writes = steps.filter(step => step.op === 'CALL' && ['tasks.create', 'tasks.update'].includes(step.capability));
    if (shared && !writes.length && !ownedUpdate && !exact) {
      const [read] = steps, capability = model.capabilities['tasks.get'];
      const readsCompletedTask = steps.length === 1 && read.op === 'CALL' && read.capability === 'tasks.get'
        && read.version === capability.version && read.resultType === capability.result
        && keys(read, ['id', 'op', 'capability', 'version', 'args', 'resultType'])
        && Object.keys(read.args ?? {}).join() === 'taskId'
        && field(expression(read.args.taskId, 0), 'input', 'taskId');
      const inert = steps.every(step => step.op === 'BIND' && keys(step, ['id', 'op', 'value', 'resultType'])
        && keys(step.value, ['literal', 'type']) && Object.hasOwn(step.value, 'literal') && step.value.type === step.resultType);
      if ((readsCompletedTask || inert) && artifact.return?.fields?.status?.literal === 'NO_OP')
        return { coverage: 'complete', hook, conditions: [], action: null, readsCompletedTask: !!readsCompletedTask };
      return unavailable('The read-only behavior could not be fully described.');
    }
    if (writes.length !== 1) return unavailable('A single task change could not be identified.');
    const write = writes[0], writeIndex = indices.get(write.id), reads = new Map();
    let complete = keys(artifact, ['format', 'compiler', 'environment', 'expressions', 'entrypoint', 'modelRef', 'return', 'sourceDigest', 'steps']);
    for (const [index, step] of steps.entries()) {
      if (step.op !== 'CALL' || step === write) continue;
      if (index >= writeIndex) { complete = false; continue; }
      const taskId = exact && exactRead(step, index);
      if (!Object.hasOwn(step, 'when') && step.capability === 'tasks.get' && step.version === '3'
        && Object.keys(step.args ?? {}).join() === 'taskId' && field(expression(step.args.taskId, index), 'input', 'taskId')) {
        reads.set(step.id, { kind: 'task' });
       } else if (taskId) {
         reads.set(step.id, { kind: 'exactTask', taskId });
       } else if (step.capability === 'tasks.openMatch' && step.version === (owned ? '2' : '1')
        && Object.keys(step.args ?? {}).sort().join() === 'projectId,title') {
        const project = expression(step.args.projectId, index), title = expression(step.args.title, index);
        if (scopedLookup && reads.get(project?.record?.name)?.kind === 'task' && field(project, project.record.name, 'projectId')
          && !Object.hasOwn(step, 'when') && title?.kind === 'literal' && validOpenMatchInput('source-project', title.value)) {
          used.add(project.record.name);
           reads.set(step.id, { kind: 'sourceMatch', title: title.value });
         } else if (owned && project?.kind === 'literal' && title?.kind === 'literal'
             && !Object.hasOwn(step, 'when') && validOpenMatchInput(project.value, title.value)) {
           reads.set(step.id, { kind: 'sourceMatch', projectId: project.value, title: title.value });
        } else if (!shared && project?.kind === 'literal' && title?.kind === 'literal' && validOpenMatchInput(project.value, title.value)) {
          const guardIndex = indices.get(step.when), guard = steps[guardIndex];
          if (Object.hasOwn(step, 'when') && !(guardIndex < index && guard?.op === 'BIND'
              && !Object.hasOwn(guard, 'when') && guard.resultType === 'Boolean')) { complete = false; continue; }
          reads.set(step.id, { kind: 'match', projectId: project.value, title: title.value, guard: step.when });
        } else complete = false;
      } else complete = false;
    }
    function conditions(expr, raw = expr) {
      if (exact) for (const [id, read] of reads) {
        const condition = exactTaskCondition(expr, id, read.taskId);
        if (condition) return [condition];
      }
      if ((ownedUpdate || exactCreate) && reads.get(expr?.record?.name)?.kind === 'sourceMatch' && field(expr, expr.record.name, 'matches')) {
        const { title, projectId } = reads.get(expr.record.name);
        used.add(expr.record.name);
        return [{ field: 'openMatch', title, projectId }];
      }
      if (call(expr, '_&&_', 2)) {
        const left = conditions(expr.args[0], raw.args?.[0]), right = conditions(expr.args[1], raw.args?.[1]);
        return left && right ? [...left, ...right] : undefined;
      }
      if (call(expr, '_?_:_', 3) && call(raw, '_?_:_', 3)
        && expr.args[2]?.kind === 'literal' && expr.args[2].value === false && call(expr.args[1], '!_', 1)) {
        const selected = expr.args[1].args[0], read = reads.get(selected?.record?.name);
        if (read?.kind === 'match' && read.guard && raw.args[0]?.kind === 'ident' && raw.args[0].name === read.guard
          && field(selected, selected.record.name, 'matches')) {
          const eligibility = conditions(expr.args[0]);
          if (eligibility) {
            used.add(selected.record.name);
            return [...eligibility, { field: 'noOpenMatch', projectId: read.projectId, title: read.title, step: selected.record.name }];
          }
        }
      }
      if (call(expr, '_==_', 2)) {
        for (const [selected, value] of [expr.args, [...expr.args].reverse()]) {
          const read = reads.get(selected?.record?.name);
          if (read?.kind === 'task' && field(selected, selected.record.name)
            && ['projectId', 'title', 'priority', 'status'].includes(selected.name) && value?.kind === 'literal' && typeof value.value === 'string') {
            used.add(selected.record.name); return [{ field: selected.name, value: value.value, step: selected.record.name }];
          }
        }
      }
      if (call(expr, '@in', 2) && expr.args[0]?.kind === 'literal' && typeof expr.args[0].value === 'string') {
        const selected = expr.args[1];
        if (reads.get(selected?.record?.name)?.kind === 'task' && field(selected, selected.record.name, 'tags')) {
          used.add(selected.record.name); return [{ field: 'tag', value: expr.args[0].value, step: selected.record.name }];
        }
      }
      if (call(expr, '!_', 1)) {
        const selected = expr.args[0], read = reads.get(selected?.record?.name);
        if (read?.kind === 'task' && selected?.kind === 'field' && selected.testOnly && selected.name === 'dueAt') {
          used.add(selected.record.name); return [{ field: 'dueAbsent', step: selected.record.name }];
        }
        if (read?.kind === 'match' && !read.guard && field(selected, selected.record.name, 'matches')) {
          used.add(selected.record.name); return [{ field: 'noOpenMatch', projectId: read.projectId, title: read.title, step: selected.record.name }];
        }
        if (read?.kind === 'sourceMatch' && field(selected, selected.record.name, 'matches')) {
           used.add(selected.record.name); return [{ field: 'noOpenMatch', title: read.title, ...(read.projectId && { projectId: read.projectId }) }];
        }
      }
    }
    let guard, knownConditions;
    if (!Object.hasOwn(write, 'when')) knownConditions = [];
    else {
      const index = indices.get(write.when), binding = steps[index];
      if (index < writeIndex && binding?.op === 'BIND' && !Object.hasOwn(binding, 'when')) {
        used.add(binding.id); guard = expression(binding.value, index); knownConditions = conditions(guard, expression(binding.value, index, 0, false));
      }
      if (!knownConditions || scopedLookup && knownConditions.filter(c => ['noOpenMatch', 'openMatch'].includes(c.field)).length > 1) complete = false;
    }
    if (ownedUpdate && !knownConditions?.some(c => ['noOpenMatch', 'openMatch'].includes(c.field) && c.projectId)) complete = false;
    if (exact && new Set(knownConditions?.filter(c => c.taskId).map(c => c.taskId)).size !== 1) complete = false;
    function value(expr) {
      if (expr?.kind === 'literal' && ['string', 'boolean', 'number'].includes(typeof expr.value)) return expr;
      if (reads.get(expr?.record?.name)?.kind === 'task' && field(expr, expr.record.name)
        && ['projectId', 'title', 'priority', 'status', 'dueAt'].includes(expr.name)) {
        used.add(expr.record.name); return { kind: 'taskField', step: expr.record.name, field: expr.name };
      }
      if (call(expr, '_+_', 2)) {
        const [left, right] = expr.args;
        if (field(left, 'input', 'occurredAt') && call(right, 'duration', 1) && right.args[0]?.kind === 'literal'
          && typeof right.args[0].value === 'string' && /^-?\d+s$/.test(right.args[0].value)) {
          const seconds = Number(right.args[0].value.slice(0, -1));
          if (Number.isSafeInteger(seconds) && Math.abs(seconds) <= 315_576_000_000) return { kind: 'eventOffset', seconds };
        }
        for (const [source, text, side] of [[left, right, 'suffix'], [right, left, 'prefix']]) {
          if (reads.get(source?.record?.name)?.kind === 'task' && field(source, source.record.name, 'title')
            && text?.kind === 'literal' && typeof text.value === 'string') {
            used.add(source.record.name); return { kind: 'title', step: source.record.name, [side]: text.value };
          }
          const nested = source?.kind === 'call' ? value(source) : undefined;
          if (nested?.kind === 'title' && text?.kind === 'literal' && typeof text.value === 'string')
            return { ...nested, [side]: side === 'prefix' ? text.value + (nested.prefix ?? '') : (nested.suffix ?? '') + text.value };
        }
      }
    }
    const fields = {}, create = write.capability === 'tasks.create';
    for (const [name, argument] of Object.entries(write.args ?? {})) {
      const expr = expression(argument, writeIndex);
      const recognized = shared && name === 'parentTaskId' && field(expr, 'input', 'taskId')
        ? { kind: 'triggeringTask' } : !create && dueUpdate && name === 'dueAt'
          && call(expr, 'timestamp', 1) && json(expr.overloads) === json(['string_to_timestamp']) && expr.args[0]?.kind === 'literal'
          ? expr.args[0] : value(expr);
      if (!recognized || argument.type !== model.capabilities[write.capability]?.parameters[name]?.type
        || !(create ? ['projectId', 'title', 'tagsText', 'dueAt', 'priority', 'notes', ...(shared ? ['parentTaskId', 'assigneeId'] : [])]
           : dueUpdate ? ['priority', 'dueAt', 'clearDue', ...(tagUpdate ? ['addTag'] : [])] : sourceUpdate ? ['priority'] : ['dueAt', 'priority', 'addTag']).includes(name)
         || sourceUpdate && !create && name !== 'dueAt' && recognized.kind !== 'literal'
           || shared && (name === 'projectId' && recognized.kind !== 'taskField'
             && !(owned && recognized.kind === 'literal' && validOpenMatchInput(recognized.value, 'project'))
          || name === 'dueAt' && recognized.kind === 'taskField'
          || name === 'parentTaskId' && recognized.kind !== 'triggeringTask'
          || name === 'assigneeId' && (recognized.kind !== 'literal' || typeof recognized.value !== 'string' || !recognized.value))
        || recognized.kind === 'eventOffset' && name !== 'dueAt'
        || recognized.kind === 'title' && name !== 'title'
        || recognized.kind === 'taskField' && recognized.field !== name) {
        complete = false; continue;
      }
      try {
        if (!create && dueUpdate && name === 'clearDue') {
          if (recognized.value === true) fields.dueAt = { kind: 'clear' };
          else complete = false;
          continue;
        }
        if (!create && dueUpdate && name === 'dueAt' && recognized.kind === 'literal') taskDueAt(recognized.value);
        if (recognized.kind === 'literal' && (typeof recognized.value !== 'string'
           || name === 'projectId' && !recognized.value
           || name === 'priority' && !['low', 'normal', 'high'].includes(recognized.value)
           || shared && name === 'notes' && (!recognized.value.isWellFormed() || recognized.value.length > 4000)
          || name === 'dueAt' && !Number.isFinite(Date.parse(recognized.value)))) { complete = false; continue; }
        if (name === 'tagsText' || name === 'addTag') {
          if (recognized.kind !== 'literal' || tagUpdate && name === 'addTag' && Buffer.byteLength(recognized.value) > 256) {
            complete = false; continue;
          }
          fields[name === 'tagsText' ? 'tags' : name] = literal(name === 'tagsText' ? parseWorkflowTagsText(recognized.value) : normalizeTaskTag(recognized.value));
        } else if (name === 'title' && recognized.kind === 'literal') fields.title = literal(normalizeWorkflowTitle(recognized.value));
        else fields[name] = recognized;
      } catch { complete = false; }
    }
    if (create && (!fields.projectId || !fields.title) || !create && (!Object.keys(fields).length
       || combinedUpdate && Object.hasOwn(write.args, 'clearDue') && Object.hasOwn(write.args, 'dueAt')
       || sourceUpdate && !combinedUpdate && Object.keys(write.args ?? {}).length !== 1)) complete = false;
    if (write.version !== (shared ? model.capabilities[write.capability]?.version : create ? '2' : '1'))
      return unavailable('The task change version is not supported.');
    used.add(write.id);
    const status = create ? 'CREATED' : 'UPDATED';
    const returned = artifact.return;
    const result = expression(returned?.fields?.status, steps.length);
    const expectedResult = guard ? call(result, '_?_:_', 3) && json(result.args[0]) === json(guard)
      && result.args[1]?.kind === 'literal' && result.args[1].value === status
      && result.args[2]?.kind === 'literal' && result.args[2].value === 'NO_OP'
      : result?.kind === 'literal' && result.value === status;
    if (!expectedResult || !keys(returned, ['fields', 'type']) || returned.type !== 'Report'
      || Object.keys(returned.fields ?? {}).join() !== 'status') complete = false;
    for (const step of steps) {
      if (!used.has(step.id) || !keys(step, step.op === 'CALL'
        ? ['id', 'op', 'resultType', 'capability', 'version', 'args', 'when'] : ['id', 'op', 'resultType', 'value'])
        || !['CALL', 'BIND'].includes(step.op)
        || step.op === 'BIND' && step.value?.type !== step.resultType
        || step.op === 'CALL' && (step.resultType !== model.capabilities[step.capability]?.result
          || step.version !== model.capabilities[step.capability]?.version)) complete = false;
      if (step.op === 'CALL') for (const [name, argument] of Object.entries(step.args ?? {})) {
        const parameter = model.capabilities[step.capability]?.parameters[name];
        if (!parameter || parameter.binding !== 'agent' || argument?.type !== parameter.type) complete = false;
      }
    }
    const description = { coverage: complete ? 'complete' : 'partial', hook,
      ...(owned && { ownedProjects: true }),
      ...(ownedUpdate && { ownedUpdate: true }),
      ...(lookupUpdate ? { lookupUpdate: true } : exactUpdate && { exactUpdate: true }),
      ...(exactCreate && { exactCreate: true }),
      ...(!create && pins.definitionId === SHARED_COMPLETED_UPDATE && { completedUpdate: true }),
      ...(knownConditions ? { conditions: knownConditions } : {}),
      action: { capability: write.capability, step: write.id, target: create ? 'newTask' : 'triggeringTask', fields } };
    if (!complete) description.reason = 'Some checked conditions, values or behavior are not described.';
    return description;
  } catch { return unavailable('The checked rule could not be read safely.'); }
}
