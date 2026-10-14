# L-PROBE-1 — voice past Pangolin on the founder's homelab

Date: @@FILL@@ · Instance build: @@FILL@@ (`dillad --version`) · Probe code: `feat(testkit,media): a network voice probe for a real instance` and its fix round (web-3 task 2) · Session: the supervisor with Jonas, about 45 minutes, dev box on the LAN and Jonas's laptop on a phone hotspot (founder decision 11, R10–R12, RV-6).

**Status: the checklist below is ready; the session has not run.** Every `@@FILL@@` cell is filled from the session's reports, and task 2 step 9 checks that none is left.

## Question

Does LiveKit's UDP media need its own port past Pangolin? UDP arrives at the Pangolin VPS's public IP (R10), so it must be forwarded from the VPS to the homelab; this session forwards it through the WireGuard tunnel (gerbil and Traefik). TURN over TCP is tried only if UDP fails (R11). The same session measures what bounds the deploy guide's 30 s Traefik `udp.timeout` (follow-up card 6) and the datagram sizes against the tunnel MTU of 1280.

**Decision rules.**
- "Does LiveKit UDP need its own port past Pangolin?" is **yes** if leg 1 fails and leg 2 works.
- `udp.timeout`: leg 3 measures, while both sides send no RTP, two gaps on the forwarded port, each the largest over the flows (a flow is one client↔VPS address-and-port pair, the unit Traefik keeps a session for): **G_any**, between datagrams in either direction, and **G_in**, between inbound datagrams (to 7882) only. Both are bounded by ICE keepalives and consent checks, which run while a call is connected.
  - 30 s stays if **5 × G_in ≤ 30 s** and media resumes after the silence without an ICE restart: safe whichever direction refreshes Traefik's session.
  - If only **5 × G_any ≤ 30 s** holds, 30 s is safe only if Traefik refreshes a session on replies too; the result says so and the timeout is raised to at least 5 × G_in.
  - Otherwise it is raised to at least 5 × G_in.
  - A connected call, even a silent one, cannot idle a session whose timeout is above the gap that refreshes it.
- The TURN fallback is recommended or not according to leg 4.
- A plain port forward on the VPS (`DNAT`, or a home-router forward) is **not tried**: it would add a public exposure of the homelab; only the tunnel path is measured.

## The probe

