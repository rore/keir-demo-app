import { AUTHORING_TOOLS, string, tool } from './keir-authoring-agent.mjs';
import { AuthoringError } from './authoring-provider.mjs';
import { digest, json } from './extension-catalog.mjs';
import { teamModel } from './team-runtime.mjs';
import { normalizeTeamAgreement, TEAM_BINDINGS } from './team-qualification.mjs';

const save = tool('save_draft', 'Compile and save the complete proposal, including its independent expected examples. Use the exact format discovered from this host.', {
  proposalJson: string,
});
export const teamAuthoringTools = [...AUTHORING_TOOLS.filter(item => !['compile_draft', 'propose_scenarios'].includes(item.name)), save];
export const teamAuthoringHandlers = {
  save_draft: { advancesDraft: true, async run(host, args, context) { return { draft: await host.save(args.proposalJson, context) }; } },
};
const offer = tool('offer_proposal', 'Offer the complete proposal, including independent expected examples, for the person to confirm. This does not compile or save rules. Use the exact host format.', { proposalJson: string });
export const teamConversationTools = teamAuthoringTools.filter(item => !['discover_catalog', 'save_draft', 'simulate_draft', 'offer_review'].includes(item.name)).concat(offer);
export const teamConversationInstructions = `You are Daymark’s assistant for a shared project. The currentContext in the message is the fresh, scoped discovery result; use it directly.
If asked what Daymark can do, answer directly with two or three short, concrete examples: add a linked follow-up for a teammate, add one only for matching tasks such as high priority, or keep the original task open until its linked review is done. Do not ask the user to choose before answering basic capability questions.
Only original tasks people add can start this customization. Linked tasks created by it do not start another creation rule. A linked review can be completed normally; waiting for it applies to the original task only. Never propose manual creation or an extra recursion check to avoid a loop that cannot occur.
Use words a teammate would use: Daymark, original task, linked review, example, approval, turn on. Do not talk about hosts, hooks, artifacts, child/root tasks, IDs, or recursion. This wording rule is for visible replies, not structured proposal fields. State unsupported parts plainly and use ask_clarification to get consent before omitting them. Do not ask again once the person explicitly accepts the same narrowing and all needed details are known. When the request is complete, offer the exact proposal in the same reply. Never save it without the separate human confirmation.`;
export const teamConversationHandlers = {
  offer_proposal: { run(host, args) {
    const proposal = host.validateProposal(args.proposalJson);
    return { event: { result: { status: 'AWAITING_USER' }, terminal: {
      status: 'AWAITING_USER', message: 'Check that this is the behavior you want. Confirming saves a draft and checks its examples. It does not turn anything on.', proposal,
    } } };
  } },
};

const handles = state => ({
  draftVersion: state.draftVersion,
  revisionId: state.draft?.revisionId ?? null,
  suiteDigest: state.draft?.agreement ? digest(json(state.examples)) : null,
});

export function teamAuthoringHost({ capability, projects, actor, projectId, authorize }) {
  const get = () => capability.state(actor, projectId, authorize);
  const proofFor = state => {
    if (!state.draft?.agreement || !state.evidence) return null;
    const proof = capability.evidence(actor, projectId, state.evidence.id, authorize);
    if (proof.revisionId !== state.draft.revisionId) throw new AuthoringError('STALE_DRAFT');
    const summary = { cases: proof.report.cases.map(c => ({
      name: c.name, passed: c.passed, events: c.events.map(event => ({
        action: event.action, ref: event.ref, expected: event.expected, observed: event.observed, mismatches: event.mismatches,
      })),
    })), qualification: proof.report.qualification };
    return { ...handles(state), evidenceId: proof.id, simulationSuiteIdentity: proof.caseDigest, eligible: state.eligibility.eligible,
      summary: Buffer.byteLength(json(summary)) <= 65536 ? summary : { available: false, message: 'Open the saved example results for details.' } };
  };
  return {
    awareness() { const { project } = get(); return { target: { name: project.name, scope: 'Team' } }; },
    readDraft: () => handles(get()),
    discover() {
      const state = get();
      const source = state.draft?.agreement ? capability.source(actor, projectId, state.draft.revisionId, authorize) : null;
      const currentProposal = source ? { source: json(source.sourceBundle.sources), cases: state.examples, summary: state.draft.agreement.summary } : null;
      return {
        businessContext: {
          project: state.project,
          members: projects.members(actor, projectId).members.map(({ id, name }) => ({ id, name })),
          restriction: 'Use only current project members. Only original tasks people add start a Team creation rule. A task added by the rule is linked to that original task and never starts another creation rule. A linked review can be completed normally; a completion rule can hold only the original task. Daymark cannot update the original task, send email, schedule reminders or set an automatic due date. Ask before narrowing. Only the person approves and turns on a draft.',
        },
        model: teamModel, modelDigest: digest(json(teamModel)), currentDraft: handles(state), currentProposal,
        currentUse: state.selected ? { summary: state.selected.agreement?.summary ?? 'An earlier saved customization is in use.' } : null,
        proposalContract: capability.contract(actor, projectId, authorize),
      };
    },
    validateProposal(text) {
      if (!text.trim() || !text.isWellFormed() || Buffer.byteLength(text) > 98304) throw new AuthoringError('INVALID_TOOL_ARGUMENTS');
      let input;
      try { input = JSON.parse(text); } catch { throw new AuthoringError('INVALID_TOOL_ARGUMENTS'); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 2
          || !Object.hasOwn(input, 'bindings') || !Object.hasOwn(input, 'agreement')) throw new AuthoringError('INVALID_TOOL_ARGUMENTS');
      if (!input.bindings || Object.keys(input.bindings).length !== TEAM_BINDINGS.length
          || TEAM_BINDINGS.some(hook => !Object.hasOwn(input.bindings, hook) ||
            input.bindings[hook] !== null && typeof input.bindings[hook] !== 'string'))
        throw new AuthoringError('INVALID_TOOL_ARGUMENTS');
      try { return { bindings: input.bindings, agreement: normalizeTeamAgreement(input.agreement) }; }
      catch { throw new AuthoringError('INVALID_TOOL_ARGUMENTS'); }
    },
    async save(text, { draft, signal }) {
      const input = this.validateProposal(text);
      try { return handles(await capability.proposeAuthored(actor, projectId, { ...input, expectedDraftVersion: draft.draftVersion }, authorize, { signal })); }
      catch (error) {
        if ([400, 413, 422].includes(error.status)) throw new AuthoringError('INVALID_TOOL_ARGUMENTS');
        if (error.status === 409) throw new AuthoringError('STALE_DRAFT');
        throw error;
      }
    },
    async simulate(revisionId, expectedDraftVersion, signal) {
      const state = get();
      if (!state.draft?.agreement || state.draft.revisionId !== revisionId || state.draftVersion !== expectedDraftVersion)
        throw new AuthoringError('STALE_DRAFT');
      const next = await capability.simulate(actor, projectId, { revisionId, expectedDraftVersion, cases: state.examples }, authorize, { signal });
      const proof = proofFor(next);
      if (proof?.evidenceId !== next.evidenceId) throw new AuthoringError('HOST_RESULT_INVALID');
      return proof;
    },
    readEvidence: () => proofFor(get()),
  };
}
