import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { CodeList, type CodeListProps } from './CodeList.tsx';
import { expectNoAxeViolations } from '../test/setup.ts';

// The server's format: a 26 character base32 code (A-Z, 2-7), sent in groups of five joined by hyphens
// (internal/auth/recovery.go format5). client-core's BACKUP_CODE and normaliseBackupCode accept it.
const CODES = [
  'JBSWY-3DPEH-PK3PX-PJBSW-Y3DPE-H',
  '5ICO4-DTHPV-D23TY-J7KQ2-MRB6E-A',
  'K3M7Q-W2DX2-RT5PN-AHV5C-J2ZEM-T',
  'YF2GK-DR3WP-N7HZ2-CQ6XA-B5TV7-L',
] as const;
const BACKUP_CODE = /^[A-Z2-7]{26}$/;
const normaliseBackupCode = (code: string): string => code.replace(/[-\s]/g, '').toUpperCase();
const LABEL = 'Backup codes';
const LABELS = { copy: 'Copy codes', print: 'Print codes' };

function renderList(over: Partial<CodeListProps> = {}) {
  const props: CodeListProps = { codes: CODES, label: LABEL, onCopy: vi.fn(), onPrint: vi.fn(), labels: LABELS, ...over };
  return { props, ...render(<CodeList {...props} />) };
}

const items = () => within(screen.getByRole('list', { name: LABEL })).getAllByRole('listitem');

describe('CodeList', () => {
  it('uses codes of the real format', () => {
    for (const c of CODES) expect(normaliseBackupCode(c)).toMatch(BACKUP_CODE);
  });

  it('is a real ordered list named by the label with one item per code', () => {
    const { container } = renderList();
    const list = screen.getByRole('list', { name: LABEL });
    expect(list.tagName.toLowerCase()).toBe('ol');
    expect(container.querySelectorAll('ol')).toHaveLength(1);
    expect(items()).toHaveLength(CODES.length);
  });

  it('shows an already hyphenated code once: groups of five joined by single hyphens, no spaces', () => {
    renderList();
    expect(items().map(i => i.textContent)).toEqual([...CODES]);
  });

  it('normalises before grouping: lower case, spaces and hyphens in any place give the same display', () => {
    renderList({ codes: ['jbswy3dpehpk3pxpjbswy3dpeh', 'jb swy-3dpeh pk3px-pjbsw y3dpe-h'] });
    expect(items().map(i => i.textContent)).toEqual(['JBSWY-3DPEH-PK3PX-PJBSW-Y3DPE-H', 'JBSWY-3DPEH-PK3PX-PJBSW-Y3DPE-H']);
  });

  it('puts every group in its own unbreakable element with a break opportunity between groups', () => {
    renderList({ codes: [CODES[0]] });
    const groups = items()[0]!.querySelectorAll('.d-code-list__group');
    expect(Array.from(groups).map(g => g.textContent)).toEqual(['JBSWY-', '3DPEH-', 'PK3PX-', 'PJBSW-', 'Y3DPE-', 'H']);
    expect(items()[0]!.querySelectorAll('wbr')).toHaveLength(5);
  });

  it('copies codes a client accepts: each line normalises to a valid backup code and round-trips', async () => {
    const user = userEvent.setup();
    const raw = ['jbswy3dpehpk3pxpjbswy3dpeh', ...CODES];
    const { props } = renderList({ codes: raw });
    await user.click(screen.getByRole('button', { name: LABELS.copy }));
    expect(props.onCopy).toHaveBeenCalledTimes(1);
    const text = vi.mocked(props.onCopy).mock.calls[0]![0];
    const lines = text.split('\n');
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(normaliseBackupCode(line)).toMatch(BACKUP_CODE);
    expect(lines.map(normaliseBackupCode)).toEqual(raw.map(normaliseBackupCode));
  });

  it('calls Print once, without a copy', async () => {
    const user = userEvent.setup();
    const { props } = renderList();
    await user.click(screen.getByRole('button', { name: LABELS.print }));
    expect(props.onPrint).toHaveBeenCalledTimes(1);
    expect(props.onCopy).not.toHaveBeenCalled();
  });

  it('has no serious axe violations', async () => {
    const { container } = render(<div className="d-root"><CodeList codes={CODES} label={LABEL} onCopy={() => {}} onPrint={() => {}} labels={LABELS} /></div>);
    await expectNoAxeViolations(container);
  });
});
