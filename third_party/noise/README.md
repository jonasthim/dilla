# Pinned beta microphone runtime

`deepfilter/` contains the exact DeepFilterNet3 model, patched WASM and JavaScript bindings used in the recorded evaluation. SHA-256 hashes are checked against `experiments/noise/asset-lock.json` by every beta or qualified build. RNNoise is extracted from the pinned npm dependency and checked against the same lock. Ordinary builds include none of these enhancement files.

Source: DeepFilterNet revision `d375b2d8309e0935d165700c91da9de862a99c31`, built with `experiments/noise/prepare.mjs`, its committed Cargo lock and `deepfilter-free.patch`. Rebuilding can change WASM bytes, including compiler paths; never replace the pinned binaries without updating their provenance and validation. The exact upstream model archive is stored as `deepfilter-model.bin` without changing its bytes. Hush and GTCRN are evaluation dependencies and are not vendored here.

DeepFilterNet's MIT and Apache-2.0 notices are retained under `experiments/noise/licenses/` and emitted with beta distributions. The exact weights grant remains ambiguous as documented in that directory's audit. On 2026-10-17 the owner explicitly requested release after this uncertainty and the runtime failures were disclosed. That authorizes this beta publication; it does not assert a new upstream license grant, successful qualification, or Krisp parity.
