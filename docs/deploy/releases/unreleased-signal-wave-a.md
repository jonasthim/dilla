# dilla, Signal redesign wave A (unreleased)

These are the notes for the next release, which carries the Signal redesign of the web client (wave A) together with the
server, core and Bot changes it needs. They get the release's tag name when it is cut. The release includes `dillad` (with
the web client), `dillabot`, their matching core modules, installers and checksums.

## What's new

- The web client is redrawn on the Signal design: a dark, blue-accented default theme (`signal`; a stored `mesh` choice
  reads as `signal`; light and high contrast stay), a top bar with search, the reminders bell and settings, a 56 px rail,
  the channel list with voice channels and their people, Threads and Members in the channel header, one full-screen
  settings workspace, and phone tabs (Home, Activity, You) at the design's sizes. See the README's "What works today".
- Voice: a share picker (source, resolution, frame rate, system audio, an upload estimate), each person's ping on their
  tile, the now-playing bar on the stage, and a person menu (volume 0–200 %, mute for me, copy username).
- Glenn (the managed Bot) posts "X started music in {room}" with a live player card, reports its own ping, and can be
  restarted from Server settings → Bot; Polls and Reminders can be switched off per server.
- Server settings: roles get the **Control music** permission (it replaces the DJ roles list), invites can last forever or
  have no use limit (Manage server only), and Music has a default volume and an idle time.
- The instance signs each account's kind (person or bot); a browser checks it before it trusts a device's claim
  (protocol/03 § Account kind attestation, wire 4).

## Versions and compatibility

| Component | This release | bot1 |
|---|---:|---:|
| Server database schema | **51** | 47 |
| Browser client store schema | **13** | 12 |
| Negotiated wire version | **4** | 3 |

## Deploy order

1. Back up the server database and config (see bot1's notes for SQLite and PostgreSQL). Check that no call is live
   (`dillad media --rooms --config=/etc/dilla/dilla.toml`): the upgrade restarts media and ends calls.
2. **Upgrade `dillad` (which serves the web client) first**, with `install.sh --upgrade`. Confirm `dillad migrate status`
   shows 51, the service is healthy, and a browser signs in.
3. **Ask everyone to reload their open tabs.** The server still accepts wire 3 and 2 (the managed Bot speaks wire 3), so
   a tab from before the upgrade keeps connecting, but it runs the old client: without the new screens and without the
   account-kind check. Open tabs also find the new build by themselves and reload it.
4. **Then upgrade `dillabot`** with `install-bot.sh --upgrade`. The Bot and the server ship together: the new Bot needs the
   server's new routes (the music announcement, the restart request, its ping), and an old Bot on the new server fails the
   **Control music** check for every DJ. Do not leave either one on the previous release.

## No rollback below wire 4

- **Do not roll `dillad` back below this release.** A browser that has stored an account-kind attestation leaves every
  person without one pending: after a rollback to a wire-3 server it stops showing other people's messages and refuses
  calls with them.
- **The web app's store schema 13 is one-way.** An older bundle shows "This version of dilla is too old for the data
  saved in this browser" (data version 13 found, 12 supported). Redeploy this release, or clear the site's data and sign in
  again with the recovery key.
- The server's down migrations exist for an emergency with the new binary (`migrate down --to=47`), but
  `00048_control_music`'s down migration recreates the DJ roles table empty (the DJ list is lost; the permission bits stay
  on the roles). Prefer restoring the verified pre-upgrade backup, and expect the browser side above either way.

## Screen share cap

A share encodes at the bitrate its picker's choice asks for, never above `livekit.max_share_bitrate_kbps`, which is now
**8000** (8 Mb/s) by default. The cap is **advisory**: it is handed to clients with the call token and the server cannot
enforce a bitrate, so a modified client can send more. The SFU's own hard, node-wide limit is `livekit.limit_bytes_per_sec`
(bytes per second, not bits; unset by default). Lower the share cap on a host with little upload to spare: each sharer's
stream is forwarded to every viewer. See [LiveKit](../README.md#livekit).

## Known limits

- Avatars take their colour from the person's name (eight hues); the design's sample hues differ.
- Speaking rings in the channel list show only for the call you are in.
- The design's DM threads, member moves, server mute and disconnect are later waves.
