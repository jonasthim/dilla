// Dilla chat refinement — the main React app.
// Loaded after chat-icons.jsx and themes.js / data.js.
// Exports `window.ChatApp`.

const { useState, useEffect, useRef, useMemo } = React;
const { Icon } = window;

// ───────────── helpers ─────────────
function timeShort(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function dayLabel(d) {
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (sameDay) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}
function groupMessages(msgs) {
  // Group consecutive messages by the same author within ~5min into stacks.
  const out = [];
  let last = null;
  msgs.forEach(m => {
    if (last && last.author === m.author && m.kind === 'text' && last.kind === 'text'
        && (m.at - last.at) < 5 * 60e3) {
      last.children.push(m);
    } else {
      const group = { author: m.author, at: m.at, kind: m.kind, base: m, children: [m] };
      out.push(group);
      last = group;
    }
  });
  return out;
}

// ───────────── small bits ─────────────
function Avatar({ member, size }) {
  const sty = { background: member.color };
  if (size) Object.assign(sty, { width: size, height: size, fontSize: size * 0.4 });
  return (
    <div className="avatar" style={sty}>
      {member.initials}
      {member.status && <span className={`presence ${member.status}`}></span>}
    </div>
  );
}

function PlainAvatar({ member, size }) {
  const sty = { background: member.color };
  if (size) Object.assign(sty, { width: size, height: size, fontSize: size * 0.4 });
  return <div className="avatar" style={sty}>{member.initials}</div>;
}

function MiniMeter() {
  // tiny 4-bar audio meter that updates on a timer
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT(x => x + 1), 140);
    return () => clearInterval(id);
  }, []);
  function v(i) { return 0.3 + Math.abs(Math.sin(t * 0.7 + i * 1.3)) * 0.7; }
  return (
    <span className="mini-meter">
      {[0,1,2,3].map(i => (
        <span key={i} className="mm-bar" style={{ height: 3 + Math.round(v(i) * 6) }} />
      ))}
    </span>
  );
}

// Modal: forward a message to another channel or DM
function ForwardModal({ sourceMsg, members, onClose, onForward }) {
  const [q, setQ] = useState('');
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const data = window.MOCK_DATA;
  const targets = [
    ...data.CHANNELS.filter(c => c.type === 'text').map(c => ({ id: c.id, label: '#' + c.name, sub: c.topic || '', kind: 'channel' })),
    ...data.DMS.map(d => {
      const m = d.group ? null : data.byId[d.with];
      return { id: d.id, label: d.group ? d.name : m?.name, sub: d.group ? 'group' : (m?.custom || 'direct message'), kind: 'dm', color: m?.color };
    }),
  ].filter(t => !q || t.label.toLowerCase().includes(q.toLowerCase()));
  const author = data.byId[sourceMsg.author] || { name: sourceMsg.author };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ width: 'min(540px, 100%)' }}>
        <header className="modal-head">
          <h2>Forward message</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="fwd-preview">
            <div className="fwd-author">{author.name}</div>
            <div className="fwd-text">{(sourceMsg.text || '').slice(0, 140)}{(sourceMsg.text||'').length > 140 ? '…' : ''}</div>
          </div>
          <input autoFocus value={q} onChange={e => setQ(e.target.value)}
                 placeholder="search kanals & DMs…"
                 style={{ padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--hairline-2)', borderRadius: 'var(--r-sm)', color: 'var(--fg)', fontFamily: 'inherit', fontSize: 13, outline: 'none' }} />
          <div className="ndm-list">
            {targets.map(t => (
              <button key={t.id} className="ndm-row" onClick={() => onForward(t.id)}>
                <div className="ndm-av" style={{ background: t.color || 'var(--accent-soft)', color: t.color ? '#111' : 'var(--accent)' }}>
                  {t.kind === 'channel' ? '#' : (t.label || '?').slice(0,2).toUpperCase()}
                </div>
                <div>
                  <div className="ndm-name">{t.label}</div>
                  <div className="ndm-sub">{t.sub}</div>
                </div>
              </button>
            ))}
            {targets.length === 0 && <div className="pin-empty">no kanals or DMs match.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// Modal: pick a member to start a new DM with
function NewDmModal({ members, onClose, onPick }) {
  const [q, setQ] = useState('');
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const list = (members.MEMBERS || []).filter(m => m.id !== 'thim' && (!q || m.name.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()} style={{ width: 'min(480px, 100%)' }}>
        <header className="modal-head">
          <h2>New direct message</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <input autoFocus value={q} onChange={e => setQ(e.target.value)}
                 placeholder="filter by name…"
                 style={{ padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--hairline-2)', borderRadius: 'var(--r-sm)', color: 'var(--fg)', fontFamily: 'inherit', fontSize: 13, outline: 'none' }} />
          <div className="ndm-list">
            {list.map(m => (
              <button key={m.id} className="ndm-row" onClick={() => onPick(m.id)}>
                <div className="ndm-av" style={{ background: m.color }}>{m.initials}<span className={'presence ' + m.status}></span></div>
                <div>
                  <div className="ndm-name">{m.name}</div>
                  <div className="ndm-sub">{m.custom || m.status}</div>
                </div>
              </button>
            ))}
            {list.length === 0 && <div className="pin-empty">no members match.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// Modal: create a new kanal (channel)
function NewChannelModal({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('text');
  const [priv, setPriv] = useState(false);
  const [topic, setTopic] = useState('');
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const ok = slug.length >= 2;
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <h2>New kanal</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="modal-row">
            <label>Type</label>
            <div className="onb-seg">
              <button className={kind === 'text' ? 'on' : ''} onClick={() => setKind('text')}><Icon.Hash size={11} /> Text</button>
              <button className={kind === 'voice' ? 'on' : ''} onClick={() => setKind('voice')}><Icon.Speaker size={11} /> Voice</button>
            </div>
          </div>
          <div className="modal-row">
            <label>Name</label>
            <div className="modal-input-pre">
              <span className="pre-glyph">{kind === 'voice' ? '🔊' : '#'}</span>
              <input value={name} autoFocus
                     onChange={e => setName(e.target.value.toLowerCase().replace(/[^a-z0-9 -]/g, ''))}
                     placeholder="ship-talk" />
            </div>
            {slug && <div className="modal-hint">URL: <code>dilla://gbg-1/k/{slug}</code></div>}
          </div>
          <div className="modal-row">
            <label>Topic <span className="modal-opt">optional</span></label>
            <input value={topic} onChange={e => setTopic(e.target.value)} placeholder="what's this kanal for?" />
          </div>
          <div className="modal-row modal-row-h">
            <div>
              <label>Private kanal</label>
              <div className="modal-hint">{priv ? 'only invited members can see this.' : 'anyone on the team can join.'}</div>
            </div>
            <button className="set-toggle" data-on={priv ? '1' : '0'} onClick={() => setPriv(p => !p)}><i /></button>
          </div>
        </div>
        <footer className="modal-foot">
          <button className="sc-btn" onClick={onClose}>Cancel</button>
          <button className="sc-btn primary" disabled={!ok} onClick={() => onCreate({ id: slug, name: slug, kind, topic, private: priv })}>Create kanal</button>
        </footer>
      </div>
    </div>
  );
}

// Modal: create-or-join team
function NewServerModal({ onClose, onCreate }) {
  const [mode, setMode] = useState('create'); // create | join
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const slug = (name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const ok = mode === 'create' ? slug.length >= 2 : token.length >= 12;
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <header className="modal-head">
          <h2>Add a team</h2>
          <button className="modal-x" onClick={onClose}>×</button>
        </header>
        <div className="modal-body">
          <div className="onb-seg" style={{ marginBottom: 18 }}>
            <button className={mode === 'create' ? 'on' : ''} onClick={() => setMode('create')}>Create a new team</button>
            <button className={mode === 'join' ? 'on' : ''} onClick={() => setMode('join')}>Join with an invite</button>
          </div>
          {mode === 'create' ? (
            <>
              <div className="modal-row">
                <label>Team name</label>
                <input value={name} autoFocus
                       onChange={e => setName(e.target.value)}
                       placeholder="Berralitos" />
                <div className="modal-hint">A team is hosted on a node you run. You'll be the admin.</div>
              </div>
              <div className="modal-row">
                <label>Server URL <span className="modal-opt">optional</span></label>
                <input defaultValue="http://localhost:8080" />
                <div className="modal-hint">Where your <code>dilla-server</code> binary is running.</div>
              </div>
            </>
          ) : (
            <>
              <div className="modal-row">
                <label>Invite link or token</label>
                <textarea rows={3} value={token} onChange={e => setToken(e.target.value)}
                          placeholder="dilla.gbg/invite/4F7A · or paste a full URL"></textarea>
                <div className="modal-hint">Single-use or capped invites. The server validates this before binding your identity.</div>
              </div>
            </>
          )}
        </div>
        <footer className="modal-foot">
          <button className="sc-btn" onClick={onClose}>Cancel</button>
          <button className="sc-btn primary" disabled={!ok} onClick={() => onCreate({
            id: mode === 'create' ? slug : 'joined-' + Date.now(),
            name: mode === 'create' ? name : 'New team',
            short: (mode === 'create' ? name : 'NT').slice(0, 1).toUpperCase() || 'N',
            node: mode === 'create' ? 'your-node.local' : 'peer.remote',
            kind: mode,
            federated: false,
            members: 1,
          })}>
            {mode === 'create' ? 'Create team' : 'Join team'}
          </button>
        </footer>
      </div>
    </div>
  );
}

// Empty state shown when a channel or DM has no messages yet.
function EmptyFeed({ channel, dmPartner }) {
  if (channel.type === 'dm' && dmPartner) {
    return (
      <div className="empty-feed">
        <div className="ef-avatar" style={{ background: dmPartner.color }}>
          {dmPartner.initials}
          <span className={'presence ' + dmPartner.status}></span>
        </div>
        <h2 className="ef-title">{dmPartner.name}</h2>
        <div className="ef-sub">This is your first private conversation with {dmPartner.name}.</div>
        <div className="ef-pills">
          <span className="ef-pill"><Icon.Shield size={11} /> Signal · X3DH</span>
          <span className="ef-pill">double-ratchet</span>
          <span className="ef-pill">server sees ciphertext only</span>
        </div>
      </div>
    );
  }
  if (channel.type === 'dm' && channel.group) {
    return (
      <div className="empty-feed">
        <div className="ef-glyph"><Icon.People size={28} /></div>
        <h2 className="ef-title">{channel.name}</h2>
        <div className="ef-sub">Group conversation, end-to-end encrypted via sender keys.</div>
      </div>
    );
  }
  return (
    <div className="empty-feed">
      <div className="ef-glyph"><Icon.Hash size={28} /></div>
      <h2 className="ef-title">Welcome to #{channel.name}</h2>
      <div className="ef-sub">This is the start of the <strong>#{channel.name}</strong> kanal. {channel.topic && <em>· {channel.topic}</em>}</div>
      <div className="ef-pills">
        {channel.encrypted && <span className="ef-pill"><Icon.Shield size={11} /> end-to-end encrypted</span>}
        <span className="ef-pill">messages sync via mesh</span>
      </div>
    </div>
  );
}

// Profile popover — anchored to click coords.
function ProfilePopover({ pop, onClose, onDM, federated }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!pop) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [pop, onClose]);
  if (!pop) return null;
  const m = window.MOCK_DATA.byId[pop.memberId];
  if (!m) return null;
  const nodes = (window.MeshChrome && window.MeshChrome.MEMBER_NODES) || {};
  const fps = (window.MeshChrome && window.MeshChrome.FINGERPRINTS) || {};
  const node = nodes[m.id] || '';
  const fed = federated && node && !node.includes('gbg-1');
  // Clamp position to viewport
  const W = 260, H = 240;
  const x = Math.min(window.innerWidth - W - 8, Math.max(8, pop.x));
  const y = Math.min(window.innerHeight - H - 8, Math.max(8, pop.y));
  return (
    <div className="pop-profile" ref={ref} style={{ position: 'fixed', left: x, top: y, width: W }}>
      <div className="pp-banner" style={{ background: m.color }} />
      <div className="pp-body">
        <div className="pp-avatar" style={{ background: m.color }}>
          {m.initials}
          <span className={`presence ${m.status}`}></span>
        </div>
        <div className="pp-name">{m.name}</div>
        <div className="pp-sub">
          {m.role && <span className="pp-role">{m.role}</span>}
          {m.custom && <span className="pp-status">· {m.custom}</span>}
        </div>
        {federated && node && (
          <div className="pp-meta">
            <span className="pp-k">node</span> {node.replace('.io','')}
            {fed && <span className="pp-fed">federated</span>}
          </div>
        )}
        {fps[m.id] && (
          <div className="pp-meta">
            <span className="pp-k">safety</span> {fps[m.id]}
          </div>
        )}
        <div className="pp-actions">
          <button className="pp-btn primary" onClick={() => { onDM(m.id); onClose(); }}>Send message</button>
          <button className="pp-btn" onClick={onClose}>View profile</button>
        </div>
      </div>
    </div>
  );
}

// Emoji picker — small grid of common emojis.
const EMOJIS = [
  '👍','👎','❤️','😄','😂','😢','😡','😍',
  '🎉','🔥','💯','✨','🙏','👀','🤔','😴',
  '🛠','🚀','✅','❌','💡','📌','🐛','📦',
  '☕','🍕','🌮','🎨','🎵','🌙','☀️','🦀',
];
function EmojiPicker({ open, onClose, onPick, anchorRect }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    function onDoc(e) { if (ref.current && !ref.current.contains(e.target)) onClose(); }
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);
  if (!open) return null;
  const W = 252, H = 200;
  const r = anchorRect || { left: 100, top: 100, bottom: 100 };
  // Position above the button, right-aligned
  const x = Math.min(window.innerWidth - W - 8, Math.max(8, r.left + r.width - W));
  const y = Math.max(8, r.top - H - 6);
  return (
    <div className="emoji-pick" ref={ref} style={{ position: 'fixed', left: x, top: y, width: W }}>
      <div className="ep-head">
        <span>Frequently used</span>
        <button className="ep-x" onClick={onClose}>×</button>
      </div>
      <div className="ep-grid">
        {EMOJIS.map(e => (
          <button key={e} className="ep-btn" onClick={() => onPick(e)}>{e}</button>
        ))}
      </div>
    </div>
  );
}

// Drag-to-resize handle for the sidebar and members columns.
function ResizeHandle({ kind, value, onResize, min = 180, max = 380 }) {
  const startX = useRef(0);
  const startW = useRef(0);
  const draggingRef = useRef(false);
  function onDown(e) {
    e.preventDefault();
    startX.current = e.clientX;
    startW.current = value;
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    function move(ev) {
      const dx = ev.clientX - startX.current;
      const newW = kind === 'sidebar' ? startW.current + dx : startW.current - dx;
      onResize(Math.max(min, Math.min(max, Math.round(newW))));
    }
    function up() {
      draggingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    }
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }
  return <div className={'resize-handle resize-' + kind} onMouseDown={onDown} title="drag to resize" />;
}

// Thread panel — opens when clicking a thread-preview on a message.
function ThreadPanel({ channelId, messageId, members, onClose, onReact }) {
  const data = window.MOCK_DATA;
  const channel = data.CHANNELS.find(c => c.id === channelId);
  const original = (data.MESSAGES[channelId] || []).find(m => m.id === messageId);
  const initialReplies = (data.THREAD_REPLIES && data.THREAD_REPLIES[messageId]) || [];
  const [replies, setReplies] = useState(initialReplies);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [replies.length]);

  function send() {
    if (!draft.trim()) return;
    setReplies(prev => [...prev, {
      id: 'tr-' + Date.now(),
      author: 'thim',
      at: new Date(),
      text: draft.trim(),
    }]);
    setDraft('');
  }

  if (!original) {
    return (
      <aside className="thread-panel">
        <header className="tp-head">
          <div><span className="tp-title">Thread</span></div>
          <button className="icon-btn" title="Close" onClick={onClose}>×</button>
        </header>
        <div className="tp-empty">thread not found</div>
      </aside>
    );
  }

  const author = members.byId[original.author];

  return (
    <aside className="thread-panel">
      <header className="tp-head">
        <div>
          <span className="tp-title">Thread</span>
          <span className="tp-channel">· #{channel?.name}</span>
        </div>
        <button className="icon-btn" title="Close" onClick={onClose}>×</button>
      </header>

      <div className="tp-feed" ref={scrollRef}>
        <div className="tp-original">
          <div className="tp-msg">
            <Avatar member={author} />
            <div>
              <div className="head">
                <span className="author">{author.name}</span>
                <span className="at">{timeShort(original.at)}</span>
              </div>
              <div className="body">{renderText(original.text, members)}</div>
            </div>
          </div>
          <div className="tp-meta">{replies.length} {replies.length === 1 ? 'reply' : 'replies'}</div>
        </div>

        {replies.map(r => {
          const a = members.byId[r.author];
          return (
            <div key={r.id} className="tp-msg">
              <Avatar member={a} />
              <div>
                <div className="head">
                  <span className="author">{a.name}</span>
                  <span className="at">{timeShort(r.at)}</span>
                </div>
                <div className="body">{renderText(r.text, members)}</div>
                {r.reactions && (
                  <div className="rxns">
                    {r.reactions.map((rx, i) => (
                      <span key={i}
                            className={'rxn' + (rx.mine ? ' mine' : '')}
                            onClick={() => {
                              setReplies(prev => prev.map(rr => {
                                if (rr.id !== r.id) return rr;
                                const list = [...(rr.reactions || [])];
                                const idx = list.findIndex(x => x.e === rx.e);
                                if (idx >= 0) {
                                  const cur = list[idx];
                                  if (cur.mine) {
                                    if (cur.n <= 1) list.splice(idx, 1);
                                    else list[idx] = { ...cur, n: cur.n - 1, mine: false };
                                  } else {
                                    list[idx] = { ...cur, n: cur.n + 1, mine: true };
                                  }
                                }
                                return { ...rr, reactions: list };
                              }));
                            }}>
                        <span>{rx.e}</span><span>{rx.n}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="tp-composer">
        <div className="composer">
          <div className="composer-input">
            <textarea
              placeholder={`Reply in thread…`}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              rows={1}
            />
            <button className="send-btn" disabled={!draft.trim()} onClick={send} title="Send (↵)">
              <Icon.Send size={14} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

function MockCam({ member, mini }) {
  // pick a warm skin/light tone derived from the member's brand color
  const tones = {
    thim: '#d4a06e',
    ada:  '#c89476',
    ben:  '#b07a5c',
    mira: '#dab38a',
    ola:  '#c69275',
    juno: '#b88862',
    kai:  '#cd9c7a',
    sven: '#a87858',
    noa:  '#c08c66',
  };
  const tone = tones[member.id] || '#c89770';
  return (
    <div className={'mock-cam' + (mini ? ' mini' : '')} style={{ '--cam-skin': tone }}>
      <svg className="mock-cam-head" viewBox="0 0 100 100" preserveAspectRatio="xMidYMax meet">
        <circle cx="50" cy="40" r="14" fill="rgba(0,0,0,0.22)" />
        <path d="M20 100 C 22 76, 78 76, 80 100 Z" fill="rgba(0,0,0,0.22)" />
      </svg>
      {!mini && <span className="mock-cam-label">{member.name}</span>}
      {!mini && <span className="mock-cam-rec">● LIVE</span>}
    </div>
  );
}

// Mock screen-share — stylized terminal / editor preview.
function MockScreen({ member, pip }) {
  // pre-computed line widths so they don't reshuffle every render
  const lines = [
    72, 56, 38, 84, 28, 64, 48, 90,
    34, 70, 58, 26, 80, 44, 60, 36, 78,
  ];
  return (
    <div className="mock-screen">
      <div className="ms-titlebar">
        <span className="ms-dot r" />
        <span className="ms-dot y" />
        <span className="ms-dot g" />
        <span className="ms-title">~/dilla/server-rs/src/voice/sfu.rs</span>
      </div>
      <div className="ms-body">
        <div className="ms-sidebar">
          {Array.from({ length: 7 }).map((_, i) => (
            <span key={i} className="ms-side-line" style={{ width: (50 + ((i * 17) % 40)) + '%' }} />
          ))}
        </div>
        <div className="ms-editor">
          {lines.map((w, i) => (
            <div key={i} className="ms-row">
              <span className="ms-num">{i + 1}</span>
              <span className="ms-line" style={{ width: w + '%' }} />
            </div>
          ))}
        </div>
      </div>
      <div className="ms-foot">
        <span>{member.name}'s screen · 1920×1080 · 8fps</span>
      </div>
      {pip && (
        <div className="ms-pip">
          <MockCam member={pip} mini />
        </div>
      )}
    </div>
  );
}

// ───────────── server rail ─────────────
function ServerRail({ servers, activeServer, onPick }) {
  const [serverOrder, setServerOrder] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const ordered = serverOrder
    ? serverOrder.map(id => servers.find(s => s.id === id)).filter(Boolean).concat(servers.filter(s => !serverOrder.includes(s.id)))
    : servers;
  function reorder(srcId, targetId) {
    const ids = ordered.map(s => s.id);
    const from = ids.indexOf(srcId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, srcId);
    setServerOrder(next);
  }
  return (
    <aside className="rail">
      {ordered.map(s => (
        <div key={s.id}
             className={'rail-item' + (s.id === activeServer ? ' active' : '') + (overId === s.id && dragId && dragId !== s.id ? ' drop-target' : '') + (dragId === s.id ? ' dragging' : '')}
             draggable
             onDragStart={(e) => { setDragId(s.id); e.dataTransfer.effectAllowed = 'move'; }}
             onDragOver={(e) => { e.preventDefault(); setOverId(s.id); }}
             onDragLeave={() => { if (overId === s.id) setOverId(null); }}
             onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== s.id) reorder(dragId, s.id); setDragId(null); setOverId(null); }}
             onDragEnd={() => { setDragId(null); setOverId(null); }}
             onClick={() => onPick(s.id)}
             onContextMenu={(e) => {
               e.preventDefault();
               window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                 { label: s.name, icon: null, onClick: () => {} },
                 { sep: true },
                 { label: 'Team settings', icon: <Icon.Cog size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'team' } })) },
                 { label: 'Invites', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 4l6 5 6-5M2 4v8h12V4" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'invites' } })) },
                 { label: 'Federation', icon: <Icon.Lightning size={12} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: { mode: 'team', tab: 'federation' } })) },
                 { label: 'Mark all read', icon: null, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: s.name, author: 'system', text: 'All kanals in ' + s.name + ' marked as read.', duration: 2500 } })) },
                 { sep: true },
                 { label: 'Leave team', danger: true, icon: null, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: s.name, author: 'system', text: 'Confirm in Team Settings → Danger Zone.', duration: 3000 } })) },
               ] } }));
             }}
             title={s.name}>
          {s.short}
          {!s.federated && <span className="rail-dot" style={{ background: 'var(--warn)' }}></span>}
        </div>
      ))}
      <button className="rail-add" title="Add team" onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-add-server'))}><Icon.Plus /></button>
    </aside>
  );
}

