// Dilla onboarding wizard.
// 5-step flow: connect → identity → keygen → safety number → done.

const { useState: useO, useEffect: useOE, useRef: useOR } = React;

const STEPS = [
{ id: 'connect', label: 'Connect' },
{ id: 'identity', label: 'Identity' },
{ id: 'keygen', label: 'Keys' },
{ id: 'safety', label: 'Safety' },
{ id: 'done', label: 'Done' }];


function Onboarding() {
  const [stepIdx, setStepIdx] = useO(0);
  const [server, setServer] = useO('http://localhost:8080');
  const [bootstrap, setBootstrap] = useO('');
  const [team, setTeam] = useO('');
  const [username, setUsername] = useO('');
  const [passphrase, setPassphrase] = useO('');
  const [showPass, setShowPass] = useO(false);
  const [connecting, setConnecting] = useO(false);

  function next() {setStepIdx((i) => Math.min(STEPS.length - 1, i + 1));}
  function back() {setStepIdx((i) => Math.max(0, i - 1));}

  const step = STEPS[stepIdx];

  return (
    <div className="onb-shell">
      <div className="onb-bg" />
      <header className="onb-header">
        <div className="onb-logo">
          <span className="onb-logo-mark">D</span>
          <span className="onb-logo-text">DILLA</span>
          <span className="onb-logo-caret" />
        </div>
        <div className="onb-keybinds">
          <span><kbd>esc</kbd> cancel</span>
          <span><kbd>↵</kbd> continue</span>
        </div>
      </header>

      <main className="onb-main">
        <ol className="onb-steps">
          {STEPS.map((s, i) =>
          <li key={s.id}
          className={
          'onb-step' + (
          i === stepIdx ? ' active' : '') + (
          i < stepIdx ? ' done' : '')}>
              <span className="onb-step-num">{String(i + 1).padStart(2, '0')}</span>
              <span className="onb-step-label">{s.label}</span>
            </li>
          )}
        </ol>

        <div className="onb-card">
          {step.id === 'connect' &&
          <ConnectStep
            server={server} setServer={setServer}
            bootstrap={bootstrap} setBootstrap={setBootstrap}
            team={team} setTeam={setTeam}
            connecting={connecting} setConnecting={setConnecting}
            onNext={next} />

          }
          {step.id === 'identity' &&
          <IdentityStep
            username={username} setUsername={setUsername}
            passphrase={passphrase} setPassphrase={setPassphrase}
            showPass={showPass} setShowPass={setShowPass}
            team={team || 'Berralitos'}
            onBack={back} onNext={next} />

          }
          {step.id === 'keygen' &&
          <KeyGenStep
            username={username}
            passphrase={passphrase}
            onDone={next} />

          }
          {step.id === 'safety' &&
          <SafetyStep onBack={back} onNext={next} />
          }
          {step.id === 'done' &&
          <DoneStep
            username={username || 'thim'}
            team={team || 'Berralitos'} />

          }
        </div>
      </main>

      <footer className="onb-footer">
        <div className="onb-status">
          <span className="onb-dot" /> waiting · step {stepIdx + 1}/{STEPS.length}
        </div>
        <a className="onb-skip" href="Dilla Mesh.html">skip to chat →</a>
      </footer>
    </div>);

}

