// Tier-2 extras: notification toasts, first-run splash, incoming-call ring,
// safety-number compare flow, federation join wizard.
// All small, theme-aware, listen for window events.

const { useState: useT2, useEffect: useT2E, useRef: useT2R } = React;

// ───────── Notification toasts ─────────
function NotificationStack({ teaserOnly = false }) {
  const [toasts, setToasts] = useT2([]);
  useT2E(() => {
    function add(e) {
      const id = 't-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
      const t = { id, ...e.detail };
      setToasts(prev => [...prev.slice(-3), t]);
      const dur = e.detail.duration || 5500;
      setTimeout(() => setToasts(prev => prev.filter(x => x.id !== id)), dur);
    }
    window.addEventListener('dilla:notify', add);
    return () => window.removeEventListener('dilla:notify', add);
  }, []);

  function dismiss(id) { setToasts(prev => prev.filter(x => x.id !== id)); }
  return (
    <div className="notify-stack">
      {toasts.length >= 4 && (
        <div className="notify-overflow">
          <span>{toasts.length} active · </span>
          <button onClick={() => setToasts([])}>clear all</button>
        </div>
      )}
      {toasts.map(t => (
        <div key={t.id} className={'notify-toast' + (t.mention ? ' mention' : '') + (t.channel ? ' clickable' : '')}
             onClick={() => {
               if (t.channel) {
                 const chMap = { design: 'design', general: 'general', dev: 'dev', mesh: 'mesh', random: 'random', 'voice-lounge': 'voice', 'mesh-status': 'mesh' };
                 const id = chMap[t.channel] || t.channel;
                 window.dispatchEvent(new CustomEvent('dilla:pickchannel', { detail: id }));
               }
               dismiss(t.id);
             }}>
          <div className="nt-icon">
            {t.kind === 'mention' ? '@' : t.kind === 'voice' ? '◉' : '●'}
          </div>
          <div className="nt-body">
            <div className="nt-head">
              <span className="nt-team">{t.team || 'Berralitos'}</span>
              {t.channel && <><span className="nt-sep">·</span><span className="nt-channel">#{t.channel}</span></>}
            </div>
            {teaserOnly ? (
              <div className="nt-text nt-teaser">
                <span className="nt-lock">🔒</span> {t.author} sent an encrypted message
              </div>
            ) : (
              <>
                <div className="nt-author">{t.author}</div>
                <div className="nt-text">{t.text}</div>
              </>
            )}
          </div>
          <button className="nt-close" onClick={() => dismiss(t.id)}>×</button>
        </div>
      ))}
    </div>
  );
}

// One-shot demo: trigger a notification ~3s after mount.
function notifyDemo() {
  const demos = [
    { kind: 'mention', mention: true, channel: 'dev',  author: 'ada',  text: '@thim can you take another pass on the X3DH key bundle endpoint?' },
    { kind: 'message',                channel: 'design', author: 'mira', text: 'pushed the new channel-list mock — last 4 frames in figma' },
    { kind: 'voice',                  channel: 'voice-lounge', author: 'ada', text: 'started a voice call · join?' },
    { kind: 'message',                channel: 'general', author: 'ben',  text: 'lunch ☕' },
  ];
  let i = 0;
  function fire() {
    const d = demos[i++ % demos.length];
    window.dispatchEvent(new CustomEvent('dilla:notify', { detail: d }));
  }
  // first toast after a beat
  setTimeout(fire, 2200);
}

// ───────── First-run splash ─────────
function FirstRunSplash({ onDone }) {
  const [phase, setPhase] = useT2(0);
  const phases = [
    'connecting to gbg-1.dilla.local…',
    'unsealing keystore · argon2id',
    'verifying jwt · ed25519',
    'subscribing to channels · 5',
    'syncing mesh state · 2 peers',
    'ready.',
  ];
  useT2E(() => {
    const id = setInterval(() => {
      setPhase(p => {
        if (p + 1 >= phases.length) {
          clearInterval(id);
          setTimeout(onDone, 350);
          return p + 1;
        }
        return p + 1;
      });
    }, 180);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="splash">
      <div className="splash-bg" />
      <div className="splash-card">
        <div className="splash-logo">
          <span className="splash-mark">D</span>
          <span className="splash-name">DILLA</span>
          <span className="splash-caret" />
        </div>
        <div className="splash-log">
          {phases.slice(0, phase + 1).map((line, i) => (
            <div key={i} className="splash-line">
              <span className="splash-prompt">{i < phase ? '✓' : '›'}</span> {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ───────── Incoming voice call ─────────
function IncomingCall({ call, onAccept, onDecline }) {
  useT2E(() => {
    if (!call) return;
    function onKey(e) {
      if (e.key === 'Escape') onDecline();
      if (e.key === 'Enter')  onAccept();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [call, onAccept, onDecline]);
  if (!call) return null;
  const m = window.MOCK_DATA.byId[call.from];
  if (!m) return null;
  return (
    <div className="ring-overlay">
      <div className="ring-card">
        <div className="ring-eyebrow">
          <span className="ring-dot" /> incoming · voice
        </div>
        <div className="ring-avatar" style={{ background: m.color }}>
          <span className="ring-pulse" />
          <span className="ring-pulse ring-pulse-2" />
          {m.initials}
        </div>
        <div className="ring-name">{m.name}</div>
        <div className="ring-sub">{call.kind === 'video' ? 'wants to start a video call' : 'is calling you'} · SRTP · opus</div>
        <div className="ring-actions">
          <button className="ring-btn decline" onClick={onDecline} title="Decline (esc)">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
              <path d="M3 7c2-2 8-2 10 0v2l-3 1V8.5c-1-.5-3-.5-4 0V10L3 9V7z" fill="currentColor" transform="rotate(135 8 8)" />
            </svg>
          </button>
          <button className="ring-btn accept" onClick={onAccept} title="Accept (↵)">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
              <path d="M3 7c2-2 8-2 10 0v2l-3 1V8.5c-1-.5-3-.5-4 0V10L3 9V7z" fill="currentColor" />
            </svg>
          </button>
        </div>
        <div className="ring-keybinds">
          <span><kbd>↵</kbd> accept</span>
          <span><kbd>esc</kbd> decline</span>
        </div>
      </div>
    </div>
  );
}

// ───────── Safety number compare ─────────
function SafetyCompare({ contactId, onClose }) {
  const [verified, setVerified] = useT2(false);
  const [comparing, setComparing] = useT2(false);
  if (!contactId) return null;
  const m = window.MOCK_DATA.byId[contactId];
  if (!m) return null;
  const fps = (window.MeshChrome && window.MeshChrome.FINGERPRINTS) || {};
  const yours = '4f7a 9c12  8d3b e5f0  17ac 6b29  0e88 4173  cf2a 9b06  8d51 743f';
  const theirs = fps[contactId] || '0000 0000  0000 0000  0000 0000  0000 0000  0000 0000  0000 0000';
  // Pair the numbers into 12-block pairs for side-by-side comparison
  const yp = yours.split(/\s+/).filter(Boolean);
  const tp = theirs.split(/\s+/).filter(Boolean);
  while (tp.length < yp.length) tp.push('····');
  return (
    <div className="sc-overlay" onClick={onClose}>
      <div className="sc-dialog" onClick={e => e.stopPropagation()}>
        <header className="sc-head">
          <h2>Verify safety number</h2>
          <button className="sc-x" onClick={onClose}>×</button>
        </header>
        <p className="sc-blurb">Read this number out loud to <strong>{m.name}</strong> (in person, on a separate call, or via a different channel) and check that yours and theirs match exactly. Then mark verified.</p>
        <div className="sc-pair">
          <div className="sc-side">
            <div className="sc-side-head">
              <div className="sc-side-avatar" style={{ background: '#F39E2B' }}>TH</div>
              <span>you</span>
            </div>
            <div className="sc-number">
              {yp.map((b, i) => <span key={i} className="sc-block">{b}</span>)}
            </div>
          </div>
          <div className="sc-side">
            <div className="sc-side-head">
              <div className="sc-side-avatar" style={{ background: m.color }}>{m.initials}</div>
              <span>{m.name}</span>
            </div>
            <div className="sc-number">
              {tp.map((b, i) => <span key={i} className={'sc-block' + (comparing ? ' sc-block-pulse' : '')}>{b}</span>)}
            </div>
          </div>
        </div>
        {verified ? (
          <div className="sc-verified">
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="7" stroke="var(--accent)" strokeWidth="1.5" />
              <path d="M5 8l2 2 4-4" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>Verified · safety number recorded for this device</span>
          </div>
        ) : (
          <div className="sc-actions">
            <button className="sc-btn" onClick={() => { setComparing(true); setTimeout(() => setComparing(false), 800); }}>Highlight blocks</button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="sc-btn danger" onClick={onClose}>Doesn't match</button>
              <button className="sc-btn primary" onClick={() => setVerified(true)}>Mark verified</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ───────── Federation: add peer wizard ─────────
function AddPeerWizard({ open, onClose }) {
  const [step, setStep] = useT2(0);
  const [mode, setMode] = useT2('have'); // 'have' | 'create'
  const [token, setToken] = useT2('');
  const [log, setLog] = useT2([]);
  useT2E(() => {
    if (!open) { setStep(0); setMode('have'); setToken(''); setLog([]); }
  }, [open]);
  useT2E(() => {
    if (step !== 2) return;
    const seq = [
      'parsing join token · hmac ok',
      'resolving rust.berra.io · 167.235.21.144:8081',
      'opening federation socket · tls 1.3',
      'exchanging memberlist gossip · 12 alive peers',
      'syncing channels (5) · messages (412)',
      'syncing roles (3) · presence (8 online)',
      'lamport clock synced · 12944',
      'mesh ok.',
    ];
    let acc = 0;
    const timeouts = [];
    seq.forEach((line, i) => {
      acc += 320;
      timeouts.push(setTimeout(() => {
        setLog(prev => [...prev, line]);
        if (i === seq.length - 1) timeouts.push(setTimeout(() => setStep(3), 600));
      }, acc));
    });
    return () => timeouts.forEach(clearTimeout);
  }, [step]);
  if (!open) return null;
  return (
    <div className="apw-overlay" onClick={onClose}>
      <div className="apw" onClick={e => e.stopPropagation()}>
        <header className="apw-head">
          <h2>Add a peer node</h2>
          <button className="sc-x" onClick={onClose}>×</button>
        </header>
        <div className="apw-steps">
          {['Token','Confirm','Handshake','Done'].map((s, i) => (
            <span key={s} className={'apw-step' + (i === step ? ' active' : '') + (i < step ? ' done' : '')}>
              <span className="apw-step-n">{i + 1}</span> {s}
            </span>
          ))}
        </div>

        {step === 0 && (
          <>
            <div className="apw-seg" style={{ marginBottom: 16 }}>
              <button className={mode === 'have' ? 'on' : ''} onClick={() => setMode('have')}>I have a token</button>
              <button className={mode === 'create' ? 'on' : ''} onClick={() => setMode('create')}>Generate one for a peer</button>
            </div>
            {mode === 'have' ? (
              <>
                <p className="sc-blurb">Paste the join command from the other admin. It's HMAC-signed with the cluster secret so other peers can't impersonate this one.</p>
                <textarea className="apw-input" rows={3} placeholder="dilla-server --join-token eyJraWQiOiJoczI1Ni…"
                          value={token} onChange={e => setToken(e.target.value)} />
                <div className="apw-actions">
                  <span />
                  <button className="sc-btn primary" disabled={token.length < 12} onClick={() => setStep(1)}>Parse →</button>
                </div>
              </>
            ) : (
              <>
                <p className="sc-blurb">Run this on the new node's machine. The token expires in 15 minutes and is single-use.</p>
                <pre className="apw-snippet">{`dilla-server \\
  --team "Berralitos" \\
  --peers gbg-1.dilla.local:8081 \\
  --join-token eyJraWQiOiJoczI1NiIsInR5cCI6IkpXVCJ9
    .eyJpc3MiOiJnYmctMSIsImV4cCI6MTc3OTAxMjkw…
    .Aq4FZ_kQXg2vV1iJsK5JmZ1cT_R7…`}</pre>
                <div className="apw-actions">
                  <button className="sc-btn" onClick={onClose}>Cancel</button>
                  <button className="sc-btn primary">Copy command</button>
                </div>
              </>
            )}
          </>
        )}

        {step === 1 && (
          <>
            <p className="sc-blurb">Token decoded. About to add this peer to the mesh:</p>
            <div className="apw-fields">
              <div className="apw-field"><span className="apw-k">node name</span> <span>rust.berra.io</span></div>
              <div className="apw-field"><span className="apw-k">address</span> <span>167.235.21.144:8081</span></div>
              <div className="apw-field"><span className="apw-k">issued by</span> <span>ola@rust.berra.io</span></div>
              <div className="apw-field"><span className="apw-k">expires</span> <span>in 12 minutes</span></div>
              <div className="apw-field"><span className="apw-k">attestation</span> <span style={{ color: 'var(--accent)' }}>HMAC ok · ed25519 sig ok</span></div>
            </div>
            <div className="apw-callout">
              <strong>This will replicate.</strong> Channels, messages, roles, and presence will sync to the new peer. Voice audio stays on the originating node.
            </div>
            <div className="apw-actions">
              <button className="sc-btn" onClick={() => setStep(0)}>Back</button>
              <button className="sc-btn primary" onClick={() => setStep(2)}>Connect peer</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <p className="sc-blurb">Handshaking with rust.berra.io…</p>
            <pre className="onb-log onb-log-big" style={{ minHeight: 200 }}>
              {log.map((l, i) => (
                <div key={i} className="onb-log-line"><span className="onb-log-prompt">›</span> {l}</div>
              ))}
              <div className="onb-log-line"><span className="onb-log-cursor">_</span></div>
            </pre>
          </>
        )}

        {step === 3 && (
          <>
            <div className="sc-verified" style={{ margin: '12px 0 18px' }}>
              <svg width="20" height="20" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="7" stroke="var(--accent)" strokeWidth="1.5" />
                <path d="M5 8l2 2 4-4" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>rust.berra.io joined the mesh · 2/2 peers</span>
            </div>
            <div className="apw-fields">
              <div className="apw-field"><span className="apw-k">channels synced</span> <span>5</span></div>
              <div className="apw-field"><span className="apw-k">messages replicated</span> <span>412</span></div>
              <div className="apw-field"><span className="apw-k">lamport</span> <span>12944</span></div>
              <div className="apw-field"><span className="apw-k">latency</span> <span>14ms p50</span></div>
            </div>
            <div className="apw-actions">
              <span />
              <button className="sc-btn primary" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ───────── Connection banner (offline / reconnecting / mesh degraded) ─────────
function ConnectionBanner() {
  const [state, setState] = useT2(null); // null | 'offline' | 'reconnecting' | 'degraded'
  useT2E(() => {
    function on(e) { setState(e.detail); }
    window.addEventListener('dilla:connection', on);
    return () => window.removeEventListener('dilla:connection', on);
  }, []);
  if (!state) return null;
  const config = {
    offline:      { color: 'var(--danger)', text: 'You are offline. Messages will queue and send when reconnected.' },
    reconnecting: { color: 'var(--warn)',   text: 'Reconnecting to mesh… retrying with exponential backoff (next in 4s)' },
    degraded:     { color: 'var(--warn)',   text: 'Mesh degraded · rust.berra.io unreachable. Messages still saving locally and to gbg-1.' },
  };
  const c = config[state] || config.offline;
  return (
    <div className="conn-banner" style={{ background: c.color }}>
      <span className="conn-dot" />
      <span>{c.text}</span>
      <button className="conn-dismiss" onClick={() => setState(null)}>dismiss</button>
    </div>
  );
}

window.DillaExtras = {
  NotificationStack, notifyDemo,
  FirstRunSplash,
  IncomingCall,
  SafetyCompare,
  AddPeerWizard,
  ConnectionBanner,
};
