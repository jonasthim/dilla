import './Tag.css';
import { Icon } from '../Icon/Icon.tsx';
export type TagKind = 'bot' | 'web' | 'admin' | 'readable' | 'canHear';
const TEXT: Record<Exclude<TagKind, 'readable'>, string> = { bot: 'bot', web: 'web', admin: 'admin', canHear: 'can hear' };
export function Tag({ kind }: { kind: TagKind }) {
  if (kind === 'readable') return <span className="d-tag d-tag--glyph" role="img" aria-label="Readable by this server"><Icon name="eye" size={14} /></span>;
  return <span className="d-tag" data-kind={kind}>{TEXT[kind]}</span>;
}
