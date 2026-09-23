// MeshChrome — wraps the ChatApp with extra brutalist/terminal chrome.
// - Top bar: node identity + global mesh status + keybinds
// - Bottom status bar: lamport, peers, latency, encryption, audio mode
// - Cmd-K command palette
// - Audio level meter in the voice dock (mock animation)
// - Member node-origin badges

const { useState: useStateMC, useEffect: useEffectMC, useRef: useRefMC } = React;

// Tag members with the node they live on.
const MEMBER_NODES = {
  thim: 'gbg-1.dilla.local',
  ada: 'gbg-1.dilla.local',
  mira: 'gbg-1.dilla.local',
  ben: 'rust.berra.io',
  ola: 'rust.berra.io',
  juno: 'gbg-1.dilla.local',
  kai: 'rust.berra.io',
  sven: 'rust.berra.io',
  noa: 'gbg-1.dilla.local'
};

// Static safety numbers (would be derived from key fingerprints in real signal protocol).
const FINGERPRINTS = {
  thim: '4f7a 9c12 8d3b e5f0 17ac 6b29',
  ada: '8e1d 3c44 7a52 9bf6 22d1 4e08',
  mira: 'a013 7b88 e2cd 1f54 6c9e b370',
  ben: '6c2a 91e0 4d33 b7f8 5e10 a92c',
  ola: '0e88 4173 cf2a 9b06 8d51 743f',
  juno: 'b541 27ec 9080 3a6d ef12 c4b9',
  kai: '3d77 e119 8c40 a5b2 fb6e 0291',
  sven: 'f218 4e0a 7361 d9c5 1b08 a44e',
  noa: '99c1 b07e 2d5f 8311 ac46 7e9b'
};

// ───────── top bar ─────────
function MeshTopBar({ onCmdK, onSearch, onHelp, federated = true, degraded = false }) {
  const [, setTick] = useStateMC(0);
  useEffectMC(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  return (
    <div className="mesh-top">
      <div className="mt-left">
        <span className="mt-brand">DILLA</span>
        <span className="mt-sep">─</span>
        <span className="mt-dim">team</span> <span>BERRALITOS</span>
        <span className="mt-sep">─</span>
        <span className="mt-dim">node</span> <span>gbg-1</span>
        <span className="mt-sep">─</span>
        {federated ?
        <span className="mt-ok">● MESH OK</span> :
        <span className="mt-ok">● READY</span>}
      </div>
      <div className="mt-center">
        {time}
      </div>
      <div className="mt-right" style={{ padding: "0px" }}>
        <button className="mt-key" onClick={onCmdK}>
          <span className="mt-kbd">⌘K</span> CMD
        </button>
        <button className="mt-key" onClick={onSearch}><span className="mt-kbd">/</span> SEARCH</button>
        <button className="mt-key" onClick={onHelp}><span className="mt-kbd">?</span> HELP</button>
      </div>
    </div>);

}

// ───────── bottom status bar ─────────
function MeshBottomBar({ voiceConnection, peerStatus, federated = true, degraded = false }) {
  const [lamport, setLamport] = useStateMC(12944);
  const [latency, setLatency] = useStateMC(14);
  useEffectMC(() => {
    const id = setInterval(() => {
      setLamport((l) => l + Math.floor(Math.random() * 4));
      setLatency(() => 12 + Math.floor(Math.random() * 6));
    }, 1400);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="mesh-bottom">
      <div className="mb-chunk mb-clickable"
           title="Click for federation settings"
           onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'federation' } }))}>
        <span className="mb-k">node</span> gbg-1.dilla.local
      </div>
      {federated ?
      <>
          <div className="mb-chunk mb-clickable"
               title="Click for peer status"
               onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'federation' } }))}>
            <span className="mb-k">peers</span> {degraded
              ? <span style={{ color: 'var(--warn)', fontWeight: 600 }}>1/2 ⚠</span>
              : <span className="mb-ok">2/2 ▲</span>}
          </div>
          <div className="mb-chunk"><span className="mb-k">lamport</span> {lamport.toLocaleString()}↑</div>
          <div className="mb-chunk"><span className="mb-k">latency</span> {degraded ? '—' : latency + 'ms p50'}</div>
        </> :
      null}
      <div className="mb-chunk mb-clickable"
           title="Click for encryption details"
           onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'user', tab: 'privacy' } }))}>
        <span className="mb-k">e2e</span> SIGNAL · X3DH · AES-256-GCM
      </div>
      {voiceConnection ?
      <div className="mb-chunk mb-voice mb-clickable"
           title="Click for voice settings"
           onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'user', tab: 'voice' } }))}>
          <span className="mb-k">voice</span> SRTP · OPUS 48kHz @ 96kbps
          <AudioMeter />
        </div> :

      <div className="mb-chunk"><span className="mb-k">db</span> SQLCIPHER · AES-256</div>
      }
      <div className="mb-chunk mb-grow"></div>
      <div className="mb-chunk"><span className="mb-k">v</span> 0.4.2-nightly · build c0ffee</div>
    </div>);

}

