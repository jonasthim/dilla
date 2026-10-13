# L-PROBE-1 — voice past Pangolin on the founder's homelab

Date: @@FILL@@ · Instance build: @@FILL@@ (`dillad --version`) · Probe code: `feat(testkit,media): a network voice probe for a real instance` (web-3 task 2) · Session: the supervisor with Jonas, about 45 minutes, dev box on the LAN and Jonas's laptop on a phone hotspot (founder decision 11, R10–R12, RV-6).

**Status: the checklist below is ready; the session has not run.** Every `@@FILL@@` cell is filled from the session's reports, and task 2 step 9 checks that none is left.

## Question

Does LiveKit's UDP media need its own port past Pangolin? UDP arrives at the Pangolin VPS's public IP (R10), so it must be forwarded from the VPS to the homelab, either through the WireGuard tunnel (gerbil and Traefik) or by a plain port forward. TURN over TCP is tried only if UDP fails (R11). The same session measures the deploy guide's unmeasured 30 s Traefik `udp.timeout` (follow-up card 6) and the tunnel MTU of 1280.

**Decision rules.**
- "Does LiveKit UDP need its own port past Pangolin?" is **yes** if leg 1 fails and leg 2 works.
- The deploy guide's `udp.timeout` stays at 30 s if leg 3 resumes, or is raised to the value that resumed.
- The TURN fallback is recommended or not according to leg 4.

## The probe

- **`dilla-testkit netprobe prepare --instance <url> --invite <code> --out <dir>`** signs up two throwaway accounts through the invite (`netprobe-a-<6 hex>` and `netprobe-b-<6 hex>`, one random suffix per run, because a deleted handle stays reserved), opens their 1:1 DM, registers its call group as A and joins it by external commit as B, and writes `<dir>/side-a/` and `<dir>/side-b/` (each side's identity seed, ids and MLS store, owner-only files). It starts no call. It prints both account names and the cleanup commands.
- **`dilla-testkit netprobe start --instance <url> --state <dir>/side-<x> --out <file>`** signs in as that side, syncs the call group, starts or joins the DM call and writes the start JSON. **The probe page must press Start within 30 s of it**: a leaf that stays out of a live call's room longer than 30 s is removed by the room sweep. A call group whose call has ended is closed, so `start` then refuses with "run prepare again": **every run needs its own `prepare`**, which is why the session prepares four runs up front.
- **The probe page** (`npm run probe -w @dilla/media`, `http://localhost:5191`) loads one start JSON, joins with `@dilla/media`'s `joinCall` on the Start press, publishes a synthetic 440 Hz tone (no microphone), samples `getStats()` and the media worker's counters every second for 60 s, and offers the report as a JSON download (`ProbeReport`, L-PROBE-1, plus an `events` list: ICE and room state changes and the silence window). Its "silence 45 s" button stops all RTP from that side for 45 s (`pauseUpstream`; DTX alone still sends comfort noise every 400 ms) and extends the run to 15 s past the resume.
- **Public routes only.** Neither verb calls `/debug/*` or a test host's control listener.
- **TLS.** The testkit speaks plain `http://` only (no TLS stack, by its dependency rules). With `DILLA_PROBE_INSTANCE=https://<instance host>` the probe page's server also proxies the instance's `/v1`, `/gateway` and `/rtc`, so on both machines the testkit takes `--instance http://localhost:5191`, and the page's LiveKit signalling goes to `ws://localhost:5191/rtc` and on to the instance. Only signalling takes this path: media is ICE between the browser and the SFU's `node_ip`, which is what the session measures.
- **Which page path worked (task 2 step 3).** `/rtc` admits the page's own `localhost` dev-server origin: the automated check (PROBE-E2E, Chromium 153 and Firefox 155, test host on loopback) passes with the page served by the dev server, and again with the static build (`npm run probe -w @dilla/media -- build`, served by `npm run probe -w @dilla/media -- preview`). The `ssh -L` fallback is not needed.
- **Reading a report.** `pair` is the selected candidate pair (local and remote candidate type, protocol, relay protocol, remote address and port). `candidates` lists the gathered local candidates without addresses. `summary.lossPct` is lost / (lost + received) × 100 from the last sample's cumulative counters, so loss before the first sample counts. `relayUnavailable` is "ICE failed and no relay candidate was gathered"; a join that never connected counts as failed ICE. `verifiedRemote` counts frames the media worker authenticated and bound to a roster device; `decryptDrops` counts every frame it refused (the `events` list names the reasons at the end; `sif` drops are LiveKit's own server-injected frames and expected).
- **Redaction.** A downloaded report keeps the remote address; reports live only in the dev box's git-ignored `target/netprobe/reports/`. This document records `remoteIsVps: yes|no` and the port, never an address, a hostname or a port other than 7882 of the homelab, the VPS or the laptop.