- **`dilla-testkit netprobe prepare --instance <url> --out <dir>`**, with the invite code in `NETPROBE_INVITE` (or `--invite <code>`), signs up two throwaway accounts through the invite (`netprobe-a-<6 hex>` and `netprobe-b-<6 hex>`, one random suffix per pair, because a deleted handle stays reserved), opens their 1:1 DM, registers its first call group as A and joins it by external commit as B, and writes `<dir>/side-a/` and `<dir>/side-b/` (each side's identity seed, ids and MLS store, owner-only files). It starts no call. It prints each account name, with its delete command, the moment the account exists, so a prepare that fails half-way still names what it made.
- **`dilla-testkit netprobe arm --instance <url> --state <dir>/side-<x>`** readies one side for the next run against the instance's call snapshot (`GET /v1/channels/{dm}/call`, web-3). Side a registers a fresh call group unless its own is still the open one; side b joins the open group by external commit unless it already holds it. It is a no-op on a side that is armed, and it **refuses while a call is live** ("still live": the previous call ends about 20 s after both pages are done). A call group lives only per run: an ended call closes it, and the instance closes an unused one 600 s after it was created. So **every run is `arm` side a, `arm` side b, `start` both**, all within seconds, and no secret crosses machines after a pair's first copy.
- **`dilla-testkit netprobe start --instance <url> --state <dir>/side-<x> --out <file>`** signs in as that side, reads the call group's handshakes (side a merges side b's join here), refuses unless both sides are in the group ("arm the other side"), starts or joins the DM call and writes the start JSON. A closed or replaced group is refused with "run arm again". **Run the second side's `start` within 30 s of the first, and press Start on each page within 30 s of its own `start`**: a leaf that stays out of a live call's room longer than 30 s is removed by the room sweep.
- **`dilla-testkit netprobe end --instance <url> --state <dir>/side-<x>`** ends the DM's live call (`DELETE /v1/calls/{id}`), which closes its group. Use it only when `arm` keeps answering "still live" more than a minute after both pages are done (a page that crashed can leave a ghost participant).
- **The probe page** (`npm run probe -w @dilla/media`, `http://localhost:5191`) loads one start JSON, joins with `@dilla/media`'s `joinCall` on the Start press, publishes a synthetic 440 Hz tone (no microphone), samples `getStats()` and the media worker's counters every second for 60 s, and offers the report as a JSON download (`ProbeReport`, L-PROBE-1, plus an `events` list: ICE and room state changes, the silence window and the drop reasons). Its "silence 45 s" button stops all RTP from that side for 45 s (`pauseUpstream`; DTX alone would still send comfort noise every 400 ms) and extends the run to 15 s past the resume. ICE keepalives and consent checks keep flowing while RTP is paused.
- **Public routes only.** No verb calls `/debug/*` or a test host's control listener.
- **TLS.** The testkit speaks plain HTTP only (no TLS stack, by its dependency rules). With `DILLA_PROBE_INSTANCE=https://<instance host>` the probe page's server also proxies the instance's `/v1`, `/gateway` and `/rtc`, so on both machines the testkit takes `--instance http://localhost:5191`, and the page's LiveKit signalling goes to `ws://localhost:5191/rtc` and on to the instance. Only signalling takes this path: media is ICE between the browser and the SFU's `node_ip`, which is what the session measures. The server listens on the loopback only and refuses to serve `target/netprobe/` (the probe's device state and start JSONs).
- **Which page path worked (task 2 step 3).** `/rtc` admits the page's own `localhost` dev-server origin: the automated check (PROBE-E2E, Chromium 153 and Firefox 155, test host on loopback) passes with the page served by the dev server, and again with the static build (`npm run probe -w @dilla/media -- build`, served by `npm run probe -w @dilla/media -- preview`). The `ssh -L` fallback is not needed. PROBE-E2E exercises only an `http:` target behind the proxy, so both machines run the proxy smoke check below before the session.
- **Reading a report.** `pair` is the selected candidate pair (local and remote candidate type, protocol, relay protocol, remote address and port). `candidates` lists the gathered local candidates without addresses. `joinMs.connected` is the time from the Start press to the joined room, `null` when the join failed (the `join failed` event says when it gave up). `summary.rttP50Ms` is the browser↔SFU round trip of the selected pair, not the VPS→homelab hop. `summary.lossPct` is lost / (lost + received) × 100 from the last sample's cumulative counters, so loss before the first sample counts. `relayUnavailable` is "ICE failed and no relay candidate was gathered"; a join that never connected counts as failed ICE. `verifiedRemote` counts frames the media worker authenticated and bound to a roster device; `decryptDrops` counts every frame it refused (the `events` list names the reasons at the end; `sif` drops are LiveKit's own server-injected frames and expected).
- **Redaction.** A downloaded report keeps the remote address; reports live only in the dev box's git-ignored `target/netprobe/reports/`. This document records `remoteIsVps: yes|no` and the port, never an address, a hostname or a port other than 7882 of the homelab, the VPS or the laptop. Before the session-result commit, besides task 2 step 9's gate, run `grep -nE '[0-9a-fA-F]{1,4}(:[0-9a-fA-F]{0,4}){2,7}' docs/spikes/2026-10-homelab-voice.md docs/deploy/README.md` (short IPv6 forms such as a WireGuard ULA), `grep -niE 'DOMAIN1|DOMAIN2' docs/spikes/2026-10-homelab-voice.md docs/deploy/README.md` with each of Jonas's domain names in place of the placeholders, and `grep -noE 'https?://[^ )`]+' docs/spikes/2026-10-homelab-voice.md docs/deploy/README.md | grep -vE '://(localhost([:/]|$)|<)'` (every URL whose host is neither `localhost` nor a `<placeholder>`); each must show nothing of Jonas's.

## Before the session

**Jonas, staged before the timed session starts (the Pangolin edits below interrupt every Pangolin resource and site tunnel for a moment, so they are made before the session and reverted after it):**

1. Deploy the web-3 build (step 1 of the checklist).
2. Stage leg 2's tunnel path (a) (step 4 of the checklist), but leave the Pangolin UDP resource **disabled** until leg 2: leg 1 must run with no UDP forward.
3. Stage the firewall openings of step 4 ("Firewalls"): the LAN rules from the Pangolin connector hosts and from the dev box to the LXC, and the VPS's inbound UDP 7882. None of them is reachable from the internet without the Pangolin UDP resource, which stays disabled until leg 2.

**Dev box (supervisor), on the LAN, in the repository root of this branch:**

