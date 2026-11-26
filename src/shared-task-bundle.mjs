import { AppError } from './data.mjs';
import { BEFORE_CREATE, BEFORE_COMPLETE, TASK_CREATED, TASK_HOOK, digest, json } from './extension-catalog.mjs';
import { COMPLETION_GATE_CHECK, CREATED_CHECK, CREATED_UPDATE_CHECK, COMPLETED_UPDATE_CHECK, GUARD_CHECK, TAG_CHECK, OWNED_CREATED_CHECK, OWNED_COMPLETED_CHECK,
  OWNED_CREATED_UPDATE_CHECK, OWNED_COMPLETED_UPDATE_CHECK,
  EXACT_CREATED_CHECK, EXACT_COMPLETED_CHECK, OWNED_GUARD_CHECK,
  EXACT_CREATED_CREATE_CHECK, EXACT_COMPLETED_CREATE_CHECK,
  EXACT_CREATED_LOOKUP_UPDATE_CHECK, EXACT_COMPLETED_LOOKUP_UPDATE_CHECK,
  ownedProjectCheck, completionCases, completionProofMatches, sharedHost,
  readCompletionManifest, scopedCompletionManifest } from './shared-completion-contract.mjs';
import { checkSharedCompletion } from './shared-completion.mjs';

export const BUNDLE_MANIFEST = 'daymark.shared-task-bundle/1';
export const COMPOSED_MANIFEST = 'daymark.shared-task-bundle/2';
export const TEAM_GATE_MANIFEST = 'daymark.shared-task-bundle/3';
export const isTaskBundle = format => [BUNDLE_MANIFEST, COMPOSED_MANIFEST, TEAM_GATE_MANIFEST].includes(format);
const bundleCheck = 'daymark.shared-task-bundle-check/1';
const composedCheck = 'daymark.shared-task-bundle-check/2';
export const bundleHooks = Object.freeze([BEFORE_CREATE, TASK_CREATED, TASK_HOOK]);
export const allHooks = Object.freeze([BEFORE_CREATE, TASK_CREATED, BEFORE_COMPLETE, TASK_HOOK]);
export const presentHooks = manifest => allHooks.filter(hook => manifest.hooks[hook] !== null);
// Keep the existing Personal primary slot when present, so existing bundle items can be revised.
export const primaryHook = manifest => [TASK_HOOK, TASK_CREATED, BEFORE_CREATE].find(hook => manifest.hooks[hook] !== null);
export const harnessFor = hook => hook === BEFORE_CREATE ? GUARD_CHECK : hook === BEFORE_COMPLETE ? COMPLETION_GATE_CHECK : hook === TASK_CREATED ? CREATED_CHECK : TAG_CHECK;
function bindingHarness(hook, source, format) {
  if (format !== BUNDLE_MANIFEST) {
    try {
      const domain = JSON.parse(source)?.domain;
      if (hook === BEFORE_CREATE && domain?.id === 'daymark.shared-before-create.personal' && domain.version === '2') return OWNED_GUARD_CHECK;
      if ([TASK_CREATED, TASK_HOOK].includes(hook) && domain?.id === `daymark.personal-owned-projects.${hook.toLowerCase()}`) {
        if (domain.version === '1') return hook === TASK_CREATED ? OWNED_CREATED_CHECK : OWNED_COMPLETED_CHECK;
        if (domain.version === '2') return hook === TASK_CREATED ? OWNED_CREATED_UPDATE_CHECK : OWNED_COMPLETED_UPDATE_CHECK;
        if (domain.version === '3') return hook === TASK_CREATED ? EXACT_CREATED_CHECK : EXACT_COMPLETED_CHECK;
        if (domain.version === '4') return hook === TASK_CREATED ? EXACT_CREATED_CREATE_CHECK : EXACT_COMPLETED_CREATE_CHECK;
        if (domain.version === '5') return hook === TASK_CREATED ? EXACT_CREATED_LOOKUP_UPDATE_CHECK : EXACT_COMPLETED_LOOKUP_UPDATE_CHECK;
      }
      if (hook === TASK_CREATED && domain?.version === '2') return CREATED_UPDATE_CHECK;
      if (hook === TASK_HOOK && domain?.version === '6' && ['daymark.shared-task.personal', 'daymark.shared-task.team'].includes(domain.id))
        return COMPLETED_UPDATE_CHECK;
    } catch { /* Compiler validates source. */ }
  }
  return harnessFor(hook);
}
const unavailable = () => new AppError(503, 'The exact shared task revision is unavailable.');
const exactKeys = (value, keys) => value && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function bundleCases(hook, cases, harness = harnessFor(hook)) {
  if (hook === BEFORE_CREATE || hook === BEFORE_COMPLETE || ownedProjectCheck(harness)) return completionCases(cases, harness);
  if (!Array.isArray(cases) || cases.some(c => typeof c?.projectId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(c.projectId)))
    throw new AppError(400, 'Choose a project for each lifecycle example.');
  const normalized = completionCases(cases.map(({ projectId, ...example }) => example), harness);
  return normalized.map((c, i) => ({ ...c, projectId: cases[i].projectId }));
}

