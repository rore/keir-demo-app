# Package provenance

Daymark's `vendor/` files and provenance JSON identify the exact Keir packages this checkout consumes. The current compiler and runtime match the bytes published in [Core 0.3.1](https://github.com/rore/keir-core/releases/tag/v0.3.1), built from Core source `5c772d02b4dc92bb28ea8aedabd34498ff6d9391`. They were adopted before publication. Active provenance deliberately preserves `verified-candidate` and `release: null` as the original adoption record; those immutable fields are not the current GitHub release status. [Core's release and preparation record](https://github.com/rore/keir-core/blob/main/docs/releases/core-0.3.1-candidate.md) contains package hashes, licenses, installed Java/Node smoke evidence and the later published-download comparison.

The Node archive is `keir-runtime-node-0.3.1.tgz`, SHA-256 `97b7afc93e260dab075e9576176ffb5f908a797f9fb5ea35d233240598486d86`. The compiler JAR is `keir-compiler-java-0.3.1-cli.jar`, SHA-256 `2abc650ac1c6b2a697cfee61aa71fe14d653f4cda1efa44f1cd2dd33292ad94b`. The lockfile, per-file inventory and compiler metadata pin those exact tested bytes.

The current authoring guide comes from licensed companion 7, input source `bdd273112c7a86d255082c1de545a943cc2d87e6`, with nonguide inputs pinned to the same Core source. The local archive `keir-authoring-v7-candidate.zip` has SHA-256 `8a4101a64fbbf4d09b59f936083a48df39256fcba8386cee66bd5f7bcad2c4a7`. It includes the full Apache 2.0 license and verifies offline using Core's existing companion verifier. The unchanged archive and `keir-authoring-v7-candidate.SHA256SUMS` are available on the Core 0.3.1 release. Its embedded guide and Core compatibility record retain their original candidate wording, `candidate` status and empty package map. Publishing that archive does not convert its metadata into released-package qualification.

Original 0.3.0 and 0.2.0 binaries and metadata remain unchanged under versioned provenance files. The old compiler notice tree remains available; candidate notices have their own `compiler-0.3.1-notices/` directory. Guides 3–5 retain their original bytes and provenance. Saved supported artifacts, approvals and active selections keep their exact original producer/package identities while the new runtime executes them through its explicit compatibility rules.

## Historical source lookup

Core's history cleanup changed commit IDs without changing the source trees used for these releases. For Core 0.3.0, original build revision `b2329440dd2a25acc547f3ebfea214748d912022` has equivalent reachable source `ec994bfa6df98714f334e95d8739cc412b1da503`. For Core 0.2.0, original revision `43f28600d8db460db6f22b48c2d4c2c0de9c52b7` maps to `8b4a72d8a8f1cf690993ad99da6a6a315a79f68e`. These are source lookup mappings, not new origins for the existing binaries.

Core's [source revision receipt](https://github.com/rore/keir-core/blob/main/scripts/release-source-revisions.json) includes the shared tree pins. Its [provenance note](https://github.com/rore/keir-core/blob/main/docs/releases/source-provenance.md) explains historical companion rebuilds and new release qualification. A fresh build must record its actual source and receive its own package checks; do not overwrite a published release or relabel an existing vendor package.

Legacy companion ZIPs omit the root project license; retain the [Apache 2.0 license](../LICENSE) when redistributing an old guide or archive. Original source IDs, archive hashes, JAR hashes and per-file digests identify those historical bytes and must not be relabeled.

A binary privacy scan or dependency-resolution check is bounded evidence. It does not clear remote release ZIPs, retained Actions artifacts, old pull-request history or external copies. Verify actual package downloads and the released Java consumer path before claiming those checks passed.

## Distribution and rollout boundary

Core's candidate assets were constructed twice identically and passed the actual installed-package smoke before vendoring here. GitHub release API access was blocked during that initial preparation. The later distribution check reproduced the exact recorded bytes, verified all seven draft uploads by downloading them, and published Core 0.3.1 as a normal release on 2026-11-11. All seven published downloads again matched their expected bytes and SHA-256 hashes; tag `v0.3.1` resolves to the Core source above. The repository remains private. This publication and the earlier source adoption did not deploy or restart Daymark; a live rollout remains separate.