1. `npm ci`, `npm run build:wasm -w @dilla/media`, `cargo build -p dilla-testkit --release --locked`.
2. Terminal 1, kept running for the whole session: `env DILLA_PROBE_INSTANCE=https://<instance host> npm run probe -w @dilla/media`.
3. Proxy smoke check: `curl -sf http://localhost:5191/v1/instance >/dev/null && echo proxy ok` prints `proxy ok`.

**Laptop (Jonas), still on the LAN, in its checkout of this branch (RV-6):**

1. `git pull`, `npm ci`, `npm run build:wasm -w @dilla/media`, `cargo build -p dilla-testkit --release --locked`.
   - If the media wasm build fails there (it needs wasm-pack, wasm-bindgen-cli 0.2.128 and clang 23), the dev box runs `npm run probe -w @dilla/media -- build` and copies `target/netprobe/page/` to the same path on the laptop, which then serves it with `preview` in place of the dev server below.
2. Terminal 1, kept running: `env DILLA_PROBE_INSTANCE=https://<instance host> npm run probe -w @dilla/media` (or `... npm run probe -w @dilla/media -- preview`).
3. Proxy smoke check: `curl -sf http://localhost:5191/v1/instance >/dev/null && echo proxy ok` prints `proxy ok`.
4. Open `http://localhost:5191` in Chromium. (Firefox works too; the browser is recorded per report.)

## Checklist

### 1. Deploy (Jonas)

Put a dillad of **the web-3 build** (this branch after lanes A–C landed: it has the call snapshot route `netprobe arm` reads and the 600 s idle close of unused call groups) on the LXC behind Pangolin, with:

- `livekit.enabled = true`;
- `livekit.udp_port = 7882`;
- `livekit.node_ip` = **the Pangolin VPS's public IP** (the key is `[livekit] node_ip`; there is no `rtc` table): UDP arrives there, not at the LXC's LAN address. *Revert:* restore the previous `node_ip` line (or remove the key if there was none) and restart dillad, unless the decision keeps it;
- `livekit.advertise_internal_ip` left at its default (`true` in `internal/config/defaults.go`); record the value `dillad doctor` or the rendered config shows. With it on, the LAN side may pair on a host candidate and pass leg 1 trivially, so leg 1's verdict rests on the **outside** side;
- TURN as `behind_proxy` leaves it: off (D23).

*Revert of the deploy itself:* redeploy the build that ran before, with its previous configuration file, unless the decision keeps the web-3 build.

Report: the `dillad --version` line; `advertise_internal_ip` as read.

| item | value |
|---|---|
| `dillad --version` | @@FILL@@ |
| `advertise_internal_ip` as read | @@FILL@@ |

### 2. Invite and the two pairs (Jonas, then the supervisor and the laptop)

1. Jonas runs `dillad admin invite create --max-uses=4 --ttl=2h` and sends the supervisor the invite code and the invite id it logs. Four uses: **pair L** (side a on the dev box, side b on the laptop) and **pair O** (both sides on the laptop, outside), two accounts each.
2. **Pair L**, on the dev box, the laptop still on the LAN: `env NETPROBE_INVITE=<code> target/release/dilla-testkit netprobe prepare --instance http://localhost:5191 --invite-id <invite id> --out target/netprobe/pairL`. It prints both account names and their delete commands; the supervisor keeps them for step 8.
3. The supervisor copies `target/netprobe/pairL/side-b/` to the laptop once, over the LAN, before it moves to the hotspot: first `ssh <laptop> mkdir -p -m 700 <checkout>/target/netprobe/pairL`, then `scp -r target/netprobe/pairL/side-b <laptop>:<checkout>/target/netprobe/pairL/`. This is a throwaway device's secret; step 8 deletes it.
4. The laptop moves to the phone hotspot and keeps its probe server running.
5. **Pair O**, on the laptop, on the hotspot, at any time before leg 2's outside↔outside run: `env NETPROBE_INVITE=<code> target/release/dilla-testkit netprobe prepare --instance http://localhost:5191 --invite-id <invite id> --out target/netprobe/pairO`. It holds both sides, so nothing moves between machines; Jonas sends the supervisor the two account names it prints.

**Every run** (the supervisor calls each step; only the word "go" crosses machines):

