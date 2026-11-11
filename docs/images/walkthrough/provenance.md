# Walkthrough screenshot provenance

These are unedited screenshots of Daymark at source revision [`2e8516927276d8313793b15e9717e88cde46988f`](https://github.com/rore/keir-demo-app/commit/2e8516927276d8313793b15e9717e88cde46988f). They replace the earlier walkthrough captures; Git history retains those originals. The screenshots are covered by the repository’s [Apache License 2.0](../../../LICENSE).

The flow uses fictional, disposable data and the [offline authoring fixture](../../../tests/fixtures/authoring-server.mjs). Assistant responses are scripted; the installed compiler, simulation, saved evidence, explicit human approval, separate activation and native task writes are real. No paid model requests were made. The user explicitly chooses the suggested name and saves it; the assistant does not rename the customization.

The capture follows the [walkthrough](../../customization-walkthrough.md): request and clarification, proposed behavior, recorded simulation values, approved but not active, completion of a newly added task, and the actual saved follow-up task. The app uses its pinned Core 0.3.1 candidate packages; this capture does not publish those packages or certify a deployment. The images contain no real customer data or provider settings.

Captured with Playwright 1.64.1 and Chromium 156.0.8078.79 at a 1,440 × 1,000 CSS-pixel viewport. The checks also exercise narrow and short viewports; these desktop images do not certify physical devices or other browser engines.

| Image | Bytes | SHA-256 |
| --- | ---: | --- |
| [01-request.png](01-request.png) | 69,763 | `6a0e383b7bf2cc5bce933755b1c3e27a167f0ba475104d604c9a3a060dfdafcb` |
| [02-summary.png](02-summary.png) | 127,126 | `062088cb0e919598d7a9a7177a0141cda46bd5d0c6437479986f635366d9a42a` |
| [03-simulation.png](03-simulation.png) | 121,746 | `1167e2fc52d935215c2a109e94d8e27d1d240ca2c3f3ba34ff85395946e93968` |
| [04-approved.png](04-approved.png) | 105,991 | `746f99fc3081d337a3730daa25e80d25217f39001588233014143993378fb7ce` |
| [05-runtime.png](05-runtime.png) | 71,804 | `1c88cd72ead9584b29db05a237ff9975eed613a00d7af37b2e7142f016580ad4` |
| [06-saved-task.png](06-saved-task.png) | 93,837 | `20f39017a4fb6d95b0dcc4bdd34779012a16ad23f2b36071d9588ec2200e8380` |
