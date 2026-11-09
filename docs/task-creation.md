# Native task creation

Task creation has a separate attempt identity so a lost response does not cause a duplicate task. This protocol belongs to Daymark. Automation keeps its existing original event key and native effect receipts.

## Create and read back

`POST /api/tasks` requires the usual current demo session, session-context header, same origin and JSON content type, plus `X-Task-Create-Id` containing a UUID. The business body remains `{projectId,title,notes?,tags?,priority?,dueAt?}`. Internal native callers supply the UUID separately as `createTask(owner,input,{operationId})`.

Choose a new UUID for an explicit attempt and retain it with the submitted body. The server normalizes the full candidate once using native field rules. Reusing the same ID and equivalent normalized candidate returns the original terminal result. Reusing it with a different candidate returns `409 CREATE_PAYLOAD_MISMATCH`; this does not prove that the original attempt failed. Different IDs are separate attempts, even with identical fields.

A confirmed creation returns `201 TaskDto`. A replay returns the same original task snapshot, including after that task is edited or deleted. It never recreates the task. Refresh the current authorized task list before rendering current task state; do not append the saved snapshot to it.

A confirmed no-create response has this closed body:

```json
{"operationId":"<attempt UUID>","state":"NOT_CREATED","code":"RULE_DENIED","message":"Add a due date for this task."}
```

| Code | HTTP status | Meaning |
| --- | --- | --- |
| `RULE_DENIED` | 422 | The current rule denied the attempt. |
| `CHECK_UNAVAILABLE` | 503 | The selected rule could not be checked. |
| `STALE_ATTEMPT` | 409 | The attempt expired, was cancelled, or its rule changed. |
| `NATIVE_REJECTED` | 422 | Native validation rejected the normalized candidate. |

Only a validated terminal envelope for the matching attempt confirms no creation. A bare error or status code does not. Invalid input that cannot be normalized receives ordinary validation failure before a terminal result is recorded.

`GET /api/task-create-operations/:operationId` requires the current session and returns `{operationId,state:"CREATED",task}`, the saved `NOT_CREATED` envelope, or exactly `{operationId,state:"UNRESOLVED"}`. It never starts creation. An absent result remains unresolved because the original request may still finish.

After uncertainty, retain both the editable draft and the separate frozen attempt. Read back first. If still unresolved, an explicit retry uses the same ID and frozen body. Do not automatically resubmit, change the payload under that ID, or allocate another ID while the original attempt is unresolved. After confirmed no-create, an explicit correction is a new attempt with a new ID.

## Access and persistence

Tasks, their ordinary creation events and successful terminal results commit together. Confirmed no-create results contain no task or event. A matching concurrent winner takes precedence over a later allow or denial. Terminal results are immutable across ordinary restart and task edits/deletion.

Every saved-result read and replay checks the current session, owner and access to the original project. Project access loss returns a generic access error without the saved snapshot or rule message. A different owner cannot read the result by knowing its UUID.

The exclusive destructive demo reset backs up and clears these records with the tasks. Its newly seeded projects have different IDs. A retained attempt must remain bound to its original owner and exact project ID; never retarget it to the new default project. Browser drafts and attempt IDs are not promised to survive page reload.
