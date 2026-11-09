# Selected Studio direction and comparison

The user selected **A, a decision brief within the conversation**, for the proposed behavior and approval decision. Develop the idea through normal dialogue first. Use short questions like B's when clarification helps; do not require the person to traverse another guided sequence before every decision. There is no separate canvas. B remains a historical comparison, not an extra production flow.

## Why this direction

A gives the person one place to inspect the behavior, a familiar before/after task, the examples and their limits. It is easier to return to later without reconstructing several messages. B is a credible alternative for explaining an unfamiliar rule, but spreads the decision across more messages and adds an extra “ready to decide” step. Keep conversation as the primary means of changing and questioning the proposal, with this compact explanation as its decision aid.

A was selected after explanation of both alternatives using the actual due-date behavior. This is direction acceptance, not production completion or a usability study. Two independent agent readers reconstructed the rule and authority boundaries correctly. The first preferred A for scanning and deciding; the second preferred B for a first encounter and A for returning. That disagreement is useful evidence about the tradeoff, not a vote or proof that either works for business users. No human testers participated in those proxy exercises; the later user selection is a separate product decision.

## Same behavior, different presentation

Both layouts use one shared semantic dataset in `verified-example.mjs`. Behavior and four case categories follow a developer inspection of the actual saved source, executable artifact and matched proof. Public task names, projects, dates and the earlier discussion are synthetic substitutes. This prototype does not recreate, rerun or publish the saved proof.

- A new-task event starts the rule. Read that same task; only if its due date is absent, set it to the event time plus 604800 seconds (exactly 168 hours).
- Every project is included. There is no title, tag, priority or task-status restriction. Existing dates and omitted fields stay unchanged; turning on does not backfill older tasks.
- Two saved examples add dates, including another project and a year boundary. One keeps an existing date. One deliberately fails the task read temporarily, producing no update and no effect as expected. All four match their saved expectations.
- The intentionally failed read is a completed, matching check. It is not an unfinished check, a mismatch, or evidence that all failures are safe. Missing tasks, denied access, rejected writes, uncertain write outcomes and suitability around clock changes remain outside this example suite.
- The underlying saved proposal was neither approved nor in use when inspected. Prototype approval and turn-on buttons change local scripted state only.

The source description in the application needs a separate production correction: source parsing falls back to a description path that does not cover this rule, losing its condition and elapsed duration. Better layout alone cannot repair untrustworthy descriptions. Developers must derive the explanation from the exact source and bindings, preserving uncertainty for unsupported forms.

## Comprehension exercise and revisions

| Round | What readers saw | Findings | Response |
| --- | --- | --- | --- |
| 1 | Both alternatives at desktop, phone and short sizes, expanded unavailable-read case and approved state | Rule, 168-hour timing, unchanged cases, four-case meaning, limitations and approval versus use understood. A preferred. Long card and composer overlap made reading harder. | Put desktop conversation and composer in separate rows; keep earlier proposal visible and read-only during follow-up; retain initial clarification; explicitly label B's proposed state. |
| 2 | Revised rendered alternatives and evidence/approved views; a fresh reader without the first review | Semantics understood. B preferred for first encounter, A for revisiting. Scroll route unclear, B repeated the check summary, expanded-row affordance weak. | Add a keyboard-accessible route to examples and next steps; remove B's repeated summary; show expanded state. Phones and short windows use ordinary page flow to recover reading space. |

The final small navigation and phone-flow changes received focused browser verification and author inspection, not a third independent comprehension round. Neither round evaluated real assistant responses, real persistence or real lifecycle operations.

## Verified prototype behavior

Both alternatives were rendered at 1440×1000, 320×740 and 683×384. Browser checks cover horizontal overflow, reading-area/composer separation, keyboard navigation to examples, request and clarification, approval without activation, separate turn-on, a subsequent change, opening an earlier idea and returning through Customizations while retaining unsent text. The state model separately asserts approval/activation ordering and that edits retain the previous proposal and current use. No browser JavaScript errors were observed.

Explicit rename is available; collection identity is based on the proposed behavior rather than an exploratory first question. Earlier work is secondary under More. Using an earlier idea starts discussion of a new proposal and does not replace the behavior already on. These are scripted demonstrations, not claims of backend capability or durability after refresh.

## Production handoff

Use the selected **Summary + Simulation** vocabulary. Under Simulation, explain “Example tasks; your tasks are unchanged.” Outcome labels describe what changed, was kept, or stayed unchanged during a deliberately unavailable read. Keep expected/observed detail; do not substitute “matches” or “checked examples” for the user's task outcome. Incomplete simulation, an unexpected outcome, an unconfirmed effect and an uncovered situation remain distinct. The final vocabulary change received a focused render check, without restarting the comparison or adding another proxy round.

Keep one exact proposal and its independent evidence connected to the decision brief. Do not combine evidence from different versions or infer conditions from successful examples. Preserve the actual conversation, explicit name, reading position and unsent message. Show what is currently on separately from work in progress. Show mismatches, incomplete checks and unknown effects with their own truthful recovery paths; the current all-matching sample is not coverage for those states.

Retain host-owned identity, evidence freshness, human approval and activation boundaries. The selected direction can proceed to implementation. Review the actual implemented interaction afterward; selecting this prototype does not certify production behavior. The old canvas design and prototype are preserved as historical context, not parallel implementation guidance.

## Try the scripted comparison

From the repository root, run `node docs/studio-business-understanding/serve.mjs` and open the printed loopback URL. Use the top A/B links to compare; use the prototype controls to start from the request. The server uses an available ephemeral port and accepts `stop` on stdin. No dependency installation or application database is needed. All state stays in the page and is lost on refresh.
