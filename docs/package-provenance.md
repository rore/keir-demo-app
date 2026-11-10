# Package provenance

Daymark's `vendor/` files and provenance JSON describe the original Keir packages it consumes. Keep their recorded source IDs, archive hashes, JAR hashes and per-file digests unchanged when inspecting or redistributing those packages.

Core's history cleanup changed commit IDs without changing the source trees used for these releases. For Core 0.3.0, original build revision `b2329440dd2a25acc547f3ebfea214748d912022` has equivalent reachable source `ec994bfa6df98714f334e95d8739cc412b1da503`. For Core 0.2.0, original revision `43f28600d8db460db6f22b48c2d4c2c0de9c52b7` maps to `8b4a72d8a8f1cf690993ad99da6a6a315a79f68e`. These are source lookup mappings, not new origins for the existing binaries.

Core's [source revision receipt](https://github.com/rore/keir-core/blob/main/scripts/release-source-revisions.json) includes the shared tree pins. Its [provenance note](https://github.com/rore/keir-core/blob/main/docs/releases/source-provenance.md) explains historical companion rebuilds and new release qualification. A fresh build must record its actual source and receive its own package checks; do not overwrite a published release or relabel an existing vendor package.

The vendored companion guide remains edition 5 with its original provenance. Legacy companion ZIPs omit the root project license; retain the [Apache 2.0 license](../LICENSE) when redistributing the guide or archive. Core's licensed edition 6 is a separate unpublished candidate. Adopting it requires its own deliberate pin and compatibility review; this note does not update Daymark's dependencies.

A binary privacy scan or dependency-resolution check is bounded evidence. It does not clear remote release ZIPs, retained Actions artifacts, old pull-request history or external copies. Verify actual package downloads and the released Java consumer path before claiming those checks passed.
