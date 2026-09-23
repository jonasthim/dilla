// Settings modal for Dilla. Opens as a centered overlay over the chat.
// Two entry points: the team-header cog opens Team settings,
// the user-panel cog opens User preferences.

const { useState: useStateS, useEffect: useEffectS, useRef: useRefS } = React;

const USER_TABS = [
  { id: 'account',  name: 'Account' },
  { id: 'notif',    name: 'Notifications' },
  { id: 'voice',    name: 'Voice & video' },
  { id: 'appear',   name: 'Appearance' },
  { id: 'privacy',  name: 'Privacy & encryption' },
  { id: 'keys',     name: 'Keyboard shortcuts' },
];
const TEAM_TABS = [
  { id: 'team',       name: 'Team info' },
  { id: 'invites',    name: 'Invites' },
  { id: 'roles',      name: 'Roles & permissions' },
  { id: 'federation', name: 'Federation' },
  { id: 'audit',      name: 'Audit log' },
];

function Settings({ open, mode, defaultTab, onClose }) {
  const tabs = mode === 'team' ? TEAM_TABS : USER_TABS;
  const [active, setActive] = useStateS(defaultTab || tabs[0].id);
  useEffectS(() => { if (open) setActive(defaultTab || tabs[0].id); }, [open, mode, defaultTab]);
  useEffectS(() => {
    if (!open) return;
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings" onClick={e => e.stopPropagation()}>
        <aside className="set-nav">
          <div className="set-nav-head">
            <div className="set-nav-title">{mode === 'team' ? 'Team' : 'User'}</div>
            <div className="set-nav-sub">{mode === 'team' ? 'BERRALITOS' : 'thim'}</div>
          </div>
          {tabs.map(t => (
            <button key={t.id}
                    className={'set-nav-item' + (active === t.id ? ' active' : '')}
                    onClick={() => setActive(t.id)}>
              {t.name}
            </button>
          ))}
          <div className="set-nav-foot">
            <button className="set-nav-item danger">{mode === 'team' ? 'Leave team' : 'Sign out'}</button>
          </div>
        </aside>
        <main className="set-pane">
          <header className="set-pane-head">
            <h2>{tabs.find(t => t.id === active)?.name}</h2>
            <button className="set-close" onClick={onClose} title="Close (Esc)">×</button>
          </header>
          <div className="set-body">
            {mode === 'user'  && active === 'account'   && <UserAccount />}
            {mode === 'user'  && active === 'notif'     && <UserNotif />}
            {mode === 'user'  && active === 'voice'     && <UserVoice />}
            {mode === 'user'  && active === 'appear'    && <UserAppear />}
            {mode === 'user'  && active === 'privacy'   && <UserPrivacy />}
            {mode === 'user'  && active === 'keys'      && <UserKeys />}
            {mode === 'team'  && active === 'team'      && <TeamInfo />}
            {mode === 'team'  && active === 'invites'   && <TeamInvites />}
            {mode === 'team'  && active === 'roles'     && <TeamRoles />}
            {mode === 'team'  && active === 'federation'&& <TeamFederation />}
            {mode === 'team'  && active === 'audit'     && <TeamAudit />}
          </div>
          <footer className="set-foot">
            <span className="set-foot-hint">changes are saved per-device · push to peers on save</span>
            <div className="set-foot-actions">
              <button className="sc-btn" onClick={onClose}>Cancel · esc</button>
              <button className="sc-btn primary" onClick={() => {
                window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: mode === 'team' ? 'BERRALITOS' : null, author: 'preferences', text: 'Preferences saved. Synced to 2/2 peers.', duration: 3000 } }));
                onClose();
              }}>Save changes · ⌘↵</button>
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}

