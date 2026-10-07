import { useEffect, useState } from 'react';

/**
 * Stories only (not exported from the package): an image drawn on a canvas at story time — four coloured quadrants
 * and a diagonal — shown through a `blob:` URL that is revoked on unmount. No binary fixture and no `data:` URL.
 * The colours are image content drawn on a canvas, not styles, so the tokens rule does not reach them. Null until
 * the canvas has been encoded.
 */
export function useDrawnImage(w: number, h: number): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx !== null) {
      const hw = w / 2;
      const hh = h / 2;
      ctx.fillStyle = '#2e86de'; ctx.fillRect(0, 0, hw, hh);
      ctx.fillStyle = '#10ac84'; ctx.fillRect(hw, 0, w - hw, hh);
      ctx.fillStyle = '#ee5253'; ctx.fillRect(0, hh, hw, h - hh);
      ctx.fillStyle = '#feca57'; ctx.fillRect(hw, hh, w - hw, h - hh);
      ctx.strokeStyle = '#222f3e';
      ctx.lineWidth = Math.max(2, Math.round(Math.min(w, h) / 40));
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, h); ctx.stroke();
      canvas.toBlob(blob => {
        if (cancelled || blob === null) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      }, 'image/png');
    }
    return () => {
      cancelled = true;
      if (made !== null) URL.revokeObjectURL(made);
      setUrl(null);
    };
  }, [w, h]);
  return url;
}
