export type ThemeName = 'mesh' | 'light' | 'high-contrast';

export type ColorTokens = {
  bg: string; bg2: string; bg3: string; surface: string; surface2: string; surfaceHi: string;
  hairline: string; hairline2: string; edge: string;
  fg: string; fg2: string; fg3: string; fg4: string; fgLink: string;
  accent: string; accent2: string; accentInk: string; accentSoft: string;
  danger: string; warn: string; ok: string; mention: string; mentionInk: string;
  linkUnderline: 0 | 1;
};

export const themes: Record<ThemeName, ColorTokens> = {
  mesh: {
    bg: '#070809', bg2: '#0C0D0F', bg3: '#101214', surface: '#0C0D0F', surface2: '#14171A', surfaceHi: '#1A1E22',
    hairline: '#1F2226', hairline2: '#363B41', edge: '#6B7370',
    fg: '#E8ECE8', fg2: '#A0A6A0', fg3: '#767C76', fg4: '#5E635E', fgLink: '#7CFF8E',
    accent: '#7CFF8E', accent2: '#A8FFB6', accentInk: '#06150A', accentSoft: 'rgba(124,255,142,0.14)',
    danger: '#FF6E6E', warn: '#FFD16A', ok: '#7CFF8E', mention: '#FFD16A', mentionInk: '#1A1300',
    linkUnderline: 0,
  },
  light: {
    bg: '#F5F6F5', bg2: '#ECEEEC', bg3: '#E3E6E3', surface: '#FFFFFF', surface2: '#E6E9E6', surfaceHi: '#DDE1DD',
    hairline: '#CBD0CB', hairline2: '#8F978F', edge: '#6F776F',
    fg: '#14171A', fg2: '#3F453F', fg3: '#5C635C', fg4: '#A9B0A9', fgLink: '#1B7334',
    accent: '#1B7334', accent2: '#238C41', accentInk: '#FFFFFF', accentSoft: 'rgba(27,115,52,0.14)',
    danger: '#B3261E', warn: '#8A5A00', ok: '#1B7334', mention: '#F2C14E', mentionInk: '#1A1300',
    linkUnderline: 0,
  },
  'high-contrast': {
    bg: '#000000', bg2: '#000000', bg3: '#0A0A0A', surface: '#000000', surface2: '#101010', surfaceHi: '#1C1C1C',
    hairline: '#FFFFFF', hairline2: '#FFFFFF', edge: '#FFFFFF',
    fg: '#FFFFFF', fg2: '#E6E6E6', fg3: '#C8C8C8', fg4: '#8A8A8A', fgLink: '#9BFFA8',
    accent: '#9BFFA8', accent2: '#C4FFCC', accentInk: '#000000', accentSoft: 'rgba(155,255,168,0.2)',
    danger: '#FF9A9A', warn: '#FFE08A', ok: '#9BFFA8', mention: '#FFE08A', mentionInk: '#000000',
    linkUnderline: 1,
  },
};

type K = keyof ColorTokens;
/** Text pairs (≥ 4.5:1): [foreground, background]. */
export const TEXT_PAIRS: Array<[K, K]> = [
  ['fg', 'bg'], ['fg', 'bg2'], ['fg', 'surface'], ['fg', 'surface2'], ['fg', 'surfaceHi'],
  ['fg2', 'bg'], ['fg2', 'bg2'], ['fg2', 'surface2'],
  ['fg3', 'bg'], ['fg3', 'bg2'], ['fg3', 'surface'],
  ['fgLink', 'bg'], ['danger', 'bg'], ['warn', 'bg'], ['ok', 'bg2'],
  ['accentInk', 'accent'], ['mentionInk', 'mention'],
];
/** UI component and large-text pairs (≥ 3:1). */
export const UI_PAIRS: Array<[K, K]> = [
  ['accent', 'bg'], ['accent', 'bg2'], ['edge', 'bg'], ['edge', 'surface2'], ['danger', 'surface2'], ['warn', 'surface2'], ['fg2', 'surfaceHi'],
];

export const structural = {
  font: {
    mono: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    serifItalic: '"DM Serif Display", Georgia, serif',
  },
  text: { micro: '10px', xs: '11px', sm: '12.5px', base: '13.5px', md: '14px', lg: '17px', xl: '22px' },
  weight: { display: '700', body: '420', label: '600' },
  labelTracking: '0.08em',
  radius: { sm: '0px', md: '2px', lg: '3px', pill: '999px', avatar: '2px' },
  shadow: { s1: '0 0 0 1px rgba(124,255,142,0.08)', s2: '0 0 0 1px rgba(124,255,142,0.18), 0 12px 30px rgba(0,0,0,0.6)' },
  layout: { railW: '60px', sidebarW: '240px', membersW: '232px', threadW: '380px', topbarH: '32px', bottombarH: '26px', channelHeaderH: '48px' },
  focusRing: '0 0 0 2px var(--bg), 0 0 0 4px var(--accent)',
  motion: { fast: '150ms', normal: '200ms', slow: '300ms', easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)', toast: '220ms', pulse: '2s', caret: '1s', flash: '1.4s', meter: '120ms' },
  sounds: ['join', 'leave', 'mention', 'mute', 'unmute', 'deafen', 'undeafen', 'ping', 'error'] as const,
} as const;

export const densities = {
  compact: { rowPadY: '4px', rowPadX: '16px', rowGap: '0px', groupGap: '8px', avatar: '28px', lineHeight: '1.4' },
  regular: { rowPadY: '6px', rowPadX: '18px', rowGap: '2px', groupGap: '14px', avatar: '32px', lineHeight: '1.5' },
  cozy: { rowPadY: '10px', rowPadX: '20px', rowGap: '4px', groupGap: '22px', avatar: '36px', lineHeight: '1.55' },
} as const;
