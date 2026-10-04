# SP-29 — the 25/10 capacity rig and the first numbers

Date: 2026-10-04 · Commit: `aa32ab3` plus the uncommitted rig · Rig: `cmd/dilla-loadrig` (Go lksdk + `internal/media`)

## Question

Does one dillad with in-process LiveKit v1.13.7 carry 25 voice participants and 10 simultaneous sharers on the founder's LAN, and what does each cell cost? The founder-LXC LAN leg is pending (NV-7), so this run measures the dev box over loopback only. These numbers are **dev box, loopback, not a capacity figure**.

## Rig and interpretation

- Host: Linux 7.2.7-1-cachyos, AMD Ryzen 7 7800X3D (16 logical CPUs), 30 GiB RAM. `GOMAXPROCS=4`. The rig and LiveKit share one process; the CPU and RSS columns therefore include both. `lo` transmit bytes count local traffic, not a physical NIC. No other media or benchmark workload ran during the cells; file inspection and documentation edits did.
- Go lksdk participants use 32-hex device identities. Every receiver gets the full roster, epoch 1, and the fixed rig base key `0a` × 16. Go viewers decrypt subscribed tracks with `internal/media`. A result's decrypt percentage excludes LiveKit SIF frames from the denominator. Every participant auto-subscribes except to its own tracks.
- Voice fixture: 90 s Ogg Opus, 64 kbit/s target, 20 ms packets. DTX publishers send one `f8 ff fe` Opus frame every 400 ms, RFC 6464 level 127. This roughly models a silent dilla browser after the zero-byte audio exception: the separately measured Chromium 153 and Firefox 155 silent microphones each sent **4.7 packets/s** (the task 22 prerequisite `dtx-report.md`). The rig's deliberate 400 ms spacing is 2.5 packets/s; it is an approximation, not an exact browser trace. A zero-byte Opus frame is the only audio frame passed without ciphertext; every nonempty fixture frame is encrypted.
- Shares: single-layer VP8 IVF with `Encryption_CUSTOM` (DEV-40 b): q 480×270 at 150 kbit/s, h 960×540 at 625 kbit/s, f 1920×1080 at 2.5 Mbit/s, all 15 fps. Go simulcast is not used.
- Each cell warms up 15 s, then samples for 60 s. SFU RTP egress is `8 * sum(rate(livekit_packet_bytes{direction="outgoing"}[30s]))`, implemented as the delta between two `/metrics` scrapes. Ingress is the corresponding incoming delta. Wire transmit comes from `/proc/net/dev`; process CPU from `/proc/<pid>/stat` at USER_HZ 100; RSS from `/proc/<pid>/status`; loss from `livekit_packet_loss_total / livekit_packet_total`. Each table row is printed by the rig without later rounding.

The loopback command (from the repository root) was:

```sh
GOMAXPROCS=4 target/dilla-loadrig -local-sfu -iface lo -voice target/rig-media/voice.ogg -share-q target/rig-media/share-q.ivf -share-h target/rig-media/share-h.ivf -share-f target/rig-media/share-f.ivf -cells all -warmup 15s -hold 60s -location 'dev box, loopback, rig+SFU in one process' -commit aa32ab3 -out target/capacity-loopback-final.md
```

### Reproducible media

Generated with `/usr/bin/ffmpeg` n9.0.2 in ignored `target/rig-media/`:

```sh
/usr/bin/ffmpeg -y -loglevel error -f lavfi -i sine=frequency=440:sample_rate=48000:duration=90 -ac 1 -c:a libopus -b:a 64k -frame_duration 20 -application voip -page_duration 20000 target/rig-media/voice.ogg
/usr/bin/ffmpeg -y -loglevel error -f lavfi -i testsrc2=size=480x270:rate=15:duration=90 -c:v libvpx -b:v 150k -minrate 150k -maxrate 150k -deadline realtime -cpu-used 8 -g 150 -auto-alt-ref 0 -lag-in-frames 0 target/rig-media/share-q.ivf
/usr/bin/ffmpeg -y -loglevel error -f lavfi -i testsrc2=size=960x540:rate=15:duration=90 -c:v libvpx -b:v 625k -minrate 625k -maxrate 625k -deadline realtime -cpu-used 8 -g 150 -auto-alt-ref 0 -lag-in-frames 0 target/rig-media/share-h.ivf
/usr/bin/ffmpeg -y -loglevel error -f lavfi -i testsrc2=size=1920x1080:rate=15:duration=90 -c:v libvpx -b:v 2500k -minrate 2500k -maxrate 2500k -deadline realtime -cpu-used 8 -g 150 -auto-alt-ref 0 -lag-in-frames 0 target/rig-media/share-f.ivf
```