// ───────── audio level meter ─────────
function AudioMeter() {
  const [bars, setBars] = useStateMC(() => Array(12).fill(0));
  useEffectMC(() => {
    const id = setInterval(() => {
      setBars((prev) => prev.map((_, i) => {
        // weight middle bars more
        const base = Math.sin(Date.now() / 200 + i * 0.5) * 0.5 + 0.5;
        const jitter = Math.random();
        return base * 0.6 + jitter * 0.4;
      }));
    }, 120);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="audio-meter">
      {bars.map((v, i) =>
      <span key={i} className="am-bar" style={{ opacity: 0.25 + v * 0.75, height: 4 + Math.round(v * 8) }} />
      )}
    </span>);

}

// ───────── command palette ─────────
const COMMANDS = [
{ sec: 'NAVIGATE', cmd: 'channel #design', hint: '⌘+1', shortcut: 'design' },
{ sec: 'NAVIGATE', cmd: 'channel #general', hint: '⌘+2', shortcut: 'general' },
{ sec: 'NAVIGATE', cmd: 'channel #dev', hint: '⌘+3', shortcut: 'dev' },
{ sec: 'NAVIGATE', cmd: 'channel #mesh-status', hint: '⌘+4', shortcut: 'mesh' },
{ sec: 'NAVIGATE', cmd: 'channel #voice-lounge', hint: '⌘+5', shortcut: 'voice' },
{ sec: 'VOICE', cmd: 'simulate incoming call (from ada)', hint: '', dispatch: 'dilla:incoming-call', payload: { from: 'ada', kind: 'voice' } },
{ sec: 'VOICE', cmd: 'simulate incoming call (from ben)', hint: '', dispatch: 'dilla:incoming-call', payload: { from: 'ben', kind: 'voice' } },
{ sec: 'VOICE', cmd: 'toggle mute', hint: 'M' },
{ sec: 'VOICE', cmd: 'toggle deafen', hint: 'D' },
{ sec: 'VOICE', cmd: 'disconnect', hint: '⌘+⇧+D' },
{ sec: 'FEDERATION',cmd: 'add peer node', hint: '', dispatch: 'dilla:add-peer' },
{ sec: 'FEDERATION',cmd: 'simulate peer drop (degraded)', hint: '', dispatch: 'dilla:connection', payload: 'degraded' },
{ sec: 'FEDERATION',cmd: 'simulate offline', hint: '', dispatch: 'dilla:connection', payload: 'offline' },
{ sec: 'FEDERATION',cmd: 'simulate reconnecting', hint: '', dispatch: 'dilla:connection', payload: 'reconnecting' },
{ sec: 'FEDERATION',cmd: 'show mesh status', hint: '⌘+F' },
{ sec: 'FEDERATION',cmd: 'generate join token', hint: '' },
{ sec: 'ENCRYPTION',cmd: 'verify safety number (with ada)', hint: '', dispatch: 'dilla:verify-safety', payload: 'ada' },
{ sec: 'ENCRYPTION',cmd: 'verify safety number (with mira)', hint: '', dispatch: 'dilla:verify-safety', payload: 'mira' },
{ sec: 'ENCRYPTION',cmd: 'rotate session keys', hint: '' },
{ sec: 'ENCRYPTION',cmd: 'export identity backup', hint: '' },
{ sec: 'ACCOUNT', cmd: 'set custom status', hint: '' },
{ sec: 'ACCOUNT', cmd: 'sign out', hint: '⌘+⇧+Q' },
];


function CommandPalette({ open, onClose, onPickChannel }) {
  const [q, setQ] = useStateMC('');
  const [idx, setIdx] = useStateMC(0);
  const inputRef = useRefMC(null);
  const filtered = COMMANDS.filter((c) => !q || c.cmd.toLowerCase().includes(q.toLowerCase()) || c.sec.toLowerCase().includes(q.toLowerCase()));
  useEffectMC(() => {if (open && inputRef.current) inputRef.current.focus();setIdx(0);setQ('');}, [open]);
  if (!open) return null;

  const sections = [...new Set(filtered.map((c) => c.sec))];

  function pick(c) {
    if (c.shortcut && onPickChannel) onPickChannel(c.shortcut === 'mesh' ? 'mesh' : c.shortcut);
    if (c.dispatch) {
      window.dispatchEvent(new CustomEvent(c.dispatch, { detail: c.payload }));
    }
    onClose();
  }

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-head">
          <span className="cmdk-prompt">{'>'}</span>
          <input ref={inputRef}
          className="cmdk-input"
          placeholder="type a command…"
          value={q}
          onChange={(e) => {setQ(e.target.value);setIdx(0);}}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {e.preventDefault();setIdx((i) => Math.min(filtered.length - 1, i + 1));}
            if (e.key === 'ArrowUp') {e.preventDefault();setIdx((i) => Math.max(0, i - 1));}
            if (e.key === 'Enter') {if (filtered[idx]) pick(filtered[idx]);}
          }} />
          <span className="cmdk-hint">ESC to close · ↑↓ to navigate · ↵ to run</span>
        </div>
        <div className="cmdk-list">
          {sections.map((sec) =>
          <div key={sec}>
              <div className="cmdk-sec">{sec}</div>
              {filtered.filter((c) => c.sec === sec).map((c) => {
              const i = filtered.indexOf(c);
              return (
                <div key={c.cmd}
                className={'cmdk-row' + (i === idx ? ' selected' : '')}
                onMouseEnter={() => setIdx(i)}
                onClick={() => pick(c)}>
                    <span className="cmdk-cmd">{c.cmd}</span>
                    <span className="cmdk-kbd">{c.hint}</span>
                  </div>);

            })}
            </div>
          )}
          {filtered.length === 0 && <div className="cmdk-empty">no matches</div>}
        </div>
      </div>
    </div>);

}