## Before the session

**Dev box (supervisor), on the LAN, in the repository root of this branch:**

1. `npm ci`, `npm run build:wasm -w @dilla/media`, `cargo build -p dilla-testkit --release --locked`.
2. Terminal 1, kept running for the whole session: `env DILLA_PROBE_INSTANCE=https://<instance host> npm run probe -w @dilla/media`.

**Laptop (Jonas), still on the LAN, in its checkout of this branch (RV-6):**

1. `git pull`, `npm ci`, `npm run build:wasm -w @dilla/media`, `cargo build -p dilla-testkit --release --locked`.
   - If the media wasm build fails there (it needs wasm-pack, wasm-bindgen-cli 0.2.128 and clang 23), the dev box runs `npm run probe -w @dilla/media -- build` and copies `target/netprobe/page/` to the same path on the laptop, which then serves it with `preview` in place of the dev server below.
2. Terminal 1, kept running: `env DILLA_PROBE_INSTANCE=https://<instance host> npm run probe -w @dilla/media` (or `... npm run probe -w @dilla/media -- preview`).
3. Open `http://localhost:5191` in Chromium. (Firefox works too; the browser is recorded per report.)

## Checklist

### 1. Deploy (Jonas)

Put a dillad from `BASE` (main after web-2c) on the LXC behind Pangolin, with:

- `livekit.enabled = true`;
- `livekit.udp_port = 7882`;
- `livekit.node_ip` = **the Pangolin VPS's public IP** (the key is `[livekit] node_ip`; there is no `rtc` table): UDP arrives there, not at the LXC's LAN address. *Revert:* restore the previous `node_ip` (or remove the key) unless the decision keeps it;
- `livekit.advertise_internal_ip` left at its default (`true` in `internal/config/defaults.go`); record the value `dillad doctor` or the rendered config shows. With it on, the LAN side may pair on a host candidate and pass leg 1 trivially, so leg 1's verdict rests on the **outside** side;
- TURN as `behind_proxy` leaves it: off (D23).

Report: the `dillad --version` line; `advertise_internal_ip` as read.

| item | value |
|---|---|
| `dillad --version` | @@FILL@@ |
| `advertise_internal_ip` as read | @@FILL@@ |

### 2. Invite and prepare (Jonas, then the supervisor; the laptop still on the LAN)