| file | SHA-256 |
|---|---|
| `voice.ogg` | `b59b50b730da3cada1f296eb3f488976cac7450a58c7889cb59013d28bd3ec2b` |
| `share-q.ivf` | `dc82b97d0e5b6c0909d5a15f4e09af11ebad116bbc1bf649d0cefb06f0e2ea5e` |
| `share-h.ivf` | `f2c30e022d6f76fa5848cf9f637a035ef921097fd91d67c4a9b06f22bbc60202` |
| `share-f.ivf` | `349c52a7c5df9fb799c8508a72fdafd7056f18fcbce27a7532983543d215dcc9` |

## Founder LXC, LAN

**Not run here:** no founder LXC address, SSH user, LAN interface or `/metrics` URL is available; the controller also forbids deploying this branch or touching the LXC LiveKit secret. The result is pending (NV-7). A later LAN run first obtains those values from Jonas. LiveKit signalling remains bound to loopback and goes through an SSH tunnel; media goes directly over UDP to the LXC's advertised LAN address.

```sh
ssh -N -L 7880:127.0.0.1:7880 <ssh-user>@<lxc-lan-host>
GOMAXPROCS=4 target/dilla-loadrig -lk-url ws://127.0.0.1:7880 -lk-http http://127.0.0.1:7880 -api-key dilla -api-secret-file <operator-provided-secret-file> -metrics <metrics-url> -ssh <ssh-user>@<lxc-lan-host> -dillad-pid <pid-from-ssh-pidof-dillad> -iface <lan-interface> -voice target/rig-media/voice.ogg -share-q target/rig-media/share-q.ivf -share-h target/rig-media/share-h.ivf -share-f target/rig-media/share-f.ivf -cells all -warmup 15s -hold 60s -location 'founder LXC, LAN' -commit <measured-commit> -out target/capacity-lan.md
```

The first command stays running in another terminal. Confirm the ICE candidate advertises the LXC LAN address and UDP 7882 reaches it before treating the second command's rows as a LAN measurement. Do not bind LiveKit signalling to a LAN address.

## Dev box, loopback — not a capacity figure

<!-- egress = 8 * sum(rate(livekit_packet_bytes{direction="outgoing"}[30s])); ingress = 8 * sum(rate(livekit_packet_bytes{direction="incoming"}[30s])); wire = /proc/net/dev lo tx -->
| cell | participants | SFU egress Mbps (RTP) | SFU ingress Mbps (RTP) | wire tx Mbps | dillad CPU % | dillad RSS MiB | loss % | audio subscriptions | decrypt-ok % | location | date | commit |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| video-s1-v3-q | 4 | 0.5 | 0.2 | 0.7 | 1 | 94 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s1-v3-h | 4 | 1.9 | 0.6 | 2.7 | 1 | 101 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s1-v3-f | 4 | 7.6 | 2.5 | 10.5 | 2 | 103 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s1-v12-q | 13 | 1.9 | 0.2 | 2.2 | 1 | 134 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s1-v12-h | 13 | 7.6 | 0.6 | 8.7 | 2 | 151 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s1-v12-f | 13 | 30.3 | 2.5 | 34.2 | 6 | 150 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s1-v24-q | 25 | 3.7 | 0.2 | 4.3 | 2 | 192 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s1-v24-h | 25 | 15.3 | 0.6 | 16.7 | 4 | 204 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s1-v24-f | 25 | 60.7 | 2.5 | 65.8 | 13 | 210 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s3-v3-q | 4 | 1.4 | 0.5 | 2.0 | 1 | 139 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s3-v3-h | 4 | 5.7 | 1.9 | 8.0 | 2 | 128 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s3-v3-f | 4 | 22.8 | 7.6 | 31.6 | 5 | 125 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s3-v12-q | 13 | 5.6 | 0.5 | 6.6 | 3 | 167 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s3-v12-h | 13 | 22.9 | 1.9 | 26.0 | 6 | 178 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s3-v12-f | 13 | 91.0 | 7.6 | 102.5 | 16 | 185 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s3-v24-q | 25 | 11.2 | 0.5 | 12.6 | 5 | 233 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s3-v24-h | 25 | 45.8 | 1.9 | 49.9 | 11 | 252 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s3-v24-f | 25 | 182.1 | 7.6 | 197.2 | 34 | 260 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s10-v12-q | 13 | 18.7 | 1.6 | 21.8 | 7 | 264 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s10-v12-h | 13 | 76.3 | 6.4 | 86.4 | 16 | 261 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s10-v12-f | 13 | 303.4 | 25.3 | 341.7 | 51 | 273 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s10-v24-q | 25 | 37.4 | 1.6 | 41.8 | 13 | 366 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s10-v24-h | 25 | 152.6 | 6.4 | 166.2 | 32 | 374 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| video-s10-v24-f | 25 | 606.6 | 25.3 | 657.1 | 104 | 424 | 0.00 | 0 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| voice-3t-22dtx | 25 | 7.6 | 0.3 | 10.4 | 11 | 400 | 0.00 | 600 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |
| voice-25t | 25 | 60.4 | 2.6 | 74.7 | 50 | 404 | 0.00 | 600 | 100.00 | dev box, loopback, rig+SFU in one process | 2026-10-04 | aa32ab3 |

