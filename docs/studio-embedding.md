# Embedding Extension Studio in a host application

Proposed design. Daymark is the reference host. The goal is for another application with scoped authoring and lifecycle services to embed the same conversation and review experience, supply its own domain views, and keep control of what can run.

Define this boundary now; a second host is not a prerequisite for design. Implementation, the alternate-domain fixture and independent packaging are separate delivery decisions. This proposal does not expand the active general-Studio implementation scope or claim that today's component already meets the boundary.

## What the host supplies

| Boundary | Studio owns | Host owns |
| --- | --- | --- |
| Entry and navigation | Library, conversational start and discovery, optional review canvas, accessible focus and reading position | Mount point, session changes, available customization opportunities, return to the original application context |
| Authoring | Messages, clarification choices, proposal presentation, draft versus active status | Agent or manual workflow, model credentials, approved hooks and catalog, candidate generation, validation, supported actions and reasons for unavailability |
| Evidence | Opening a specific run, expected and observed results side by side, history and separate Approve and Use controls | Simulation, exact revision and evidence storage, redaction, approval policy, selection generation, rollback eligibility |
| Domain content | Placement and interaction conventions for a behavior sketch, scenario or result detail | Trusted local components and labels for domain facts, interpretation of a consumer receipt, navigation to actual application behavior |

The host application mounts Studio within its authenticated UI. Its integration translates server responses into the current opportunity or item, draft, approval, active selection, evidence references and available actions. It translates user actions back into host operations. A host can implement this with ordinary functions and existing endpoints. These responsibilities do not prescribe a transport or storage schema. An embedding host with only a task API would still need to implement authoring, evidence and lifecycle services for the corresponding actions to work.

## One interaction from entry to use

| User action | Studio behavior | Daymark integration |
| --- | --- | --- |
| Open Customizations or New | Show known items and available starting points. Opening the conversational start is side-effect free. Resume a draft if one exists. | Read the signed-in owner's lifecycle state and expose the available `TaskCompleted` opportunity. Preserve the originating task and unsaved edits on return. |
| Describe or choose behavior | Render conversation and trusted choice controls. Show a visible reason for unsupported actions. | Accept the first explicit message as an owner-scoped customization. The authoring service uses the approved host model and returns bounded proposal and review data. Text and generated markup cannot register code or invoke lifecycle actions. |
| Test and review | Offer the saved run when ready. Keep the user's place until they open it. Compare the recorded expectation with the recorded outcome. | Simulate the exact revision with host-owned fixtures. Resolve evidence by ID. Identify simulated effects separately from outcomes on saved tasks. |
| Approve | Submit the current draft version, revision and the exact evidence the person reviewed. Refresh from the server. | Verify session, owner, current draft, evidence and dependencies. Approval leaves the active selection intact. Expose the evidence bound to approval separately from the latest run. |
| Use, disable or restore | Show the proposed consequence and keep current behavior visible until the server confirms the change. Restore names a specific eligible historical revision. | Validate the expected selection generation and all operation-specific pins. Reject stale requests. A saved-task check belongs to Daymark, including whether its result may still be displayed after a session or generation change. |

Treat identifiers as opaque. A template, hook, customization, revision, evidence run and active selection serve different purposes. In particular, a host with one slot per owner and hook need not mint a fictitious customization ID. A library row may represent an available starting point. Create an independent item only when the host supports that operation and confirms persistence.

## Integration and failure rules

- Keep endpoint paths, transport types, domain labels and consumer-specific result shapes together on the host side. Studio can request a run by reference without constructing a URL or interpreting `openCode`. Keep the existing host navigation callbacks so embedding does not require Studio to take over routing.
- Studio controls the transcript, split width, keyboard navigation, focus return and which evidence is open. A changed owner clears owner-specific state and invalidates outstanding responses. Remount reads persisted lifecycle state. Keep transient reading position separate from durable approval.
- Prefer a small set of built-in review surfaces with locally registered domain views where needed. An unavailable or unknown view falls back to a safe description. Raw HTML, executable strings, arbitrary URLs and model-chosen callbacks are outside the rendering contract.
- Treat action availability as presentation. The host reauthorizes every operation. On a stale version or uncertain mutation, refresh from the server before offering another attempt. Keep historical receipts inspectable without enabling approval or activation of the current draft from an old receipt.
- Explicitly distinguish the latest run from the approved run. At the inspected Daymark baseline, the state response returns the latest evidence and an approval boolean. If A was approved and B was run later on the same revision, reopening A requires a server-supplied approval-to-evidence reference. This narrow readback correction is already included in the active Daymark plan. A host lacking the reference can label B as the latest run, but cannot claim exact approved-run reopening. Never infer that link from result equality or history order, or silently weaken Daymark's required reopening behavior.

## Building toward this in Daymark

1. Keep the existing lifecycle service and routes. Move their translation out of the interaction view when touching the corresponding flow. Group task scenario explanations and receipt rendering with the host integration. Keep one Studio interaction controller.
2. Qualify the boundary without building a second app. Open Studio from the library with no task selected, continue a real draft, run examples, review, approve, leave, reopen and use it. Verify the same journey from task detail preserves the unsaved form. Check that a planned action explains its availability and sends no write.
3. Exercise the shared interaction with a small host fixture whose opaque identifiers, labels and result fields contain no task vocabulary. A custom result view should replace the domain rendering without replacing the conversation, keyboard handling or approval flow. Include approve-A/run-B/remount, an owner switch during a request and a stale activation generation. Run the authority cases against Daymark's server as well.

Use these journeys to plan the boundary, then qualify its implementation without Studio interpreting a task receipt or the host reimplementing review interactions. Keep the reusable portion in the application initially. Independent packaging, version compatibility across hosts and measured integration effort are separate delivery decisions.

See the [Studio interactions](studio-on-demand-review.md), [extension lifecycle](read-extension-lifecycle.md) and [task effects](task-effects.md) contracts.
