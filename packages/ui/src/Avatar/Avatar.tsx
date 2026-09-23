import './Avatar.css';
export type Presence = 'online' | 'idle' | 'dnd' | 'offline';
export type AvatarProps = { name: string; initials?: string; hue?: number; presence?: Presence; size?: 'sm' | 'md' | 'lg' };

// Curated palette of hues verified ≥4.5:1 contrast with white at HSL(H 45% 42%)
const AVATAR_HUES = [0, 20, 210, 230, 250, 270, 300, 330];

function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const s = parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return s.toUpperCase();
}
function deriveHue(name: string): number {
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % AVATAR_HUES.length;
  return AVATAR_HUES[h];
}
const GLYPH: Record<Presence, string> = { online: '●', idle: '◐', dnd: '⊘', offline: '○' };

export function Avatar({ name, initials, hue, presence, size = 'md' }: AvatarProps) {
  const label = presence ? `${name}, ${presence}` : name;
  return (
    <span className="d-avatar" data-size={size} role="img" aria-label={label} style={{ ['--avatar-hue' as string]: String(hue ?? deriveHue(name)) }}>
      <span className="d-avatar__initials" aria-hidden="true">{initials ?? deriveInitials(name)}</span>
      {presence ? <span className="d-avatar__presence" data-presence={presence} aria-hidden="true">{GLYPH[presence]}</span> : null}
    </span>
  );
}
