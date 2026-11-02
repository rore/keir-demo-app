import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { ENVIRONMENT } from '@keir/runtime-node';

export const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
export const json = value => JSON.stringify(sorted(value));
export const consumer = Object.freeze({ id: 'demo.taskadvice', version: '1', kind: 'DISPLAY' });
export const hook = 'ClassifyTask';

export function loadCatalog() {
  const load = path => readFileSync(new URL('../' + path, import.meta.url));
  const pins = JSON.parse(load('extensions/task-read/selection.json'));
  const provenance = JSON.parse(load('vendor/provenance.json'));
  const archive = load('vendor/' + provenance.archive);
  if ('sha512-' + createHash('sha512').update(archive).digest('base64') !== provenance.integrity) throw new Error('Invalid runtime package');
  const dcmBytes = load('extensions/task-read/dcm.json');
  if (digest(dcmBytes) !== pins.modelDigest) throw new Error('Invalid model');
  return ['pending', 'attention'].map((id, index) => {
    const stem = index ? 'leo' : 'maya';
    const artifactBytes = load(`extensions/task-read/${stem}.json`);
    const source = load(`extensions/task-read/${stem}.yaml`);
    if (digest(artifactBytes) !== pins.programs[stem].digest || digest(source) !== pins.programs[stem].sourceDigest) throw new Error('Invalid program');
    const identity = { sourceDigest: digest(source), artifactDigest: digest(artifactBytes), modelDigest: pins.modelDigest,
      compiler: pins.compiler, environment: ENVIRONMENT, profile: 'keir-read/2', hook, consumer,
      packageIntegrity: provenance.integrity, adapter: 'native-task-read/1' };
    return Object.freeze({ id, label: index ? 'Needs attention' : 'Pending', openCode: index ? 'NEEDS_ATTENTION' : 'PENDING',
      identity: json(identity), pins: JSON.parse(json(identity)), artifactBytes, dcmBytes });
  });
}
