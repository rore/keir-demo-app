# Make the customization understandable

A is the selected implementation direction. B is a historical comparison, not an additional production flow. Neither prototype is an implemented capability or a certificate of runtime behavior.

## The person's model

| Concept | Meaning | User-facing entry |
| --- | --- | --- |
| Customization | A named behavior the person wants the app to follow. It keeps its identity while it changes. | A meaningful goal name in Customizations. Preserve a name the person supplied. |
| Conversation | The discussion that develops and explains this behavior. Reading it changes nothing. | Open the customization. Earlier messages stay in the same discussion. |
| Proposal | The specific behavior currently being considered. It may differ from what is on. | “Proposed change · Not on” and an inline explanation of behavior. |
| Simulation | Trying this proposal on made-up tasks and comparing what happened with what was intended. | “Simulation” with “Example tasks; your tasks are unchanged.” |
| Approval | The person's agreement to the exact explained proposal and its checks. | “Approve this change”; followed by “Approved · Not on yet.” |
| Current use | The exact behavior the app is applying now. | “On” or “Off,” separate from the proposal's state. |
| Earlier version | A prior form of the customization, useful for understanding a change or proposing a return. | “Earlier versions,” inside “More.” Not a primary workflow stage. |

Saving is not a decision the person has to make. The app keeps accepted conversation and proposal work as it goes; unsent text stays an unsent draft. Use “Your conversation and proposal are kept” only when persistence is confirmed. An unknown response must say what could not be confirmed and offer the existing recovery operation. Do not invent a successful save indicator.

“Review” is an activity, not a durable object the user must file or find. Say what they can inspect: “What this will do,” “Simulation,” “What is on now,” or “Earlier versions.”

## Two different layouts to compare

**A — Selected: a decision brief inside the conversation.** One assistant reply contains the behavior, a recognizable before/after task and a compact set of example outcomes. The whole decision is readable in one document-like card. Follow-up discussion continues below it. Reopen the current brief through “See proposed change.”

**B — Historical comparison: a conversation that explains the decision in parts.** Short assistant exchanges introduce the behavior, a concrete task change, and the exceptions. The person can ask “What stays the same?” or “What if a task cannot be read?” Each answer stays in the conversation. A small decision message gathers the essentials and limitations before approval. There is no fixed side canvas, modal reading task, mandatory wizard or persistent box covering chat.

Both alternatives must use identical verified behavior and cases. A compact surface cannot omit a condition, hide a failed check behind a good-looking total, or make approval look like activation.

## Reading outcomes

- **Changed as intended:** the observed task change matches the independent expectation. Show the actual before/after fields.
- **Left unchanged as intended:** no change was the desired outcome for this case. Explain why.
- **Problem handled as intended:** a deliberately unavailable task produced the expected safe outcome. Name the simulated problem. This is not an unchecked case and does not mean the app is currently unavailable.
- **Different from what we wanted:** show desired versus observed change; offer correction, not approval.
- **We could not finish the simulation:** no trustworthy result. State what is unknown; do not count it as a match.
- **Not covered by this simulation:** an identified situation is outside the recorded examples. Keep that limitation visible before approval.

Never summarize these distinctions as “4/4 passed” alone. The main summary should name how many changes, intentional no-changes, and expected problem outcomes were checked. Detailed expected/observed evidence remains accessible by expanding the named example.

## Leaving and returning

Opening a customization restores its own conversation and unsent text. A quiet status identifies the proposal and current use separately. Opening an earlier version labels it “Earlier version · Read only”; its examples never approve the current proposal. “Use as a new proposal” copies only eligible earlier work into a new draft, leaves the current behavior unchanged and requires fresh checks/approval/turn-on as applicable. If the host cannot perform that operation, show the supported action and its actual consequences instead.

A newly approved proposal remains off until “Turn on.” When replacing another rule for the same trigger, name what stops and what starts before confirmation. Changes for other triggers keep their existing selections. A later edit does not quietly replace what is on. A late reply offers new information without moving the person's reading position or overwriting unsent text.

## Collection names

Use an explicit user name first. Otherwise offer a suggested name grounded in the current verified behavior, with a clear rename control. Before trustworthy behavior exists, use a short description of the current intent, marked as a discussion. Do not name a completed proposal after an exploratory question such as “What can I customize?” Never overwrite an explicit name as the conversation evolves.
