# UX audit scripts

The world and the screen shooters behind the alignment audit (web3.8's `ux-audit.md`, web3.9's AUDIT-2) and the design
parity tool (`docs/design/signal/parity`, `--app`). Everything is written to `target/ui-screens/signal-b/` unless `--out` says
otherwise; the repo root comes from the script's own location.

Build first: `npm run build -w @dilla/web`, `go build -o target/dilla-testhost ./cmd/dilla-testhost`,
`go build -o target/dillabot ./cmd/dillabot`, and the core wasm (`internal/mlswasi/testdata/dilla_core_wasi.wasm`,
`packages/core-wasm/pkg`). The world never builds the web client or the wasm core (it starts the host with `prebuilt: true`, so
two worlds in one tree cannot race on `packages/web/dist`); it checks the four artifacts first and exits 2 naming the build
command of each one that is missing. The Bot's own helper binary is still built incrementally by `startTestHost`.

**Never point `--out` into a tracked path.** `state.json` (passwords, recovery keys, TOTP secrets) and some shots (recovery-key
screens) hold throwaway secrets; the default `target/ui-screens/signal-b` is git-ignored.

1. `npm run ux:world -w @dilla/e2e -- [--base <n>] [--out <dir>]` starts an empty test host with the Bot runtime
   (`startTestHost` from `e2e/web/support/host.ts`, bundled with esbuild so plain node can load it) and builds the server through
   the client: Ada, Björn, Mira and Liv (offline), text, announcement and voice channels (the AFK channel is the built-in
   one), the Bot installed through Server settings -> Bot with Polls, Reminders and Music on, a conversation, unread counts, a DM
   from Mira, Björn and Mira in `harbour`, and Ada's phone as a second device. Ports from `--base n` (default 8611): host
   `n`/`n+1`, SFU `n+2`/`n+4`, browsers' CDP from `n+10`, Ada's phone `n+19`. `state.json` (in `--out`) is written when it
   prints `READY`; it holds the people with their TOTP secrets, recovery keys and passwords, `invitePath`, `serverPath`,
   `voicePath`, `afkPath`, `botName` and the CDP ports. It holds until Ctrl+C. Two worlds can run side by side with different
   `--base` and `--out`. Mira shares a screen in `harbour` (a fake display track), so the stage opens in the share focus layout
   (`state.miraShares`). Ada's server gets a dummy Giphy key (`abcdEFGH12345678`, set by the world itself through Server settings
   -> GIFs) so the composer's GIF button shows; Giphy is unreachable, so the pickers stay on "searching". A failed phone sign-in
   fails the world (`state.ready=false`, `state.notReady`, exit 1) instead of printing READY. A shoot of mutating pairs (see
   `docs/design/signal/parity/README.md`) changes the world: restart it before shooting again.
2. `npm run ux:shots -w @dilla/e2e` shoots every step; `node e2e/ux/shots.mjs --list` names them, and
   `node e2e/ux/shots.mjs shell dm --size 1440 --theme signal` runs some. Files are `<d|p><width>-<theme>-<step>.png`.
3. `npm run ux:sheets -w @dilla/e2e` composes one contact sheet per width and theme into `sheets/`.

`run.mjs` is the runner a one-off step file uses: `node e2e/ux/run.mjs <ada|bjorn|mira|phone> <step.mjs> [args] [--out <dir>]`.
The audit's CSS-variable check (`vars.mjs`) is replaced by `npm run check:css`.