export function taskBundleOffer(input, format = BUNDLE_MANIFEST) {
  if (!isTaskBundle(format)) throw unavailable();
  if (format !== BUNDLE_MANIFEST) {
    if (!exactKeys(input, ['bindings', 'cases']) || !exactKeys(input.bindings, allHooks) || !exactKeys(input.cases, allHooks)
        || (format === TEAM_GATE_MANIFEST) !== (input.bindings.TaskBeforeComplete !== null))
      throw new AppError(400, 'Use the supported task hooks and mark unused bindings and examples null.');
    const hooks = allHooks.filter(hook => input.bindings[hook] !== null);
    if (!hooks.length || allHooks.some(hook => input.bindings[hook] === null ? input.cases[hook] !== null
      : typeof input.bindings[hook] !== 'string' || !input.bindings[hook].trim() || !input.bindings[hook].isWellFormed()
        || Buffer.byteLength(input.bindings[hook]) > 65536))
      throw new AppError(400, 'Supply source and independent examples for at least one supported hook.');
    const sources = Object.fromEntries(hooks.map(hook => [hook, input.bindings[hook]]));
    const cases = Object.fromEntries(hooks.map(hook => [hook, bundleCases(hook, input.cases[hook], bindingHarness(hook, sources[hook], format))]));
    if (Buffer.byteLength(json(cases)) > 32000) throw new AppError(400, 'The combined examples are too large.');
    return { sources, cases };
  }
  if (!exactKeys(input, ['bindings', 'cases']) || !exactKeys(input.bindings, [...bundleHooks, 'TaskBeforeComplete'])
      || input.bindings.TaskBeforeComplete !== null || !exactKeys(input.cases, bundleHooks)
      || bundleHooks.some(hook => typeof input.bindings[hook] !== 'string' || !input.bindings[hook].trim()
        || !input.bindings[hook].isWellFormed() || Buffer.byteLength(input.bindings[hook]) > 65536))
    throw new AppError(400, 'Supply the three supported bindings and separate examples for each.');
  const sources = Object.fromEntries(bundleHooks.map(hook => [hook, input.bindings[hook]]));
  const cases = Object.fromEntries(bundleHooks.map(hook => [hook, bundleCases(hook, input.cases[hook])]));
  if (Buffer.byteLength(json(cases)) > 32000) throw new AppError(400, 'The combined examples are too large.');
  return { sources, cases };
}

export async function compileTaskBundle(compiler, scope, subject, input, check, signal, format = BUNDLE_MANIFEST) {
  if (format === TEAM_GATE_MANIFEST && scope !== 'TEAM') throw unavailable();
  const { sources, cases } = taskBundleOffer(input, format), artifacts = {};
  for (const hook of Object.keys(sources)) {
    check();
    const harness = bindingHarness(hook, sources[hook], format);
    const result = await compiler.compile(Buffer.from(sources[hook]), { definition: sharedHost(scope, harness), signal });
    if (!result.artifact) throw Object.assign(new AppError(422, 'A binding in the shared task revision did not compile.'),
      result.diagnostics?.length ? { rejectedHook: hook } : {});
    artifacts[hook] = result.artifact;
  }
  check();
  return { ...readTaskBundle(scope, subject, sources, artifacts, cases, undefined, format), sources, artifacts, cases };
}

