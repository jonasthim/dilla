# dilla-librespot-helper

Pinned Spotify playback helper used by Dilla's Go Spotify adapter. Build the
standalone Linux executable from the repository root with:

```sh
cargo build --release --locked --manifest-path crates/dilla-librespot-helper/Cargo.toml
```

The executable is `target/release/dilla-librespot-helper` relative to the
crate directory. Package or install that file at the absolute path configured
as the adapter's `HelperPath`.

The process accepts one `spotify:track:<22-character-id>` argument, reads its
credential JSON from file descriptor 3, reads four-byte big-endian length
prefixed JSON controls from stdin, writes four-byte big-endian length
prefixed status JSON to stderr, and writes `DPCM` version 1 frames to stdout.
Each PCM payload is 3,528 bytes of 44.1 kHz stereo signed 16-bit little-endian
audio. Diagnostics never include credential or provider response contents.
