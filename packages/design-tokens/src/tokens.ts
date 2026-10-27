export type ThemeName = 'signal' | 'light' | 'high-contrast';

export type ColorTokens = {
  bg: string; bg2: string; bg3: string; surface: string; surface2: string; surfaceHi: string;
  hairline: string; hairline2: string; edge: string;
  fg: string; fgBody: string; fgStrong: string; fg2: string; fg3: string; fg4: string; fgLink: string;
  accent: string; accent2: string; accentInk: string; accentSoft: string; brand: string; hover: string;
  danger: string; warn: string; ok: string; mention: string; mentionInk: string;
  okSoft: string; okSoftBorder: string; okTint: string; okBorder: string; okText: string;
  dangerSoft: string; dangerBorder: string; dangerInk: string; warnSoft: string; scrim: string; knob: string; trackOff: string; accentChip: string; lineStrong: string; brandInk: string; hoverHi: string;
  /** Control boundaries (task 6b). Signal: the prototype's exact borders; light and high-contrast: `edge`. */
  controlEdge: string; controlEdgeField: string; controlEdgeKey: string;
  /** The reminders popover (task 6b fix round 1): a due row's icon tint and the row action's text (prototype #C9CED6). */
  warnTint: string; fgChip: string;
  /**
   * The conversation (task 7), each the prototype's literal: the replied-to row's tint, the jump flash, the thread chip's
   * hover, faint meta text (a code block's line count, the placeholder), the GIF tag's scrim, and the code highlighter
   * (line numbers, comments, booleans, keywords, a hovered code line).
   */
  accentFaint: string; accentFlash: string; accentHover: string; fgFaint: string; scrimTag: string;
  codeLineNo: string; codeComment: string; codeBool: string; codeKeyword: string; codeRowHover: string;
  /** A failed tray card's line, and the feed's welcome tile. */
  dangerLine: string; surfaceTile: string;
  /** Quiet meta in the feed and composer (the gutter time, an empty composer's send): signal is the prototype's #5C636E; light and high-contrast keep 4.5:1. */
  fgQuiet: string;
  linkUnderline: 0 | 1;
};