## Audio downtracks (DEV-04)

Both measured voice cells had **600** live audio subscriptions (25 publishers × 24 subscribers), confirming the required N×(N−1) count on loopback. `voice-25t` RTP egress was **60.4 Mbps**, or **100.7 kbit/s per subscribed downtrack** when divided by the printed total. `voice-3t-22dtx` RTP egress was **7.6 Mbps**, or **12.7 kbit/s per subscribed downtrack** by the same calculation. These are SFU RTP bytes, not physical network bitrates. The 3-talker/22-DTX row uses the synthetic 2.5-packets/s DTX fixture described above.

## VPS hop (F6; follow-up card 6)

**Not run here:** no founder VPS or WAN uplink measurement. The first action is to ask Jonas: “public IP or CGNAT, and upload Mbps?” No answer was supplied for this run. After Jonas supplies the VPS path and uplink, run the same 26-cell command above from the VPS-hop rig host, with its SSH signalling tunnel to the founder LXC, `-location 'founder LXC, VPS hop'`, and `-out target/capacity-vps.md`; retain direct UDP media over the configured VPS forwarding path. The substituted LXC address, SSH user, metrics URL, interface, PID, secret file and measured commit are recorded with that later run.

From the VPS-hop rig host, after copying the rig binary and the four hashed fixtures there, the command template is:

```sh
ssh -N -L 7880:127.0.0.1:7880 <ssh-user>@<lxc-reachable-from-vps>
GOMAXPROCS=4 target/dilla-loadrig -lk-url ws://127.0.0.1:7880 -lk-http http://127.0.0.1:7880 -api-key dilla -api-secret-file <operator-provided-secret-file> -metrics <metrics-url> -ssh <ssh-user>@<lxc-reachable-from-vps> -dillad-pid <pid-from-ssh-pidof-dillad> -iface <lan-interface> -voice target/rig-media/voice.ogg -share-q target/rig-media/share-q.ivf -share-h target/rig-media/share-h.ivf -share-f target/rig-media/share-f.ivf -cells all -warmup 15s -hold 60s -location 'founder LXC, VPS hop' -commit <measured-commit> -out target/capacity-vps.md
```

As with the LAN leg, the tunnel carries signalling only; the configured UDP path carries media. Confirm that ICE selects the intended VPS UDP path before attributing the numbers to that hop.

## Pass or fail and decision

All 26 dev-box loopback cells ran for a 60 s hold after 15 s warm-up and printed **100.00% decrypt-ok** and **0.00% LiveKit-reported packet loss**. The final rig also required every participant with a remote publisher to decrypt frames during the hold. Both voice cells had exactly 600 audio downtracks. The maximum printed CPU was 104% and maximum RSS was 424 MiB, but both include the rig and SFU in one process and neither is an LXC capacity observation.

**Founder-LXC LAN capacity: pending (NV-7).** The dev-box run proves the rig can execute the 25/10 matrix and checks decryption on loopback; it cannot establish whether the founder LXC holds 25 voice participants or 10 sharers. The LAN and VPS-hop legs are not run here for the reasons above. Follow-up card 6 needs the founder LAN egress of `video-s1-v24-f`, `video-s10-v24-f` and `voice-25t`, plus Jonas’s answer about public IP/CGNAT and upload Mbps. No protocol/09 capacity figure is published from this spike.

The first exploratory matrix reported zero audio subscriptions for `voice-25t` because the brief subtracted two samples of `livekit_track_subscribed_total` as though it were a counter. The pinned LiveKit v1.13.7 module declares it as a current gauge. A RED→GREEN test corrected the rig, a two-voice-cell retest returned 600/600, and this final 26-cell matrix was rerun with the gauge fix and a per-viewer activity check. Only the final matrix above is used for the decision.