// ───────── Step 1: Connect ─────────
function ConnectStep({ server, setServer, bootstrap, setBootstrap, team, setTeam, connecting, setConnecting, onNext }) {
  const [mode, setMode] = useO('bootstrap'); // 'bootstrap' | 'invite' | 'existing'
  const [log, setLog] = useO([]);

  function connect() {
    setConnecting(true);
    setLog([]);
    // If token is the demo "invalid" value, simulate a failure path.
    const fail = (mode === 'bootstrap' || mode === 'invite') && /invalid|bad|expired/i.test(bootstrap);
    const sequence = fail ? [
      { ms: 100, line: `connecting to ${server}…` },
      { ms: 350, line: 'tls handshake · ok' },
      { ms: 250, line: 'GET /api/v1/version → {"version":"0.4.2"}' },
      { ms: 300, line: mode === 'bootstrap' ? 'POST /api/v1/bootstrap · 410 Gone' : 'POST /api/v1/invite · 401 Unauthorized', err: true },
      { ms: 200, line: mode === 'bootstrap' ? '✗ bootstrap already used (admin already enrolled)' : '✗ invite token revoked or expired', err: true },
    ] : [
      { ms: 100, line: `connecting to ${server}…` },
      { ms: 350, line: 'tls handshake · ok' },
      { ms: 250, line: 'GET /api/v1/version → {"version":"0.4.2"}' },
      { ms: 200, line: 'GET /api/v1/team → "Berralitos"' },
      { ms: 250, line: mode === 'bootstrap' ? 'bootstrap token valid — admin enrollment' : mode === 'invite' ? 'invite token valid — member enrollment' : 'identity not yet bound — register required' },
      { ms: 150, line: 'ready.' },
    ];
    let acc = 0;
    sequence.forEach((s, i) => {
      acc += s.ms;
      setTimeout(() => {
        setLog(prev => [...prev, s]);
        if (i === sequence.length - 1) {
          if (fail) {
            setConnecting(false);
          } else {
            setTeam('Berralitos');
            setTimeout(() => { setConnecting(false); onNext(); }, 500);
          }
        }
      }, acc);
    });
  }

  return (
    <>
      <h1 className="onb-title">Connect to a Dilla server</h1>
      <p className="onb-blurb">Run <code>./dilla-server</code> on your own infrastructure, then paste the URL it printed on first boot. Or use a bootstrap link from your admin.</p>

      <div className="onb-seg">
        <button className={mode === 'bootstrap' ? 'on' : ''} onClick={() => setMode('bootstrap')}>I have a bootstrap link</button>
        <button className={mode === 'invite' ? 'on' : ''} onClick={() => setMode('invite')}>I have an invite</button>
        <button className={mode === 'existing' ? 'on' : ''} onClick={() => setMode('existing')}>Already enrolled</button>
      </div>

      <div className="onb-field">
        <label>Server URL</label>
        <input type="text" value={server} onChange={(e) => setServer(e.target.value)}
        placeholder="http://localhost:8080" />
      </div>

      {(mode === 'bootstrap' || mode === 'invite') &&
      <div className="onb-field">
          <label>{mode === 'bootstrap' ? 'Bootstrap token' : 'Invite token'}</label>
          <input type="text" value={bootstrap} onChange={(e) => setBootstrap(e.target.value)}
        placeholder={mode === 'bootstrap' ? 'abc123def456…' : 'inv-4f7a-9c12'} />
          <div className="onb-hint">{mode === 'bootstrap' ?
          'One-time link from your server\'s first-run output. Becomes invalid after the admin registers.' :
          'A reusable or one-time link generated from Team Settings → Invites.'}</div>
        </div>
      }

      {log.length > 0 &&
      <pre className="onb-log">
          {log.map((l, i) =>
        <div key={i} className={'onb-log-line' + (l.err ? ' err' : '')}>
              <span className={'onb-log-prompt' + (l.err ? ' err' : '')}>{l.err ? '✗' : '›'}</span> {l.line}
            </div>
        )}
          {connecting && <div className="onb-log-line"><span className="onb-log-cursor">_</span></div>}
        </pre>
      }

      {!connecting && log.some(l => l.err) && (
        <div className="onb-callout" style={{ borderLeftColor: 'var(--danger)', background: 'color-mix(in oklab, var(--danger) 8%, transparent)' }}>
          <strong style={{ color: 'var(--danger)' }}>Token rejected.</strong> Ask the admin to generate a fresh link, or try the "Already enrolled" option if your identity is already bound to this team.
        </div>
      )}

      <div className="onb-actions">
        <span />
        <button className="onb-btn primary"
        disabled={connecting || (mode === 'bootstrap' || mode === 'invite') && !bootstrap}
        onClick={connect}>
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
      </div>
    </>);

}

