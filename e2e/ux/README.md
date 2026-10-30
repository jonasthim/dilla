# UX audit scripts

The world and the screen shooters behind the alignment audit (web3.8's `ux-audit.md`, web3.9's AUDIT-2) and the design
parity tool (`docs/design/signal/parity`, `--app`). Everything is written to `target/ui-screens/signal-b/` unless `--out` says
otherwise; the repo root comes from the script's own location.

Build first: `npm run build -w @dilla/web`, `go build -o target/dilla-testhost ./cmd/dilla-testhost`,
`go build -o target/dillabot ./cmd/dillabot`, and the core wasm (`internal/mlswasi/testdata/dilla_core_wasi.wasm`,
`packages/core-wasm/pkg`). With `CI=true` the world does not rebuild the web client and the wasm core itself.

1. `npm run ux:world -w @dilla/e2e -- [--base <n>] [--out <dir>]` starts an empty test host with the Bot runtime
   (`startTestHost` from `e2e/web/support/host.ts`, bundled with esbuild so plain node can load it) and builds the server through
   the client: Ada, Björn, Mira and Liv (offline), text, announcement and voice channels (the AFK channel is the built-in
   one), the Bot installed through Server settings -> Bot with Polls and Reminders on, a conversation, unread counts, a DM
   from Mira, Björn and Mira in `harbour`, and Ada's phone as a second device. Ports from `--base n` (default 8611): host
   `n`/`n+1`, SFU `n+2`/`n+4`, browsers' CDP from `n+10`, Ada's phone `n+19`. `state.json` (in `--out`) is written when it
   prints `READY`; it holds the people with their TOTP secrets, recovery keys and passwords, `invitePath`, `serverPath`,
   `voicePath`, `afkPath`, `botName` and the CDP ports. It holds until Ctrl+C. Two worlds can run side by side with different
   `--base` and `--out`.
2. `npm run ux:shots -w @dilla/e2e` shoots every step; `node e2e/ux/shots.mjs --list` names them, and
   `node e2e/ux/shots.mjs shell dm --size 1440 --theme signal` runs some. Files are `<d|p><width>-<theme>-<step>.png`.
3. `npm run ux:sheets -w @dilla/e2e` composes one contact sheet per width and theme into `sheets/`.

`run.mjs` is the runner a one-off step file uses: `node e2e/ux/run.mjs <ada|bjorn|mira|phone> <step.mjs> [args] [--out <dir>]`.
The audit's CSS-variable check (`vars.mjs`) is replaced by `npm run check:css`.
