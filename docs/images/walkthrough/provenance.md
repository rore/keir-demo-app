# Walkthrough screenshot provenance

These are unedited screenshots captured on 17 November 2026 from the reviewed Daymark usability correction based on [`c4d503a4c3f3c4898f1df30cdecb05fd7f3b2d25`](https://github.com/rore/keir-demo-app/commit/c4d503a4c3f3c4898f1df30cdecb05fd7f3b2d25). That link identifies the pre-correction base; the rendered asset and image hashes below identify this corrected capture set. The screenshots are covered by the repository’s [Apache License 2.0](../../../LICENSE).

The flow uses fictional, disposable data and the [offline authoring fixture](../../../tests/fixtures/authoring-server.mjs). Assistant responses are scripted; the installed compiler, simulation, saved evidence, explicit human approval, separate activation and native task writes are real. No paid model requests were made. The user explicitly chooses the suggested name and saves it; the assistant does not rename the customization.

The capture follows the [walkthrough](../../customization-walkthrough.md): request and clarification, proposed behavior, recorded simulation values, approved but not active, completion of a newly added task, and the actual saved follow-up task. The app uses its pinned Core 0.5.0 compiler/runtime package bytes. Source and built-asset hashes were frozen before capture. The rendered JavaScript SHA-256 is `7e0aecdebb9eaf377b4c61bc8c4452d3dc9f5cd43ba3916245a27aa6d2c65954`; the stylesheet SHA-256 is `2381ad1877ea37437d5ec93ba1a99481343fe34ed66d48b53578037440947378`. The isolated fixture does not certify a live deployment or provider compatibility. The images contain no real customer data or provider settings.

Captured with Playwright 1.64.1 and Chromium 156.0.8078.4 at a 1,440 × 1,000 CSS-pixel viewport in UTC. The capture verifies separate approval/activation, unchanged native tasks before activation, the real created task and its reload readback, and no new AI request during native execution. These desktop images do not certify narrow layouts, physical devices or other browser engines; the application’s existing browser suite covers its tested narrow/short viewports.

| Image | Bytes | SHA-256 |
| --- | ---: | --- |
| [01-request.png](01-request.png) | 38,168 | `ffb3f41033a69f10f0491bdbc904bfd512fe41362ccf40f98229ebcc3027a748` |
| [02-summary.png](02-summary.png) | 57,680 | `3230c6f30780d0d248a9cd43ea8f2ed9b4e73a9193a79f9cfeb96ac2b82e3d02` |
| [03-simulation.png](03-simulation.png) | 86,391 | `2447d62b766504de1f4db5210ac61745af7b80ba0df1b06057e34e0d7b64fe92` |
| [04-approved.png](04-approved.png) | 82,456 | `e0f5303a58a6f6ec6e889d109e9074511e2f867990ba8a766543178213200a06` |
| [05-runtime.png](05-runtime.png) | 52,984 | `0f00447cf56ca61f5f6a12ac34ba12a8bbac54b58ed6ac6d05a646b1deddfcd0` |
| [06-saved-task.png](06-saved-task.png) | 51,806 | `e386574027c67ec0dea5ff7f754b4886b03f0966df40012c42a4b83303ed8e1b` |