// ───────── Step 2: Identity ─────────
function IdentityStep({ username, setUsername, passphrase, setPassphrase, showPass, setShowPass, team, onBack, onNext }) {
  const [keyProtect, setKeyProtect] = useO('passphrase'); // 'passphrase' | 'hardware' | 'both'
  const [hwConfirmed, setHwConfirmed] = useO(false);
  const [hwTapping, setHwTapping] = useO(false);

  // Persist the chosen protection method to a window global so KeyGenStep can read it.
  useOE(() => {
    window.__DILLA_KEY_PROTECT = keyProtect;
    window.__DILLA_HW_CONFIRMED = hwConfirmed;
  }, [keyProtect, hwConfirmed]);

  function tapKey() {
    setHwTapping(true);
    setTimeout(() => {
      setHwTapping(false);
      setHwConfirmed(true);
    }, 1400);
  }

  const strength = passphraseStrength(passphrase);
  const passOk = strength.score >= 2;
  const hwOk = hwConfirmed;
  const protectionOk =
  keyProtect === 'passphrase' ? passOk :
  keyProtect === 'hardware' ? hwOk :
  passOk && hwOk;
  const ok = username.length >= 2 && protectionOk;

  return (
    <>
      <h1 className="onb-title">Create your identity</h1>
      <p className="onb-blurb">Joining <strong>{team}</strong>. No password is sent to the server — you authenticate by signing challenges with a private key generated on this device.</p>

      <div className="onb-field">
        <label>Username</label>
        <input type="text" value={username} onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
        placeholder="thim" autoFocus />
        <div className="onb-hint">Lowercase letters, numbers, _, -. Visible to your team.</div>
      </div>

      <div className="onb-field">
        <label>Protect this device's private key with</label>
        <div className="onb-seg onb-seg-protect">
          <button className={keyProtect === 'passphrase' ? 'on' : ''} onClick={() => setKeyProtect('passphrase')}>Passphrase</button>
          <button className={keyProtect === 'hardware' ? 'on' : ''} onClick={() => setKeyProtect('hardware')} style={{ width: "190px" }}>Hardware key</button>
          <button className={keyProtect === 'both' ? 'on' : ''} onClick={() => setKeyProtect('both')}>Both</button>
        </div>
        <div className="onb-hint">
          {keyProtect === 'passphrase' && 'Argon2id-derived AES-256-GCM key seals your private key on disk.'}
          {keyProtect === 'hardware' && 'Any WebAuthn authenticator works — hardware keys (YubiKey, Titan), platform biometrics (Touch ID, Windows Hello), or passkey managers (1Password, Proton Pass, Bitwarden, iCloud Keychain). Manager-stored passkeys sync your Dilla identity across all your devices via their E2E sync.'}
          {keyProtect === 'both' && 'Defence in depth — hardware key for daily use, passphrase as recovery if the key is lost.'}
        </div>
      </div>

      {(keyProtect === 'passphrase' || keyProtect === 'both') &&
      <div className="onb-field">
          <label>Passphrase
            <button className="onb-link" onClick={() => setShowPass((v) => !v)}>{showPass ? 'hide' : 'show'}</button>
          </label>
          <input type={showPass ? 'text' : 'password'} value={passphrase}
        onChange={(e) => setPassphrase(e.target.value)}
        placeholder="something long and memorable" />
          <div className="onb-strength">
            <div className="onb-strength-bars">
              {[0, 1, 2, 3].map((i) =>
            <span key={i} className={'onb-sb' + (i < strength.score ? ' on' : '')}
            style={{ background: i < strength.score ? strength.color : undefined }} />
            )}
            </div>
            <span className="onb-strength-label">{strength.label}</span>
          </div>
          <div className="onb-hint">Dilla never sees it — losing it locks you out permanently.</div>
        </div>
      }

      {(keyProtect === 'hardware' || keyProtect === 'both') &&
      <div className="onb-field">
          <label>{keyProtect === 'both' ? 'Hardware key (primary)' : 'Hardware key'}</label>
          <div className="onb-auth-chips">
            <span className="onb-chip"><b>USB</b> YubiKey · Titan</span>
            <span className="onb-chip"><b>OS</b> Touch ID · Windows Hello</span>
            <span className="onb-chip"><b>Passkey</b> 1Password · Proton Pass · Bitwarden · iCloud</span>
          </div>
          <HardwareTap
          confirmed={hwConfirmed}
          tapping={hwTapping}
          onTap={tapKey}
          onReset={() => setHwConfirmed(false)} />
        
        </div>
      }

      <div className="onb-actions">
        <button className="onb-btn" onClick={onBack}>Back</button>
        <button className="onb-btn primary" disabled={!ok} onClick={onNext}>Generate keys</button>
      </div>
    </>);

}

function HardwareTap({ confirmed, tapping, onTap, onReset }) {
  if (confirmed) {
    return (
      <div className="onb-hw onb-hw-confirmed">
        <div className="onb-hw-icon onb-hw-check">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M5 12.5l4 4 10-10" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="onb-hw-body">
          <div className="onb-hw-title">Bound to YubiKey 5C NFC</div>
          <div className="onb-hw-sub">serial 12345678 · attestation: yubico · firmware 5.4.3</div>
        </div>
        <button className="onb-btn" onClick={onReset}>Use a different key</button>
      </div>);

  }
  return (
    <div className={'onb-hw' + (tapping ? ' onb-hw-tapping' : '')}>
      <div className="onb-hw-icon">
        <div className="onb-hw-pulse" />
        <div className="onb-hw-pulse onb-hw-pulse-2" />
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
          <rect x="3" y="9" width="14" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
          <rect x="17" y="10.5" width="4" height="3" rx="0.6" stroke="currentColor" strokeWidth="1.6" />
          <line x1="6" y1="9" x2="6" y2="6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <line x1="10" y1="9" x2="10" y2="6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <line x1="14" y1="9" x2="14" y2="6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="10" cy="12" r="1" fill="currentColor" />
        </svg>
      </div>
      <div className="onb-hw-body">
        <div className="onb-hw-title">{tapping ? 'Authenticating…' : 'Tap your security key'}</div>
        <div className="onb-hw-sub">{tapping ? 'Hold steady — generating WebAuthn credential' : 'Picks any registered authenticator on this device'}</div>
      </div>
      <button className="onb-btn primary" onClick={onTap} disabled={tapping}>
        {tapping ? '…' : 'Tap'}
      </button>
    </div>);

}

