# Application source

`data.mjs` owns native task services, SQLite constraints and data lifecycle. `app.mjs` exposes the same owner-scoped operations behind Fastify session/Origin checks. `server.mjs` owns loopback startup and the shared exclusive data lock. `web/` contains the React/TypeScript native workspace; Vite builds it into `dist/`.

The Personal customization path uses the independently packaged Node runtime and Java compiler:

| Responsibility | Implementation |
| --- | --- |
| Host model, hook catalog and exact package pins | [extension-catalog.mjs](extension-catalog.mjs), [numeric DCM](../extensions/task-effect/numeric/dcm.json), [retained authoring DCM](../extensions/task-effect/retained/dcm.json) |
| Before-save decision and native continuation | [task-create-guard.mjs](task-create-guard.mjs), [app.mjs](app.mjs) |
| After-save binding, dispatch and native effects | [task-effects.mjs](task-effects.mjs), [data.mjs](data.mjs) |
| Exact-artifact simulation and decision consumption | [task-effect-simulation.mjs](task-effect-simulation.mjs) |
| Source compilation | [compiler.mjs](compiler.mjs) |
| Conversation, scoped tools and provider transport | [authoring-service.mjs](authoring-service.mjs), [authoring-agent.mjs](authoring-agent.mjs), [authoring-provider.mjs](authoring-provider.mjs) |
| Saved revisions, evidence, approval and selection | [extension-lifecycle.mjs](extension-lifecycle.mjs) |
| Host UI and customization conversation | [web/main.tsx](web/main.tsx), [web/Customizations.tsx](web/Customizations.tsx), [web/Studio.tsx](web/Studio.tsx) |

Adapters call native services with trusted host-bound identity. AI proposes source and scenarios; Daymark validates tools and authorizes real operations. People approve and turn on rules through Daymark. The proposed [reusable Studio boundary](../docs/studio-embedding.md) is not a separately packaged component.

Personal and Team share [Keir turn logic](keir-authoring-agent.mjs) inside this app. The [Team project reference](../docs/native-task-app-design.md#team-projects) describes the separate project-scoped authoring tools, durable journal and native lifecycle.