export const themes: Record<ThemeName, ColorTokens> = {
  signal: {
    bg: '#08090B', bg2: '#0B0D10', bg3: '#0D1014', surface: '#0D1014', surface2: '#0F1216', surfaceHi: '#171B22',
    hairline: '#1A1D23', hairline2: '#232831', edge: '#5C636E',
    fg: '#E4E8EE', fgBody: '#D5DAE1', fgStrong: '#B9BFC8', fg2: '#8C939E', fg3: '#767D89', fg4: '#5C636E', fgLink: '#5AA8E6',
    accent: '#5AA8E6', accent2: '#8CC4F0', accentInk: '#03121E', accentSoft: 'rgba(90,168,230,0.12)', brand: '#005799', hover: '#14171C',
    danger: '#FF6E6E', warn: '#FFD16A', ok: '#7CFF8E', mention: '#FFD16A', mentionInk: '#1A1300',
    okSoft: 'rgba(124,255,142,0.04)', okSoftBorder: 'rgba(124,255,142,0.22)', okTint: 'rgba(124,255,142,0.08)', okBorder: 'rgba(124,255,142,0.25)', okText: '#9EF5AC',
    dangerSoft: 'rgba(255,110,110,0.1)', dangerBorder: 'rgba(255,110,110,0.45)', dangerInk: '#1A0606', warnSoft: 'rgba(255,209,106,0.05)', scrim: 'rgba(3,4,6,0.6)', knob: '#FFFFFF', trackOff: '#2A303A', accentChip: 'rgba(90,168,230,0.16)', lineStrong: '#2A303A', brandInk: '#FFFFFF', hoverHi: '#1A1E25',
    controlEdge: '#2A303A', controlEdgeField: '#252A33', controlEdgeKey: '#3A404A',
    warnTint: 'rgba(255,209,106,0.14)', fgChip: '#C9CED6',
    accentFaint: 'rgba(90,168,230,0.07)', accentFlash: 'rgba(90,168,230,0.18)', accentHover: 'rgba(90,168,230,0.08)', fgFaint: '#636A75', scrimTag: 'rgba(8,9,11,0.8)',
    codeLineNo: '#4A5059', codeComment: '#6C737E', codeBool: '#E9B6EC', codeKeyword: '#C4A7FF', codeRowHover: 'rgba(255,255,255,0.02)',
    dangerLine: 'rgba(255,110,110,0.5)', surfaceTile: '#11151A', fgQuiet: '#5C636E',
    linkUnderline: 0,
  },
  light: {
    bg: '#F5F6F5', bg2: '#ECEEEC', bg3: '#E3E6E3', surface: '#FFFFFF', surface2: '#E6E9E6', surfaceHi: '#DDE1DD',
    hairline: '#CBD0CB', hairline2: '#8F978F', edge: '#6F776F',
    fg: '#14171A', fgBody: '#14171A', fgStrong: '#3F453F', fg2: '#3F453F', fg3: '#5C635C', fg4: '#A9B0A9', fgLink: '#005799',
    accent: '#005799', accent2: '#004A82', accentInk: '#FFFFFF', accentSoft: 'rgba(0,87,153,0.12)', brand: '#005799', hover: '#E3E6E3',
    danger: '#B3261E', warn: '#8A5A00', ok: '#1B7334', mention: '#F2C14E', mentionInk: '#1A1300',
    okSoft: 'rgba(27,115,52,0.04)', okSoftBorder: 'rgba(27,115,52,0.22)', okTint: 'rgba(27,115,52,0.08)', okBorder: 'rgba(27,115,52,0.25)', okText: '#1B7334',
    dangerSoft: 'rgba(179,38,30,0.1)', dangerBorder: 'rgba(179,38,30,0.45)', dangerInk: '#FFFFFF', warnSoft: 'rgba(138,90,0,0.05)', scrim: 'rgba(0,0,0,0.4)', knob: '#FFFFFF', trackOff: '#8A918A', accentChip: 'rgba(0,87,153,0.16)', lineStrong: '#B4BBB4', brandInk: '#FFFFFF', hoverHi: '#D6DAD6',
    controlEdge: '#6F776F', controlEdgeField: '#6F776F', controlEdgeKey: '#6F776F',
    warnTint: 'rgba(138,90,0,0.14)', fgChip: '#3F453F',
    accentFaint: 'rgba(0,87,153,0.07)', accentFlash: 'rgba(0,87,153,0.18)', accentHover: 'rgba(0,87,153,0.08)', fgFaint: '#5C635C', scrimTag: 'rgba(20,23,26,0.8)',
    codeLineNo: '#5C635C', codeComment: '#5C635C', codeBool: '#8A2E8F', codeKeyword: '#5B3BA8', codeRowHover: 'rgba(0,0,0,0.03)',
    dangerLine: 'rgba(179,38,30,0.5)', surfaceTile: '#FFFFFF', fgQuiet: '#4F564F',
    linkUnderline: 0,
  },
  'high-contrast': {
    bg: '#000000', bg2: '#000000', bg3: '#0A0A0A', surface: '#000000', surface2: '#101010', surfaceHi: '#1C1C1C',
    hairline: '#FFFFFF', hairline2: '#FFFFFF', edge: '#FFFFFF',
    fg: '#FFFFFF', fgBody: '#FFFFFF', fgStrong: '#E6E6E6', fg2: '#E6E6E6', fg3: '#C8C8C8', fg4: '#8A8A8A', fgLink: '#9CCBFF',
    accent: '#9CCBFF', accent2: '#C7E2FF', accentInk: '#000000', accentSoft: 'rgba(156,203,255,0.2)', brand: '#005799', hover: '#1C1C1C',
    danger: '#FF9A9A', warn: '#FFE08A', ok: '#9BFFA8', mention: '#FFE08A', mentionInk: '#000000',
    okSoft: 'rgba(155,255,168,0.04)', okSoftBorder: 'rgba(155,255,168,0.22)', okTint: 'rgba(155,255,168,0.08)', okBorder: 'rgba(155,255,168,0.25)', okText: '#9BFFA8',
    dangerSoft: 'rgba(255,154,154,0.1)', dangerBorder: 'rgba(255,154,154,0.45)', dangerInk: '#000000', warnSoft: 'rgba(255,224,138,0.05)', scrim: 'rgba(0,0,0,0.7)', knob: '#000000', trackOff: '#C8C8C8', accentChip: 'rgba(156,203,255,0.24)', lineStrong: '#FFFFFF', brandInk: '#FFFFFF', hoverHi: '#2A2A2A',
    controlEdge: '#FFFFFF', controlEdgeField: '#FFFFFF', controlEdgeKey: '#FFFFFF',
    warnTint: 'rgba(255,224,138,0.2)', fgChip: '#E6E6E6',
    accentFaint: 'rgba(156,203,255,0.12)', accentFlash: 'rgba(156,203,255,0.3)', accentHover: 'rgba(156,203,255,0.16)', fgFaint: '#C8C8C8', scrimTag: 'rgba(0,0,0,0.85)',
    codeLineNo: '#C8C8C8', codeComment: '#C8C8C8', codeBool: '#F5C2F7', codeKeyword: '#D9C8FF', codeRowHover: 'rgba(255,255,255,0.08)',
    dangerLine: 'rgba(255,154,154,0.5)', surfaceTile: '#000000', fgQuiet: '#C8C8C8',
    linkUnderline: 1,
  },
};

