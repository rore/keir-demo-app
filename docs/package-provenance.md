# Package provenance

This integration checkout stages the independently qualified **unpublished Core 0.5 candidate**, not a public release or deployment. The exact downloaded package input is Core `b9782d1cb7dd7106d44878f7199cbd4774e91510`, [Actions run 43431976777](https://github.com/rore/keir-core/actions/runs/43431976777), artifact `14039569337`. Active metadata uses `verified-candidate` and `release: null`. Focused source reviews passed. [Hosted run 43474838743](https://github.com/rore/keir-demo-app/actions/runs/43474838743) at Daymark `331f2d910bc8c7117415f978035a017dfaec794f` passed build, 606 Node tests (12 existing opt-in process/crash skips) and all 261 browser tests. These are scripted-provider host integration results, not live-model qualification, publication or deployment.

| Candidate asset | SHA-256 |
| --- | --- |
| `keir-runtime-node-0.5.0.tgz` | `9c59e4722f4d85bcd0e57580a1cef9526f7ceb52670e345576e39ca29d489736` |
| `keir-compiler-cli-0.5.0.zip` | `ec36271caaa55714257601c2f8bc7aa19f2ced76858f02b15021dacd3a138e76` |
| Extracted `keir-compiler-java-0.5.0-cli.jar` | `1561dd1cce36c2eb3521442dcedbfd3a0ba4f1781b1e052a079ecdab32366c36` |

Normal builds use the independently packaged vendored archive, not a sibling Core source checkout. All five package assets match [package-only run 43438170269](https://github.com/rore/keir-core/actions/runs/43438170269) at actual Core package source `3a383c2d0c6227eedc9c03927c2dd1910360d5b9`. Existing installed-consumer evidence is reused; new host integration checks must establish Daymark behavior separately.

## Replacement companion 9

The working tree pins the corrected archive from [companion-only run 43451868303](https://github.com/rore/keir-core/actions/runs/43451868303), source `9435dfef2ade61af2d7617754c761775502d68b5`. It replaces the earlier candidate that omitted a guide-linked offline index. This packet passed its 23 recipe checks, archive build, offline verification and exact-package checks upstream. Local adoption checks verify bytes and relative guide links; they do not establish Daymark execution.

| Exact candidate input | Bytes | SHA-256 |
| --- | ---: | --- |
| `keir-authoring-companion-v9.zip` | 246443 | `c1ca8b6f2f3c5089afca5e134d0b21ed2477a570141c36fcc1ea55a2f6c41867` |
| Raw `manifest.json`, retained as `keir-authoring-companion-v9-manifest.json` | 7159 | `a98c013fe2221073f93b280f8bc0223b49bd298ff7bc910e69a2dec97387a74b` |
| Unchanged `customer-authoring-guide-v9.md` | 11801 | `21615e93fc426f11eb756e850a4e0660d3a5cab55f69f47f5b3e818fc3fb1257` |
| Included `docs/specs/README.md` | 12036 | `4bce42b59c998b3f8cde706ccba0628fa4e439d923524d3b838a98b8c1b06250` |

All 35 payloads match the exact manifest and Git blobs. All 10 direct relative guide document links resolve inside the archive. The archive retains its full license and all eight versioned schemas under their original `schemas/` paths. The manifest maps the unchanged Core packages to numeric source/model/recipe `3/4/3` and retained `2/3/2`; both use producer 0.5.0 and artifact/scenario `/4`. Its `release` compatibility status does not mean public publication. Earlier guide editions and their original metadata remain unchanged.

## Retained Core 0.4 release

The previous integration consumed the exact compiler and Node runtime published in [Core 0.4.0](https://github.com/rore/keir-core/releases/tag/v0.4.0), built from Core source `fc0601ae410e06c0be76d6f3b769abbd049b5999`. Original `verified-release` metadata is retained under versioned provenance files, alongside unchanged binaries and approved definitions.

| Asset | SHA-256 |
| --- | --- |
| `keir-runtime-node-0.4.0.tgz` | `b3e9b7fe31437d2fa2795cccc4758ebf1184d0eca6d15cfa93898d2591a67962` |
| `keir-compiler-cli-0.4.0.zip` | `9960bb1f160e72a54c7d203b402f6056e4c430bdacc8094c73c4deb81a313e06` |
| Extracted `keir-compiler-java-0.4.0-cli.jar` | `d008f1ac152888e504f2753359caa98ba20af55d44d765edba60157858c9b413` |
| `keir-authoring-v8-candidate.zip` | `4433908295095612c495b11447170fe542758db06acc4b1ce253359a10ac2676` |

The retained edition 8 guide is unchanged from its published companion archive, input source `dca92178dad7a9a4f65312128afec15abf88ce67`, with the original 0.4 Core input above. Its preparation-time wording and manifest's `candidate` status and empty package map remain unchanged. Archive publication and checksum verification do not turn that metadata into live-provider qualification. The companion includes its full Apache 2.0 license; compiler licenses and notices are retained under `vendor/compiler-0.4.0-notices/`.

Runtime 0.4.0 supports the retained producer 0.2.0 `/2` tuple and producers 0.3.0, 0.3.1 and 0.4.0 `/3` tuples with matching environment pins. Only 0.4.0 authors the guarded-result example. Original binaries, guides, provenance and notices remain available. The 0.3.1 adoption's `verified-candidate` and `release: null` metadata is preserved under versioned provenance filenames; those fields record its original adoption, not the later GitHub publication status. Existing saved artifacts, approvals and selections keep their exact original producer/package identities. They are never silently recompiled or approved by the upgrade.

## Historical source lookup

Core's history cleanup changed commit IDs without changing the source trees used for these releases. For Core 0.3.0, original build revision `b2329440dd2a25acc547f3ebfea214748d912022` has equivalent reachable source `ec994bfa6df98714f334e95d8739cc412b1da503`. For Core 0.2.0, original revision `43f28600d8db460db6f22b48c2d4c2c0de9c52b7` maps to `8b4a72d8a8f1cf690993ad99da6a6a315a79f68e`. These are source lookup mappings, not new origins for the existing binaries.

Core's [source revision receipt](https://github.com/rore/keir-core/blob/main/scripts/release-source-revisions.json) includes the shared tree pins. Its [provenance note](https://github.com/rore/keir-core/blob/main/docs/releases/source-provenance.md) explains historical companion rebuilds and new release qualification. A fresh build must record its actual source and receive its own package checks; do not overwrite a published release or relabel an existing vendor package.

For an early companion archive that omits the root project license, retain the [Apache 2.0 license](../LICENSE) when redistributing it. Original source IDs, archive hashes, JAR hashes and per-file digests identify those historical bytes and must not be relabeled.

A binary privacy scan or dependency-resolution check is bounded evidence. It does not clear remote release ZIPs, retained Actions artifacts, old pull-request history or external copies. Verify actual package downloads and the released Java consumer path before claiming those checks passed.

## Verification and rollout boundary

[Application verification](../tests/README.md) covers the installed package hashes, real compiler/simulation/runtime paths, immutable retained approvals and native task effects. The scripted authoring journey is separate from live-provider qualification. This adoption changes the repository's packages; it does not deploy, restart an operator's instance or change repository visibility.
