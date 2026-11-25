import { AUTHORING_TOOLS, tool } from './keir-authoring-agent.mjs';
import { AuthoringError } from './authoring-provider.mjs';
import { digest, json } from './extension-catalog.mjs';
import { teamModel } from './team-runtime.mjs';
import { businessProposal, expandTeamOffer, teamOfferFields } from './team-business-offer.mjs';

const offer = tool('offer_proposal', 'Offer matching source and independent business outcomes before a person confirms. Use null for an unused hook, or for a when field with no restriction. Every reachable context needs exactly one outcome. A linkedTask value of null in expected means add nothing. Daymark owns all checks. No save or compile.', teamOfferFields);
export const teamConversationTools = [AUTHORING_TOOLS.find(item => item.name === 'ask_clarification'), offer];
export const teamConversationInstructions = `You are Daymark’s assistant for a shared project. The currentContext in the message is the fresh, scoped discovery result; use it directly.
If asked what Daymark can do, answer directly with two or three short, concrete examples: add a linked follow-up for a teammate, add one only for matching tasks such as high priority, or keep the original task open until its linked review is done. Do not ask the user to choose before answering basic capability questions.
Only original tasks people add can start this customization. Linked tasks created by it do not start another creation rule. A linked review can be completed normally; waiting for it applies to the original task only. Never propose manual creation or an extra recursion check to avoid a loop that cannot occur.
For each used hook, put only steps and return in its source JSON string. Daymark supplies language, name, domain and entrypoint. Use {cel: "..."} for expressions, {literal: "...", type: "UserId"} for a fixed teammate ID, and {record: {...}} for the return. For a call step, use {id: "task", call: "tasks.get", args: {taskId: {cel: "input.taskId"}}}. The call is a string and args is a sibling object. Read only the original's id, projectId and priority. Do not read parentTaskId or add a root-only check. Use a creation step's when only for a real business branch covered both ways by the outcomes; it names an earlier Boolean binding. Unconditional creation has no when. Use unguarded completion steps and a conditional decision in the return. For linked-task state, bind tasks.childrenSummary to input.taskId and input.creationEventId.
If the person says the original can finish only after its own review is done, declare the applicable priorities in requireFinishedReviewFor. Missing is not done: deny both absent and open, and allow completed. In source, “review done” requires exists AND NOT anyIncomplete, not just NOT anyIncomplete. Include unaffected priorities explicitly if the rule is conditional. Use null for a different completion rule, including an explicitly requested exception for missing reviews; do not change an existing agreement unless requested. Represent all matching and nonmatching reachable cases. Do not offer a rule that needs other conditions.
Use words a teammate would use: Daymark, original task, linked review, example, approval, turn on. Do not ask about rule syntax or test mechanics. Daymark builds its own checks from the independent business outcomes; supply only the source and the typed outcomes in offer_proposal. Use an ordinary fixed title or a short blocking explanation when the person leaves wording open; show your choices in the offer. Ask only about a material business choice, such as which teammate or when the rule should apply. State unsupported parts plainly and ask before omitting them. Do not ask again once the person accepts the same narrowing and the behavior is clear. When ready, call offer_proposal now, without another text-only round. Never save it without separate human confirmation.`;
export const teamConversationHandlers = {
  offer_proposal: { invalidOfferCode: 'TEAM_OFFER_INVALID', run(host, args) {
    const proposal = host.expandOffer(args);
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
  const members = () => projects.members(actor, projectId).members;
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
      const currentProposal = source ? businessProposal(state.draft.agreement, source.sourceBundle.sources) : null;
      return {
        businessContext: {
          project: state.project,
          members: members().map(({ id, name }) => ({ id, name })),
          restriction: 'Use only current project members. Only original tasks people add start a Team creation rule. A task added by the rule is linked to that original task and never starts another creation rule. A linked review can be completed normally; a completion rule can hold only the original task. Daymark cannot update the original task, send email, schedule reminders or set an automatic due date. Ask before narrowing. Only the person approves and turns on a draft.',
        },
        model: teamModel, currentDraft: handles(state), currentProposal,
        currentUse: state.selected ? { summary: state.selected.agreement?.summary ?? 'An earlier saved customization is in use.' } : null,
      };
    },
    expandOffer(input) {
      authorize();
      return expandTeamOffer(input, actor, members());
    },
    async save(input, { draft, signal }) {
      try { return handles(await capability.proposeAuthored(actor, projectId, { ...input, expectedDraftVersion: draft.draftVersion }, authorize, { signal })); }
      catch (error) {
        if ([400, 413, 422].includes(error.status)) throw new AuthoringError('TEAM_OFFER_INVALID');
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
