# Extension Studio: first experience design

Status: initial interactive design for user review, not an implemented authoring service. Run `node docs/extension-studio/serve.mjs` from the repository root and open `http://localhost:4179/`. Stop this prototype server with Ctrl+C when finished. It serves only the [prototype](extension-studio/index.html) and its state module on loopback; no dependency installation, Python or AI key is needed. It uses browser modules; opening the HTML directly as a file may not work. `PORT` can select another available local port without persistent environment changes.

The [core roadmap design feature](https://github.com/rore/keir-core/blob/main/roadmap/features/extension-studio-design.md) owns progress. The core-owned `agent-workflow:extension-studio-prototype` record owns this implementation contribution. Neither document replaces the authoring/lifecycle contracts.

## What the visitor should understand

An app exposes approved operations and a hook once. A customer describes a behavior, resolves ambiguities, inspects what was produced, checks scenarios and explicitly activates an exact revision. They can then see the resulting behavior in the same task application. AI assists authoring; compiler validation, simulation and host activation serve different purposes and remain visible.

The Studio is the demo's centerpiece. Keep the task app useful and small, and spend deliberate design effort on the customer's understanding and control. A chat transcript alone cannot show the current behavior, expectations, active version and actual result reliably.

## Representative customization

Maya asks: “When a task is completed in Launch, create a task called Review completion.” The host supplies task/event facts and protected user scope; the extension owns the selected project and title. The shared catalog contains generic `tasks.get` and `tasks.create`; there is no follow-up-specific capability or hook-specific list of calls.

The source logic reads the completed task, checks the selected project, then conditionally creates one task. Other projects cause no change; a missing source causes a business rejection without a write. Source-owned project constants do not imply a new hook input. The example fits the current scalar, one-WRITE shape; actual real effects still require separately accepted core/native admission evidence.

Leo's draft instead selects Operations and Plan next step. Sam begins without an active customization. Each user's state is separate in the prototype. This demonstrates the intended UX, not implemented authentication or isolation guarantees.

## Information architecture and visual direction

- Keep the surrounding task-app navigation visible to connect authoring with application behavior. A slim workspace rail and the current demo user anchor the context.
- The Studio workspace has a primary interaction area and an always-visible behavior summary. Keep user scope, trigger, maximum effect and active revision visible while the draft changes.
- Describe, Behavior, Test, Review and Activity organize information, not a one-way wizard. Users can revisit earlier steps; validation and evidence requirements control consequential actions.
- Use warm off-white surfaces, forest-green actions, dark ink, fine borders, restrained rust warnings and editorial headings. Give the work clear hierarchy without gradients, decorative metrics or a generic dashboard grid.
- Primary actions describe their consequence: Create a draft, Confirm & validate, Run scenarios, Approve this revision, Activate prototype revision. Approval and activation remain visibly separate.
- Technical details are secondary. Business users should understand conditions and effects without IR. Production UI can disclose exact artifacts, traces and diagnostics on demand using maintained contracts.

## Screen and interaction contract

| Area/state | What is visible | Allowed transition and evidence |
| --- | --- | --- |
| Provider setup | Connected/setup-needed status and clear local configuration guidance | Missing provider blocks new AI generation, not existing tasks or review. Prototype only toggles an example state; it never accepts keys. |
| Describe | Customer request, retained intent and one concrete example | Generation prepares a proposed behavior, not an active extension. In this prototype free text is retained but only the single example is scripted; Behavior asks for explicit confirmation. |
| Clarify/Behavior | Project/title choices, ordered actions, no-op and rejection boundaries | Editing behavior creates a new draft revision and invalidates validation, scenarios and approval. The current active snapshot stays unchanged. |
| Unsupported request | Concrete unsupported requirement and explanation | Revise toward supported event-triggered behavior; never claim scheduling exists. Production repair preserves user requirements or asks before narrowing them. |
| Test before run | Scenario inputs and independently selected expected outcomes | The user can deliberately choose an incorrect outside-project expectation. No real host operations occur during simulation. |
| Test matched | Expected/observed comparison per scenario and evidence limitations | Review becomes available only after current validation and matched scenarios. Passing examples is not a proof of all behavior or native guarantees. |
| Test mismatch | Expected versus observed difference and both resolution paths | The user decides whether intent/behavior or expectation changes. Changing expectations invalidates prior approval and requires another run; no silent oracle rewriting. |
| Review | Behavior, selected scope, draft revision, scenario evidence and explicit confirmations | Approve this exact revision only after reviewing both behavior and expectations. Approval alone does not activate anything. |
| Approved | Clear approved-but-not-active state | Activate explicitly. Production must bind source/artifact/model/scenario/authority identities, not the prototype's revision number alone. |
| Activity | Exact active revision, illustrative task outcome and earlier events | A completed example event shows what a created task would look like. Production must replace the illustrative feed with actual host evidence. |
| Unknown result | Lost response and explicit uncertainty | No blind retry action. A task may exist; real host records and reconciliation are needed. |
| Revised draft | New draft alongside unchanged active selection | Review/retest before replacing the active revision. Old approved evidence is not reused after relevant changes. |
| Disabled/rollback | Changed future selection plus retained prior activity | Neither action undoes tasks/effects or changes in-flight admissions. Rollback needs a previous reviewed selection. |
| User switch/resume | New user's draft, active revision and activity | Prototype changes remain tab-local and survive reload where session storage is available. Production must enforce scope in services and ignore stale client responses, not just switch UI objects. |

## Prototype review tour

1. As Maya, inspect the request and create a draft. Confirm the project/title and the three proposed actions. Validate it.
2. Inspect the three scenario expectations and run them. Change the outside-project expectation to Create a task, rerun and inspect the mismatch. Choose the intended expectation yourself and rerun.
3. Review revision 1, confirm behavior and expectations, approve it, then separately activate it. Try a completed event and inspect the explicitly illustrative task result.
4. Explore a lost response. Confirm that UNKNOWN is not presented as no effect or safe to retry.
5. Edit the draft title. Confirm the previous active revision remains intact and the draft needs fresh validation, scenarios and approval. Activate the second revision, then roll back the selection and disable it.
6. Switch to Leo, create a different customization at the same hook and return to Maya. Confirm each retains its own draft/selection. Sam has no enabled customization.
7. Toggle provider setup-needed and attempt generation. Explore an unsupported scheduling request. Reload to inspect tab-local resume. No real key, request, activation or mutation occurs.

## Accessibility, responsive behavior and recovery

Use native labeled controls, keyboard focus indicators, a named journey navigation, disabled actions with accompanying explanations and an alert region for errors. Communicate statuses in text as well as color. At narrow widths the rail compacts and the behavior summary follows the main interaction; avoid hidden consequential state or clipped action controls. Validate actual keyboard flow, contrast, overflow and representative desktop/mobile screens before claiming these qualities.

The production design must additionally specify generation/compilation/simulation progress, cancellation, provider timeout/auth/rate-limit/budget errors, editable clarification turns and durable draft recovery. Never replace a deliberate decision with an indefinite spinner. Preserve the last valid draft; explain whether an operation stopped and whether earlier effects may have occurred. This first prototype has immediate scripted transitions and setup/unsupported/mismatch/uncertain examples; asynchronous provider/cancellation and complete interrupted-session interactions remain design work, not implemented claims.

## Production seams and verification

Host services own scoped catalog discovery, source validation/compilation, scenario execution, immutable evidence/approval, active bindings, revocation and runtime evidence. The model receives bounded tools; it cannot self-approve, publish a catalog or bypass host authorization. Provider credentials remain on the local app server. The same authoring workflow will be qualified against selected providers/models; the prototype is not that qualification.

Keep fast pure interaction regressions separate from native service tests and actual browser journeys. `node --test docs/extension-studio/studio.test.mjs` checks approval prerequisites, edit invalidation, mismatch recovery, per-user prototype state, rollback, absent provider and honest unknown outcomes. These tests protect the prototype's state transitions only. Production acceptance also needs native scope/persistence tests, exact core artifacts, actual authoring/lifecycle tools and separate opt-in live-provider checks.

## Review decisions still open

- Does the conversation plus persistent behavior summary explain the system clearly enough? Decide whether conversation should remain visible through Test/Review and how much history to show.
- Review the visual direction, screen density and mobile ordering in the actual prototype. It is a proposal, not a user-approved design.
- Define the first live AI clarification/repair interaction and asynchronous/cancellation states; this prototype deliberately supports one scripted customization.
- Decide how actual task-app results link back to the approved revision without exposing unnecessary technical details.
- Review all recovery paths and exact approval boundaries before implementing the production Studio UI. The full design feature remains active until these decisions and user feedback are resolved.
