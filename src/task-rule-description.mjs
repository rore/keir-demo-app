import { fromBinary } from '@bufbuild/protobuf';
import { CheckedExprSchema } from '@bufbuild/cel-spec/cel/expr/checked_pb.js';
import { digest, json } from './extension-catalog.mjs';
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
    if (digest(definition.dcmBytes) !== pins.modelDigest || !artifact
      || !['keir-artifact/2', 'keir-artifact/3'].includes(artifact.format)
      || artifact.format.slice(-1) !== pins.modelRef.format.slice(-1)
      || artifact.entrypoint !== hook || artifact.compiler !== pins.compiler
      || json(artifact.environment) !== json(pins.environment) || json(artifact.modelRef) !== json(pins.modelRef)
      || !/^sha256:[0-9a-f]{64}$/.test(artifact.sourceDigest ?? '')) return unavailable('The checked rule does not match its host definition.');
    if (!['TaskCreated', 'TaskCompleted', 'TaskBeforeCreate'].includes(hook)) return unavailable('This hook is not described yet.');
    if (!Array.isArray(artifact.steps) || artifact.steps.length > 64 || !keys(artifact.expressions, Object.keys(artifact.expressions ?? {})))
      return unavailable('The checked rule is malformed or exceeds description limits.');
    const steps = artifact.steps, indices = new Map();
    for (const [index, step] of steps.entries()) {
      if (!step || typeof step.id !== 'string' || indices.has(step.id)) return unavailable('The checked steps are malformed.');
      indices.set(step.id, index);
    }
    const used = new Set(), decoded = new Map();
    let checkedBytes = 0;
    function expression(value, before, depth = 0) {
      if (depth >= 32 || !keys(value, ['literal', 'expr', 'type'])) return;
      if (Object.hasOwn(value, 'literal')) return Object.hasOwn(value, 'expr') ? undefined : literal(value.literal);
      if (typeof value.expr !== 'string') return;
      if (artifact.expressions[value.expr]?.resultType !== value.type) return;
      if (!decoded.has(value.expr)) {
        const encoded = artifact.expressions[value.expr]?.checked;
        if (typeof encoded !== 'string' || encoded.length > 22_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return;
        checkedBytes += encoded.length;
        if (checkedBytes > 256_000) return;
        decoded.set(value.expr, fromBinary(CheckedExprSchema, Uint8Array.from(atob(encoded), char => char.charCodeAt(0))).expr);
      }
      return node(decoded.get(value.expr), before, depth + 1);
    }
    function node(expr, before, depth) {
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
        if (index < before && binding?.op === 'BIND' && !Object.hasOwn(binding, 'when')) {
          used.add(name);
          return expression(binding.value, index, depth + 1);
        }
        return { kind: 'ident', name };
      }
      if (kind?.case === 'selectExpr') return { kind: 'field', name: kind.value.field, testOnly: kind.value.testOnly,
        record: node(kind.value.operand, before, depth + 1) };
      if (kind?.case === 'callExpr') return { kind: 'call', name: kind.value.function,
        target: kind.value.target ? node(kind.value.target, before, depth + 1) ?? {} : undefined,
        args: kind.value.args.map(arg => node(arg, before, depth + 1)) };
    }
    if (hook === 'TaskBeforeCreate') {
      const returned = artifact.return, output = model.types[model.entrypoints[hook].output]?.fields;
      if (!keys(artifact, ['format', 'compiler', 'environment', 'expressions', 'entrypoint', 'modelRef', 'return', 'sourceDigest', 'steps'])
        || !keys(returned, ['fields', 'type']) || returned.type !== model.entrypoints[hook].output
        || Object.keys(returned.fields ?? {}).sort().join() !== 'decision,message'
        || returned.fields.decision.type !== output.decision || returned.fields.message.type !== output.message
        || steps.some(step => step.op !== 'BIND' || !keys(step, ['id', 'op', 'resultType', 'value'])
          || step.value?.type !== step.resultType)) return unavailable('The before-save decision could not be fully described.');
      const decision = expression(returned.fields.decision, steps.length), message = expression(returned.fields.message, steps.length);
      if (!call(decision, '_?_:_', 3) || decision.args[1]?.kind !== 'literal' || decision.args[1].value !== 'DENY'
        || decision.args[2]?.kind !== 'literal' || decision.args[2].value !== 'ALLOW'
        || !call(message, '_?_:_', 3) || json(decision.args[0]) !== json(message.args[0])
        || message.args[1]?.kind !== 'literal' || typeof message.args[1].value !== 'string'
        || !message.args[1].value.isWellFormed() || Buffer.byteLength(message.args[1].value) > 256
        || !message.args[1].value.trim() || message.args[2]?.kind !== 'literal' || message.args[2].value !== '')
        return unavailable('The before-save outcomes could not be fully described.');
      function guardConditions(expr) {
        if (call(expr, '_&&_', 2)) {
          const left = guardConditions(expr.args[0]), right = guardConditions(expr.args[1]);
          return left && right ? [...left, ...right] : undefined;
        }
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
        if (call(expr, '!_', 1)) {
          const nested = guardConditions(expr.args[0]);
          if (nested?.length === 1 && ['hasNotes', 'hasDueDate'].includes(nested[0].field))
            return [{ ...nested[0], value: !nested[0].value }];
          if (nested?.length === 1 && nested[0].field === 'tag') return [{ ...nested[0], negated: !nested[0].negated }];
        }
      }
      const conditions = guardConditions(decision.args[0]);
      if (!conditions || steps.some(step => !used.has(step.id))) return unavailable('The before-save conditions could not be fully described.');
      return { coverage: 'complete', hook, guard: { conditions, message: message.args[1].value.trim() } };
    }
    const writes = steps.filter(step => step.op === 'CALL' && ['tasks.create', 'tasks.update'].includes(step.capability));
    if (writes.length !== 1) return unavailable('A single task change could not be identified.');
    const write = writes[0], writeIndex = indices.get(write.id), reads = new Map();
    let complete = keys(artifact, ['format', 'compiler', 'environment', 'expressions', 'entrypoint', 'modelRef', 'return', 'sourceDigest', 'steps']);
    for (const [index, step] of steps.entries()) {
      if (step.op !== 'CALL' || step === write) continue;
      if (index >= writeIndex || Object.hasOwn(step, 'when')) { complete = false; continue; }
      if (step.capability === 'tasks.get' && step.version === '3'
        && Object.keys(step.args ?? {}).join() === 'taskId' && field(expression(step.args.taskId, index), 'input', 'taskId')) {
        reads.set(step.id, { kind: 'task' });
      } else if (step.capability === 'tasks.openMatch' && step.version === '1'
        && Object.keys(step.args ?? {}).sort().join() === 'projectId,title') {
        const project = expression(step.args.projectId, index), title = expression(step.args.title, index);
        if (project?.kind === 'literal' && title?.kind === 'literal' && validOpenMatchInput(project.value, title.value)) {
          reads.set(step.id, { kind: 'match', projectId: project.value, title: title.value });
        } else complete = false;
      } else complete = false;
    }
    function conditions(expr) {
      if (call(expr, '_&&_', 2)) {
        const left = conditions(expr.args[0]), right = conditions(expr.args[1]);
        return left && right ? [...left, ...right] : undefined;
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
        if (read?.kind === 'match' && field(selected, selected.record.name, 'matches')) {
          used.add(selected.record.name); return [{ field: 'noOpenMatch', projectId: read.projectId, title: read.title, step: selected.record.name }];
        }
      }
    }
    let guard, knownConditions;
    if (!Object.hasOwn(write, 'when')) knownConditions = [];
    else {
      const index = indices.get(write.when), binding = steps[index];
      if (index < writeIndex && binding?.op === 'BIND' && !Object.hasOwn(binding, 'when')) {
        used.add(binding.id); guard = expression(binding.value, index); knownConditions = conditions(guard);
      }
      if (!knownConditions) complete = false;
    }
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
      const recognized = value(expression(argument, writeIndex));
      if (!recognized || argument.type !== model.capabilities[write.capability]?.parameters[name]?.type
        || !(create ? ['projectId', 'title', 'tagsText', 'dueAt', 'priority', 'notes'] : ['dueAt', 'priority', 'addTag']).includes(name)
        || recognized.kind === 'eventOffset' && name !== 'dueAt'
        || recognized.kind === 'title' && name !== 'title'
        || recognized.kind === 'taskField' && recognized.field !== name) {
        complete = false; continue;
      }
      try {
        if (recognized.kind === 'literal' && (typeof recognized.value !== 'string'
          || name === 'projectId' && !recognized.value
          || name === 'priority' && !['low', 'normal', 'high'].includes(recognized.value)
          || name === 'dueAt' && !Number.isFinite(Date.parse(recognized.value)))) { complete = false; continue; }
        if (name === 'tagsText' || name === 'addTag') {
          if (recognized.kind !== 'literal') { complete = false; continue; }
          fields[name === 'tagsText' ? 'tags' : name] = literal(name === 'tagsText' ? parseWorkflowTagsText(recognized.value) : normalizeTaskTag(recognized.value));
        } else if (name === 'title' && recognized.kind === 'literal') fields.title = literal(normalizeWorkflowTitle(recognized.value));
        else fields[name] = recognized;
      } catch { complete = false; }
    }
    if (create && (!fields.projectId || !fields.title) || !create && !Object.keys(fields).length) complete = false;
    if (write.version !== (create ? '2' : '1')) return unavailable('The task change version is not supported.');
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
      ...(knownConditions ? { conditions: knownConditions } : {}),
      action: { capability: write.capability, step: write.id, target: create ? 'newTask' : 'triggeringTask', fields } };
    if (!complete) description.reason = 'Some checked conditions, values or behavior are not described.';
    return description;
  } catch { return unavailable('The checked rule could not be read safely.'); }
}