// The outer identity covers the whole revision. Per-hook reports retain their own exact identities.
export function readTaskBundle(scope, subject, sources, artifacts, cases, expected, format = expected?.format ?? BUNDLE_MANIFEST) {
  if (!isTaskBundle(format)) throw unavailable();
  const composed = format === COMPOSED_MANIFEST;
  const gate = format === TEAM_GATE_MANIFEST;
  const present = composed || gate ? allHooks.filter(hook => sources && Object.hasOwn(sources, hook)) : bundleHooks;
  if (gate ? scope !== 'TEAM' || !present.includes(BEFORE_COMPLETE) : present.includes(BEFORE_COMPLETE)) throw unavailable();
  if (!present.length || !exactKeys(sources, present) || !exactKeys(artifacts, present) || !exactKeys(cases, present)) throw unavailable();
  const bindings = {}, hooks = Object.fromEntries(allHooks.map(hook => [hook, null]));
  for (const hook of present) {
    const source = sources[hook], bytes = artifacts[hook];
    if (typeof source !== 'string' || !source.isWellFormed() || Buffer.byteLength(source) > 65536
        || !(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 1048576) throw unavailable();
    const harness = bindingHarness(hook, source, format), inputs = bundleCases(hook, cases[hook], harness);
    if (scope === 'TEAM' && inputs.some(c => c.projectId !== subject)) throw unavailable();
    const local = hook === BEFORE_CREATE || hook === BEFORE_COMPLETE || ownedProjectCheck(harness) ? inputs : inputs.map(({ projectId, ...c }) => c);
    const fragment = scopedCompletionManifest(scope, subject, source, bytes, local, harness);
    bindings[hook] = { ...readCompletionManifest(scope, subject, fragment, source, bytes, local),
      cases: inputs, exampleIdentity: digest(json(inputs)) };
    hooks[hook] = { ...fragment.hooks[hook], harness, caseDigest: fragment.caseDigest };
  }
  const manifest = { format, scope, subject, harness: gate ? 'daymark.shared-task-bundle-check/3' : composed ? composedCheck : bundleCheck, caseDigest: digest(json(cases)), hooks };
  if (expected !== undefined && json(expected) !== json(manifest)) throw unavailable();
  return { manifest, bindings, executableIdentity: digest(json(manifest)) };
}

export function bundleProofMatches(bundle, revisionId, report) {
  const present = presentHooks(bundle.manifest), legacy = bundle.manifest.format === BUNDLE_MANIFEST;
  return report?.harness === bundle.manifest.harness && report.revisionId === revisionId
    && report.caseDigest === bundle.manifest.caseDigest && report.executableIdentity === bundle.executableIdentity
    && exactKeys(report.reports, present) && report.passed === true
    && (!legacy || bundle.bindings[TASK_CREATED].write?.capability === 'tasks.create' && !!bundle.bindings[TASK_HOOK].write)
    && (!bundle.bindings[BEFORE_COMPLETE]?.usesLinkedTask || bundle.bindings[TASK_CREATED]?.cases.some(c => c.expect?.linked))
    && present.every(hook => report.reports[hook]?.exampleIdentity === bundle.bindings[hook].exampleIdentity
      && completionProofMatches(bundle.bindings[hook], revisionId, report.reports[hook]));
}

export async function checkTaskBundle(bundle, revisionId, actor, members, check) {
  const reports = {}, present = presentHooks(bundle.manifest);
  for (const hook of present) reports[hook] = {
    ...await checkSharedCompletion(bundle.bindings[hook], revisionId, actor, members, check, bundle),
    exampleIdentity: bundle.bindings[hook].exampleIdentity,
  };
  const report = { harness: bundle.manifest.harness, revisionId, executableIdentity: bundle.executableIdentity,
    caseDigest: bundle.manifest.caseDigest, reports, passed: present.every(hook => reports[hook].passed) };
  return { ...report, eligible: bundleProofMatches(bundle, revisionId, report) };
}

// Bundle rows are immutable. Recheck exact bytes, including presence, rather than admitting each artifact again on every native authority check.
export function cachedTaskBundle() {
  let last;
  return (scope, subject, sources, artifacts, cases, manifest) => {
    const identity = digest(json({ scope, subject, manifest, sources, cases,
      artifacts: Object.fromEntries(Object.entries(artifacts).map(([hook, bytes]) => [hook, digest(bytes)])) }));
    if (last?.identity !== identity) last = { identity, bundle: readTaskBundle(scope, subject, sources, artifacts, cases, manifest) };
    return last.bundle;
  };
}

export function cachedBundleProof() {
  let last;
  return (bundle, revisionId, payload) => {
    const identity = digest(json([bundle.executableIdentity, revisionId, payload]));
    if (last?.identity !== identity) last = { identity, match: bundleProofMatches(bundle, revisionId, JSON.parse(payload)) };
    return last.match;
  };
}
