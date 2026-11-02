import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ENVIRONMENT, bindModel, prepareProgram } from '@keir/runtime-node';

export const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const json = value => JSON.stringify(sorted(value));
export const consumer = Object.freeze({ id: 'demo.taskadvice', version: '1', kind: 'DISPLAY' });
export const hook = 'ClassifyTask';

const load = path => readFileSync(new URL('../' + path, import.meta.url));
export function loadHost() {
  const pins = JSON.parse(load('extensions/task-read/selection.json'));
  const provenance = JSON.parse(load('vendor/provenance.json'));
  const archive = load('vendor/' + provenance.archive);
  if ('sha512-' + createHash('sha512').update(archive).digest('base64') !== provenance.integrity) throw new Error('Invalid runtime package');
  const dcmBytes = load('extensions/task-read/dcm.json');
  if (digest(dcmBytes) !== pins.modelDigest) throw new Error('Invalid model');
  return { dcmBytes, programs: pins.programs, pins: { modelDigest: pins.modelDigest, compiler: pins.compiler, environment: ENVIRONMENT,
    profile: 'keir-read/2', hook, consumer, packageIntegrity: provenance.integrity, adapter: 'native-task-read/1' } };
}

// Admission has no business invoker: it checks bytes and host pins without executing the program.
export function admitArtifact(artifactBytes, host) {
  const scope = 'demo.task-advice:admission';
  const binding = bindModel(host.dcmBytes, { scope, modelRef: { domainId: 'demo.tasks', domainVersion: '1',
    format: 'keir-dcm/read-2', digest: host.pins.modelDigest, descriptorRecipe: 'keir-record-descriptors/1' },
    profile: 'keir-read/2', environment: ENVIRONMENT, mode: 'real' }, {
    'tasks.get': { version: '1', mode: 'real', invoke: async () => { throw new Error('Admission cannot dispatch'); } },
  });
  if (binding.diagnostic) throw new Error('Invalid host model');
  const result = prepareProgram(artifactBytes, binding.boundModel, { expectedArtifactDigest: digest(artifactBytes),
    expectedDcmDigest: host.pins.modelDigest, compiler: host.pins.compiler, entrypoint: hook, consumer,
    environment: ENVIRONMENT, mode: 'real' });
  if (result.diagnostic) throw new Error('Invalid authored program');
  return JSON.parse(Buffer.from(artifactBytes).toString('utf8'));
}

export function hostBindings(artifactBytes, owner) {
  const artifact = JSON.parse(Buffer.from(artifactBytes).toString('utf8'));
  return artifact.steps.some(step => step.op === 'CALL' && step.capability === 'tasks.get') ? { actorId: owner } : {};
}

export function loadCatalog() {
  const host = loadHost();
  return ['pending', 'attention'].map((id, index) => {
    const stem = index ? 'leo' : 'maya';
    const artifactBytes = load(`extensions/task-read/${stem}.json`);
    const source = load(`extensions/task-read/${stem}.yaml`);
    if (digest(artifactBytes) !== host.programs[stem].digest || digest(source) !== host.programs[stem].sourceDigest) throw new Error('Invalid program');
    const identity = { sourceDigest: digest(source), artifactDigest: digest(artifactBytes), ...host.pins };
    return Object.freeze({ id, label: index ? 'Needs attention' : 'Pending', openCode: index ? 'NEEDS_ATTENTION' : 'PENDING',
      identity: json(identity), pins: JSON.parse(json(identity)), artifactBytes, dcmBytes: host.dcmBytes });
  });
}
