import test from 'node:test';
import assert from 'node:assert/strict';
import { initial, transition } from './model.mjs';
test('approval is distinct from use and preserves unsent text', () => {
 const draft={...initial(),draft:'Keep my question'};
 assert.equal(transition(draft,'turn-on').on,false);
 const approved=transition(draft,'approve');
 assert.equal(approved.on,false);assert.equal(approved.draft,draft.draft);
 const on=transition(approved,'turn-on');assert.equal(on.on,true);
 const editing=transition(on,'edit');assert.equal(editing.on,true);assert.equal(editing.draft,draft.draft);
 assert.equal(editing.hasProposal,true);
 assert.equal(transition(editing,'approve').phase,'discuss');
 const restored=transition(on,'restore');assert.equal(restored.on,true);assert.equal(restored.phase,'discuss');
});
test('request clarification remains part of the proposed conversation',()=>{
 const started=transition(initial(),'start');assert.equal(started.hasProposal,false);
 const confirmed=transition(transition(started,'clarify'),'confirm');
 assert.equal(confirmed.hasProposal,true);assert.equal(confirmed.fromRequest,true);assert.equal(confirmed.on,false);
});
