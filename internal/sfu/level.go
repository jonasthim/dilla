package sfu

// MediaLevel is the API<->SFU contract's level. It is bumped whenever that contract changes: the
// livekit-server version, ClientProtocol, the rendered sfu config, the RoomService calls or the
// webhook events dillad uses. TestMediaLevelGuard pins those inputs, so a change to one of them
// without a bump here fails.
//
// Level 1 is v0.1.0-web3.11, the baseline CI proves. Level 2 (web3.12) is an SFU that also serves
// TURN (docs/superpowers/plans/2026-10-21-calls-survive-upgrade.md, R-UP1 and R-UP11).
const MediaLevel = 2

// MinSFUMediaLevel is the oldest running SFU level this API works with. A running SFU at level L
// can stay across an upgrade if and only if L >= the new release's MinSFUMediaLevel (R-UP1).
const MinSFUMediaLevel = 1

// Capabilities is what this build's SFU can do beyond the baseline contract. `dillad version
// --json` lists all of them; media.json lists "turn" only once a TURN listener is actually bound
// (UP8), so a running SFU's file may list fewer than its build supports.
var Capabilities = []string{"turn"}
