// Theme tokens for the 4 dilla-chat refinement directions.
// Each theme is a flat object of CSS variable values; applied with
// <div style={themeVars(theme)}> on the chat root.

window.THEMES = (function () {

  // ───────────── 1. PULSE — refined dark teal ─────────────
  // Same vibe as the existing app but tighter type, a real scale, presence pulses.
  const pulse = {
    name: 'Pulse',
    blurb: 'Refined dark · teal',
    // surfaces
    '--bg':         '#0E1216',
    '--bg-2':       '#141A20',
    '--bg-3':       '#1A2128',
    '--surface':    '#1A2128',
    '--surface-2':  '#222B33',
    '--surface-hi': '#2A3540',
    '--hairline':   '#222C35',
    '--hairline-2': '#2F3B45',
    // text
    '--fg':         '#E6EEF4',
    '--fg-2':       '#9CAEBC',
    '--fg-3':       '#6E8090',
    '--fg-link':    '#7FD8C9',
    // brand / state
    '--accent':     '#37B6A2',
    '--accent-2':   '#5BD0BD',
    '--accent-ink': '#0F1F1C',
    '--accent-soft':'rgba(55,182,162,0.14)',
    '--danger':     '#E55A6E',
    '--warn':       '#E9B65B',
    '--ok':         '#5BD0BD',
    '--mention':    '#E9B65B',
    // typography
    '--font-ui':    "'Inter Tight', 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
    '--font-body':  "'Inter', ui-sans-serif, system-ui, sans-serif",
    '--font-mono':  "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
    '--font-display': "'Inter Tight', ui-sans-serif, system-ui, sans-serif",
    '--fw-display': '650',
    '--fw-body':    '420',
    '--display-tracking': '-0.022em',
    // radii / sizes
    '--r-sm': '6px',
    '--r-md': '10px',
    '--r-lg': '14px',
    '--r-pill': '999px',
    '--avatar-shape': '8px',
    // shadows
    '--shadow-1':   '0 1px 0 rgba(255,255,255,0.04) inset, 0 1px 2px rgba(0,0,0,0.3)',
    '--shadow-2':   '0 8px 28px rgba(0,0,0,0.35)',
    // misc
    '--scrollbar':  'rgba(255,255,255,0.08)',
    style: 'pulse',
  };

  // ───────────── 2. AURORA — dark warm + editorial ─────────────
  // Warm amber accent, generous whitespace, serif display headings.
  const aurora = {
    name: 'Aurora',
    blurb: 'Editorial dark · amber',
    '--bg':         '#16120E',
    '--bg-2':       '#1D1813',
    '--bg-3':       '#241D17',
    '--surface':    '#1D1813',
    '--surface-2':  '#2A2218',
    '--surface-hi': '#352B1F',
    '--hairline':   '#2A231B',
    '--hairline-2': '#3A3024',
    '--fg':         '#F2EADD',
    '--fg-2':       '#C7B79B',
    '--fg-3':       '#8A7A60',
    '--fg-link':    '#E9B65B',
    '--accent':     '#E9A23B',
    '--accent-2':   '#F6C36D',
    '--accent-ink': '#1A1308',
    '--accent-soft':'rgba(233,162,59,0.14)',
    '--danger':     '#E2705A',
    '--warn':       '#E9B65B',
    '--ok':         '#A8C36D',
    '--mention':    '#E9A23B',
    '--font-ui':    "'Söhne', 'Inter', ui-sans-serif, system-ui, sans-serif",
    '--font-body':  "'Inter', ui-sans-serif, system-ui, sans-serif",
    '--font-mono':  "'JetBrains Mono', ui-monospace, Menlo, monospace",
    '--font-display': "'Fraunces', 'Newsreader', Georgia, serif",
    '--fw-display': '420',
    '--fw-body':    '420',
    '--display-tracking': '-0.018em',
    '--r-sm': '4px',
    '--r-md': '8px',
    '--r-lg': '12px',
    '--r-pill': '999px',
    '--avatar-shape': '999px',
    '--shadow-1':   '0 1px 0 rgba(255,255,255,0.03) inset, 0 1px 2px rgba(0,0,0,0.4)',
    '--shadow-2':   '0 14px 40px rgba(0,0,0,0.5)',
    '--scrollbar':  'rgba(255,255,255,0.08)',
    style: 'aurora',
  };

  // ───────────── 3. SLATE — light, privacy-first ─────────────
  // Quiet light surface, mono microtype to surface E2E/federation metadata.
  const slate = {
    name: 'Slate',
    blurb: 'Light · privacy-forward',
    '--bg':         '#F4F5F2',
    '--bg-2':       '#ECEDE8',
    '--bg-3':       '#E3E4DE',
    '--surface':    '#FFFFFF',
    '--surface-2':  '#F8F8F5',
    '--surface-hi': '#EFEFE9',
    '--hairline':   '#E2E3DD',
    '--hairline-2': '#CFD0C9',
    '--fg':         '#1A1C18',
    '--fg-2':       '#5C615A',
    '--fg-3':       '#8B8F86',
    '--fg-link':    '#1F6B57',
    '--accent':     '#1F6B57',
    '--accent-2':   '#2C8C73',
    '--accent-ink': '#FFFFFF',
    '--accent-soft':'rgba(31,107,87,0.10)',
    '--danger':     '#B8434C',
    '--warn':       '#9B6A1F',
    '--ok':         '#2C8C73',
    '--mention':    '#9B6A1F',
    '--font-ui':    "'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
    '--font-body':  "'Inter', ui-sans-serif, system-ui, sans-serif",
    '--font-mono':  "'IBM Plex Mono', ui-monospace, Menlo, monospace",
    '--font-display': "'Inter', ui-sans-serif, system-ui, sans-serif",
    '--fw-display': '600',
    '--fw-body':    '420',
    '--display-tracking': '-0.02em',
    '--r-sm': '5px',
    '--r-md': '8px',
    '--r-lg': '12px',
    '--r-pill': '999px',
    '--avatar-shape': '6px',
    '--shadow-1':   '0 1px 0 rgba(0,0,0,0.02), 0 1px 2px rgba(0,0,0,0.04)',
    '--shadow-2':   '0 10px 30px rgba(20,28,24,0.10)',
    '--scrollbar':  'rgba(0,0,0,0.18)',
    style: 'slate',
  };

  // ───────────── 4. MESH — brutalist terminal ─────────────
  // Mono everywhere, neon-green accent, exposes the federation/crypto chrome.
  const mesh = {
    name: 'Mesh',
    blurb: 'Brutalist · terminal',
    '--bg':         '#070809',
    '--bg-2':       '#0C0D0F',
    '--bg-3':       '#101214',
    '--surface':    '#0C0D0F',
    '--surface-2':  '#14171A',
    '--surface-hi': '#1A1E22',
    '--hairline':   '#1F2226',
    '--hairline-2': '#363B41',
    '--fg':         '#E8ECE8',
    '--fg-2':       '#A0A6A0',
    '--fg-3':       '#5E635E',
    '--fg-link':    '#7CFF8E',
    '--accent':     '#7CFF8E',
    '--accent-2':   '#A8FFB6',
    '--accent-ink': '#06150A',
    '--accent-soft':'rgba(124,255,142,0.14)',
    '--danger':     '#FF6E6E',
    '--warn':       '#FFD16A',
    '--ok':         '#7CFF8E',
    '--mention':    '#FFD16A',
    '--font-ui':    "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
    '--font-body':  "'JetBrains Mono', ui-monospace, Menlo, monospace",
    '--font-mono':  "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
    '--font-display': "'JetBrains Mono', ui-monospace, Menlo, monospace",
    '--fw-display': '700',
    '--fw-body':    '420',
    '--display-tracking': '0.01em',
    '--r-sm': '0px',
    '--r-md': '2px',
    '--r-lg': '3px',
    '--r-pill': '0px',
    '--avatar-shape': '2px',
    '--shadow-1':   '0 0 0 1px rgba(124,255,142,0.08)',
    '--shadow-2':   '0 0 0 1px rgba(124,255,142,0.18), 0 12px 30px rgba(0,0,0,0.6)',
    '--scrollbar':  'rgba(124,255,142,0.18)',
    style: 'mesh',
  };

  const ALL = [pulse, aurora, slate, mesh];

  // Density presets — used to compute message-row padding etc.
  const DENSITY = {
    compact:  { rowPad: '4px 16px',  rowGap: '0px',  groupGap: '8px',  avatar: 28, lineHeight: 1.4 },
    regular:  { rowPad: '6px 18px',  rowGap: '2px',  groupGap: '14px', avatar: 32, lineHeight: 1.5 },
    cozy:     { rowPad: '10px 20px', rowGap: '4px',  groupGap: '22px', avatar: 36, lineHeight: 1.55 },
  };

  // Convert theme object into a style-prop suitable for React.
  function themeVars(theme, opts = {}) {
    const out = {};
    for (const k in theme) if (k.startsWith('--')) out[k] = theme[k];
    if (opts.accent) {
      out['--accent'] = opts.accent;
    }
    if (opts.sidebar) {
      out['--sidebar-w'] = opts.sidebar + 'px';
    }
    if (opts.density) {
      const d = DENSITY[opts.density] || DENSITY.regular;
      out['--row-pad'] = d.rowPad;
      out['--row-gap'] = d.rowGap;
      out['--group-gap'] = d.groupGap;
      out['--avatar-sz'] = d.avatar + 'px';
      out['--line-h'] = d.lineHeight;
    }
    return out;
  }

  return { pulse, aurora, slate, mesh, ALL, DENSITY, themeVars };
})();