// ───────────── channel sidebar ─────────────
function ChannelSidebar({ team, tab, onTab, channels, activeChannel, onPickChannel,
                          voiceConnection, members, dms, activeDM, onPickDM,
                          onLeaveVoice, mute, setMute, deaf, setDeaf, cam, setCam, screen, setScreen,
                          mutedChannels = new Set(), toggleMuteChannel, onNewDm }) {
  const [dragId, setDragId] = useState(null);
  const [overId, setOverId] = useState(null);
  const [orderOverride, setOrderOverride] = useState(null); // [ids…]
  const voiceChs = channels.filter(c => c.type === 'voice' && (c.participants || []).length > 0);
  const textChsRaw = channels.filter(c => c.type === 'text');
  const textChs = orderOverride
    ? orderOverride.map(id => textChsRaw.find(c => c.id === id)).filter(Boolean).concat(textChsRaw.filter(c => !orderOverride.includes(c.id)))
    : textChsRaw;
  function reorderTextCh(srcId, targetId) {
    const ids = textChs.map(c => c.id);
    const from = ids.indexOf(srcId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...ids];
    next.splice(from, 1);
    next.splice(to, 0, srcId);
    setOrderOverride(next);
  }
  const otherVoice = channels.filter(c => c.type === 'voice' && !voiceChs.includes(c));

  return (
    <aside className="side">
      <div className="side-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="team-name">{team.name}{team.federated && <Icon.Lightning size={11} />}</div>
          <div className="team-node">{team.node} · mesh ok</div>
        </div>
        <button className="icon-btn" title="Team settings" onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: 'team' }))}>
          <Icon.Cog size={14} />
        </button>
      </div>

      <div className="tabs">
        <button className={'tab' + (tab === 'kanals' ? ' active' : '')} onClick={() => onTab('kanals')}>
          <Icon.Hash size={12} /> Kanals
        </button>
        <button className={'tab' + (tab === 'pms' ? ' active' : '')} onClick={() => onTab('pms')}>
          <Icon.Chat size={12} /> PMs {dms.reduce((a,b) => a + b.unread, 0) > 0 && (
            <span className="unread-pill mention" style={{ marginLeft: 4, padding: '0 5px' }}>
              {dms.reduce((a,b) => a + b.unread, 0)}
            </span>
          )}
        </button>
      </div>

      {tab === 'kanals' ? (
        <div className="side-scroll">
          {voiceChs.length > 0 && (
            <>
              <div className="cat">
                <span>Active voice</span>
                <span style={{ color: 'var(--accent)', fontFamily: 'var(--font-mono)' }}>● live</span>
              </div>
              {voiceChs.map(c => (
                <div key={c.id}>
                  <div
                    className={'channel-row' + (c.id === activeChannel ? ' active' : '')}
                    onClick={() => onPickChannel(c.id)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                        { label: 'Disconnect from voice', danger: true, icon: <Icon.Mic size={13} off />, onClick: onLeaveVoice },
                        { label: 'Copy link', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6 10l4-4M6 6l4 4" stroke="currentColor" strokeWidth="1.4"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/></svg>, onClick: () => { navigator.clipboard?.writeText('dilla://gbg-1/k/' + c.id); window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Voice kanal link copied.', duration: 2000 } })); } },
                        { sep: true },
                        { label: 'Kanal settings', icon: <Icon.Cog size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Voice kanal settings: bitrate, region, permissions, codec.', duration: 4000 } })) },
                      ] } }));
                    }}>
                    <span className="ch-glyph"><Icon.Speaker size={14} /></span>
                    <span className="ch-name">{c.name}</span>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--fg-3)' }}>
                      {(c.participants||[]).length}
                    </span>
                  </div>
                  <div className="voice-participants">
                    {(c.participants || []).map(pid => {
                      const m = members.byId[pid];
                      const speaking = pid === 'ada'; // mock speaking
                      const muted = pid === 'thim' && mute;
                      const deafened = pid === 'thim' && deaf;
                      const screenOn = pid === 'ben';
                      const camOn = pid === 'thim' && cam;
                      return (
                        <div key={pid} className={'voice-participant' + (speaking ? ' speaking' : '') + (muted ? ' muted' : '')}
                             onContextMenu={(e) => {
                               e.preventDefault();
                               window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                                 { label: 'Adjust volume', icon: <Icon.Headphones size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: 'voice', author: 'mixer', text: 'Per-user volume slider for ' + m.name + ' (drag to set).', duration: 3500 } })) },
                                 { label: 'View profile', icon: <Icon.People size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-profile', { detail: { memberId: pid, x: 200, y: 200 } })) },
                                 { sep: true },
                                 { label: 'Mute for me only', icon: <Icon.Mic size={13} off />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'mixer', text: 'Muted ' + m.name + ' for this session only.', duration: 2500 } })) },
                                 { label: 'Server-mute (admin)', danger: true, icon: <Icon.Mic size={13} off />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'admin', text: 'Server-mute requires admin role. Propagates across the mesh.', duration: 3500 } })) },
                                 { label: 'Disconnect from voice', danger: true, icon: null, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'admin', text: 'Disconnect ' + m.name + ' from #voice-lounge (admin only).', duration: 3000 } })) },
                               ] } }));
                             }}>
                          <div className="vp-avatar" style={{ background: m.color }}>{m.initials}</div>
                          <span className="vp-name">{m.name}</span>
                          <div className="vp-state">
                            {speaking && <MiniMeter />}
                            {camOn && <span className="vp-icon screen" title="camera on"><Icon.Video size={11} /></span>}
                            {screenOn && <span className="vp-icon screen" title="sharing screen"><Icon.Screen size={11} /></span>}
                            {deafened && <span className="vp-icon mute" title="deafened"><Icon.Headphones size={11} off /></span>}
                            {muted && <span className="vp-icon mute" title="muted"><Icon.Mic size={11} off /></span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </>
          )}

          <div className="cat">
            <span>Kanals</span>
            <div className="cat-actions"><button className="icon-btn" title="New kanal" onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-new-channel'))}><Icon.Plus size={12} /></button></div>
          </div>
          {textChs.map(c => (
            <div key={c.id}
                 draggable
                 onDragStart={(e) => { setDragId(c.id); e.dataTransfer.effectAllowed = 'move'; }}
                 onDragOver={(e) => { e.preventDefault(); setOverId(c.id); }}
                 onDragLeave={(e) => { if (overId === c.id) setOverId(null); }}
                 onDrop={(e) => { e.preventDefault(); if (dragId && dragId !== c.id) reorderTextCh(dragId, c.id); setDragId(null); setOverId(null); }}
                 onDragEnd={() => { setDragId(null); setOverId(null); }}
                 className={'channel-row' + (c.id === activeChannel ? ' active' : '') + (c.unread > 0 ? ' unread' : '') + (mutedChannels.has(c.id) ? ' muted' : '') + (overId === c.id && dragId && dragId !== c.id ? ' drop-target' : '') + (dragId === c.id ? ' dragging' : '')}
                 onClick={() => onPickChannel(c.id)}
                 onContextMenu={(e) => {
                   e.preventDefault();
                   window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                   { label: 'Mark as read', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M3 4h10M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Marked all messages in #' + c.name + ' as read.', duration: 2500 } })) },
                   { label: 'Mute kanal', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 6h2l3-3v10l-3-3H2zM10 5l3 3-3 3M13 5l-3 3 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>, onClick: () => { toggleMuteChannel(c.id); window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: (mutedChannels.has(c.id) ? 'Unmuted ' : 'Muted ') + '#' + c.name + '.', duration: 2500 } })); } },
                   { label: 'Copy link', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6 10l4-4M6 6l4 4" stroke="currentColor" strokeWidth="1.4"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/></svg>, onClick: () => { navigator.clipboard?.writeText('dilla://gbg-1/k/' + c.id); window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Link copied.', duration: 2000 } })); } },
                   { sep: true },
                   { label: 'Kanal settings', icon: <Icon.Cog size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Kanal settings: edit topic, slow-mode, member overrides (admin only).', duration: 4000 } })) },
                   { label: 'Leave kanal', danger: true, icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M10 4V2H3v12h7v-2M6 8h9M12 5l3 3-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Left #' + c.name + '.', duration: 2500 } })) },
                 ] } }));
                 }}>
              <span className="ch-glyph"><Icon.Hash size={14} /></span>
              <span className="ch-name">{c.name}</span>
              {mutedChannels.has(c.id) && <span className="ch-muted" title="muted"><svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M2 6h2l3-3v10l-3-3H2zM10 5l3 3-3 3M13 5l-3 3 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg></span>}
              {c.unread > 0 && !mutedChannels.has(c.id) && (
                <span className={'unread-pill' + (c.mention ? ' mention' : '')}>{c.unread}</span>
              )}
            </div>
          ))}

          {otherVoice.length > 0 && (
            <>
              <div className="cat"><span>Voice</span></div>
              {otherVoice.map(c => (
                <div key={c.id}
                     className={'channel-row' + (c.id === activeChannel ? ' active' : '')}
                     onClick={() => onPickChannel(c.id)}
                     onContextMenu={(e) => {
                       e.preventDefault();
                       window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                         { label: 'Join voice', icon: <Icon.Speaker size={13} />, onClick: () => { onPickChannel(c.id); } },
                         { label: 'Copy link', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6 10l4-4M6 6l4 4" stroke="currentColor" strokeWidth="1.4"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/></svg>, onClick: () => { navigator.clipboard?.writeText('dilla://gbg-1/k/' + c.id); window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Voice kanal link copied.', duration: 2000 } })); } },
                         { sep: true },
                         { label: c.locked ? 'Unlock kanal' : 'Lock kanal', icon: <Icon.Lock size={12} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'admin', text: (c.locked ? 'Unlocked ' : 'Locked ') + '#' + c.name + ' — admin-only.', duration: 2800 } })) },
                         { label: 'Kanal settings', icon: <Icon.Cog size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Voice kanal settings: bitrate, region, permissions, codec.', duration: 4000 } })) },
                       ] } }));
                     }}>
                  <span className="ch-glyph"><Icon.Speaker size={14} /></span>
                  <span className="ch-name">{c.name}</span>
                  {c.locked && <span style={{ color: 'var(--fg-3)' }}><Icon.Lock size={11} /></span>}
                </div>
              ))}
            </>
          )}
        </div>
      ) : (
        <div className="side-scroll">
          <div className="cat"><span>Direct Messages</span>
            <div className="cat-actions"><button className="icon-btn" title="New DM" onClick={() => onNewDm && onNewDm()}><Icon.Plus size={12} /></button></div>
          </div>
          {dms.map(d => {
            const isGroup = d.group;
            const other = isGroup ? null : members.byId[d.with];
            const name = isGroup ? d.name : other.name;
            return (
              <div key={d.id}
                   className={'channel-row' + (d.id === activeDM ? ' active' : '') + (d.unread > 0 ? ' unread' : '')}
                   onClick={() => onPickDM(d.id)}
                   onContextMenu={(e) => {
                     e.preventDefault();
                     window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                       { label: 'Mark as read', icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M3 4h10M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'system', text: 'Marked DM as read.', duration: 2000 } })) },
                       { label: 'Mute notifications', icon: <Icon.Mic size={13} off />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'system', text: 'DM muted.', duration: 2000 } })) },
                       { sep: true },
                       { label: 'Close DM', danger: true, icon: null, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'system', text: 'Closed DM. Re-open it from a member profile.', duration: 2500 } })) },
                     ] } }));
                   }}>
                {isGroup ? (
                  <span className="ch-glyph"><Icon.People size={14} /></span>
                ) : (
                  <div className="vp-avatar" style={{ background: other.color, width: 20, height: 20, fontSize: 10 }}>{other.initials}</div>
                )}
                <span className="ch-name">{name}</span>
                {d.unread > 0 && <span className="unread-pill mention">{d.unread}</span>}
              </div>
            );
          })}
        </div>
      )}

      {voiceConnection && (
        <div className="voice-dock">
          <div className="voice-dock-top">
            <div className="voice-dock-status">Voice</div>
            <div className="voice-dock-name">{voiceConnection.channel} · {team.name}</div>
          </div>
          <div className="voice-dock-controls">
            <button className={'vctrl' + (mute ? ' active' : '')} title={mute ? "Unmute" : "Mute"} onClick={() => setMute(!mute)}>
              <Icon.Mic size={14} off={mute} />
            </button>
            <button className={'vctrl' + (deaf ? ' active' : '')} title={deaf ? "Undeafen" : "Deafen"} onClick={() => setDeaf(!deaf)}>
              <Icon.Headphones size={14} off={deaf} />
            </button>
            <button className={'vctrl' + (cam ? ' on' : '')} title={cam ? "Stop camera" : "Start camera"} onClick={() => setCam(!cam)}>
              <Icon.Video size={14} off={!cam} />
            </button>
            <button className={'vctrl' + (screen ? ' on' : '')} title={screen ? "Stop sharing" : "Share screen"} onClick={() => setScreen(!screen)}>
              <Icon.Screen size={14} off={!screen} />
            </button>
            <button className="vctrl danger" title="Disconnect" onClick={onLeaveVoice}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 7c2-2 8-2 10 0v2l-3 1V8.5c-1-.5-3-.5-4 0V10L3 9V7z" fill="currentColor"/></svg>
            </button>
          </div>
        </div>
      )}

      <UserPanel member={members.byId.thim} />
    </aside>
  );
}

