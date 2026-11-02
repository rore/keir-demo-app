import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
import { readAuthoringConfig } from '../src/authoring-config.mjs';
import { createAuthoringProvider } from '../src/authoring-provider.mjs';
import { createAuthoringState, runAuthoringTurn } from '../src/authoring-agent.mjs';

// The operator's isolated host fixture must wire the actual packaged compiler and simulator.
// Fake transport tests qualify this harness, not real provider compatibility or the application.
export async function checkAuthoringProvider({ live = false, env = process.env, host, context, inputs, fetchImpl } = {}) {
  if (!live) return { status: 'NOT_RUN', code: 'LIVE_OPT_IN_REQUIRED' };
  if (!host || !context || !Array.isArray(inputs) || !inputs.length || inputs.length > 8) return { status: 'NOT_RUN', code: 'HOST_FIXTURE_REQUIRED' };
  const config = readAuthoringConfig(env);
  if (config.status !== 'ready') return { status: 'NOT_RUN', code: config.code };
  const bound = { ...context, budget: context.budget ?? { remainingMicros: config.maxMicros } };
  try {
    const state = createAuthoringState(bound);
    const provider = createAuthoringProvider(config, { fetchImpl });
    let result;
    for (const input of inputs) {
      result = await runAuthoringTurn({ provider, host, context: bound, state,
        input: { id: input.id, text: input.text, expectedVersion: state.version } });
      if (result.status !== 'AWAITING_USER') break;
    }
    return { status: result.status, ...(result.code && { code: result.code }), provider: config.provider, model: config.model,
      counts: { ...state.counts }, usage: { ...state.usage },
      ...(result.review && { review: { revisionId: result.review.revisionId, draftVersion: result.review.draftVersion,
        suiteDigest: result.review.suiteDigest, evidenceId: result.review.evidenceId, eligible: result.review.eligible } }) };
  } catch { return { status: 'BLOCKED', code: 'QUALIFICATION_FAILED' }; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let result;
  if (!args.length) result = await checkAuthoringProvider();
  else if (args.length === 3 && args[0] === '--live' && args[1] === '--host') {
    const target = resolve(args[2]); const local = relative(process.cwd(), target);
    if (!local || local.startsWith('..') || isAbsolute(local) || !local.endsWith('.mjs')) result = { status: 'NOT_RUN', code: 'HOST_FIXTURE_REQUIRED' };
    else {
      try {
        // This path is an explicit operator CLI argument, never a model tool argument.
        const fixture = await import(pathToFileURL(target).href);
        result = await checkAuthoringProvider({ ...await fixture.createQualificationHost(), live: true });
      } catch { result = { status: 'NOT_RUN', code: 'HOST_FIXTURE_UNAVAILABLE' }; }
    }
  } else result = { status: 'NOT_RUN', code: 'EXPLICIT_LIVE_AND_HOST_REQUIRED' };
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status !== 'REVIEW_AVAILABLE' || !result.review?.eligible) process.exitCode = args.length ? 1 : 0;
}