// ───────── search palette (opens on /) ─────────
function SearchPalette({ open, onClose, onPickChannel }) {
  const [q, setQ] = useStateMC('');
  const [idx, setIdx] = useStateMC(0);
  const inputRef = useRefMC(null);
  useEffectMC(() => {if (open && inputRef.current) inputRef.current.focus();setIdx(0);setQ('');}, [open]);

  const data = window.MOCK_DATA;
  const results = (() => {
    if (!q || q.length < 2) return [];
    const ql = q.toLowerCase();
    const hits = [];
    Object.entries(data.MESSAGES).forEach(([chId, msgs]) => {
      msgs.forEach((m) => {
        if (m.kind === 'system') return;
        const text = m.text || '';
        if (text.toLowerCase().includes(ql)) {
          hits.push({ chId, msg: m });
        }
      });
    });
    return hits.slice(0, 20);
  })();

  function highlight(text, ql) {
    const ix = text.toLowerCase().indexOf(ql.toLowerCase());
    if (ix < 0) return text;
    const start = Math.max(0, ix - 30);
    const end = Math.min(text.length, ix + ql.length + 60);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < text.length ? '…' : '';
    return [
    prefix + text.slice(start, ix),
    <mark key="m">{text.slice(ix, ix + ql.length)}</mark>,
    text.slice(ix + ql.length, end) + suffix];

  }

  function pick(r) {
    if (onPickChannel) onPickChannel(r.chId);
    onClose();
  }

  if (!open) return null;
  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk srch" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-head">
          <span className="cmdk-prompt">/</span>
          <input ref={inputRef}
          className="cmdk-input"
          placeholder="search messages across kanals…"
          value={q}
          onChange={(e) => {setQ(e.target.value);setIdx(0);}}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') {e.preventDefault();setIdx((i) => Math.min(results.length - 1, i + 1));}
            if (e.key === 'ArrowUp') {e.preventDefault();setIdx((i) => Math.max(0, i - 1));}
            if (e.key === 'Enter') {if (results[idx]) pick(results[idx]);}
          }} />
          <span className="cmdk-hint">{q.length < 2 ? 'type 2+ chars' : `${results.length} match${results.length === 1 ? '' : 'es'}`}</span>
        </div>
        <div className="cmdk-list">
          {q.length < 2 &&
          <div className="srch-tip">
              <div className="cmdk-sec">SEARCH SCOPE</div>
              <div className="srch-tip-row">all kanals · client-side · works on encrypted messages</div>
              <div className="cmdk-sec">TIPS</div>
              <div className="srch-tip-row"><kbd>from:ada</kbd> by author · <kbd>in:#dev</kbd> in channel · <kbd>has:image</kbd> with attachment</div>
            </div>
          }
          {q.length >= 2 && results.length === 0 && <div className="cmdk-empty">no matches in 5 kanals</div>}
          {results.map((r, i) => {
            const author = data.byId[r.msg.author] || { name: r.msg.author, color: '#666', initials: '??' };
            const ch = data.CHANNELS.find((c) => c.id === r.chId);
            return (
              <div key={r.msg.id}
              className={'srch-row' + (i === idx ? ' selected' : '')}
              onMouseEnter={() => setIdx(i)}
              onClick={() => pick(r)}>
                <div className="srch-meta">
                  <span className="srch-ch">#{ch ? ch.name : r.chId}</span>
                  <span className="srch-sep">·</span>
                  <span className="srch-author" style={{ color: author.color }}>{author.name}</span>
                  <span className="srch-sep">·</span>
                  <span className="srch-time">{r.msg.at.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                </div>
                <div className="srch-snippet">{highlight(r.msg.text || '', q)}</div>
              </div>);

          })}
        </div>
      </div>
    </div>);

}

window.MeshChrome = {
  MeshTopBar, MeshBottomBar, CommandPalette, SearchPalette,
  MEMBER_NODES, FINGERPRINTS
};