1. Side a: `target/release/dilla-testkit netprobe arm --instance http://localhost:5191 --state target/netprobe/<pair>/side-a` prints `registered` (or `kept`).
2. Side b: the same with `side-b` prints `joined` (or `kept`).
3. Side a: `target/release/dilla-testkit netprobe start --instance http://localhost:5191 --state target/netprobe/<pair>/side-a --out target/netprobe/<pair>/a.json`, load `a.json` into its page, set the label, press **Start** within 30 s.
4. Side b, within 30 s of side a's `start`: the same with `side-b` and `b.json`, its own label, and **Start** within 30 s of its own `start`.
5. When both status lines say `done`, press **Download** on both pages.
6. Before the next run on the same pair, `arm` answers "still live" until the call has ended (about 20 s after both pages are done); wait and repeat it. If it still says so after a minute, run `netprobe end` with either side's `--state`, then `arm` again.

For pair L, side a runs on the dev box and side b on the laptop. For pair O, both run on the laptop, in two terminals and two browser windows.

### 3. Leg 1, HTTP only (pair L)

Only the existing Pangolin HTTP resource for 443; the UDP resource stays disabled. One run of pair L: labels `leg1-lan` (dev box) and `leg1-outside` (laptop on the hotspot).

**Expectation:** the outside side's ICE fails or no media flows: its report shows `relayUnavailable: true` or `verifiedRemote` stays 0.

### 4. Leg 2, the UDP forward from the VPS through the tunnel (pair L, then pair O)

UDP arrives at the VPS public IP and travels through the Pangolin WireGuard tunnel to the LXC's port 7882 (the deploy guide's Traefik/gerbil UDP router). Configuration, each with its revert (staged before the session; see "Before the session"):

- **Pangolin raw resources.** If this Pangolin version only offers raw TCP/UDP resources with `flags: allow_raw_resources: true` in its `config.yml`, set it and restart Pangolin. *Revert:* restore the previous `flags` value and restart Pangolin.
- **Traefik entryPoint** `udp-7882` in Traefik's static configuration (gerbil's network namespace):

  ```yaml
  entryPoints:
    udp-7882:
      address: ":7882/udp"
      udp:
        timeout: 30s
  ```

  *Revert:* delete the `udp-7882` block and restart Traefik.
- **gerbil port** `7882:7882/udp` added to the `gerbil` service's `ports:` in the compose file, then `docker compose up -d gerbil`. *Revert:* delete that line and run `docker compose up -d gerbil` again.
- **Pangolin raw UDP resource** from 7882 to the LXC's 7882 on the newt site. It stays disabled through leg 1 and is enabled for leg 2. *Revert:* delete the resource.

**Firewalls** (staged before the session; generic, because the rules depend on Jonas's network):

- **LAN firewall, connector → LXC.** Allow UDP to the LXC's port 7882 from the host(s) that run the Pangolin connector (newt) for this site, and, only for leg 4, TCP to the LXC's `<turn port>` from the same hosts. *Revert:* delete exactly those allow rules.
- **LAN firewall, dev box → LXC.** If the LAN firewall blocks the dev box from the LXC's UDP 7882 (the LAN side may pair on the LXC's own host candidate, because `advertise_internal_ip` is on), allow UDP from the dev box to the LXC's port 7882. *Revert:* delete that allow rule.
- **VPS firewalls.** Admit inbound UDP 7882 at the VPS provider's firewall (security group or cloud firewall) and at the VPS host's own firewall, if either filters inbound traffic; for leg 4 also inbound TCP `<turn port>`. *Revert:* delete exactly those rules at both places.

Then:

1. **Pair L, LAN and outside** (labels `leg2-lan`, `leg2-outside`). While it runs, two **simultaneous, timed** captures, terminal output only, never `-w`:
   - on the VPS, on its public interface: `timeout 30 tcpdump -ni <vps public if> udp dst port 7882 2>/dev/null | awk '{n++; if ($NF+0 > m) m = $NF+0} END {print n, m}'`;
   - on the LXC, leaving out the dev box's direct traffic (its host candidate reaches the LXC without the tunnel; type its LAN address in the terminal only): `timeout 30 tcpdump -ni eth0 udp dst port 7882 and not host <dev box address> 2>/dev/null | awk '{n++; if ($NF+0 > m) m = $NF+0} END {print n, m}'`.

   Each prints two numbers: the datagrams to 7882 in those 30 s, and the largest UDP payload length. LXC count / VPS count is the hop's upstream delivery. Named interfaces, because `-i any` sees each datagram on the public interface and again on gerbil's bridge.
   - At the same time, on the laptop: `ping -c 30 <vps public ip>`; report its average and its loss only. The hop round-trip estimate is the **outside** report's probe RTT p50 minus this average. The VPS may drop ICMP: then write "no ICMP reply" and no estimate.
   - Press nothing else until both captures have printed (30 s).