function UserPanel({ member }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [status, setStatus] = useState(member.status);
  const [custom, setCustom] = useState(member.custom || '');
  const [draftCustom, setDraftCustom] = useState(custom);
  const popRef = useRef(null);

  useEffect(() => {
    if (!pickerOpen) return;
    function onDoc(e) { if (popRef.current && !popRef.current.contains(e.target)) setPickerOpen(false); }
    function onKey(e) { if (e.key === 'Escape') setPickerOpen(false); }
    setTimeout(() => document.addEventListener('mousedown', onDoc), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [pickerOpen]);

  const statuses = [
    { id: 'online',  label: 'Online',  hint: 'available' },
    { id: 'idle',    label: 'Idle',    hint: 'away · auto after 10 min' },
    { id: 'dnd',     label: 'Do not disturb', hint: 'suppress notifications' },
    { id: 'offline', label: 'Invisible', hint: 'appears offline · still receive messages' },
  ];

  return (
    <div className="user-panel" style={{ position: 'relative' }}>
      <PlainAvatar member={{ ...member, status }} />
      <div className="meta">
        <div className="name">{member.name}</div>
        <div className="sub">{custom || status}</div>
      </div>
      <div className="actions">
        <button className="icon-btn" title="Set status" onClick={() => setPickerOpen(o => !o)}><Icon.Emoji size={13} /></button>
        <button className="icon-btn" title="Preferences" onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-settings', { detail: 'user' }))}>
          <Icon.Cog size={14} />
        </button>
      </div>
      {pickerOpen && (
        <div ref={popRef} className="status-pop">
          <div className="sp-head">Set your status</div>
          {statuses.map(s => (
            <button key={s.id}
                    className={'sp-row' + (s.id === status ? ' on' : '')}
                    onClick={() => { setStatus(s.id); setPickerOpen(false); }}>
              <span className={'presence ' + s.id}></span>
              <span className="sp-label">{s.label}</span>
              <span className="sp-hint">{s.hint}</span>
            </button>
          ))}
          <div className="sp-divider" />
          <div className="sp-custom">
            <div className="sp-custom-label">Custom message</div>
            <div className="sp-custom-row">
              <input value={draftCustom} onChange={(e) => setDraftCustom(e.target.value)} placeholder="pushing pixels" maxLength={42} />
              <button className="sp-btn" onClick={() => { setCustom(draftCustom); setPickerOpen(false); }}>Set</button>
            </div>
            {custom && (
              <button className="sp-clear" onClick={() => { setCustom(''); setDraftCustom(''); }}>clear</button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ───────────── main pane: text channel ─────────────
function TextChannel({ channel, messages, members, dmPartner, draft, setDraft, onSend, onReact, onVote, onEdit, onDelete, onAttach, replyTo, onSetReply, typing, onJoinVoice, membersOpen, onToggleMembers }) {
  const groups = useMemo(() => groupMessages(messages), [messages]);
  const feedRef = useRef(null);
  const emojiBtnRef = useRef(null);
  const textareaRef = useRef(null);
  const [picker, setPicker] = useState({ open: false, anchor: null, target: 'draft' });
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [forwardId, setForwardId] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState([]);
  const [unreadAt, setUnreadAt] = useState(null);
  const [mention, setMention] = useState(null); // { query }
  const [mentionIdx, setMentionIdx] = useState(0);
  const [slash, setSlash] = useState(null); // { query }
  const [slashIdx, setSlashIdx] = useState(0);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, msgId }
  const [savedMsgs, setSavedMsgs] = useState(new Set());
  const [savedOpen, setSavedOpen] = useState(false);
  const [showJump, setShowJump] = useState(false);

  // Mock-pinned message IDs per channel
  const PINNED_BY_CHANNEL = { design: ['m7', 'm12'], dev: ['d1'], general: [], mesh: [], random: [], 'dm-ada': [] };
  const pinnedMsgs = (PINNED_BY_CHANNEL[channel.id] || [])
    .map(id => messages.find(m => m.id === id))
    .filter(Boolean);
  function saveEdit() {
    if (onEdit && editingId) onEdit(editingId, editDraft.trim());
    setEditingId(null);
  }
  const deleteTarget = deleteConfirm ? messages.find(m => m.id === deleteConfirm) : null;

  const mentionMatches = mention
    ? (members.MEMBERS || []).filter(m => m.name.toLowerCase().startsWith(mention.query) && m.id !== 'thim').slice(0, 6)
    : [];

  const SLASH_COMMANDS = [
    { cmd: '/me',      args: '<action>',  desc: 'narrate an action in italics' },
    { cmd: '/code',    args: '<language>', desc: 'start a code block' },
    { cmd: '/shrug',   args: '',          desc: "appends ¯\\_(ツ)_/¯" },
    { cmd: '/poll',    args: '<question> | <opt1> | <opt2>', desc: 'create a quick poll' },
    { cmd: '/giphy',   args: '<search>',  desc: 'embed a gif' },
    { cmd: '/remind',  args: '<when> <what>', desc: 'set a personal reminder' },
    { cmd: '/topic',   args: '<text>',    desc: 'set the kanal topic (admin)' },
    { cmd: '/invite',  args: '<user>',    desc: 'invite to the team' },
    { cmd: '/dm',      args: '<user>',    desc: 'open a private message' },
    { cmd: '/help',    args: '',          desc: 'show all keyboard shortcuts' },
  ];
  const slashMatches = slash
    ? SLASH_COMMANDS.filter(s => s.cmd.startsWith('/' + slash.query)).slice(0, 8)
    : [];

  function applyMention(name) {
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = draft.slice(0, pos);
    const after = draft.slice(pos);
    const newBefore = before.replace(/@\w*$/, '@' + name + ' ');
    const next = newBefore + after;
    setDraft(next);
    setMention(null);
    setMentionIdx(0);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const newPos = newBefore.length;
        textareaRef.current.setSelectionRange(newPos, newPos);
      }
    }, 0);
  }
  function applySlash(cmd) {
    const next = cmd.cmd + (cmd.args ? ' ' : '');
    setDraft(next);
    setSlash(null);
    setSlashIdx(0);
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const newPos = next.length;
        textareaRef.current.setSelectionRange(newPos, newPos);
      }
    }, 0);
  }

  function fakeAttach(name = 'screenshot.png', size = 240 * 1024) {
    const id = 'up-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const upload = { id, name, size, progress: 0, phase: 'reading' };
    setUploads(prev => [...prev, upload]);
    const phases = [
      { ms: 200,  p: 18, phase: 'reading' },
      { ms: 300,  p: 42, phase: 'encrypting' },
      { ms: 350,  p: 68, phase: 'uploading' },
      { ms: 250,  p: 88, phase: 'uploading' },
      { ms: 250,  p: 100, phase: 'sealed' },
    ];
    let acc = 0;
    phases.forEach((ph) => {
      acc += ph.ms;
      setTimeout(() => {
        setUploads(prev => prev.map(u => u.id === id ? { ...u, progress: ph.p, phase: ph.phase } : u));
      }, acc);
    });
    setTimeout(() => {
      setUploads(prev => prev.filter(u => u.id !== id));
      if (onAttach) onAttach({ name, size });
    }, acc + 600);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length === 0) {
      fakeAttach('dropped.png', 320 * 1024);
    } else {
      files.forEach(f => fakeAttach(f.name, f.size));
    }
  }
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [messages.length, channel.id]);

  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    function onScroll() {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowJump(dist > 120);
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [channel.id]);

  function scrollToBottom() {
    if (feedRef.current) feedRef.current.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
  }

  // Compute day dividers
  const dividers = useMemo(() => {
    const map = {};
    groups.forEach((g, i) => {
      const k = g.at.toDateString();
      if (!map[k]) map[k] = i;
    });
    return map;
  }, [groups]);
  const seenDays = new Set();

  return (
    <div className="main">
      <div className="main-head">
        <div className="ch-title">
          {channel.type === 'dm' ? (
            channel.group ? (
              <><Icon.People size={15} /><span>{channel.name}</span></>
            ) : dmPartner ? (
              <>
                <span className="dm-avatar" style={{ background: dmPartner.color }}>
                  {dmPartner.initials}
                  <span className={'presence ' + dmPartner.status}></span>
                </span>
                <span>{dmPartner.name}</span>
              </>
            ) : (
              <><Icon.Chat size={15} /><span>{channel.name}</span></>
            )
          ) : (
            <>
              <Icon.Hash size={15} />
              <span>{channel.name}</span>
            </>
          )}
          {channel.encrypted && <span className="enc-badge"><Icon.Shield size={10} /> E2E</span>}
        </div>
        <div className="ch-topic">{channel.topic}</div>
        <div className="head-actions">
          {channel.type !== 'dm' && (
            <div style={{ position: 'relative' }}>
              <button className={'icon-btn' + (threadsOpen ? ' active' : '')}
                      title="Threads in this kanal"
                      onClick={() => setThreadsOpen(o => !o)}>
                <Icon.Thread size={14} />
              </button>
              {threadsOpen && (() => {
                const threads = messages.filter(m => m.thread);
                return (
                  <div className="pin-pop">
                    <div className="pin-head">
                      <span>Threads in #{channel.name}</span>
                      <button className="pin-x" onClick={() => setThreadsOpen(false)}>×</button>
                    </div>
                    {threads.length === 0 ? (
                      <div className="pin-empty">no active threads yet · click the thread icon on any message to start one</div>
                    ) : (
                      <div className="pin-list">
                        {threads.map(tm => {
                          const a = members.byId[tm.author] || { name: tm.author, color: '#666', initials: '??' };
                          return (
                            <div key={tm.id} className="pin-row"
                                 onClick={() => {
                                   setThreadsOpen(false);
                                   window.dispatchEvent(new CustomEvent('dilla:open-thread', { detail: { channelId: channel.id, messageId: tm.id } }));
                                 }}>
                              <div className="pin-av" style={{ background: a.color }}>{a.initials}</div>
                              <div>
                                <div className="pin-meta">
                                  <span className="pin-author">{a.name}</span>
                                  <span className="pin-time">· {timeShort(tm.at)}</span>
                                </div>
                                <div className="pin-text">{tm.text}</div>
                                <div className="th-foot">
                                  <span className="th-count">↪ {tm.thread.count} replies</span>
                                  <span className="th-sep">·</span>
                                  <span className="th-last">last {timeShort(tm.thread.lastReplyAt)}</span>
                                  <div className="th-avs">
                                    {(tm.thread.participants || []).map(pid => {
                                      const p = members.byId[pid];
                                      if (!p) return null;
                                      return <div key={pid} className="rr-av" style={{ background: p.color, marginLeft: -4 }}>{p.initials}</div>;
                                    })}
                                  </div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          )}
          {channel.type !== 'dm' && (
            <div style={{ position: 'relative' }}>
              <button className={'icon-btn' + (savedOpen ? ' active' : '')}
                      title={`Saved messages${savedMsgs.size ? ' (' + savedMsgs.size + ')' : ''}`}
                      onClick={() => setSavedOpen(o => !o)}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 2v12l4-3 4 3V2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
              </button>
              {savedOpen && (
                <div className="pin-pop">
                  <div className="pin-head">
                    <span>Saved messages · all kanals</span>
                    <button className="pin-x" onClick={() => setSavedOpen(false)}>×</button>
                  </div>
                  {savedMsgs.size === 0 ? (
                    <div className="pin-empty">no saved messages yet · right-click a message to bookmark it</div>
                  ) : (
                    <div className="pin-list">
                      {Array.from(savedMsgs).map(sid => {
                        let msg = null, chanName = '';
                        for (const [chId, list] of Object.entries(data.MESSAGES)) {
                          const f = list.find(x => x.id === sid);
                          if (f) { msg = f; chanName = chId; break; }
                        }
                        if (!msg) return null;
                        const a = data.byId[msg.author] || { name: msg.author, color: '#666', initials: '??' };
                        return (
                          <div key={sid} className="pin-row" onClick={() => { setSavedOpen(false); setActiveChannel(chanName); setActiveView({ kind: 'channel', id: chanName }); }}>
                            <div className="pin-av" style={{ background: a.color }}>{a.initials}</div>
                            <div>
                              <div className="pin-meta"><span className="pin-author">{a.name}</span> <span className="pin-time">· #{chanName} · {timeShort(msg.at)}</span></div>
                              <div className="pin-text">{msg.text}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {channel.type !== 'dm' && (
            <div style={{ position: 'relative' }}>
              <button className={'icon-btn' + (pinnedOpen ? ' active' : '')}
                      title={`Pinned messages${pinnedMsgs.length ? ' (' + pinnedMsgs.length + ')' : ''}`}
                      onClick={() => setPinnedOpen(o => !o)}>
                <Icon.Pin />
              </button>
              {pinnedOpen && (
                <div className="pin-pop" onMouseLeave={() => {}}>
                  <div className="pin-head">
                    <span>Pinned in #{channel.name}</span>
                    <button className="pin-x" onClick={() => setPinnedOpen(false)}>×</button>
                  </div>
                  {pinnedMsgs.length === 0 ? (
                    <div className="pin-empty">no pinned messages yet · pin one via the message menu</div>
                  ) : (
                    <div className="pin-list">
                      {pinnedMsgs.map(pm => {
                        const a = members.byId[pm.author] || { name: pm.author, color: '#666', initials: '??' };
                        return (
                          <div key={pm.id} className="pin-row" onClick={() => setPinnedOpen(false)}>
                            <div className="pin-av" style={{ background: a.color }}>{a.initials}</div>
                            <div>
                              <div className="pin-meta"><span className="pin-author">{a.name}</span> <span className="pin-time">· {timeShort(pm.at)}</span></div>
                              <div className="pin-text">{pm.text}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {channel.type !== 'dm' && <button className={'icon-btn' + (membersOpen ? '' : ' off')}
                  title={membersOpen ? 'Hide members' : 'Show members'}
                  onClick={onToggleMembers}>
            <Icon.People size={14} />
          </button>}
          <div className="search-box" role="button" tabIndex={0}
               onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-search', { detail: { scopeChannel: channel.id, scopeName: channel.name } }))}>
            <Icon.Search size={13} />
            <span>{channel.type === 'dm' ? 'Search this DM…' : 'Search in #' + channel.name + '…'}</span>
            <span style={{ marginLeft: 'auto', fontFamily: 'var(--font-mono)', fontSize: 10, opacity: 0.7 }}>/</span>
          </div>
        </div>
      </div>

      <div className="feed" ref={feedRef}>
        {groups.length === 0 ? (
          <EmptyFeed channel={channel} dmPartner={dmPartner} />
        ) : groups.map((g, i) => {
          const dayKey = g.at.toDateString();
          const showDay = !seenDays.has(dayKey);
          seenDays.add(dayKey);
          const showUnreadAbove = unreadAt && g.children && g.children[0] && g.children[0].id === unreadAt;
          const author = members.byId[g.author] || { name: g.author, color: '#666', initials: '??' };
          if (g.base.kind === 'system') {
            return (
              <React.Fragment key={i}>
                {showDay && <div className="day-divider">{dayLabel(g.at)}</div>}
                <div className="msg system">
                  <div></div>
                  <div>
                    <div className="body">— {g.base.text}</div>
                    {g.base.meta && <div className="meta">{g.base.meta}</div>}
                  </div>
                </div>
              </React.Fragment>
            );
          }
          return (
            <React.Fragment key={i}>
              {showDay && <div className="day-divider">{dayLabel(g.at)}</div>}
              {showUnreadAbove && (
                <div className="unread-divider"><span>new</span></div>
              )}
              {g.children.map((m, idx) => {
                const isFirst = idx === 0;
                const hasMention = (m.mentions || []).includes('thim');
                return (
                  <div key={m.id}
                       className={'msg' + (isFirst ? '' : ' compact') + (hasMention ? ' has-mention' : '') + (m.replyTo ? ' has-reply' : '')}
                       data-msg-id={m.id}
                       onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, msgId: m.id, isMine: m.author === 'thim' }); }}>
                    {m.replyTo && (() => {
                      const orig = messages.find(om => om.id === m.replyTo);
                      if (!orig) return null;
                      const oa = members.byId[orig.author] || { name: orig.author, color: '#666', initials: '??' };
                      return (
                        <div className="reply-ref"
                             onClick={() => {
                               const el = feedRef.current && feedRef.current.querySelector('[data-msg-id="' + orig.id + '"]');
                               if (el) {
                                 el.classList.add('msg-flash');
                                 el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                 setTimeout(() => el.classList.remove('msg-flash'), 1400);
                               }
                             }}>
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M5 9L1 5l4-4M1 5h8a4 4 0 014 4v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          <span className="rr-av" style={{ background: oa.color }}>{oa.initials}</span>
                          <span className="rr-author">{oa.name}</span>
                          <span className="rr-text">{(orig.text || '').slice(0, 80)}{(orig.text||'').length > 80 ? '…' : ''}</span>
                        </div>
                      );
                    })()}
                    {isFirst ? (
                      <span style={{ cursor: 'pointer' }} onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect();
                        window.dispatchEvent(new CustomEvent('dilla:open-profile', {
                          detail: { memberId: author.id || g.author, x: r.right + 8, y: r.top }
                        }));
                      }}><Avatar member={author} /></span>
                    ) : (
                      <div style={{ position: 'relative' }}>
                        <span style={{ position: 'absolute', right: 6, top: 4, fontFamily: 'var(--font-mono)', fontSize: 9.5, color: 'var(--fg-3)', opacity: 0 }}
                              className="hover-time">{timeShort(m.at)}</span>
                      </div>
                    )}
                    <div>
                      {isFirst && (
                        <div className="head">
                          <span className="author"
                                onClick={(e) => {
                                  const r = e.currentTarget.getBoundingClientRect();
                                  window.dispatchEvent(new CustomEvent('dilla:open-profile', {
                                    detail: { memberId: author.id || g.author, x: r.left, y: r.bottom + 4 }
                                  }));
                                }}>{author.name}</span>
                          <span className="at">{timeShort(m.at)}</span>
                          {m.author === 'thim' && (
                            <span className="msg-seen" title="seen by ada, mira, ben">
                              <svg width="14" height="10" viewBox="0 0 14 10" fill="none">
                                <path d="M1 5l3 3 6-6M5 5l3 3 5-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            </span>
                          )}
                          {author.role === 'admin' && <span className="enc-badge" style={{ fontSize: 9, padding: '1px 5px' }}>admin</span>}
                        </div>
                      )}
                      <div className="body">
                        {editingId === m.id ? (
                          <div className="msg-edit">
                            <textarea autoFocus value={editDraft}
                                      onChange={e => setEditDraft(e.target.value)}
                                      onKeyDown={e => {
                                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
                                        if (e.key === 'Escape') setEditingId(null);
                                      }}
                                      rows={Math.min(6, (editDraft.match(/\n/g) || []).length + 1)} />
                            <div className="msg-edit-actions">
                              <button onClick={() => setEditingId(null)}>Cancel · esc</button>
                              <button className="primary" onClick={saveEdit} disabled={!editDraft.trim()}>Save · ↵</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {m.kind === 'image' && m.text && <div style={{ marginBottom: 4 }}>{renderText(m.text, members)}</div>}
                            {m.kind === 'image' && (
                              <div className="attach">
                                <div className="attach-img" style={{ background: m.attachment?.tint }}></div>
                                <div className="attach-name">{m.attachment?.label} · 240 KB</div>
                              </div>
                            )}
                            {m.kind === 'text' && renderText(m.text, members)}
                            {m.kind === 'action' && (
                              <span className="msg-action">
                                <em>* {author.name} {m.text}</em>
                              </span>
                            )}
                            {m.kind === 'poll' && (
                              <div className="msg-poll">
                                <div className="poll-q">{m.question}</div>
                                {(() => {
                                  const total = m.options.reduce((s, o) => s + (o.votes || 0), 0) || 1;
                                  return m.options.map((o, oi) => (
                                    <div key={oi}
                                         className={'poll-opt' + (o.mine ? ' mine' : '')}
                                         onClick={() => onVote && onVote(m.id, oi)}>
                                      <div className="poll-bar" style={{ width: ((o.votes || 0) / total * 100) + '%' }} />
                                      <span className="poll-label">{o.label}</span>
                                      <span className="poll-count">{o.votes || 0}</span>
                                    </div>
                                  ));
                                })()}
                                <div className="poll-foot">click to vote · {m.options.reduce((s, o) => s + (o.votes || 0), 0)} votes</div>
                              </div>
                            )}
                            {m.kind === 'giphy' && (
                              <div className="msg-giphy">
                                <div className="giphy-img" style={{ background: `linear-gradient(135deg, hsl(${m.query.length * 37 % 360} 60% 30%), hsl(${(m.query.length * 37 + 60) % 360} 60% 50%))` }}>
                                  <div className="giphy-watermark">GIPHY</div>
                                </div>
                                <div className="giphy-meta">/giphy · "{m.query}"</div>
                              </div>
                            )}
                            {m.kind === 'text' && detectUnfurls(m.text).map((u, ui) => (
                              <Unfurl key={ui} url={u.url} host={u.host} />
                            ))}
                            {m.edited && <span className="msg-edited" title={'edited ' + (m.editedAt ? timeShort(new Date(m.editedAt)) : '')}>(edited)</span>}
                          </>
                        )}
                      </div>
                      {m.reactions && m.reactions.length > 0 && (
                        <div className="rxns">
                          {m.reactions.map((r, ri) => (
                            <span key={ri}
                                  className={'rxn' + (r.mine ? ' mine' : '')}
                                  title={r.mine ? 'click to remove' : 'click to add yours'}
                                  onClick={() => onReact && onReact(m.id, r.e)}>
                              <span>{r.e}</span><span>{r.n}</span>
                            </span>
                          ))}
                          <span className="rxn rxn-add"
                                title="Add reaction"
                                onClick={(e) => {
                                  const anchor = e.currentTarget.getBoundingClientRect();
                                  setPicker({ open: true, anchor, target: 'react:' + m.id });
                                }}>
                            <Icon.Emoji size={11} />
                          </span>
                        </div>
                      )}
                      {m.thread && (
                        <div className="thread-preview"
                             onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-thread', {
                               detail: { channelId: channel.id, messageId: m.id }
                             }))}>
                          <div className="thread-stack">
                            {m.thread.participants.map(pid => {
                              const p = members.byId[pid];
                              return <div key={pid} className="avatar" style={{ background: p.color }}>{p.initials}</div>;
                            })}
                          </div>
                          <span style={{ fontWeight: 600 }}>{m.thread.count} replies</span>
                          <span style={{ color: 'var(--fg-3)' }}>· last {timeShort(m.thread.lastReplyAt)}</span>
                        </div>
                      )}
                    </div>
                    <div className="msg-tools">
                      <button title="Add reaction"
                              onClick={(e) => {
                                const anchor = e.currentTarget.getBoundingClientRect();
                                setPicker({ open: true, anchor, target: 'react:' + m.id });
                              }}>
                        <Icon.Emoji size={13} />
                      </button>
                      <button title="Reply"
                              onClick={() => {
                                if (onSetReply) onSetReply(m.id);
                                if (textareaRef.current) textareaRef.current.focus();
                              }}>
                        <Icon.Reply size={12} />
                      </button>
                      <button title="Open thread"
                              onClick={() => window.dispatchEvent(new CustomEvent('dilla:open-thread', {
                                detail: { channelId: channel.id, messageId: m.id }
                              }))}>
                        <Icon.Thread size={13} />
                      </button>
                      {m.author === 'thim' && (
                        <button title="Edit"
                                onClick={() => { setEditingId(m.id); setEditDraft(m.text || ''); }}>
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                            <path d="M11.5 1.5l3 3L5 14H2v-3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                          </svg>
                        </button>
                      )}
                      {m.author === 'thim' && (
                        <button title="Delete"
                                onClick={() => setDeleteConfirm(m.id)}>
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                            <path d="M3 4h10M5 4V2.5h6V4M6 7v5M10 7v5M4 4l1 10h6l1-10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </React.Fragment>
          );
        })}
      </div>

      <div className="composer-wrap">
        {showJump && (
          <button className="jump-btn" onClick={scrollToBottom} title="Jump to latest">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v10M3 8l5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            scroll to latest
          </button>
        )}
        {replyTo && (() => {
          const orig = messages.find(om => om.id === replyTo);
          if (!orig) return null;
          const oa = members.byId[orig.author] || { name: orig.author, color: '#666', initials: '??' };
          return (
            <div className="reply-chip">
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M5 9L1 5l4-4M1 5h8a4 4 0 014 4v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
              <span className="rc-label">Replying to</span>
              <span className="rc-av" style={{ background: oa.color }}>{oa.initials}</span>
              <span className="rc-author">{oa.name}</span>
              <span className="rc-text">{(orig.text || '').slice(0, 90)}{(orig.text||'').length > 90 ? '…' : ''}</span>
              <button className="rc-x" onClick={() => onSetReply && onSetReply(null)} title="Cancel reply (esc)">×</button>
            </div>
          );
        })()}
        {uploads.length > 0 && (
          <div className="upload-tray">
            {uploads.map(u => (
              <div key={u.id} className="upload-row">
                <div className="up-icon"><Icon.Shield size={12} /></div>
                <div className="up-body">
                  <div className="up-name">{u.name}</div>
                  <div className="up-bar">
                    <div className="up-fill" style={{ width: u.progress + '%' }} />
                  </div>
                  <div className="up-meta">
                    <span className="up-phase">{u.phase}</span>
                    <span>·</span>
                    <span>{Math.round((u.size / 1024) * (u.progress / 100))} / {Math.round(u.size / 1024)} KB</span>
                    <span>·</span>
                    <span>{u.progress}%</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="composer">
          <div className="composer-input">
            <button className="icon-btn comp-btn" title="Attach a file or image" onClick={() => fakeAttach()}><Icon.Attach size={15} /></button>
            <div className="composer-textwrap">
              {mention && mentionMatches.length > 0 && (
                <div className="mention-pop">
                  <div className="mention-head">members in this kanal · ↑↓ navigate · ⇥/↵ pick · esc cancel</div>
                  {mentionMatches.map((m, i) => (
                    <div key={m.id}
                         className={'mention-row' + (i === mentionIdx ? ' selected' : '')}
                         onMouseEnter={() => setMentionIdx(i)}
                         onMouseDown={(e) => { e.preventDefault(); applyMention(m.name); }}>
                      <div className="mention-av" style={{ background: m.color }}>{m.initials}</div>
                      <div className="mention-name">{m.name}</div>
                      {m.custom && <div className="mention-status">{m.custom}</div>}
                      <div className="mention-presence"><span className={'presence ' + m.status}></span></div>
                    </div>
                  ))}
                </div>
              )}
              {slash && slashMatches.length > 0 && (
                <div className="mention-pop slash-pop">
                  <div className="mention-head">slash commands · ↑↓ navigate · ⇥/↵ pick · esc cancel</div>
                  {slashMatches.map((s, i) => (
                    <div key={s.cmd}
                         className={'slash-row' + (i === slashIdx ? ' selected' : '')}
                         onMouseEnter={() => setSlashIdx(i)}
                         onMouseDown={(e) => { e.preventDefault(); applySlash(s); }}>
                      <div className="slash-cmd">{s.cmd}</div>
                      {s.args && <div className="slash-args">{s.args}</div>}
                      <div className="slash-desc">{s.desc}</div>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                placeholder={channel.type === 'dm' ? `Message ${channel.name}` : `Message #${channel.name}`}
                value={draft}
                onChange={e => {
                  const v = e.target.value;
                  setDraft(v);
                  const pos = e.target.selectionStart;
                  const before = v.slice(0, pos);
                  const mm = before.match(/(?:^|\s)@(\w*)$/);
                  const sm = before.match(/^\/(\w*)$/);
                  if (mm) { setMention({ query: mm[1].toLowerCase() }); setMentionIdx(0); setSlash(null); }
                  else if (sm) { setSlash({ query: sm[1].toLowerCase() }); setSlashIdx(0); setMention(null); }
                  else { setMention(null); setSlash(null); }
                }}
                onKeyDown={e => {
                  if (mention && mentionMatches.length > 0) {
                    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                      e.preventDefault();
                      applyMention(mentionMatches[mentionIdx].name);
                      return;
                    }
                    if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIdx(i => Math.min(mentionMatches.length - 1, i + 1)); return; }
                    if (e.key === 'ArrowUp')   { e.preventDefault(); setMentionIdx(i => Math.max(0, i - 1)); return; }
                    if (e.key === 'Escape')    { e.preventDefault(); setMention(null); return; }
                  }
                  if (slash && slashMatches.length > 0) {
                    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                      e.preventDefault();
                      applySlash(slashMatches[slashIdx]);
                      return;
                    }
                    if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx(i => Math.min(slashMatches.length - 1, i + 1)); return; }
                    if (e.key === 'ArrowUp')   { e.preventDefault(); setSlashIdx(i => Math.max(0, i - 1)); return; }
                    if (e.key === 'Escape')    { e.preventDefault(); setSlash(null); return; }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (draft.trim()) onSend();
                  }
                }}
                rows={1}
              />
            </div>
            <div className="composer-tools">
              <button ref={emojiBtnRef} className="icon-btn comp-btn" title="Add an emoji"
                      onClick={() => {
                        const anchor = emojiBtnRef.current ? emojiBtnRef.current.getBoundingClientRect() : null;
                        setPicker(p => p.open && p.target === 'draft' ? { ...p, open: false } : { open: true, anchor, target: 'draft' });
                      }}>
                <Icon.Emoji size={15} />
              </button>
            </div>
            <button className="send-btn" disabled={!draft.trim()} onClick={onSend} title="Send (↵)">
              <Icon.Send size={14} />
            </button>
          </div>
          <div className="composer-typing">
            {typing.length > 0 ? (
              <>{typing.join(', ')} {typing.length === 1 ? 'is' : 'are'} typing<span className="dot">.</span><span className="dot">.</span><span className="dot">.</span></>
            ) : (
              <span style={{ opacity: 0.6 }}>
                <Icon.Shield size={10} /> messages are end-to-end encrypted with Signal Protocol
              </span>
            )}
          </div>
        </div>
      </div>
      <EmojiPicker
        open={picker.open}
        anchorRect={picker.anchor}
        onClose={() => setPicker(p => ({ ...p, open: false }))}
        onPick={(e) => {
          if (picker.target === 'draft') {
            setDraft(draft + e);
          } else if (picker.target.startsWith('react:')) {
            const msgId = picker.target.slice(6);
            if (onReact) onReact(msgId, e);
          }
          setPicker(p => ({ ...p, open: false }));
        }}
      />
      {forwardId && (() => {
        const m = messages.find(x => x.id === forwardId);
        if (!m) return null;
        return (
          <ForwardModal
            sourceMsg={m}
            members={members}
            onClose={() => setForwardId(null)}
            onForward={(target) => {
              const ch = (members.byId[target.slice(3)] && target.startsWith('dm-')) ? target : target;
              const name = target.startsWith('dm-') ? members.byId[target.slice(3)]?.name : ('#' + target);
              window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: target.startsWith('dm-') ? null : target, author: 'system', text: 'Forwarded message to ' + name + '.', duration: 3000 } }));
              setForwardId(null);
            }}
          />
        );
      })()}
      {contextMenu && (
        <div className="ctx-overlay" onClick={() => setContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}>
          <div className="ctx-menu"
               style={{ left: Math.min(contextMenu.x, window.innerWidth - 220), top: Math.min(contextMenu.y, window.innerHeight - 320) }}
               onClick={e => e.stopPropagation()}>
            <button onClick={(e) => {
              const anchor = e.currentTarget.getBoundingClientRect();
              setPicker({ open: true, anchor, target: 'react:' + contextMenu.msgId });
              setContextMenu(null);
            }}>
              <Icon.Emoji size={13} /> Add reaction
            </button>
            <button onClick={() => {
              window.dispatchEvent(new CustomEvent('dilla:open-thread', { detail: { channelId: channel.id, messageId: contextMenu.msgId } }));
              setContextMenu(null);
            }}>
              <Icon.Thread size={13} /> Reply in thread
            </button>
            <button><Icon.Reply size={12} /> Quote reply</button>
            <button onClick={() => {
              const wasIn = savedMsgs.has(contextMenu.msgId);
              setSavedMsgs(prev => {
                const next = new Set(prev);
                if (next.has(contextMenu.msgId)) next.delete(contextMenu.msgId);
                else next.add(contextMenu.msgId);
                return next;
              });
              window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'saved', text: wasIn ? 'Removed from saved messages.' : 'Saved. Find it in your bookmarks.', duration: 2200 } }));
              setContextMenu(null);
            }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4 2v12l4-3 4 3V2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/></svg>
              {savedMsgs.has(contextMenu.msgId) ? 'Remove bookmark' : 'Save message'}
            </button>
            <button onClick={() => { setForwardId(contextMenu.msgId); setContextMenu(null); }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 8h11l-3-3M13 8l-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Forward to…
            </button>
            <div className="ctx-sep" />
            <button>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 2v12l5-3 5 3V2z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round"/></svg>
              Pin to channel
            </button>
            <button onClick={() => { setUnreadAt(contextMenu.msgId); setContextMenu(null); }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 8h10M3 4h10M3 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
              Mark unread from here
            </button>
            <button onClick={() => {
              navigator.clipboard?.writeText(`dilla://gbg-1.dilla.local/channels/${channel.id}/messages/${contextMenu.msgId}`);
              window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { kind: 'message', channel: channel.name, author: 'system', text: 'Link copied to clipboard.', duration: 3000 } }));
              setContextMenu(null);
            }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M6 10l4-4M6 6l4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/><circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3"/></svg>
              Copy link to message
            </button>
            {contextMenu.isMine && <div className="ctx-sep" />}
            {contextMenu.isMine && (
              <button onClick={() => {
                const msg = messages.find(m => m.id === contextMenu.msgId);
                if (msg) { setEditingId(msg.id); setEditDraft(msg.text || ''); }
                setContextMenu(null);
              }}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M11.5 1.5l3 3L5 14H2v-3z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
                Edit message
              </button>
            )}
            {contextMenu.isMine && (
              <button className="danger" onClick={() => { setDeleteConfirm(contextMenu.msgId); setContextMenu(null); }}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M3 4h10M5 4V2.5h6V4M6 7v5M10 7v5M4 4l1 10h6l1-10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/></svg>
                Delete message
              </button>
            )}
          </div>
        </div>
      )}
      {deleteTarget && (
        <div className="confirm-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="confirm-dialog" onClick={e => e.stopPropagation()}>
            <div className="cd-head">
              <div className="cd-icon">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                  <path d="M3 4h10M5 4V2.5h6V4M6 7v5M10 7v5M4 4l1 10h6l1-10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div>
                <h3>Delete message?</h3>
                <p>This removes it for everyone in the kanal. Other peer nodes will be told to drop it on their next sync.</p>
              </div>
            </div>
            <blockquote className="cd-preview">{deleteTarget.text}</blockquote>
            <div className="cd-actions">
              <button className="cd-btn" onClick={() => setDeleteConfirm(null)}>Cancel · esc</button>
              <button className="cd-btn danger" autoFocus
                      onClick={() => {
                        if (onDelete) onDelete(deleteConfirm);
                        setDeleteConfirm(null);
                      }}>Delete · ↵</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function renderText(text, members) {
  if (!text) return null;
  // Split by triple-backtick code fences first.
  const fenceRe = /```([a-z]*)\n?([\s\S]*?)```/g;
  const blocks = [];
  let lastIdx = 0;
  let fm;
  while ((fm = fenceRe.exec(text)) !== null) {
    if (fm.index > lastIdx) blocks.push({ type: 'inline', text: text.slice(lastIdx, fm.index) });
    blocks.push({ type: 'code', lang: fm[1], text: fm[2] });
    lastIdx = fm.index + fm[0].length;
  }
  if (lastIdx < text.length) blocks.push({ type: 'inline', text: text.slice(lastIdx) });

  return blocks.map((b, bi) => {
    if (b.type === 'code') {
      return (
        <pre key={bi} className="code-block">
          {b.lang && <span className="cb-lang">{b.lang}</span>}
          <code>{b.text}</code>
        </pre>
      );
    }
    // Inline pass: @mentions, `code`, **bold**, URLs
    const parts = [];
    let i = 0;
    const re = /(@\w+|`[^`]+`|\*\*[^*]+\*\*|https?:\/\/[^\s)]+)/g;
    let m;
    while ((m = re.exec(b.text)) !== null) {
      if (m.index > i) parts.push(b.text.slice(i, m.index));
      const t = m[0];
      if (t.startsWith('@')) {
        const mine = t === '@thim';
        const broad = t === '@everyone' || t === '@here';
        parts.push(
          <span key={bi + '-' + parts.length}
                className={'ic ic-mention' + (mine ? ' ic-mention-mine' : '') + (broad ? ' ic-mention-broad' : '')}
                style={{ color: 'var(--mention)', background: broad ? 'color-mix(in oklab, var(--mention) 28%, transparent)' : 'color-mix(in oklab, var(--mention) 15%, transparent)' }}>
            {t}
          </span>
        );
      }
      else if (t.startsWith('`'))  parts.push(<code key={bi + '-' + parts.length}>{t.slice(1,-1)}</code>);
      else if (t.startsWith('**')) parts.push(<strong key={bi + '-' + parts.length}>{t.slice(2,-2)}</strong>);
      else if (t.startsWith('http')) parts.push(
        <a key={bi + '-' + parts.length} href={t} target="_blank" rel="noopener noreferrer" className="ic-link">{t}</a>
      );
      i = m.index + t.length;
    }
    if (i < b.text.length) parts.push(b.text.slice(i));
    return <span key={bi}>{parts}</span>;
  });
}

// Mock unfurl content keyed by hostname — Dilla repo + a couple of others.
// Match the host exactly (or as a subdomain). Using includes() would
// accept evilgithub.com / github.com.evil.com etc.; CodeQL flagged it
// as incomplete-url-substring-sanitization.
function isHost(host, suffix) {
  return host === suffix || host.endsWith('.' + suffix);
}
function mockUnfurl(host, url) {
  if (isHost(host, 'github.com')) {
    if (url.includes('/pull/')) return {
      title: 'PR #47 · voice-dock: tighten audio meter polling',
      desc: 'ada wants to merge 6 commits into main. +112 −38. Reviewers: thim · sven.',
      kind: 'github',
      meta: 'github · 6 commits · 4 files',
    };
    return {
      title: 'dilla-chat/dilla-chat',
      desc: 'Self-hosted, end-to-end encrypted chat — built in Gothenburg.',
      kind: 'github',
      meta: 'github · rust + react · agpl-3.0',
    };
  }
  if (isHost(host, 'figma.com')) return {
    title: 'channel-list refinements · v3',
    desc: 'last edited by mira · 4 frames',
    kind: 'figma',
    meta: 'figma',
  };
  return { title: url.replace(/^https?:\/\//, ''), desc: '', kind: 'web', meta: host };
}
function Unfurl({ url, host }) {
  const info = mockUnfurl(host, url);
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className={'unfurl unfurl-' + info.kind}>
      <div className="uf-side" />
      <div className="uf-body">
        <div className="uf-host">{info.meta}</div>
        <div className="uf-title">{info.title}</div>
        {info.desc && <div className="uf-desc">{info.desc}</div>}
      </div>
    </a>
  );
}
function detectUnfurls(text) {
  if (!text) return [];
  // Skip URLs inside triple-backtick code fences
  const stripped = text.replace(/```[\s\S]*?```/g, '');
  const re = /https?:\/\/([^\s/?#)]+)([^\s)]*)?/g;
  const out = [];
  let m;
  while ((m = re.exec(stripped)) !== null) {
    out.push({ url: m[0], host: m[1] });
    if (out.length >= 2) break;
  }
  return out;
}

// ───────────── main pane: voice channel ─────────────
function VoiceChannel({ channel, members, voiceConnection, onJoin, onLeave, mute, setMute, deaf, setDeaf, cam, setCam, screen, setScreen, rich, membersOpen, onToggleMembers }) {
  const nodes = (window.MeshChrome && window.MeshChrome.MEMBER_NODES) || {};
  const participants = (channel.participants || []).map(id => members.byId[id]);
  const isConnected = voiceConnection && voiceConnection.channelId === channel.id;
  const [focusedId, setFocusedId] = useState(null);
  const [volumes, setVolumes] = useState({}); // memberId -> 0..100
  function vol(id) { return volumes[id] === undefined ? 100 : volumes[id]; }
  // Anyone currently sharing screen (for the auto-focus hint)
  const sharingId = (cam || screen) ? 'thim' : 'ben';
  const focused = focusedId ? participants.find(p => p.id === focusedId) : null;
  // Strip shows all participants (including the focused one) for context
  const others = focused ? participants : [];

  useEffect(() => {
    if (!focused) return;
    function onKey(e) { if (e.key === 'Escape') setFocusedId(null); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused]);
  return (
    <div className="main">
      {false && (
        <div className="drop-overlay">
          <div className="drop-card">
            <div className="drop-glyph"><Icon.Attach size={36} /></div>
            <div className="drop-title">Drop to attach</div>
            <div className="drop-sub">files are encrypted on this device before upload · Signal sender keys for {channel.type === 'dm' ? 'this DM' : '#' + channel.name}</div>
          </div>
        </div>
      )}
      <div className="main-head">
        <button className="chat-menu-btn" title="Open menu" onClick={() => window.dispatchEvent(new CustomEvent('dilla:toggle-drawer'))}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
        <div className="ch-title">
          <Icon.Speaker size={15} />
          <span>{channel.name}</span>
          <span className="enc-badge"><Icon.Shield size={10} /> SRTP</span>
        </div>
        <div className="ch-topic">{participants.length} connected</div>
        <div className="head-actions">
          <button className={'icon-btn' + (membersOpen ? '' : ' off')}
                  title={membersOpen ? 'Hide members' : 'Show members'}
                  onClick={onToggleMembers}>
            <Icon.People size={14} />
          </button>
        </div>
      </div>

      <div className="voice-view">
        {(() => {
          function cardFor(p, isMini) {
            const speaking = p.id === 'ada' && isConnected;
            const mineMuted = p.id === 'thim' && mute;
            const mineDeaf = p.id === 'thim' && deaf;
            const mineCam = p.id === 'thim' && cam;
            const mineScreen = p.id === 'thim' && screen;
            const benScreen = p.id === 'ben';
            const showScreen = mineScreen || benScreen;
            const showCam = mineCam;
            const node = (nodes[p.id] || '').split('.')[0] || 'local';
            const focusable = showScreen || showCam;
            return (
              <div key={p.id}
                   className={'voice-card'
                     + (speaking ? ' speaking' : '')
                     + (showScreen ? ' has-screen' : showCam ? ' has-cam' : '')
                     + (isMini ? ' mini' : '')
                     + (isMini && focused && p.id === focused.id ? ' is-focused' : '')
                     + (focusable && !isMini ? ' focusable' : '')}
                   data-node={node}
                   data-bitrate="96 kbps · opus"
                   onContextMenu={(e) => {
                     e.preventDefault();
                     window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
                       { label: 'View profile', icon: <Icon.People size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-profile', { detail: { memberId: p.id, x: e.clientX, y: e.clientY } })) },
                       { label: focusable ? (focusedId === p.id ? 'Exit focus' : 'Focus this stream') : 'No stream to focus', icon: null, onClick: () => focusable && setFocusedId(focusedId === p.id ? null : p.id) },
                       { sep: true },
                       { label: 'Mute for me only', icon: <Icon.Mic size={13} off />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'mixer', text: 'Muted ' + p.name + ' for this session only.', duration: 2500 } })) },
                       { label: 'Server-mute (admin)', danger: true, icon: <Icon.Mic size={13} off />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'admin', text: 'Server-mute requires admin role. Propagates across the mesh.', duration: 3500 } })) },
                       { label: 'Disconnect from voice', danger: true, icon: null, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { author: 'admin', text: 'Disconnect ' + p.name + ' (admin only).', duration: 3000 } })) },
                     ] } }));
                   }}
                   onClick={() => {
                     if (isMini) { setFocusedId(p.id); return; }
                     if (focusedId === p.id) { setFocusedId(null); return; }
                     if (focusable) setFocusedId(p.id);
                   }}>
                <div className="voice-media">
                  {showScreen ? <MockScreen member={p} pip={showCam ? p : null} /> :
                   showCam ? <MockCam member={p} /> :
                   <Avatar member={p} size={isMini ? 32 : 64} />}
                </div>
                <div className="v-name">{p.name}</div>
                {!isMini && <div className="v-state">
                  {mineMuted ? <><Icon.Mic size={10} off /> <span className="v-mic-off">muted</span></> :
                    speaking ? <><span style={{ color: 'var(--accent)' }}>● speaking</span></> :
                    <><Icon.Mic size={10} /> connected</>}
                </div>}
                <div className="v-badges">
                  {mineMuted && <span className="v-badge danger" title="muted"><Icon.Mic size={11} off /></span>}
                  {mineDeaf && <span className="v-badge danger" title="deafened"><Icon.Headphones size={11} off /></span>}
                  {showCam && <span className="v-badge ok" title="camera on"><Icon.Video size={11} /></span>}
                  {showScreen && <span className="v-badge ok" title="sharing screen"><Icon.Screen size={11} /></span>}
                  <span className="v-badge nq" title="network quality">
                    {[0,1,2,3].map(i => (
                      <span key={i} className="nq-bar" style={{ height: 3 + i * 2, opacity: i < 3 ? 1 : 0.4 }} />
                    ))}
                  </span>
                </div>
                {!isMini && p.id !== 'thim' && (
                  <div className="v-volume" onClick={(e) => e.stopPropagation()}>
                    <Icon.Headphones size={10} />
                    <input type="range" min={0} max={100} value={vol(p.id)}
                           onChange={(e) => setVolumes(v => ({ ...v, [p.id]: parseInt(e.target.value, 10) }))} />
                    <span className="v-volume-val">{vol(p.id)}</span>
                  </div>
                )}
                {!isMini && focusable && !focused && (
                  <button className="voice-expand" title="Expand"
                          onClick={(e) => { e.stopPropagation(); setFocusedId(p.id); }}>
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M9 2h5v5M14 2l-5 5M7 14H2V9M2 14l5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                )}
              </div>
            );
          }

          if (focused) {
            return (
              <>
                <div className="voice-focus">
                  <button className="voice-unfocus" onClick={() => setFocusedId(null)} title="Exit focus (esc)">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M2 2h5v5M7 2L2 7M14 9v5h-5M14 14l-5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    exit focus
                  </button>
                  {cardFor(focused, false)}
                </div>
                <div className="voice-strip">
                  {others.map(p => cardFor(p, true))}
                </div>
              </>
            );
          }
          return (
            <div className="voice-stage">
              {participants.length === 0 && (
                <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 40, color: 'var(--fg-3)' }}>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 22, color: 'var(--fg-2)', marginBottom: 8 }}>
                    Quiet here
                  </div>
                  <div>Click <em>Join</em> to be the first in <strong>#{channel.name}</strong>.</div>
                </div>
              )}
              {participants.map(p => cardFor(p, false))}
            </div>
          );
        })()}

        <div className="voice-controls-bar">
          <button className={'ctrl' + (mute ? ' active' : '')} onClick={() => setMute(!mute)} title={mute ? "Unmute" : "Mute"}>
            <Icon.Mic size={16} off={mute} />
          </button>
          <button className={'ctrl' + (deaf ? ' active' : '')} onClick={() => setDeaf(!deaf)} title={deaf ? "Undeafen" : "Deafen"}>
            <Icon.Headphones size={16} off={deaf} />
          </button>
          <button className={'ctrl' + (cam ? ' on' : '')} onClick={() => setCam(!cam)} title={cam ? "Stop camera" : "Start camera"}>
            <Icon.Video size={16} off={!cam} />
          </button>
          <button className={'ctrl' + (screen ? ' on' : '')} onClick={() => setScreen(!screen)} title={screen ? "Stop sharing" : "Share screen"}>
            <Icon.Screen size={16} off={!screen} />
          </button>
          {isConnected ? (
            <button className="ctrl danger" onClick={onLeave} title="Disconnect">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 7c2-2 8-2 10 0v2l-3 1V8.5c-1-.5-3-.5-4 0V10L3 9V7z" fill="currentColor"/></svg>
            </button>
          ) : (
            <button className="ctrl" style={{ background: 'var(--accent)', color: 'var(--accent-ink)', borderColor: 'var(--accent)' }} onClick={onJoin}>
              Join
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ───────────── member list ─────────────
function MemberList({ members, voiceConnection, rich, federated }) {
  const MC = window.MeshChrome || {};
  const nodes = MC.MEMBER_NODES || {};
  const fps = MC.FINGERPRINTS || {};
  const order = ['admin', 'maintainer', 'member', 'offline'];
  const onlineRoles = { admin: [], maintainer: [], member: [] };
  const offline = [];
  members.MEMBERS.forEach(m => {
    if (m.status === 'offline') offline.push(m);
    else if (m.role === 'admin') onlineRoles.admin.push(m);
    else if (m.role === 'maintainer') onlineRoles.maintainer.push(m);
    else onlineRoles.member.push(m);
  });
  const onlineCount = members.MEMBERS.filter(m => m.status !== 'offline').length;

  function Row({ m }) {
    const off = m.status === 'offline';
    const node = nodes[m.id] || '';
    const fed = node && !node.includes('gbg-1');
    return (
      <div className={'member' + (off ? ' offline' : '')}
           onClick={(e) => {
             const r = e.currentTarget.getBoundingClientRect();
             window.dispatchEvent(new CustomEvent('dilla:open-profile', {
               detail: { memberId: m.id, x: r.left - 270, y: r.top }
             }));
           }}
           onContextMenu={(e) => {
             e.preventDefault();
             window.dispatchEvent(new CustomEvent('dilla:open-menu', { detail: { x: e.clientX, y: e.clientY, items: [
               { label: 'Send message', icon: <Icon.Chat size={13} />, onClick: () => { window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: 'Berralitos', author: 'system', text: 'Opening DM with ' + m.name + '…', duration: 2200 } })); } },
               { label: 'Mention in current kanal', icon: <span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)', fontSize: 13 }}>@</span>, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: 'Berralitos', author: 'system', text: 'Mentioned @' + m.name + '.', duration: 2000 } })) },
               { label: 'View profile', icon: <Icon.People size={13} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:open-profile', { detail: { memberId: m.id, x: 200, y: 200 } })) },
               { label: 'Verify safety number', icon: <Icon.Shield size={12} />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:verify-safety', { detail: m.id })) },
               { sep: true },
               { label: 'Mute', icon: <Icon.Mic size={13} off />, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: 'Berralitos', author: 'system', text: m.name + ' muted in voice channels.', duration: 2200 } })) },
               { label: 'Kick from team', danger: true, icon: <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M10 4V2H3v12h7v-2M6 8h9M12 5l3 3-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/></svg>, onClick: () => window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: 'Berralitos', author: 'admin', text: 'Are you sure? Kicks propagate across the mesh (requires admin).', duration: 4000 } })) },
             ] } }));
           }}>
        <Avatar member={m} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="member-name">{m.name}</div>
          <div className="member-status">{m.custom || m.status}</div>
        </div>
        {rich && fed && federated && (
          <span className="node-tag fed" title={`Account hosted on federated node "${node}" — relayed to gbg-1 over the dilla mesh.`}>
            {node.replace('.io','').replace('.dilla.local','')}
          </span>
        )}
        {rich && fps[m.id] && (
          <div className="member-fingerprint">
            <div style={{ color: 'var(--accent)', marginBottom: 2 }}>SAFETY NUMBER · {node || 'local'}</div>
            {fps[m.id]}
          </div>
        )}
      </div>
    );
  }

  return (
    <aside className="members">
      {rich && federated && (
        <div className="mesh-summary" title="This team is replicated across 2 server nodes. Members on a peer server are tagged.">
          <div className="ms-row">
            <span className="ms-dot" />
            <span className="ms-label">Mesh</span>
            <span className="ms-sep">·</span>
            <span>2 nodes</span>
          </div>
          <div className="ms-nodes">
            <span className="ms-node">
              <span>gbg-1</span>
              <span className="ms-node-sub">local · {members.MEMBERS.filter(m => (nodes[m.id]||'').includes('gbg-1')).length}</span>
            </span>
            <span className="ms-node">
              <span>rust.berra.io</span>
              <span className="ms-node-sub">federated · {members.MEMBERS.filter(m => !(nodes[m.id]||'').includes('gbg-1') && nodes[m.id]).length}</span>
            </span>
          </div>
        </div>
      )}
      <div className="members-section">Admin — 1</div>
      {onlineRoles.admin.map(m => <Row key={m.id} m={m} />)}
      <div className="members-section">Online — {onlineRoles.maintainer.length + onlineRoles.member.length}</div>
      {[...onlineRoles.maintainer, ...onlineRoles.member].map(m => <Row key={m.id} m={m} />)}
      <div className="members-section">Offline — {offline.length}</div>
      {offline.map(m => <Row key={m.id} m={m} />)}
    </aside>
  );
}

// ───────────── root ─────────────
function ChatApp({ theme, opts = {}, rich = false, controller }) {
  const data = window.MOCK_DATA;
  const [activeServer, setActiveServer] = useState('berralitos');
  const [tab, setTab] = useState('kanals');
  const [activeChannel, setActiveChannel] = useState('design');
  const [activeDM, setActiveDM] = useState(null);
  const [activeView, setActiveView] = useState({ kind: 'channel', id: 'design' });
  const [messages, setMessages] = useState(data.MESSAGES);
  const [dmMessages, setDmMessages] = useState(data.DM_MESSAGES);
  const [drafts, setDrafts] = useState({});
  const [voiceConnection, setVoiceConnection] = useState({ channelId: 'voice', channel: 'voice-lounge' });
  const [mute, setMute] = useState(true);
  const [deaf, setDeaf] = useState(false);
  const [cam, setCam] = useState(false);
  const [screen, setScreen] = useState(false);
  const [typing, setTyping] = useState(['ada']);
  const [dmTyping, setDmTyping] = useState({}); // channelId -> [names]
  const [settings, setSettings] = useState({ open: false, mode: 'user', tab: null });
  const [membersOpen, setMembersOpen] = useState(true);
  const [profilePop, setProfilePop] = useState(null);
  const [activeThread, setActiveThread] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [replyTo, setReplyTo] = useState({}); // channelId -> msgId
  const [newChanOpen, setNewChanOpen] = useState(false);
  const [newServerOpen, setNewServerOpen] = useState(false);
  // Generic context menu: { x, y, items: [{ label, icon, danger, onClick }] }
  const [menuPop, setMenuPop] = useState(null);
  const [mutedChannels, setMutedChannels] = useState(new Set());
  const [newDmOpen, setNewDmOpen] = useState(false);
  function openMenu(e, items) {
    e.preventDefault();
    setMenuPop({ x: e.clientX, y: e.clientY, items });
  }
  function toggleMuteChannel(id) {
    setMutedChannels(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  useEffect(() => {
    function onAddSrv()  { setNewServerOpen(true); }
    function onAddCh()   { setNewChanOpen(true); }
    function onProfile(e) { setProfilePop(e.detail); }
    function onThread(e)  { setActiveThread(e.detail); }
    function onDrawer()   { setDrawerOpen(o => !o); }
    function onPickChannel(e) {
      const id = e.detail;
      if (data.CHANNELS.find(c => c.id === id)) {
        setActiveChannel(id); setActiveView({ kind: 'channel', id }); setTab('kanals');
      }
    }
    function onMenu(e) { setMenuPop(e.detail); }
    window.addEventListener('dilla:open-profile', onProfile);
    window.addEventListener('dilla:open-thread', onThread);
    window.addEventListener('dilla:toggle-drawer', onDrawer);
    window.addEventListener('dilla:pickchannel', onPickChannel);
    window.addEventListener('dilla:open-add-server', onAddSrv);
    window.addEventListener('dilla:open-new-channel', onAddCh);
    window.addEventListener('dilla:open-menu', onMenu);
    function onKey(e) {
      const inField = e.target.matches && e.target.matches('input, textarea, [contenteditable="true"]');
      if (inField) return;
      const order = ['general','design','dev','mesh','random'];
      if ((e.metaKey || e.ctrlKey) && /^[1-5]$/.test(e.key)) {
        const id = order[parseInt(e.key, 10) - 1];
        if (id) { e.preventDefault(); setActiveChannel(id); setActiveView({ kind: 'channel', id }); setTab('kanals'); }
      } else if (e.key.toLowerCase() === 'm' && voiceConnection) {
        e.preventDefault(); setMute(v => !v);
      } else if (e.key.toLowerCase() === 'd' && voiceConnection) {
        e.preventDefault(); setDeaf(v => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('dilla:open-profile', onProfile);
      window.removeEventListener('dilla:open-thread', onThread);
      window.removeEventListener('dilla:toggle-drawer', onDrawer);
      window.removeEventListener('dilla:pickchannel', onPickChannel);
      window.removeEventListener('dilla:open-add-server', onAddSrv);
      window.removeEventListener('dilla:open-new-channel', onAddCh);
      window.removeEventListener('dilla:open-menu', onMenu);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  function toggleReaction(channelId, msgId, emoji) {
    const isDM = channelId.startsWith('dm-');
    const setter = isDM ? setDmMessages : setMessages;
    setter(prev => {
      const arr = prev[channelId] || [];
      return {
        ...prev,
        [channelId]: arr.map(m => {
          if (m.id !== msgId) return m;
          const rxns = m.reactions ? [...m.reactions] : [];
          const idx = rxns.findIndex(r => r.e === emoji);
          if (idx >= 0) {
            const r = rxns[idx];
            if (r.mine) {
              if (r.n <= 1) rxns.splice(idx, 1);
              else rxns[idx] = { ...r, n: r.n - 1, mine: false };
            } else {
              rxns[idx] = { ...r, n: r.n + 1, mine: true };
            }
          } else {
            rxns.push({ e: emoji, n: 1, mine: true });
          }
          return { ...m, reactions: rxns };
        })
      };
    });
  }

  function voteOnPoll(channelId, msgId, optIdx) {
    const isDM = channelId.startsWith('dm-');
    const setter = isDM ? setDmMessages : setMessages;
    setter(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(m => {
        if (m.id !== msgId || m.kind !== 'poll') return m;
        return {
          ...m,
          options: m.options.map((o, i) => {
            if (i === optIdx) {
              return o.mine
                ? { ...o, votes: Math.max(0, (o.votes || 0) - 1), mine: false }
                : { ...o, votes: (o.votes || 0) + 1, mine: true };
            }
            // Single-choice poll: clear other mine flags
            return o.mine ? { ...o, votes: Math.max(0, (o.votes || 0) - 1), mine: false } : o;
          })
        };
      })
    }));
  }

  useEffect(() => {
    function onOpen(e) {
      const d = e.detail;
      if (typeof d === 'string') setSettings({ open: true, mode: d, tab: null });
      else if (d && typeof d === 'object') setSettings({ open: true, mode: d.mode || 'user', tab: d.tab || null });
      else setSettings({ open: true, mode: 'user', tab: null });
    }
    window.addEventListener('dilla:open-settings', onOpen);
    return () => window.removeEventListener('dilla:open-settings', onOpen);
  }, []);

  useEffect(() => {
    // Cycle typing to feel alive
    const cycle = ['ada', '', 'mira', '', 'ada,mira', ''];
    let i = 0;
    const id = setInterval(() => {
      const v = cycle[i++ % cycle.length];
      setTyping(v ? v.split(',') : []);
    }, 4200);
    return () => clearInterval(id);
  }, []);

  // DM typing — cycle ada/mira typing in their respective DMs
  useEffect(() => {
    const dmCycle = [
      { 'dm-ada': ['ada'] },
      { },
      { 'dm-mira': ['mira'] },
      { },
      { 'dm-grp': ['ola'] },
      { },
    ];
    let i = 0;
    const id = setInterval(() => {
      setDmTyping(dmCycle[i++ % dmCycle.length] || {});
    }, 5200);
    return () => clearInterval(id);
  }, []);

  // Expose imperative controls to a parent via the optional `controller` object.
  useEffect(() => {
    if (!controller) return;
    controller.pickChannel = (id) => {
      if (data.CHANNELS.find(c => c.id === id)) {
        setActiveChannel(id); setTab('kanals'); setActiveView({ kind: 'channel', id });
      }
    };
    controller.toggleMute   = () => setMute(v => !v);
    controller.toggleDeafen = () => setDeaf(v => !v);
    controller.disconnect   = () => setVoiceConnection(null);
    controller.getVoiceConn = () => voiceConnection;
  }, [controller, voiceConnection]);

  const team = data.SERVERS.find(s => s.id === activeServer) || data.SERVERS[0];
  const channelsForServer = data.CHANNELS;
  const baseChannel = channelsForServer.find(c => c.id === activeChannel) || channelsForServer[0];

  // Resolve the active view: either a channel or a DM (synthesized as a channel-like object).
  let viewChannel = baseChannel;
  let dmPartner = null;
  if (activeView.kind === 'dm') {
    const dm = data.DMS.find(d => d.id === activeView.id);
    if (dm) {
      if (dm.group) {
        viewChannel = { id: dm.id, name: dm.name, type: 'dm', encrypted: true, topic: 'group · ' + (dm.with.map(id => data.byId[id]?.name).join(', ')), group: true };
      } else {
        const partner = data.byId[dm.with];
        dmPartner = partner;
        viewChannel = { id: dm.id, name: partner?.name || 'dm', type: 'dm', encrypted: true, topic: partner?.custom || partner?.status };
      }
    }
  }
  const channel = viewChannel;

  function processSlash(text) {
    if (text.startsWith('/me ')) return { kind: 'action', text: text.slice(4) };
    if (text === '/me') return { kind: 'text', text };
    if (text.startsWith('/shrug')) {
      const rest = text.slice(6).trim();
      return { kind: 'text', text: (rest ? rest + ' ' : '') + '¯\\_(ツ)_/¯' };
    }
    if (text.startsWith('/poll ')) {
      const args = text.slice(6).split('|').map(s => s.trim()).filter(Boolean);
      return { kind: 'poll', question: args[0] || '?', options: args.slice(1).map(o => ({ label: o, votes: 0 })) };
    }
    if (text.startsWith('/giphy ')) return { kind: 'giphy', query: text.slice(7).trim() };
    if (text.startsWith('/code')) {
      const lang = text.slice(5).trim();
      return { kind: 'text', text: '```' + lang + '\n' + (lang ? '// type your code here\n' : 'type your code here\n') + '```' };
    }
    return { kind: 'text', text };
  }

  function send() {
    if (channel.type === 'dm') {
      const draft = drafts[channel.id];
      if (!draft || !draft.trim()) return;
      const processed = processSlash(draft.trim());
      const m = { id: 'new-' + Date.now(), author: 'thim', at: new Date(), ...processed, replyTo: replyTo[channel.id] || null };
      setDmMessages(prev => ({ ...prev, [channel.id]: [...(prev[channel.id] || []), m] }));
      setDrafts(prev => ({ ...prev, [channel.id]: '' }));
      setReplyTo(prev => ({ ...prev, [channel.id]: null }));
      return;
    }
    const draft = drafts[activeChannel];
    if (!draft || !draft.trim()) return;
    const processed = processSlash(draft.trim());
    const m = {
      id: 'new-' + Date.now(),
      author: 'thim',
      at: new Date(),
      ...processed,
      replyTo: replyTo[activeChannel] || null,
    };
    setMessages(prev => ({ ...prev, [activeChannel]: [...(prev[activeChannel] || []), m] }));
    setDrafts(prev => ({ ...prev, [activeChannel]: '' }));
    setReplyTo(prev => ({ ...prev, [activeChannel]: null }));
  }

  function editMessage(channelId, msgId, newText) {
    const isDM = channelId.startsWith('dm-');
    const setter = isDM ? setDmMessages : setMessages;
    setter(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).map(m =>
        m.id === msgId ? { ...m, text: newText, edited: true, editedAt: Date.now() } : m
      )
    }));
  }

  function deleteMessage(channelId, msgId) {
    const isDM = channelId.startsWith('dm-');
    const setter = isDM ? setDmMessages : setMessages;
    setter(prev => ({
      ...prev,
      [channelId]: (prev[channelId] || []).filter(m => m.id !== msgId)
    }));
  }

  const rootStyle = window.THEMES.themeVars(theme, opts);
  rootStyle['--sidebar-w'] = (opts.sidebar || 240) + 'px';
  const isDM = channel.type === 'dm';
  const showFourth = activeThread || (membersOpen && !isDM);
  rootStyle['--members-w'] = (showFourth ? (activeThread ? 380 : (opts.members || 232)) : 0) + 'px';

  return (
    <div className="chat" data-style={theme.style} data-drawer={drawerOpen ? '1' : '0'} style={rootStyle}>
      <ServerRail servers={data.SERVERS} activeServer={activeServer} onPick={setActiveServer} />
      <ChannelSidebar
        team={team}
        tab={tab} onTab={setTab}
        channels={channelsForServer}
        activeChannel={activeChannel}
        onPickChannel={(id) => { setActiveChannel(id); setActiveView({ kind: 'channel', id }); }}
        members={data}
        dms={data.DMS}
        activeDM={activeView.kind === 'dm' ? activeView.id : null}
        onPickDM={(id) => { setActiveDM(id); setActiveView({ kind: 'dm', id }); }}
        voiceConnection={voiceConnection}
        onLeaveVoice={() => setVoiceConnection(null)}
        mute={mute} setMute={setMute}
        deaf={deaf} setDeaf={setDeaf}
        cam={cam} setCam={setCam}
        screen={screen} setScreen={setScreen}
        mutedChannels={mutedChannels}
        toggleMuteChannel={toggleMuteChannel}
        onNewDm={() => setNewDmOpen(true)}
      />
      {channel.type === 'voice' ? (
        <VoiceChannel
          channel={channel}
          members={data}
          voiceConnection={voiceConnection}
          onJoin={() => setVoiceConnection({ channelId: channel.id, channel: channel.name })}
          onLeave={() => setVoiceConnection(null)}
          mute={mute} setMute={setMute}
          deaf={deaf} setDeaf={setDeaf}
          cam={cam} setCam={setCam}
          screen={screen} setScreen={setScreen}
          rich={rich}
          membersOpen={membersOpen}
          onToggleMembers={() => setMembersOpen(o => !o)}
        />
      ) : (
        <TextChannel
          channel={channel}
          messages={channel.type === 'dm' ? (dmMessages[channel.id] || []) : (messages[channel.id] || [])}
          members={data}
          dmPartner={dmPartner}
          draft={drafts[channel.id] || ''}
          setDraft={v => setDrafts(prev => ({ ...prev, [channel.id]: v }))}
          onSend={send}
          replyTo={replyTo[channel.id]}
          onSetReply={(id) => setReplyTo(prev => ({ ...prev, [channel.id]: id }))}
          onReact={(msgId, emoji) => toggleReaction(channel.id, msgId, emoji)}
          onVote={(msgId, optIdx) => voteOnPoll(channel.id, msgId, optIdx)}
          onEdit={(msgId, text) => editMessage(channel.id, msgId, text)}
          onDelete={(msgId) => deleteMessage(channel.id, msgId)}
          onAttach={(file) => {
            const m = {
              id: 'att-' + Date.now(),
              author: 'thim',
              at: new Date(),
              kind: 'image',
              text: '',
              attachment: { kind: 'image', label: file.name, w: 320, h: 200, tint: 'var(--accent)' },
            };
            const isDM = channel.type === 'dm';
            const setter = isDM ? setDmMessages : setMessages;
            setter(prev => ({ ...prev, [channel.id]: [...(prev[channel.id] || []), m] }));
          }}
          typing={channel.type === 'dm' ? (dmTyping[channel.id] || []) : typing}
          membersOpen={membersOpen}
          onToggleMembers={() => setMembersOpen(o => !o)}
        />
      )}
      {activeThread ? (
        <ThreadPanel
          channelId={activeThread.channelId}
          messageId={activeThread.messageId}
          members={data}
          onClose={() => setActiveThread(null)}
        />
      ) : (
        !isDM && membersOpen && <MemberList members={data} voiceConnection={voiceConnection} rich={rich} federated={opts.federated !== false} />
      )}
      {(() => {
        const SettingsModal = window.Settings;
        return SettingsModal ? (
          <SettingsModal
            open={settings.open}
            mode={settings.mode}
            defaultTab={settings.tab}
            onClose={() => setSettings(s => ({ ...s, open: false }))}
          />
        ) : null;
      })()}
      {opts.onSidebarChange && (
        <ResizeHandle kind="sidebar" value={opts.sidebar || 240}
                      onResize={opts.onSidebarChange} min={200} max={360} />
      )}
      {opts.onMembersChange && membersOpen && (
        <ResizeHandle kind="members" value={opts.members || 232}
                      onResize={opts.onMembersChange} min={180} max={340} />
      )}
      <ProfilePopover
        pop={profilePop}
        onClose={() => setProfilePop(null)}
        onDM={(id) => { setTab('pms'); setActiveDM(`dm-${id}`); setActiveView({ kind: 'dm', id: `dm-${id}` }); }}
        federated={opts.federated !== false}
      />
      {menuPop && (
        <div className="ctx-overlay" onClick={() => setMenuPop(null)} onContextMenu={(e) => { e.preventDefault(); setMenuPop(null); }}>
          <div className="ctx-menu"
               style={{ left: Math.min(menuPop.x, window.innerWidth - 220), top: Math.min(menuPop.y, window.innerHeight - (menuPop.items.length * 36 + 16)) }}
               onClick={e => e.stopPropagation()}>
            {menuPop.items.map((it, i) => it.sep ? (
              <div key={i} className="ctx-sep" />
            ) : (
              <button key={i} className={it.danger ? 'danger' : ''} onClick={() => { it.onClick && it.onClick(); setMenuPop(null); }}>
                {it.icon}
                {it.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {newChanOpen && (
        <NewChannelModal onClose={() => setNewChanOpen(false)} onCreate={(c) => {
          data.CHANNELS.push({ ...c, type: c.kind, unread: 0, encrypted: true });
          setActiveChannel(c.id); setActiveView({ kind: 'channel', id: c.id });
          setNewChanOpen(false);
          window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { channel: c.name, author: 'system', text: 'Kanal created. Synced to 2/2 peers.', duration: 3500 } }));
        }} />
      )}
      {newServerOpen && (
        <NewServerModal onClose={() => setNewServerOpen(false)} onCreate={(s) => {
          data.SERVERS.push(s);
          setActiveServer(s.id);
          setNewServerOpen(false);
          window.dispatchEvent(new CustomEvent('dilla:notify', { detail: { team: s.name, author: 'system', text: s.kind === 'join' ? 'Joined team. Subscribing to channels…' : 'New team created. You are admin.', duration: 4000 } }));
        }} />
      )}
      {newDmOpen && (
        <NewDmModal members={data} onClose={() => setNewDmOpen(false)}
          onPick={(id) => {
            const dmId = 'dm-' + id;
            if (!data.DMS.find(d => d.id === dmId)) {
              data.DMS.push({ id: dmId, with: id, preview: '', at: new Date(), unread: 0 });
            }
            setActiveDM(dmId);
            setActiveView({ kind: 'dm', id: dmId });
            setTab('pms');
            setNewDmOpen(false);
          }} />
      )}
      <div className="chat-backdrop" onClick={() => setDrawerOpen(false)} />
    </div>
  );
}

window.ChatApp = ChatApp;
