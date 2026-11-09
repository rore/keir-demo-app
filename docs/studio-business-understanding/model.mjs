export const initial = () => ({ phase: 'proposal', hasProposal: true, fromRequest: false, on: false, draft: '', messages: [], answer: '', history: false });
export function transition(state, action) {
  if (action === 'approve' && state.phase === 'proposal') return { ...state, phase: 'approved' };
  if (action === 'turn-on' && state.phase === 'approved') return { ...state, phase: 'on', on: true };
  if (action === 'edit') return { ...state, phase: 'discuss', answer: 'Describe what you want to change. What is on will keep working until you approve and turn on a replacement.' };
  if (action === 'restore') return { ...state, phase: 'discuss', history: false, answer: 'This earlier idea is now a new proposal. What is on has not changed. We need to check the new proposal before you can approve it.' };
  if (action === 'start') return { ...initial(), phase: 'request', hasProposal: false };
  if (action === 'clarify' && state.phase === 'request') return { ...state, phase: 'clarify' };
  if (action === 'confirm' && state.phase === 'clarify') return { ...state, phase: 'proposal', hasProposal: true, fromRequest: true };
  return state;
}