2. **Leg 3 in the same run** (step 5 below), started only after leg 2's captures have finished.
3. **Pair O, outside and outside** (labels `leg2-outside-a`, `leg2-outside-b`): both sides on the laptop. Both sit behind the same hotspot NAT; each still reaches the SFU through the VPS forward on its own. Run the same two captures during this run (no dev box traffic here, so the LXC's `and not host` part may be left out). **This run's LXC / VPS ratio is the delivery figure of record**; pair L's is the cross-check.

Record for each report whether the pair's remote candidate is the VPS's public IP (`remoteIsVps: yes|no`) and its port (7882).

### 5. Leg 3, what bounds the idle timeout (inside pair L's leg-2 run)

Once leg 2's captures in pair L's run have printed, press **silence 45 s** on **both** pages at once, so neither side sends RTP (each run lasts at least 15 s past the silence, so the run is long enough). Right after pressing, on the VPS public interface:

`timeout 40 tcpdump -tt -ni <vps public if> udp port 7882 2>/dev/null | awk '{s = $3; d = $5; sub(/:$/, "", d); k = (s < d) ? s " " d : d " " s; if (k in a) {g = $1 - a[k]; if (g > m) m = g} a[k] = $1; if (d ~ /\.7882$/) {if (k in b) {h = $1 - b[k]; if (h > n) n = h} b[k] = $1}} END {printf "G_any %.2f s, G_in %.2f s\n", m, n}'`

`-tt` prints absolute times; the awk keys each datagram on its flow (the sorted source and destination address-and-port pair) and prints only the two numbers, no address: **G_any**, the largest gap between datagrams of one flow in either direction, and **G_in**, the largest gap between inbound datagrams (to 7882) of one flow. With both sides silent, what still flows is ICE keepalives (about every 2 s) and consent checks (about every 5 s), so the gaps show how far below 30 s a flow's idle time stays while a call is connected. Apply the decision rule against 30 s to both: `5 × G_in ≤ 30 s` (safe whichever direction refreshes Traefik's session) and `5 × G_any ≤ 30 s` (safe only if replies refresh it too). Then record whether media resumes after the silence without an ICE restart: in each report `verifiedRemote` rises again after `silence end`, and neither report's `events` shows `room reconnecting` or a new ICE state after it.

Optional negative control, if time allows: set the entryPoint's `udp.timeout` to `3s` (Traefik's default, which the deploy guide says re-dials with a new source port), restart Traefik, run pair L once more with the silence, and record what breaks. *Revert:* set it back to `30s` and restart Traefik.

### 6. Leg 4, TURN over TCP (pair L, only if legs 2 and 3 show that UDP fails)

Each change with its revert:

- `turn.enabled = true` and `turn.listen = "<lxc address>:<turn port>"` in dillad's configuration, then restart dillad. *Revert:* remove both keys and restart dillad.
- A Traefik TCP entryPoint `tcp-<turn port>` (`address: ":<turn port>/tcp"`) in the same static configuration. *Revert:* delete the block and restart Traefik.
- `<turn port>:<turn port>/tcp` on the `gerbil` service's `ports:`, then `docker compose up -d gerbil`. *Revert:* delete the line and run it again.
- A Pangolin raw TCP resource from `<turn port>` to the LXC's `<turn port>`. *Revert:* delete the resource.
- The TCP `<turn port>` openings of step 4's "Firewalls" (LAN connector → LXC, VPS provider and host). *Revert:* as stated there.
- On the laptop (Linux), block only UDP to the VPS's media and STUN ports, so DNS and the proxy keep working:
  - `sudo nft add table inet netprobe`
  - `sudo nft add chain inet netprobe out '{ type filter hook output priority 0; }'`
  - `sudo nft add rule inet netprobe out ip daddr <vps public ip> udp dport '{ 7882, 3478 }' drop`

  *Revert, right after the run:* `sudo nft delete table inet netprobe`. (A laptop that is not Linux skips leg 4.)

Then one run of pair L (labels `leg4-lan`, `leg4-outside`). **Expectation:** the outside side's pair is `relay` with relay protocol `tcp`.

### 7. MTU

From leg 2's two captures: the largest UDP payload on the VPS and on the LXC. The tunnel MTU of 1280 bounds the inner IP packet, so compare the payload plus 28 (IPv4) or plus 48 (IPv6) against 1280. These runs are audio only; video is not exercised (libwebrtc keeps RTP packets at about 1200 bytes).

