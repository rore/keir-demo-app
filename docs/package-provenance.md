# Package provenance

Daymark consumes the exact compiler and Node runtime published in [Core 0.4.0](https://github.com/rore/keir-core/releases/tag/v0.4.0), built from Core source `fc0601ae410e06c0be76d6f3b769abbd049b5999`. Their downloaded archives were checked against the release's `SHA256SUMS` and asset digests before adoption. The current provenance records use `verified-release` and `release: v0.4.0`; the lockfile and per-file inventory pin the installed runtime bytes.

| Asset | SHA-256 |
| --- | --- |
| `keir-runtime-node-0.4.0.tgz` | `b3e9b7fe31437d2fa2795cccc4758ebf1184d0eca6d15cfa93898d2591a67962` |
| `keir-compiler-cli-0.4.0.zip` | `9960bb1f160e72a54c7d203b402f6056e4c430bdacc8094c73c4deb81a313e06` |
| Extracted `keir-compiler-java-0.4.0-cli.jar` | `d008f1ac152888e504f2753359caa98ba20af55d44d765edba60157858c9b413` |
| `keir-authoring-v8-candidate.zip` | `4433908295095612c495b11447170fe542758db06acc4b1ce253359a10ac2676` |

The authoring guide is the unchanged edition 8 file from the published companion archive, input source `dca92178dad7a9a4f65312128afec15abf88ce67`, with Core input pinned above. Its original preparation-time wording and manifest's `candidate` status and empty package map remain unchanged. Archive publication and checksum verification do not turn that metadata into live-provider qualification. The companion includes its full Apache 2.0 license; compiler licenses and notices are retained under `vendor/compiler-0.4.0-notices/`.

Runtime 0.4.0 supports the retained producer 0.2.0 `/2` tuple and producers 0.3.0, 0.3.1 and 0.4.0 `/3` tuples with matching environment pins. Only 0.4.0 authors the guarded-result example. Original binaries, guides, provenance and notices remain available. The 0.3.1 adoption's `verified-candidate` and `release: null` metadata is preserved under versioned provenance filenames; those fields record its original adoption, not the later GitHub publication status. Existing saved artifacts, approvals and selections keep their exact original producer/package identities. They are never silently recompiled or approved by the upgrade.

## Historical source lookup

Core's history cleanup changed commit IDs without changing the source trees used for these releases. For Core 0.3.0, original build revision `b2329440dd2a25acc547f3ebfea214748d912022` has equivalent reachable source `ec994bfa6df98714f334e95d8739cc412b1da503`. For Core 0.2.0, original revision `43f28600d8db460db6f22b48c2d4c2c0de9c52b7` maps to `8b4a72d8a8f1cf690993ad99da6a6a315a79f68e`. These are source lookup mappings, not new origins for the existing binaries.

Core's [source revision receipt](https://github.com/rore/keir-core/blob/main/scripts/release-source-revisions.json) includes the shared tree pins. Its [provenance note](https://github.com/rore/keir-core/blob/main/docs/releases/source-provenance.md) explains historical companion rebuilds and new release qualification. A fresh build must record its actual source and receive its own package checks; do not overwrite a published release or relabel an existing vendor package.

Legacy companion ZIPs omit the root project license; retain the [Apache 2.0 license](../LICENSE) when redistributing an old guide or archive. Original source IDs, archive hashes, JAR hashes and per-file digests identify those historical bytes and must not be relabeled.

A binary privacy scan or dependency-resolution check is bounded evidence. It does not clear remote release ZIPs, retained Actions artifacts, old pull-request history or external copies. Verify actual package downloads and the released Java consumer path before claiming those checks passed.

## Verification and rollout boundary

[Application verification](../tests/README.md) covers the installed release hashes, real compiler/simulation/runtime paths, immutable retained approvals and native task effects. The scripted authoring journey is separate from live-provider qualification. This adoption changes the repository's packages; it does not deploy, restart an operator's instance or change repository visibility.
