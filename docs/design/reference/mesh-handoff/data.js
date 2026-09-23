// Mock data for the Dilla chat refinement prototype.
// All names/messages invented; not from the real repo.

window.MOCK_DATA = (function () {
  const SERVERS = [
    { id: 'berralitos', name: 'Berralitos', short: 'B', node: 'gbg-1.dilla.local', federated: true, members: 14 },
    { id: 'rustaceans', name: 'Rustaceans', short: 'R', node: 'rust.berra.io', federated: true, members: 38 },
    { id: 'lofi', name: 'Late-night lofi', short: 'L', node: 'solo (you)', federated: false, members: 5 },
  ];

  const MEMBERS = [
    { id: 'thim', name: 'thim', initials: 'TH', color: '#F39E2B', status: 'online', role: 'admin', custom: 'pushing pixels' },
    { id: 'ada',  name: 'ada',  initials: 'AD', color: '#7C5CFF', status: 'online', role: 'maintainer' },
    { id: 'mira', name: 'mira', initials: 'MI', color: '#37B6A2', status: 'online' },
    { id: 'ben',  name: 'ben',  initials: 'BE', color: '#E0617E', status: 'idle', custom: 'lunch' },
    { id: 'ola',  name: 'ola',  initials: 'OL', color: '#4F86E0', status: 'online' },
    { id: 'juno', name: 'juno', initials: 'JU', color: '#C97442', status: 'dnd', custom: 'deep work' },
    { id: 'kai',  name: 'kai',  initials: 'KA', color: '#5DAE73', status: 'online' },
    { id: 'sven', name: 'sven', initials: 'SV', color: '#9C7CD8', status: 'offline' },
    { id: 'noa',  name: 'noa',  initials: 'NO', color: '#D88C3A', status: 'offline' },
  ];

  const byId = Object.fromEntries(MEMBERS.map(m => [m.id, m]));

  const CHANNELS = [
    { id: 'general',  name: 'general',     type: 'text', topic: 'whatever fits',                   unread: 0, encrypted: true },
    { id: 'design',   name: 'design',      type: 'text', topic: 'pixels, type, brand',             unread: 4, encrypted: true },
    { id: 'dev',      name: 'dev',         type: 'text', topic: 'rust + tauri + signal protocol',  unread: 12, mention: true, encrypted: true },
    { id: 'mesh',     name: 'mesh-status', type: 'text', topic: 'federation health',               unread: 0, encrypted: true },
    { id: 'random',   name: 'random',      type: 'text', topic: 'off-topic',                       unread: 1, encrypted: true },
    { id: 'voice',    name: 'voice-lounge',type: 'voice', participants: ['thim','ada','ben'], locked: false },
    { id: 'pair',     name: 'pair-program',type: 'voice', participants: [], locked: true },
  ];

  // A busy day in #design
  const today = new Date();
  function t(hoursAgo, minutes = 0) {
    const d = new Date(today.getTime() - hoursAgo * 3600e3 - minutes * 60e3);
    return d;
  }

  const MESSAGES = {
    design: [
      { id: 'm1', author: 'ada', at: t(5, 10), kind: 'text',
        text: "ok new pass on the channel list — switched the kanal/PM toggle to a real segmented control. screenshots coming." },
      { id: 'm2', author: 'mira', at: t(5, 8), kind: 'text',
        text: "yes please. the current pill buttons drift apart by 1px in firefox 🤡" },
      { id: 'm3', author: 'mira', at: t(5, 7), kind: 'text',
        text: "also can the voice section be collapsible? mine is permanently empty and it eats real estate" },
      { id: 'm4', author: 'ada', at: t(4, 50), kind: 'image',
        text: "first cut. mostly type + spacing — color tokens unchanged.",
        attachment: { kind: 'image', label: 'channel-list-v3.png', w: 320, h: 200, tint: '#1a3b3a' } },
      { id: 'm5', author: 'ben', at: t(4, 32), kind: 'text', text: "this slaps" },
      { id: 'm5b', author: 'ben', at: t(4, 32), kind: 'text',
        text: "small note: the unread dot is sitting right on the channel name baseline. lift it 1–2px",
        reactions: [{ e: '👀', n: 2, mine: false }, { e: '✅', n: 3, mine: true }] },
      { id: 'm6', author: 'thim', at: t(4, 12), kind: 'text',
        text: "agree on collapsible. let's keep voice pinned only when there's an active session — collapse to a single line otherwise." },
      { id: 'm7', author: 'juno', at: t(3, 45), kind: 'text',
        text: "rfc: kill the lock icon next to private kanals, replace with a subtle dot in the channel-name color. less noise.",
        thread: { count: 7, lastReplyAt: t(2, 5), participants: ['ada','mira','thim'] } },
      { id: 'm8', author: 'ada', at: t(2, 10), kind: 'text', text: "yeah lock is doing nothing for me visually. the encryption indicator should live on the channel header, not the row." },
      { id: 'm9', author: 'mira', at: t(2, 8), kind: 'text', text: "+1. row gets cluttered fast at 4+ channels per category." },
      { id: 'm10', author: 'thim', at: t(1, 30), kind: 'text',
        text: "going to push a branch later tonight with the new tokens. let me know if anyone wants to pair on the voice dock." },
      { id: 'm11', author: 'ada', at: t(1, 20), kind: 'text',
        text: "i can after 21:00 cet. voice dock is the one thing that still feels like it's from 2019",
        reactions: [{ e: '💯', n: 2, mine: true }, { e: '🛠', n: 1, mine: false }] },
      { id: 'm12', author: 'ben', at: t(0, 18), kind: 'system',
        text: "ben pinned a message",
        meta: "thim · \"let's commit to a single accent and stop bike-shedding\"" },
      { id: 'm13', author: 'mira', at: t(0, 12), kind: 'text',
        text: "currently in #voice-lounge if anyone wants to look at hover states with me" },
      { id: 'm14', author: 'thim', at: t(0, 4), kind: 'text', text: "joining" },
    ],
    general: [
      { id: 'w0', author: 'thim', at: t(48, 0), kind: 'system', text: 'thim created the team', meta: 'first peer · gbg-1.dilla.local' },
      { id: 'w1', author: 'thim', at: t(48, 0), kind: 'text', text: "**welcome to Berralitos** 👋\n\nthis is a fresh dilla instance running on gbg-1. some pointers:\n\n- press `⌘K` for the command palette, `/` for search\n- right-click anything to see what it can do\n- check `#mesh-status` for federation health\n- `Team Settings → Federation` to add peers\n- `Privacy & encryption` for your safety number\n\nmessages here are end-to-end encrypted via the signal protocol. the server only ever sees ciphertext + routing metadata. drop a screenshot in `#design` to test attachments — it'll encrypt locally before upload." },
      { id: 'g1', author: 'kai', at: t(8, 0), kind: 'text', text: "morning ☕" },
      { id: 'g2', author: 'ola', at: t(7, 50), kind: 'text', text: "morning kai. mesh sync looks clean overnight — 0 dropped messages between gbg-1 and rust.berra.io" },
      { id: 'g3', author: 'thim', at: t(7, 20), kind: 'text', text: "love that" },
      { id: 'g4', author: 'juno', at: t(3, 0), kind: 'text', text: "anyone shipping today?" },
      { id: 'g5', author: 'ada', at: t(2, 55), kind: 'text', text: "channel-list redesign — see #design" },
      { id: 'g6', author: 'mira', at: t(0, 30), kind: 'text', text: "afk for an hour, back for review" },
    ],
    dev: [
      { id: 'd1', author: 'sven', at: t(12, 0), kind: 'text', text: "fyi opened a PR to swap the WebRTC stats poll interval from 1s to 250ms — speaking detection is jittery on slow networks" },
      { id: 'd2', author: 'ada', at: t(11, 30), kind: 'text', text: "approved, that's been bugging me too" },
      { id: 'd3', author: 'thim', at: t(0, 45), kind: 'text', text: "@ada can you take another pass on the X3DH key bundle endpoint? something about the error case feels off", mentions: ['ada'] },
    ],
    mesh: [
      { id: 'me1', author: 'system', at: t(2, 0), kind: 'system', text: "peer rust.berra.io rejoined the mesh", meta: 'lamport=12944' },
      { id: 'me2', author: 'system', at: t(0, 22), kind: 'system', text: "voice SFU heartbeat ok · 14ms p50" },
    ],
    random: [
      { id: 'r1', author: 'ben', at: t(6, 0), kind: 'text', text: "best köttbullar in göteborg, go" },
    ],
  };

  const DMS = [
    { id: 'dm-ada',  with: 'ada',  preview: "ok pushing in a sec", at: t(0, 5), unread: 2 },
    { id: 'dm-mira', with: 'mira', preview: "🛠", at: t(2, 30), unread: 0 },
    { id: 'dm-grp',  with: ['ben','ola'], group: true, name: 'release-crew', preview: "ola: builds green", at: t(1, 10), unread: 0 },
  ];

  const DM_MESSAGES = {
    'dm-ada': [
      { id: 'da1', author: 'ada',  at: t(1, 0),  kind: 'text', text: "btw the voice-dock spec — should i fork off main or the design-tokens branch?" },
      { id: 'da2', author: 'thim', at: t(0,55),  kind: 'text', text: "off main. design-tokens is going to be rebased into oblivion later this week" },
      { id: 'da3', author: 'ada',  at: t(0,52),  kind: 'text', text: "👍 makes sense",
        reactions: [{ e: '👍', n: 1, mine: false }] },
      { id: 'da4', author: 'ada',  at: t(0,45),  kind: 'text', text: "im going to start with the bottom dock since that's the messiest. then bubble up to the voice card layout." },
      { id: 'da5', author: 'thim', at: t(0,40),  kind: 'text', text: "perfect. keep an eye on the audio meter — it's currently doing 1Hz polling. should be ~4Hz minimum or speaking detection lags on slow networks." },
      { id: 'da6', author: 'ada',  at: t(0,30),  kind: 'text', text: "sven's PR fixes that already?" },
      { id: 'da7', author: 'thim', at: t(0,28),  kind: 'text', text: "yes — 250ms interval. should land tonight, then you can build on top" },
      { id: 'da8', author: 'ada',  at: t(0,15),  kind: 'text', text: "k. one more — for the picture-in-picture during screen-share, do we have a webrtc constraint already or do i need to add one?" },
      { id: 'da9', author: 'thim', at: t(0,10),  kind: 'text', text: "client-side only for now. the SFU just forwards what it gets — PiP is a UI concept." },
      { id: 'da10',author: 'ada',  at: t(0, 6),  kind: 'text', text: "got it" },
      { id: 'da11',author: 'ada',  at: t(0, 5),  kind: 'text', text: "ok pushing in a sec" },
    ],
    'dm-mira': [
      { id: 'dm1', author: 'mira', at: t(3, 0),  kind: 'text', text: "got 5 min later for the channel-list mock?" },
      { id: 'dm2', author: 'thim', at: t(2,50),  kind: 'text', text: "after standup, 11:30?" },
      { id: 'dm3', author: 'mira', at: t(2,30),  kind: 'text', text: "🛠" },
    ],
    'dm-grp': [
      { id: 'g1', author: 'ola', at: t(2, 0),  kind: 'text', text: "v0.4.2-nightly artifact uploaded · sha256 c0ffee…1234" },
      { id: 'g2', author: 'ben', at: t(1,45),  kind: 'text', text: "running the upgrade on the staging LXC now" },
      { id: 'g3', author: 'ola', at: t(1,15),  kind: 'system', text: "ola pinned the release checklist", meta: 'release-v0.4.2.md' },
      { id: 'g4', author: 'ben', at: t(1,12),  kind: 'text', text: "atomic-swap worked, service healthy after 8s" },
      { id: 'g5', author: 'ola', at: t(1,10),  kind: 'text', text: "builds green" },
    ],
  };

  const THREAD_REPLIES = {
    m7: [
      { id: 't1', author: 'ada',  at: t(3, 30), text: "hmm. valid. but how do users know which kanals are e2e-only then?" },
      { id: 't2', author: 'mira', at: t(3, 25), text: "the shield badge in the header handles that already. row-level is redundant." },
      { id: 't3', author: 'thim', at: t(3, 20), text: "agree. visual hierarchy: shield in header, no clutter per-row." },
      { id: 't4', author: 'ada',  at: t(3, 10), text: "ok let's prototype both and ship the cleaner one",
        reactions: [{ e: '👍', n: 2, mine: false }] },
      { id: 't5', author: 'juno', at: t(2, 50), text: "i'll mock the no-lock version. you take the colored-dot one?" },
      { id: 't6', author: 'thim', at: t(2, 30), text: "deal" },
      { id: 't7', author: 'mira', at: t(2,  5), text: "files in figma — last frame under 'channel-list refinements'" },
    ],
  };

  return { SERVERS, MEMBERS, byId, CHANNELS, MESSAGES, DMS, DM_MESSAGES, THREAD_REPLIES };
})();