// ───────── shared form atoms ─────────
function Row({ label, hint, children }) {
  return (
    <div className="set-row">
      <div className="set-row-l">
        <div className="set-row-label">{label}</div>
        {hint && <div className="set-row-hint">{hint}</div>}
      </div>
      <div className="set-row-r">{children}</div>
    </div>
  );
}
function Group({ title, hint, children }) {
  return (
    <section className="set-group">
      <h3>{title}</h3>
      {hint && <p className="set-group-hint">{hint}</p>}
      {children}
    </section>
  );
}
function Toggle({ value, onChange }) {
  return (
    <button className="set-toggle" data-on={value ? '1' : '0'} onClick={() => onChange(!value)}>
      <i />
    </button>
  );
}
function TextField({ value, onChange, placeholder, mono }) {
  return <input className={'set-input' + (mono ? ' mono' : '')} value={value} placeholder={placeholder}
                onChange={e => onChange(e.target.value)} />;
}
function Select({ value, onChange, options }) {
  return (
    <select className="set-input" value={value} onChange={e => onChange(e.target.value)}>
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
function Btn({ children, danger, onClick }) {
  return <button className={'set-btn' + (danger ? ' danger' : '')} onClick={onClick}>{children}</button>;
}

// ───────── USER tabs ─────────
function UserAccount() {
  const [name, setName] = useStateS('thim');
  const [status, setStatus] = useStateS('pushing pixels');
  return (
    <Group title="Identity" hint="Your display name and status are visible to everyone on the team.">
      <Row label="Display name"><TextField value={name} onChange={setName} /></Row>
      <Row label="Custom status" hint="Cleared automatically after 24h."><TextField value={status} onChange={setStatus} /></Row>
      <Row label="Avatar"><div className="set-avatar-row">
        <div className="set-avatar" style={{ background: '#F39E2B' }}>TH</div>
        <Btn onClick={() => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'preferences', text: 'Avatar upload: file picker (mock).', duration: 3000 } }))}>Upload…</Btn>
        <Btn onClick={() => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'preferences', text: 'Generated new avatar from identity hash.', duration: 3000 } }))}>Generate</Btn>
      </div></Row>
      <Row label="Public key" hint="ed25519 — verified by your safety number.">
        <TextField mono value="ed25519:8e1d3c447a529bf622d14e08af31…" onChange={() => {}} />
      </Row>
    </Group>
  );
}
function UserNotif() {
  const [mode, setMode] = useStateS('mentions');
  const [quiet, setQuiet] = useStateS(true);
  return (
    <>
      <Group title="Default behaviour">
        <Row label="Notify me for">
          <div className="set-seg">
            {['all', 'mentions', 'nothing'].map(m => (
              <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>{m}</button>
            ))}
          </div>
        </Row>
        <Row label="Sound on new message"><Toggle value={true} onChange={() => {}} /></Row>
      </Group>
      <Group title="Quiet hours" hint="Suppress all push notifications during this window. Mentions still show in-app.">
        <Row label="Enable quiet hours"><Toggle value={quiet} onChange={setQuiet} /></Row>
        <Row label="From → to">
          <div className="set-range">
            <TextField value="22:00" onChange={() => {}} mono />
            <span>→</span>
            <TextField value="07:30" onChange={() => {}} mono />
          </div>
        </Row>
      </Group>
    </>
  );
}
function UserVoice() {
  const [pttKey, setPttKey] = useStateS('⌥ Space');
  const [ec, setEc] = useStateS(true);
  const [ns, setNs] = useStateS(true);
  return (
    <>
      <Group title="Devices">
        <Row label="Input">
          <Select value="Default · MacBook Pro Microphone" onChange={() => {}}
                  options={['Default · MacBook Pro Microphone', 'AirPods Pro', 'USB Audio CODEC']} />
        </Row>
        <Row label="Output">
          <Select value="Default · MacBook Pro Speakers" onChange={() => {}}
                  options={['Default · MacBook Pro Speakers', 'AirPods Pro', 'External Display']} />
        </Row>
        <Row label="Input level" hint="Speak normally to verify levels.">
          <div className="set-meter">
            {Array.from({ length: 22 }).map((_, i) => (
              <span key={i} style={{ background: i < 11 ? 'var(--accent)' : i < 17 ? 'var(--warn)' : 'var(--danger)',
                                     opacity: i < 13 ? 1 : 0.25 }} />
            ))}
          </div>
        </Row>
      </Group>
      <Group title="Processing">
        <Row label="Echo cancellation"><Toggle value={ec} onChange={setEc} /></Row>
        <Row label="Noise suppression"><Toggle value={ns} onChange={setNs} /></Row>
        <Row label="Push to talk" hint="Hold a key to transmit; release to mute.">
          <div className="set-kbd-row">
            <TextField mono value={pttKey} onChange={setPttKey} />
            <Btn>Record</Btn>
          </div>
        </Row>
      </Group>
      <Group title="Video">
        <Row label="Camera">
          <Select value="FaceTime HD" onChange={() => {}}
                  options={['FaceTime HD', 'External Webcam']} />
        </Row>
        <Row label="Mirror preview"><Toggle value={true} onChange={() => {}} /></Row>
      </Group>
    </>
  );
}
function UserAppear() {
  const [theme, setTheme] = useStateS('mesh');
  const [motion, setMotion] = useStateS(false);
  const [size, setSize] = useStateS(14);
  return (
    <>
      <Group title="Theme">
        <Row label="Direction" hint="You're previewing Mesh. Open the canvas file to compare all four.">
          <div className="set-seg">
            {['pulse','aurora','slate','mesh'].map(m => (
              <button key={m} className={theme === m ? 'on' : ''} onClick={() => setTheme(m)}>{m}</button>
            ))}
          </div>
        </Row>
      </Group>
      <Group title="Type & spacing">
        <Row label="Base font size">
          <div className="set-stepper">
            <button onClick={() => setSize(s => Math.max(11, s - 1))}>−</button>
            <span>{size}px</span>
            <button onClick={() => setSize(s => Math.min(20, s + 1))}>+</button>
          </div>
        </Row>
        <Row label="Reduce motion" hint="Disable speaking pulses, typing-dot animations, and decorative transitions.">
          <Toggle value={motion} onChange={setMotion} />
        </Row>
      </Group>
    </>
  );
}
function UserPrivacy() {
  return (
    <>
      <Group title="Your safety number" hint="Have a friend compare this number out-of-band before trusting your messages.">
        <div className="set-fingerprint">
          <div className="set-fp-block">
            <div>4f7a 9c12</div>
            <div>8d3b e5f0</div>
            <div>17ac 6b29</div>
          </div>
          <div className="set-fp-block">
            <div>0e88 4173</div>
            <div>cf2a 9b06</div>
            <div>8d51 743f</div>
          </div>
          <div className="set-fp-actions">
            <Btn>Copy</Btn>
            <Btn>Show QR</Btn>
          </div>
        </div>
      </Group>
      <Group title="Encryption">
        <Row label="Double Ratchet sessions" hint="Currently active per-contact key chains.">
          <span className="set-stat">14 sessions · last rotated 2h ago</span>
        </Row>
        <Row label="Rotate session keys" hint="Forces new key exchange with everyone you've talked to. Old messages stay readable.">
          <Btn onClick={() => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'crypto', text: 'Session keys rotated. 14 new chains established.', duration: 3500 } }))}>Rotate now</Btn>
        </Row>
        <Row label="Export identity backup" hint="Encrypted with your passphrase. Keep it offline.">
          <Btn onClick={() => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'preferences', text: 'Identity backup downloaded: dilla-identity-thim.bin (4.2 KB)', duration: 4000 } }))}>Export…</Btn>
        </Row>
      </Group>
      <Group title="Verify contacts" hint="Compare safety numbers with someone to confirm they are who they say they are — not the server impersonating them.">
        {['ada','mira','ben','ola','juno'].map(id => {
          const m = window.MOCK_DATA?.byId?.[id];
          if (!m) return null;
          return (
            <Row key={id} label={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <span className="set-avatar" style={{ background: m.color, width: 22, height: 22, fontSize: 10 }}>{m.initials}</span>
                {m.name}
              </span>
            }>
              <Btn onClick={() => window.dispatchEvent(new CustomEvent('dilla:verify-safety', { detail: id }))}>Verify</Btn>
            </Row>
          );
        })}
      </Group>
      <Group title="Block list">
        <Row label="Search blocked users"><TextField value="" onChange={() => {}} placeholder="filter…" /></Row>
        <div className="set-empty">no blocked users</div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <Btn onClick={() => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'preferences', text: 'Pick a user from members or a DM to block them.', duration: 3000 } }))}>+ Block someone</Btn>
        </div>
      </Group>
    </>
  );
}
function UserKeys() {
  const rows = [
    ['Open command palette', '⌘ K'],
    ['Open search',           '/'],
    ['Toggle mute',           'M'],
    ['Toggle deafen',         'D'],
    ['Disconnect voice',      '⌘ ⇧ D'],
    ['Quick switch channel',  '⌘ + ↑/↓'],
    ['Mark all read',         '⇧ Esc'],
    ['Reply in thread',       'R'],
    ['React to last message', '+'],
  ];
  return (
    <Group title="Shortcuts" hint="Vim-ish navigation. Hover any action elsewhere in the UI to see its keybind.">
      <table className="set-kbd-table">
        <tbody>
          {rows.map(([action, key]) => (
            <tr key={action}>
              <td>{action}</td>
              <td><kbd>{key}</kbd></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Group>
  );
}

// ───────── TEAM tabs ─────────
function TeamInfo() {
  return (
    <>
      <Group title="Team">
        <Row label="Name"><TextField value="Berralitos" onChange={() => {}} /></Row>
        <Row label="Description"><TextField value="self-hosted, gothenburg, mostly designers" onChange={() => {}} /></Row>
        <Row label="Created"><span className="set-stat">2025-09-14 · by thim</span></Row>
        <Row label="Storage"><span className="set-stat">1.2 GB / 10 GB</span></Row>
      </Group>
      <Group title="Defaults">
        <Row label="Default channel"><Select value="#general" options={['#general','#design','#dev']} onChange={() => {}} /></Row>
        <Row label="Slow mode (seconds)"><TextField mono value="0" onChange={() => {}} /></Row>
      </Group>
    </>
  );
}
function TeamInvites() {
  const [rows, setRows] = useO([
    { code: 'dilla.gbg/invite/4F7A',  uses: '4 / ∞', expires: '—',          who: 'thim · admin' },
    { code: 'dilla.gbg/invite/8E1D',  uses: '0 / 5', expires: 'in 4 days',  who: 'ada · maintainer' },
    { code: 'dilla.gbg/invite/A013',  uses: '1 / 1', expires: 'used up',    who: 'thim · admin', stale: true },
  ]);
  function revoke(code) {
    if (!confirm('Revoke invite ' + code + '? People who already have it can no longer use it.')) return;
    setRows(prev => prev.filter(r => r.code !== code));
    window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'team', text: 'Invite revoked. Propagated to 2/2 peers.', duration: 3500 } }));
  }
  function create() {
    const code = 'dilla.gbg/invite/' + Math.random().toString(16).slice(2, 6).toUpperCase();
    setRows(prev => [...prev, { code, uses: '0 / ∞', expires: '—', who: 'thim · admin' }]);
    window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'team', text: 'Invite link generated and copied to clipboard.', duration: 3500 } }));
    navigator.clipboard?.writeText(code);
  }
  return (
    <Group title="Active invites" hint="Anyone with a working link can join this team. Revoke unused links.">
      <div className="set-table">
        <div className="set-th">
          <span>Link</span><span>Uses</span><span>Expires</span><span>Created by</span><span></span>
        </div>
        {rows.map(r => (
          <div key={r.code} className={'set-tr' + (r.stale ? ' stale' : '')}>
            <code>{r.code}</code>
            <span>{r.uses}</span>
            <span>{r.expires}</span>
            <span>{r.who}</span>
            <Btn danger onClick={() => revoke(r.code)}>Revoke</Btn>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12 }}>
        <Btn onClick={create}>+ New invite link</Btn>
      </div>
    </Group>
  );
}
function TeamRoles() {
  const roles = [
    { name: 'Admin', count: 1, perms: 'all 12 permissions', color: 'var(--accent)' },
    { name: 'Maintainer', count: 1, perms: 'manage channels · kick · ban · pin · manage threads', color: 'var(--warn)' },
    { name: 'Member', count: 4, perms: 'send messages · react · upload · join voice', color: 'var(--fg-2)' },
  ];
  return (
    <Group title="Roles" hint="12-bit permission system. Drag to reorder; higher rows win conflicts.">
      <div className="set-table">
        {roles.map(r => (
          <div key={r.name} className="set-tr role">
            <span className="set-role-dot" style={{ background: r.color }} />
            <span style={{ fontWeight: 600 }}>{r.name}</span>
            <span>{r.count} member{r.count === 1 ? '' : 's'}</span>
            <span style={{ color: 'var(--fg-3)', fontSize: 11 }}>{r.perms}</span>
            <Btn onClick={() => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'system', author: 'roles', text: r.name + ' role editor — drag permissions, save to apply across the mesh.', duration: 4000 } }))}>Edit</Btn>
          </div>
        ))}
      </div>
    </Group>
  );
}
function TeamFederation() {
  return (
    <>
      <Group title="Mesh" hint="Peer nodes that replicate this team. Voice stays on the origin node, but messages, channels and presence sync across all peers.">
        <Row label="This node">
          <div>
            <code>gbg-1.dilla.local:8080</code>
            <div style={{ color: 'var(--fg-3)', fontSize: 11, marginTop: 2 }}>lamport 13,059 · uptime 4d 12h</div>
          </div>
        </Row>
        <Row label="Federation port" hint="Memberlist gossip listens here. Defaults to port + 1."><TextField mono value="8081" onChange={() => {}} /></Row>
        <Row label="Advertise as" hint="Address other nodes see for this one. Set for NAT."><TextField mono value="auto" onChange={() => {}} /></Row>
      </Group>
      <Group title="Peers">
        <div className="set-table">
          <div className="set-th"><span>Address</span><span>State</span><span>Last sync</span><span>Lamport</span><span></span></div>
          <div className="set-tr">
            <code>rust.berra.io:8081</code>
            <span><span className="set-dot ok" /> healthy</span>
            <span>0.3s ago</span>
            <span>13,062</span>
            <Btn danger onClick={() => { if (confirm('Disconnect peer rust.berra.io? The mesh will fall back to local-only until they reconnect.')) window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'federation', text: 'Peer rust.berra.io disconnected. Mesh degraded to solo.', duration: 4000 } })); }}>Disconnect</Btn>
          </div>
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
          <Btn onClick={() => window.dispatchEvent(new CustomEvent('dilla:add-peer'))}>+ Add peer</Btn>
          <Btn onClick={() => window.dispatchEvent(new CustomEvent('dilla:add-peer'))}>Generate join command</Btn>
        </div>
      </Group>
    </>
  );
}
function TeamAudit() {
  const rows = [
    ['10:39:12', 'thim',     'created channel',   '#mesh-status'],
    ['10:21:04', 'ada',      'pinned message',    'in #design'],
    ['09:55:31', 'thim',     'invited',           'ola@rust.berra.io'],
    ['08:02:18', 'system',   'peer joined mesh',  'rust.berra.io'],
    ['00:14:55', 'thim',     'rotated session',   '14 sessions'],
  ];
  return (
    <Group title="Recent activity" hint="Local audit log. Federated events are tagged with the peer they came from.">
      <div className="set-audit">
        {rows.map((r, i) => (
          <div key={i} className="set-audit-row" style={{ cursor: 'pointer' }}
               onClick={() => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: r[1], text: r[0] + ' · ' + r[2] + ' ' + r[3], duration: 3500 } }))}>
            <code>{r[0]}</code>
            <span style={{ color: 'var(--accent)' }}>{r[1]}</span>
            <span style={{ color: 'var(--fg-2)' }}>{r[2]}</span>
            <span>{r[3]}</span>
          </div>
        ))}
      </div>
    </Group>
  );
}

window.Settings = Settings;
