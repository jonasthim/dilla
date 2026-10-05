@dilla/core-wasm packages the wasm-pack output of `core/dilla-core-wasm`.
`pkg/` is generated and ignored.
Build: `wasm-pack build core/dilla-core-wasm --target web --profile wasm-release --mode no-install --out-dir ../../packages/core-wasm/pkg`.
Size gate: `scripts/check-wasm-size.mjs`.
