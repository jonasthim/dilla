import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { stubBlobUrls } from '../../test/conversation.tsx';
import { useBlobUrl } from './useBlobUrl.tsx';

function Probe({ blob }: { blob: Blob | null }) {
  const url = useBlobUrl(blob);
  return <output>{url ?? 'none'}</output>;
}

describe('useBlobUrl (G5, L-TS-37)', () => {
  it('mints in the page, keeps the URL for the same Blob, and revokes on change, on null and on unmount', () => {
    const urls = stubBlobUrls();
    try {
      const a = new Blob(['a']);
      const b = new Blob(['b']);
      const view = render(<Probe blob={a} />);
      expect(screen.getByRole('status')).toHaveTextContent('blob:test/1');
      view.rerender(<Probe blob={a} />);
      expect(urls.created).toEqual(['blob:test/1']);
      view.rerender(<Probe blob={b} />);
      expect(urls.revoked).toEqual(['blob:test/1']);
      expect(screen.getByRole('status')).toHaveTextContent('blob:test/2');
      view.rerender(<Probe blob={null} />);
      expect(urls.revoked).toEqual(['blob:test/1', 'blob:test/2']);
      expect(screen.getByRole('status')).toHaveTextContent('none');
      view.rerender(<Probe blob={a} />);
      view.unmount();
      expect(urls.revoked).toEqual(['blob:test/1', 'blob:test/2', 'blob:test/3']);
    } finally {
      urls.restore();
    }
  });
});
