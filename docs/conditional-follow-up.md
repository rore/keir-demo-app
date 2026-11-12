# Follow up on high-priority work

Maya wants a **Follow up** task after completing high-priority work in **The spring collection**, but only when that project has no open task with that exact title. Normal-priority work and other projects should leave the task list alone.

This example uses the existing task workspace. [Run locally](../README.md#run-locally), choose Maya and [configure an assistant](ai-authoring.md#configure-a-provider) if you want to author it yourself. Provider requests can incur charges. The automated journey uses scripted authoring responses; compilation, simulation, approval, activation and native task effects are real. It does not qualify a live model.

## Create and check the customization

Open **Customizations** → **New customization**. **Avoid another follow-up** is an editable starting point. Give it the actual project and exact title:

> When a high-priority task in The spring collection is completed, check for an open task titled Follow up in that project. Create one only if none is open. Other priorities and projects should do nothing. If the check is unavailable, create nothing.

Confirm the assistant's clarification. Choose **See proposed change**, read **Summary**, then choose **View simulation**. The checked examples should establish these boundaries:

| Situation | Expected behavior |
| --- | --- |
| High-priority completion in the chosen project, no open Follow up | Check for a match, then create Follow up in that project. |
| Same situation with an open Follow up | Check for a match; create nothing. |
| Normal-priority task or another project | Skip the open-task check and create nothing. |
| Task details or the open-task check are unavailable | Report the failed check; create nothing. Failure is not evidence that no match exists. |

Simulation leaves saved tasks unchanged. Choose **Approve this change**, then separately **Turn on for tasks completed**. The selection applies to future matching completions; earlier completions are not replayed.

## See it run in Tasks

1. Open **Tasks** → **The spring collection**. Enter **Send collection preview**, choose **Details**, set **Priority** to **High**, and add it.
2. Complete it. Its **Customization outcome** shows the real creation. Choose **Open task** to inspect the saved **Follow up** in the same project.
3. Add and complete another High-priority task there. While Follow up remains open, no new follow-up is created.
4. Complete Follow up, which starts with Normal priority. It does not generate another under this rule. A later Normal-priority completion still makes no change even when no Follow up is open.

The lookup uses an exact, case-sensitive title and current project access. It is a snapshot: simultaneous completions can each observe no match and create more than one follow-up. It does not reserve a unique title. If you make a follow-up High priority and complete it, it becomes another eligible event.

## What this demonstrates in Keir

Core 0.4.0 lets the program use a conditional call's actual scalar result in a later condition. Here, the task's eligibility controls whether `tasks.openMatch` runs; its Boolean answer controls the single `tasks.create` call. A skipped lookup supplies no placeholder result. A failed lookup terminates without falling back to creation.

No new host capability, model field or orchestration service is needed. Daymark still owns task persistence, permissions, native receipts and selection; Core enforces the program contract. The same compiled artifact is checked and executed. See [host binding](task-effects.md), [package provenance](package-provenance.md) and the [verification boundary](../tests/README.md#conditional-follow-up).