/** Every colour token that is a colour: `linkUnderline` is a 0/1 flag, not a colour. */
export type ColorKey = Exclude<keyof ColorTokens, 'linkUnderline'>;
/** Text pairs (≥ 4.5:1): [foreground, background]. */
export const TEXT_PAIRS: ReadonlyArray<readonly [ColorKey, ColorKey]> = [
  ['fg', 'bg'], ['fg', 'bg2'], ['fg', 'surface'], ['fg', 'surface2'], ['fg', 'surfaceHi'],
  ['fg2', 'bg'], ['fg2', 'bg2'], ['fg2', 'surface2'], ['fg2', 'surfaceHi'],
  ['fgBody', 'bg'], ['fgStrong', 'surface2'], ['okText', 'bg2'], ['fgChip', 'surface2'],
  ['fg3', 'bg'], ['fg3', 'bg2'], ['fg3', 'surface'], ['fg3', 'surface2'],
  ['fgLink', 'bg'], ['danger', 'bg'], ['warn', 'bg'], ['ok', 'bg2'],
  ['accentInk', 'accent'], ['accentInk', 'accent2'], ['mentionInk', 'mention'], ['brandInk', 'brand'],
];
/** UI component and large-text pairs (≥ 3:1). */
export const UI_PAIRS: ReadonlyArray<readonly [ColorKey, ColorKey]> = [
  ['accent', 'bg'], ['accent', 'bg2'], ['edge', 'bg'], ['edge', 'surface2'], ['danger', 'surface2'], ['warn', 'surface2'], ['fg2', 'surfaceHi'],
  ['ok', 'bg2'], ['edge', 'surface'],
];

/**
 * Control boundaries: `controlEdge` (buttons, toggle, top bar keycap; prototype #2A303A), `controlEdgeField`
 * (text fields, selects, segmented; #252A33) and `controlEdgeKey` (settings keycaps, the rail's add tile; #3A404A).
 * Exemption from the 3:1 UI rule (WCAG 1.4.11), signal only: Jonas chose the prototype's exact borders on
 * 2026-10-27 over the accessible `edge`. Light and high-contrast were not designed: there they equal `edge` and
 * must pass 3:1 (tokens.test.ts). `UI_PAIRS` keeps checking `edge` itself in every theme.
 */
export const CONTROL_EDGE_KEYS = ['controlEdge', 'controlEdgeField', 'controlEdgeKey'] as const satisfies ReadonlyArray<ColorKey>;
export const CONTROL_EDGE_EXEMPT: ReadonlyArray<ThemeName> = ['signal'];

