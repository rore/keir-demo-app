# Application verification

Add tests alongside implemented behavior: task CRUD independent of extensions; real adapter authorization, bounded results, concurrent uniqueness and replay; exact-artifact simulation/activation; business rejection and uncertain outcome handling.

Fake-adapter scenarios verify extension behavior, not database guarantees. Shared runtime conformance belongs in `keir-core`. No executable test suite exists yet.
