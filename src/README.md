# Application source

`data.mjs` owns native task services, SQLite constraints and data lifecycle. `app.mjs` exposes the same owner-scoped operations behind Fastify session/Origin checks. `server.mjs` owns loopback startup and the shared exclusive data lock. `web/` contains the React/TypeScript native workspace; Vite builds it into `dist/`.

Later Keir adapters must call these native services with trusted host-bound identity. No runtime, authoring or activation implementation is copied into this slice.