### 8. Clean up

The probe accounts and the invite are deleted; their rows remain (tombstoned accounts, the DMs, closed call groups, device lists and voice-session rows).

- For each of the four accounts the two prepares printed: `dillad admin user delete --username=netprobe-a-<suffix> --yes` and the same for `netprobe-b-<suffix>` (the handles stay reserved; nothing of them remains usable).
- `dillad admin invite revoke --id=<invite id>`.
- Safety net: `dillad admin user list | grep netprobe-` shows only deleted accounts, and `dillad admin invite list` shows the invite revoked.
- On the dev box: `rm -r target/netprobe/pairL`. On the laptop: `rm -r target/netprobe/pairL target/netprobe/pairO` (every `side-a/`, `side-b/` and start JSON), and the browser downloads of the reports after they are copied to the dev box's `target/netprobe/reports/`.
- Revert `livekit.node_ip`, the Pangolin `flags` change, the Traefik entryPoint(s), the gerbil port(s), the Pangolin UDP (and TCP) resource, the LAN firewall allow rules (connector → LXC, dev box → LXC), the VPS provider and host firewall rules, any TURN listener and the laptop's `nft` table, each as its step states, **unless** the decision keeps that piece as the documented deployment; the "What stayed" section says which and why.
- The `tcpdump` runs printed to the terminal only; no capture file exists.

## Results

Per report, from the downloaded JSON (`pair`, `joinMs`, `summary`, the last sample). `remoteIsVps` says whether the pair's remote candidate is the VPS's public IP; no address is written here. RTT is browser↔SFU.

| run, side | browser | pair local/remote, protocol | relay protocol | remoteIsVps, port | joinMs.connected (null = failed) | joinMs.firstVerifiedRemote | probe RTT p50 (ms) | loss % | jitter p50 (ms) | verified frames | decrypt drops |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| leg 1, LAN | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |
| leg 1, outside | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |
| leg 2, LAN | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |
| leg 2, outside | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |
| leg 2, outside a (pair O) | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |
| leg 2, outside b (pair O) | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |
| leg 4, LAN | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |
| leg 4, outside | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ | @@FILL@@ |

A leg that did not run (leg 4 when UDP works; pair O without the time) is written "not run" with the reason.

| leg 2, the forward through the tunnel | value |
|---|---|
| path | (a) the WireGuard tunnel; a plain port forward was not tried (no new public exposure) |
| pair O: datagrams to 7882 in 30 s, VPS public interface / LXC `eth0` | @@FILL@@ |
| pair O: upstream delivery, LXC / VPS (the figure of record) | @@FILL@@ |
| pair L: datagrams to 7882 in 30 s, VPS / LXC without the dev box's direct traffic | @@FILL@@ |
| pair L: upstream delivery, LXC / VPS (cross-check) | @@FILL@@ |
| laptop → VPS `ping`, average (ms) and loss, or "no ICMP reply" | @@FILL@@ |
| hop round trip estimate, the outside report's probe RTT p50 minus the `ping` average (ms) | @@FILL@@ |
| largest UDP payload, VPS / LXC (bytes) | @@FILL@@ |
| largest inner packet (payload + 28 or + 48) against the tunnel MTU of 1280 | @@FILL@@ |

| leg 3, the idle timeout | value |
|---|---|
| G_any: largest per-flow gap, either direction, while both sides were silent (s) | @@FILL@@ |
| G_in: largest per-flow gap between inbound datagrams (to 7882) (s) | @@FILL@@ |
| `5 × G_in ≤ 30 s` and `5 × G_any ≤ 30 s` (each yes or no, with the margin) | @@FILL@@ |
| media resumed after `silence end` (`verifiedRemote` rises on both) | @@FILL@@ |
| ICE restart or room reconnect after `silence end` (`events`) | @@FILL@@ |
| negative control at `udp.timeout: 3s` | @@FILL@@ |

## Decision

- Does LiveKit UDP need its own port past Pangolin: @@FILL@@
- The VPS→homelab UDP path the deploy guide documents (the tunnel), with the measured delivery and hop round trip: @@FILL@@
- `udp.timeout`: @@FILL@@
- MTU: @@FILL@@
- TURN over TCP: @@FILL@@

## What stayed

@@FILL@@ (each configuration change of the checklist that the decision keeps as the documented deployment, and why; everything else reverted on @@FILL@@).