function passphraseStrength(p) {
  if (!p) return { score: 0, label: 'empty', color: 'var(--fg-3)' };
  let s = 0;
  if (p.length >= 8) s++;
  if (p.length >= 14) s++;
  if (p.length >= 20) s++;
  if (/[A-Z]/.test(p) && /[a-z]/.test(p) && /[0-9]/.test(p)) s++;
  s = Math.min(4, s);
  const labels = ['too short', 'weak', 'fair', 'strong', 'excellent'];
  const colors = ['var(--danger)', 'var(--danger)', 'var(--warn)', 'var(--accent)', 'var(--accent)'];
  return { score: s, label: labels[s], color: colors[s] };
}

// ───────── Step 3: Key generation ─────────
function KeyGenStep({ username, passphrase, onDone }) {
  const [lines, setLines] = useO([]);
  useOE(() => {
    const protect = window.__DILLA_KEY_PROTECT || 'passphrase';
    const baseSeq = [
    { ms: 200, line: '$ dilla identity create' },
    { ms: 250, line: 'generating ed25519 keypair…' },
    { ms: 350, line: '  pub  ed25519:8e1d3c447a529bf622d14e08af31…' },
    { ms: 250, line: '  priv [encrypted]' },
    { ms: 300, line: `signing nonce as "${username || 'thim'}"…` },
    { ms: 250, line: '  signature ok · server returns jwt' }];

    const passphraseSeq = [
    { ms: 400, line: 'deriving keystore key (argon2id)…' },
    { ms: 300, line: '  m=65536 · t=3 · p=4 · salt=…' },
    { ms: 300, line: 'sealing private key with aes-256-gcm…' },
    { ms: 250, line: 'writing keystore to ~/.dilla/keys/identity.bin' }];

    const hardwareSeq = [
    { ms: 400, line: 'binding to webauthn credential…' },
    { ms: 300, line: '  rp.id = dilla.gbg-1.local' },
    { ms: 300, line: '  attestation: packed · authenticator: yubico-yubikey-5c-nfc' },
    { ms: 300, line: 'requesting prf extension for key wrap…' },
    { ms: 250, line: '  prf evaluated · 32 bytes derived' },
    { ms: 300, line: 'sealing private key with hardware-derived wrap key…' },
    { ms: 250, line: 'writing sealed blob to ~/.dilla/keys/identity.bin' }];

    const bothSeq = [
    { ms: 400, line: 'binding to webauthn credential (primary)…' },
    { ms: 300, line: '  attestation ok · prf 32 bytes derived' },
    { ms: 350, line: 'deriving recovery key (argon2id, m=65536 t=3 p=4)…' },
    { ms: 300, line: 'sealing private key (hardware wrap)…' },
    { ms: 250, line: 'sealing recovery copy (passphrase wrap)…' },
    { ms: 250, line: 'writing two sealed blobs to ~/.dilla/keys/' }];

    const tailSeq = [
    { ms: 300, line: 'publishing prekey bundle for X3DH…' },
    { ms: 300, line: '  10 one-time prekeys uploaded' },
    { ms: 300, line: 'identity created.' }];


    const seq = baseSeq.
    concat(protect === 'hardware' ? hardwareSeq : protect === 'both' ? bothSeq : passphraseSeq).
    concat(tailSeq);

    let acc = 0;
    const timeouts = [];
    seq.forEach((s, i) => {
      acc += s.ms;
      timeouts.push(setTimeout(() => {
        setLines((prev) => [...prev, s]);
        if (i === seq.length - 1) timeouts.push(setTimeout(onDone, 700));
      }, acc));
    });
    return () => timeouts.forEach(clearTimeout);
  }, []);

  return (
    <>
      <h1 className="onb-title">Generating keys…</h1>
      <p className="onb-blurb">Creating an ed25519 identity and sealing it with your passphrase. This happens on your device — no key material ever leaves it.</p>

      <pre className="onb-log onb-log-big">
        {lines.map((l, i) =>
        <div key={i} className="onb-log-line">
            <span className="onb-log-prompt">{l.line.startsWith('$') ? '' : '›'}</span> {l.line}
          </div>
        )}
        <div className="onb-log-line"><span className="onb-log-cursor">_</span></div>
      </pre>
    </>);

}