1. Jonas runs `dillad admin invite create --max-uses=8 --ttl=24h` and sends the supervisor the invite code and the invite id it logs. (Eight uses: four runs of two accounts each, because every run needs its own call group; see "The probe".)
2. The supervisor prepares the four runs on the dev box (terminal 2), each printing its two account names and cleanup lines:
   - `target/release/dilla-testkit netprobe prepare --instance http://localhost:5191 --invite <code> --invite-id <invite id> --out target/netprobe/run1` (leg 1);
   - the same with `--out target/netprobe/run2` (leg 2, LAN and outside, with leg 3's silence);
   - `--out target/netprobe/run3` (leg 2, outside and outside);
   - `--out target/netprobe/run4` (leg 4, only used if legs 2 and 3 show that UDP fails).
   A prepare that fails half-way may have spent invite uses: delete what it printed or created, and ask Jonas for a second invite.
3. The supervisor copies to the laptop over the LAN, before it moves to the hotspot: `run1/side-b/`, `run2/side-b/`, `run3/side-a/`, `run3/side-b/` and `run4/side-b/`, each to the same path under the laptop's checkout (`scp -r target/netprobe/run1/side-b <laptop>:<checkout>/target/netprobe/run1/`, and so on). These are throwaway devices' secrets; step 8 deletes them.
4. The laptop moves to the phone hotspot and keeps its probe server running.

**Every run, every side:** run `netprobe start` on that side's own machine, load the JSON it wrote into the page, set the label, and press **Start within 30 s**. Start both sides of a run within the same minute (the supervisor calls "go"). When the status line says `done`, press **Download**.

- Dev box, side a: `target/release/dilla-testkit netprobe start --instance http://localhost:5191 --state target/netprobe/runN/side-a --out target/netprobe/runN/a.json`
- Laptop, side b: `target/release/dilla-testkit netprobe start --instance http://localhost:5191 --state target/netprobe/runN/side-b --out target/netprobe/runN/b.json`

### 3. Leg 1, HTTP only (run1)

Only the existing Pangolin HTTP resource for 443; no UDP forward. A on the dev box (label `leg1-lan`), B on the laptop on the hotspot (label `leg1-outside`).

**Expectation:** the outside side's ICE fails or no media flows: its report shows `relayUnavailable: true` or `verifiedRemote` stays 0.

### 4. Leg 2, the UDP forward from the VPS to the homelab (run2, then run3)

UDP arrives at the VPS public IP, so it has to travel from the VPS to the LXC's port 7882. Jonas picks one path; the supervisor records which.

- **(a) Through the WireGuard tunnel** (the deploy guide's Traefik/gerbil UDP router): gerbil publishes `7882:7882/udp` on the VPS, and Traefik's `udp-7882` entryPoint routes it over the Pangolin tunnel to the newt site and on to the LXC's 7882. Configuration:
  - the Traefik entryPoint `udp-7882` (`address: ":7882/udp"`) with `udp.timeout: 30s`, in gerbil's network namespace. *Revert:* remove the entryPoint;
  - `7882:7882/udp` published on the `gerbil` service. *Revert:* remove the port and recreate gerbil;
  - a Pangolin raw UDP resource from 7882 to the LXC's 7882. *Revert:* delete the resource.
- **(b) A plain port forward:** a `DNAT` rule on the VPS from `7882/udp` to the homelab's WireGuard address or its public endpoint. *Revert:* delete the rule (and any `FORWARD` accept it needed).

Then:

1. **run2, LAN and outside:** A on the dev box (`leg2-lan`), B on the laptop (`leg2-outside`). While it runs, Jonas captures on **both** the VPS and the LXC: `tcpdump -ni any udp port 7882 -c 300` (terminal output only, never `-w`). The largest datagram is the largest `length` value printed; `tcpdump -ni any udp port 7882 -c 300 | awk '{print $NF}' | sort -n | tail -1` prints just that. Jonas reports the count seen and the largest length on each host.
2. **Leg 3 in the same run** (step 5 below): about 10 s after the outside side's first verified frame, press **silence 45 s** on the laptop's page.
3. **run3, outside and outside:** both sides on the laptop, in two browser windows (labels `leg2-outside-a`, `leg2-outside-b`), both starting through the laptop's probe server. Both sit behind the same hotspot NAT; each still reaches the SFU through the VPS forward on its own.

Record for each report: the pair's remote candidate is the VPS's public IP (`remoteIsVps: yes|no`) on port 7882.

### 5. Leg 3, the idle timeout (inside run2)

In leg 2's setup, the outside side sends no RTP for 45 s (the "silence 45 s" button), then resumes. Record whether media resumes without an ICE restart: in the LAN side's report `verifiedRemote` rises again after the silence, and neither report's `events` shows `room reconnecting` or a new ICE state after `silence end`. This tests the deploy guide's 30 s `udp.timeout` (media card 6). Note: ICE consent checks keep flowing every few seconds while RTP is paused.

### 6. Leg 4, TURN over TCP (run4, only if legs 2 and 3 show that UDP fails)

TURN on a TCP port behind Pangolin: `turn.listen` plus a Pangolin TCP resource. *Revert:* remove `turn.listen` (and `turn.enabled`) and delete the TCP resource. On the laptop, block outbound UDP with a local firewall rule (*revert:* delete the rule right after the run), then run4 (labels `leg4-lan`, `leg4-outside`). **Expectation:** the outside side's pair is `relay` with relay protocol `tcp`.

### 7. MTU

From leg 2's two `tcpdump` runs: the largest packet length seen on the VPS and on the LXC, against the deploy guide's tunnel MTU of 1280. No separate capture.

### 8. Clean up (nothing of the probe stays)

- For every account the four prepares printed: `dillad admin user delete --username=netprobe-a-<suffix> --yes` and the same for `netprobe-b-<suffix>` (the handles stay reserved; nothing else of them remains usable).
- `dillad admin invite revoke --id=<invite id>`.
- On the dev box **and** the laptop: `rm -r target/netprobe/run1 target/netprobe/run2 target/netprobe/run3 target/netprobe/run4` (every `side-a/`, `side-b/` and start JSON), and the laptop's browser downloads of the reports after they are copied to the dev box's `target/netprobe/reports/`.
- Revert `livekit.node_ip`, the Traefik entryPoint, the gerbil port, the Pangolin UDP resource or the VPS `DNAT` rule, and any TURN listener and Pangolin TCP resource, **unless** the decision keeps that piece as the documented deployment; the "What stayed" section says which and why.
- The `tcpdump` runs printed to the terminal only; no capture file exists.

## Results

Per report, from the downloaded JSON (`pair`, `joinMs`, `summary`, the last sample). `remoteIsVps` says whether the pair's remote candidate is the VPS's public IP; no address is written here.

| run, side | browser | pair local/remote, protocol | relay protocol | remoteIsVps, port | joinMs.connected | joinMs.firstVerifiedRemote | RTT p50 (ms) | loss % | jitter p50 (ms) | verified frames | decrypt drops |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| leg 1, LAN | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |
| leg 1, outside | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |
| leg 2, LAN | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |
| leg 2, outside | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |
| leg 2, outside a | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |
| leg 2, outside b | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |
| leg 4, LAN | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |
| leg 4, outside | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |

A leg that did not run (leg 4 when UDP works; outside and outside without the time) is written "not run" with the reason.

| leg 2 forward | value |
|---|---|
| path chosen, (a) tunnel or (b) DNAT | @@FILL@@ |
| packets seen on the VPS (of 300) | @@FILL@@ |
| packets seen on the LXC (of 300) | @@FILL@@ |
| largest datagram on the VPS, bytes | @@FILL@@ |
| largest datagram on the LXC, bytes | @@FILL@@ |
| against the tunnel MTU of 1280 | @@FILL@@ |

| leg 3, the idle timeout | value |
|---|---|
| silence pressed at, ended at (outside report, ms from Start) | @@FILL@@ |
| media resumed (LAN `verifiedRemote` rises after `silence end`) | @@FILL@@ |
| ICE restart or room reconnect after `silence end` (`events`) | @@FILL@@ |
| `udp.timeout` in effect | @@FILL@@ |

## Decision

- Does LiveKit UDP need its own port past Pangolin: @@FILL@@
- The VPS→homelab UDP path the deploy guide documents, with its measured RTT and loss: @@FILL@@
- `udp.timeout`: @@FILL@@
- MTU: @@FILL@@
- TURN over TCP: @@FILL@@

## What stayed

@@FILL@@ (each configuration change of the checklist that the decision keeps as the documented deployment, and why; everything else reverted on @@FILL@@).