export const structural = {
  font: {
    mono: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    serifItalic: '"DM Serif Display", Georgia, serif',
  },
  /**
   * The type scale in rem at a 16px root, never px: a user who raises the
   * browser's default text size, or zooms to 200 %, must scale the chrome
   * with it (WCAG 1.4.4). The px equivalent of each step is kept as a
   * comment so the reference stays checkable.
   */
  text: {
    pico: '0.40625rem',   // 6.5px (a reply line's 14px mini avatar; task 7)
    nano: '0.5rem',       // 8px (the reminders popover's 22px bot tile; task 6b)
    mini: '0.46875rem',   // 7.5px (an 18px voice occupant avatar's initials)
    micro: '0.625rem',    // 10px
    meta: '0.65625rem',   // 10.5px (the sidebar stat line, a voice count, the user panel's status line)
    tag: '0.53125rem',    // 8.5px
    badge: '0.5625rem',   // 9px (the top bar's reminder count)
    chip: '0.59375rem',   // 9.5px (the rail badge)
    xs: '0.6875rem',      // 11px
    btn: '0.71875rem',    // 11.5px (a settings button and a segmented option)
    ui: '0.75rem',        // 12px (the top bar's search trigger, the sign-in brand tile)
    sm: '0.78125rem',     // 12.5px
    input: '0.8125rem',   // 13px (a text field)
    base: '0.84375rem',   // 13.5px
    md: '0.875rem',       // 14px
    lg: '1.0625rem',      // 17px
    welcome: '1.125rem',  // 18px (the feed's "Welcome to #general"; task 7)
    title: '1.1875rem',   // 19px (the server name at the top of the sidebar)
    xl: '1.375rem',       // 22px
  },
  weight: { display: '700', body: '420', label: '600' },
  labelTracking: '0.08em',
  trackingSoft: '0.04em',
  labelTrackingWide: '0.12em',
  radius: { sm: '4px', md: '6px', lg: '8px', xl: '10px', xxl: '12px', pill: '999px', avatar: '999px', bot: '6px', seg: '7px', row: '5px', tag: '3px' },
  /** Dimming for de-emphasised (e.g. muted) rows. Chosen so fg-2 over bg-2 still clears 4.5:1 in every theme. */
  opacity: { muted: '0.8' },
  shadow: { s1: '0 8px 20px rgba(0,0,0,0.4)', s2: '0 20px 50px rgba(0,0,0,0.55)', s3: '0 30px 80px rgba(0,0,0,0.65)', knob: '0 1px 3px rgba(0,0,0,0.4)', popover: '0 20px 50px rgba(0,0,0,0.6)' },
  /**
   * Pane widths stay px: they are furniture the user drags, and a rail or a
   * sidebar that grew with the text size would eat the message pane. The
   * heights are rem, because each one is a box around scale text — a px bar
   * around rem text clips it the moment the browser's text size goes up.
   */
  layout: {
    railW: '56px', railTile: '38px', slotW: '32px', sidebarW: '244px', membersW: '232px', threadW: '340px',
    topbarH: '2.75rem',       // 44px
    bottombarH: '1.625rem',   // 26px
    channelHeaderH: '2.75rem',// 44px
    barH: '2.75rem',          // 44px, the one height of every pane's top bar
    panelH: '4rem',           // 64px: user panel AND voice call bar (top edges align)
    rowH: '1.75rem',          // 28px, a list row; 2.75rem on a phone (base.css)
    rowHSub: '1.625rem',      // 26px, a sub-row (a voice participant); 2.25rem on a phone
    rowH2: '2.75rem',         // 44px, a two-line row; 3.25rem on a phone
    listGap: '0.0625rem',     // 1px between list rows; 0 on a phone
  },

  /**
   * The focus ring, as an `outline` shorthand: `outline: var(--focus-ring)`
   * with `outline-offset: 2px`. An outline, not a `box-shadow`, so a
   * component's own `box-shadow` state cue (the active channel row's inset
   * bar, a pressed toggle's underline) can never swallow the ring — and so
   * the Windows forced-colors indicator survives.
   */
  focusRing: '2px solid var(--accent)',
  motion: { toggle: '240ms', press: '120ms', fast: '150ms', normal: '220ms', slow: '300ms', enter: '380ms', badge: '450ms', pop: '400ms', turn: '200ms', aside: '280ms', bar: '600ms', easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)', toast: '220ms', pulse: '2s', caret: '1s', flash: '1.4s', meter: '120ms', hover: '140ms', tab: '160ms', spin: '180ms', dock: '340ms', railBadge: '500ms', popover: '200ms',
    /** Task 7 (the prototype's conversation): the feed's channel-switch fade, the composer's focus ring, the toolbar's rise and the 40ms entrance stagger. */
    switch: '140ms', switchRise: '240ms', focus: '160ms', rise: '180ms', stagger: '40ms' },
  sounds: ['join', 'leave', 'mention', 'mute', 'unmute', 'deafen', 'undeafen', 'ping', 'error'] as const,
} as const;

/**
 * Row rhythm, in rem at a 16px root with the px equivalent as a comment. A
 * row is a box around text: its padding, its gaps and the avatar beside the
 * text all scale with the text, so raising the browser's text size moves the
 * whole row apart instead of squeezing the text inside a fixed one. The line
 * heights are unitless, which already scales them against their font size.
 */
export const densities = {
  compact: { rowPadY: '0.25rem' /* 4px */, rowPadX: '1rem' /* 16px */, rowGap: '0rem' /* 0px */, groupGap: '0.5rem' /* 8px */, avatar: '1.75rem' /* 28px */, lineHeight: '1.4' },
  regular: { rowPadY: '0.375rem' /* 6px */, rowPadX: '1.125rem' /* 18px */, rowGap: '0.125rem' /* 2px */, groupGap: '0.875rem' /* 14px */, avatar: '2rem' /* 32px */, lineHeight: '1.5' },
  cozy: { rowPadY: '0.625rem' /* 10px */, rowPadX: '1.25rem' /* 20px */, rowGap: '0.25rem' /* 4px */, groupGap: '1.375rem' /* 22px */, avatar: '2.25rem' /* 36px */, lineHeight: '1.55' },
} as const;