// ───────── Step 4: Safety number ─────────
function SafetyStep({ onBack, onNext }) {
  const fp = '4f7a 9c12  8d3b e5f0  17ac 6b29  0e88 4173  cf2a 9b06  8d51 743f';
  // Generate a deterministic QR-like SVG placeholder
  const grid = useOR(null);
  if (!grid.current) {
    const g = [];
    for (let y = 0; y < 21; y++) {
      const row = [];
      for (let x = 0; x < 21; x++) {
        // deterministic noise based on x,y
        const v = (x * 31 + y * 17 + x * y * 5 ^ 0xa5) & 1;
        row.push(v);
      }
      g.push(row);
    }
    grid.current = g;
  }

  return (
    <>
      <h1 className="onb-title">Your safety number</h1>
      <p className="onb-blurb">Compare this number out-of-band with people you message to verify their device, not just their account. Anyone can claim to be "ada" — but only the real ada has the matching number.</p>

      <div className="onb-safety">
        <div className="onb-qr">
          <svg viewBox="0 0 21 21" width="156" height="156" shapeRendering="crispEdges">
            <rect width="21" height="21" fill="var(--bg)" />
            {grid.current.map((row, y) =>
            row.map((v, x) => v ? <rect key={x + 'x' + y} x={x} y={y} width="1" height="1" fill="var(--accent)" /> : null)
            )}
            {/* Three QR-style corner markers */}
            <CornerMarker x={0} y={0} />
            <CornerMarker x={14} y={0} />
            <CornerMarker x={0} y={14} />
          </svg>
        </div>
        <div className="onb-fp">
          <div className="onb-fp-label">FINGERPRINT</div>
          <div className="onb-fp-text">{fp}</div>
          <div className="onb-fp-actions">
            <button className="onb-btn">Copy</button>
            <button className="onb-btn">Print</button>
            <button className="onb-btn">Save QR</button>
          </div>
        </div>
      </div>

      <div className="onb-callout">
        <strong>Optional — but recommended.</strong> If you skip this, encryption still works; you just can't catch a server impersonating someone.
      </div>

      <div className="onb-actions">
        <button className="onb-btn" onClick={onBack}>Back</button>
        <button className="onb-btn primary" onClick={onNext}>I've saved it</button>
      </div>
    </>);

}
function CornerMarker({ x, y }) {
  return (
    <g>
      <rect x={x} y={y} width="7" height="7" fill="var(--accent)" />
      <rect x={x + 1} y={y + 1} width="5" height="5" fill="var(--bg)" />
      <rect x={x + 2} y={y + 2} width="3" height="3" fill="var(--accent)" />
    </g>);

}

// ───────── Step 5: Done ─────────
function DoneStep({ username, team }) {
  return (
    <>
      <h1 className="onb-title">You're in.</h1>
      <p className="onb-blurb">Identity created and bound to <strong>{team}</strong> on this device. Move the keystore file in <code>~/.dilla/</code> to sign in from another machine.</p>

      <div className="onb-summary">
        <div className="onb-sum-row">
          <span className="onb-sum-k">handle</span>
          <span className="onb-sum-v">{username}</span>
        </div>
        <div className="onb-sum-row">
          <span className="onb-sum-k">team</span>
          <span className="onb-sum-v">{team}</span>
        </div>
        <div className="onb-sum-row">
          <span className="onb-sum-k">role</span>
          <span className="onb-sum-v">admin <span className="onb-pill">first user</span></span>
        </div>
        <div className="onb-sum-row">
          <span className="onb-sum-k">e2e</span>
          <span className="onb-sum-v">signal-protocol · x3dh + double-ratchet</span>
        </div>
        <div className="onb-sum-row">
          <span className="onb-sum-k">node</span>
          <span className="onb-sum-v">gbg-1.dilla.local · solo</span>
        </div>
      </div>

      <div className="onb-actions">
        <span />
        <a className="onb-btn primary" href="Dilla Mesh.html">Open Dilla →</a>
      </div>
    </>);

}

window.Onboarding = Onboarding;