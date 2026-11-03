import { readFileSync } from 'node:fs';
import { simulationCases, situation } from './extension-lifecycle.mjs';

export const businessContext = Object.freeze({
  application: 'Daymark',
  purpose: 'Help a person describe, create and revise distinct personal extensions using only this host’s published extension points.',
  supported: 'Discover the supportedHooks catalog before choosing a target. The currently published task-status hook can read the selected task status and display Done, Pending or Needs attention when the person chooses Check task advice. Other extension points must not be invented.',
  unavailable: 'Creating or editing tasks, follow-ups, project-based rules, dates, notes and background automation are not available to this assistant.',
  checking: 'Try synthetic examples without changing tasks. Include open, completed and unavailable tasks; ask what should happen when intent is unclear.',
  decisions: 'The person decides the intended behavior and expectations. Explain actual differences. Human approval and turning on the exact checked change are separate decisions.',
});

export function authoringExample() {
  const examples = simulationCases('attention').filter(item => item.id !== 'host-denied');
  return {
    label: 'Scripted example: task advice',
    description: 'Show Needs attention for open tasks and Done for completed tasks. Show no advice when a task cannot be read. This example uses no AI.',
    source: readFileSync(new URL('../extensions/task-read/leo.yaml', import.meta.url), 'utf8'),
    cases: examples.map(item => item.bytes.toString('utf8')),
    situations: examples.map(item => ({ id: item.id, label: item.label, ...situation(JSON.parse(item.bytes)) })),
  };
}

// Project immutable synthetic proof, never task records or provider continuation text.
export function evidenceSummary(proof, originals) {
  let truncated = proof.reports.length > 8;
  const text = value => {
    if (typeof value !== 'string') return undefined;
    const points = Array.from(value); if (points.length > 128) truncated = true;
    return points.slice(0, 128).join('');
  };
  const fields = (value, names) => Object.fromEntries(names.filter(name => typeof value?.[name] === 'string').map(name => [name, text(value[name])]));
  const examples = originals.map(original => JSON.parse(original));
  const cases = proof.reports.slice(0, 8).map(item => {
    const example = examples.find(example => example.id === item.id);
    if (item.report.mismatches.length > 8) truncated = true;
    return {
      id: text(item.id), label: text(item.label), status: text(item.report.status),
      taskStatus: item.taskStatus ?? null, readFailure: item.readFailure ?? null,
      expected: { ...fields(item.expected, ['classification', 'code']), consumption: fields(example?.expect?.consumption, ['status', 'code']) },
      actual: { native: fields(item.report.native, ['classification', 'code']), consumption: fields(item.report.consumption, ['status', 'code']) },
      mismatches: item.report.mismatches.slice(0, 8).map(item => ({ ...fields(item, ['stage', 'code']),
        ...(Number.isSafeInteger(item.ordinal) && item.ordinal >= 0 ? { ordinal: item.ordinal } : {}) })),
    };
  });
  return { statuses: cases.map(item => item.status), cases, truncated };
}
