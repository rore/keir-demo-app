# Walkthrough: create a follow-up when a task is completed

Maya wants every completed task in **The spring collection** to leave her a new **Follow up** task in the same project. This tour follows that customization from a plain-language request to its saved result in Daymark. You can read it without running the app.

The screenshots show the app with fictional, disposable data. Authoring responses are scripted using the [offline fixture](../tests/README.md#offline-configured-ai-fixture); compilation, simulation, approval, activation and the native task writes are real. No paid AI requests were made for this tour. [Screenshot provenance](images/walkthrough/provenance.md) records the exact app revision and image checksums.

To try it yourself, [run Daymark locally](../README.md#run-locally), have **Java 21** available, choose **Maya**, and [configure an AI provider](ai-authoring.md#configure-a-provider). Provider requests can incur charges, and the conversation may differ. Use a fresh demo workspace and add a second project, such as **Other project**, to try the nonmatching behavior too.

## 1. Describe the change

Open **Customizations** → **New customization** and send:

> When I complete a task in The spring collection, create a task titled Follow up in that project.

The assistant asks whether this should apply only to that project. Confirm the boundary: **create Follow up after a completion in The spring collection; other projects should create nothing**.

![Maya’s request and the assistant’s question confirming the project and follow-up title.](images/walkthrough/01-request.png)

*The conversation establishes when to act, what to create, and where it belongs.*

## 2. Read the proposed behavior

When the assistant offers checked results, choose **See proposed change**. **Summary** separates **When**, **Only when** and **Then** so you can check the proposed behavior at a glance. Here, the triggering task must be completed and belong to **The spring collection**. The new task starts open, with Normal priority, no tags, empty notes and no due date. The completed task stays unchanged. **Rule details** keeps the full explanation available.

Choose **Rename** if you want a more useful saved name. You can use the suggested name, edit it, and choose **Save**. A suggestion changes nothing until you save it; an existing name stays yours to keep or change. This tour saves **Create “Follow up” tasks**.

![Summary of the proposed follow-up rule, marked Proposed change · Not on, with View simulation.](images/walkthrough/02-summary.png)

*Use **Ask for a change** if the proposal differs from your goal.*

## 3. Check the examples and approve

Choose **View simulation**. Compare the intended action with what actually happened in each simulated situation. The matching example shows the task that started the rule alongside the separate **Created example task**. The new task's title, project and tags are recorded here; its other details were not checked by this example. The app's usual defaults in Summary describe what the task service does, rather than additional values verified by this simulation.

Open the individual examples to read their intended and observed results. A task completed in **Other project** creates nothing. The remaining examples check an open task and missing, denied or temporarily unavailable task details.

These are example tasks and simulated service responses: **your real saved tasks are unchanged**. A passing example means its observed result matched its expectation; an unavailable-task example can pass by correctly making no change.

![Simulation showing the separate created task, its recorded values, a clear limit on missing evidence, and expandable checked examples.](images/walkthrough/03-simulation.png)

*After reading the examples and coverage limits, **Go to approval** takes you to **Approve this change**. Choose it only when the checked proposal matches your intent. Approval records agreement to this exact version and its saved checks.*

## 4. Turn it on separately

After approval, the status is **Approved · Not on yet**. Choose **Turn on for tasks completed** to use it for future matching completions. If another customization is selected for that trigger, Daymark names what will be replaced; the previous customization stays saved.

![Approved · Not on yet status and the Turn on for tasks completed button below the checked results.](images/walkthrough/04-approved.png)

*Approval and activation are separate decisions. Turning it on does not change saved tasks or replay earlier completions.*

## 5. Complete a matching task in the app

Return to **Tasks** and select **The spring collection**. Add **Send the final collection preview**, then select its completion circle. Daymark runs the approved Keir program for this new event and saves the result through its native task service. Execution needs no further AI request.

![The completed collection-preview task shows Created “Follow up”, and Follow up appears in the project’s Up next list.](images/walkthrough/05-runtime.png)

*The completed task’s **Customization outcome** now reports a real creation, separately from the original completion.*

## 6. Open the saved result

Choose **Open task** in the outcome. The new **Follow up** opens in the ordinary **Task details** form. It is an open, saved task in the same project, ready to edit or work on; it also remains in the task list after reload.

![The saved Follow up task open in Task details, with Normal priority and empty optional fields.](images/walkthrough/06-saved-task.png)

*The result is part of the task workspace, beyond the earlier simulation preview.*

Completing a task in **Other project** leaves it completed and creates no follow-up. This simple rule does not check for an existing open **Follow up**: each later matching completion can create another, including completing a follow-up itself. Merely creating the follow-up does not trigger this completion rule.

## Changes and recovery

Opening a saved customization or earlier messages sends no AI request. A changed proposal needs fresh checks and approval; the version already on keeps running until you explicitly replace it. Approval alone never turns it on.

An unknown effect means a task may already have changed. Use **Check result** and the available readback before another action; do not repeat task completion to retry a reaction. Cancellation cannot undo a committed write. After a lost authoring response, inspect the original saved request and use its offered recovery rather than sending a replacement paid turn.

For version, evidence and recovery contracts, see the [lifecycle reference](read-extension-lifecycle.md). For native effect guarantees, see [task customizations](task-effects.md).
