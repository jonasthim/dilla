# GIFs play inline for five minutes

Jonas, 2026-10-21: "gifs are not animated until you open them", and "animate it for like 5 minutes from you first see it".

**Branch:** fix/gif-autoplay, from main 8bc1c3db or later.

## Today
- An image attachment shows the 8 KB encrypted thumbnail: the first frame, made when the file is sent, in `client-core/src/attachments/thumb.ts`.
- `packages/web/src/screens/conversation/Attachments.tsx` (Card) opens it with `openAttachment … thumb: true`.
- The full blob (`thumb: false`) is fetched only in the lightbox, or for save or play.
- Giphy picks are sent as `image/gif` attachments (GifPicker.tsx:146, variant 'full').

## Behaviour wanted
1. **Which attachments play.** An image attachment plays inline only when all of these hold:
   - `mime === 'image/gif'`;
   - `!tooLarge`;
   - `size <= GIF_AUTOPLAY_MAX = 8 MiB` (8 * 1024 * 1024);
   - `seq !== null`.
2. **When it starts.** The first time at least half of the card is visible (an IntersectionObserver at threshold 0.5), the card opens the full blob with `openAttachment … thumb: false` and shows it in place of the thumbnail.
   - Use the same `<img>` slot, size and alt text, so the layout does not shift.
   - Release the blob URL with `useBlobUrl`.
3. **Five minutes.** From that first sighting, the card animates for `GIF_PLAY_MS = 5 * 60_000`. Then it goes back to the static thumbnail and frees the full blob.
   - The clock starts at the first sighting and does not restart when the card scrolls out and back in.
   - Keep the start time per message and attachment (`${channelId}:${seq}:${index}`) in a module-level Map, so that re-mounts and virtualised rows keep the same deadline. Keep it for the page's lifetime.
   - Never fetch the blob again after the deadline.
   - If the full blob fails to open, stay on the thumbnail without an error state. The card is still openable.
4. **Opening still works.** A click or Enter opens the lightbox exactly as today, and the lightbox always shows the full, animated file.
5. **Reduced motion.** When `prefers-reduced-motion: reduce` matches, nothing autoplays; today's behaviour stays.
6. **Indicator.** A static GIF card (before playing, after the five minutes, or under reduced motion) shows a small "GIF" badge, so people know it moves when opened.
   - The badge is visual only.
   - The card's accessible name gains nothing new, because the open label already names the file.
   - Use an existing token and badge style from packages/ui. Add any string under `shell.attachment.*` in en.ts, and follow check:copy.
7. **No other change:**
   - no fetch for off-screen GIFs;
   - other images stay as they are;
   - audio and video stay never-autoplayed (L-UI-71 / R9 is about those);
   - DMs are unchanged: the same Card serves them, so GIFs received there play too.
8. **Docs.** Update flow 06's attachment row, the user-flow doc that check:docs pins, and docs/user wherever images and GIFs are described. Wording: "A GIF plays in the conversation for five minutes after you first see it; open it to watch it again. With reduced motion, GIFs stay still until you open them."

## Tests (vitest, packages/web)
- Mock IntersectionObserver and matchMedia, and use fake timers.
- A gif card does not call `openAttachment thumb:false` until it is intersecting. Once it is, the call is made once and the img src is the full blob URL.
- At 5 min − 1 s the full blob still shows. At 5 min the thumbnail is back. Scrolling out and in after that does not fetch again.
- A re-mount after 2 min keeps the original deadline, at 3 min more.
- Under reduced motion there is no full fetch.
- A PNG image never makes the full fetch.
- A GIF over 8 MiB never makes it either.
- When the full open fails, the thumbnail stays and there is no error text.
- The badge shows on a static GIF card and not on a PNG.

## Gates
- `npm run lint`
- `npm test` (includes check:copy, check:docs and check:css)
- typecheck
- e2e: if an existing attachment spec covers images, run it on chromium-web under `flock /home/thim/.cache/dilla-w3/e2e.lock`, with DILLA_TESTKIT=/home/thim/.cache/dilla-w3/i37e2e-target/release/dilla-testkit.

## 9. The gutter time beside a GIF is clipped
Jonas, 2026-10-21: a screenshot shows "10:06p" in the left gutter of a grouped (continuation) row beside an image-only message, cut off where it should read "10:06 PM".
- Find the gutter time in packages/ui MessageRow and its CSS.
- Check whether the clipping happens for every continuation row or only for attachment-only rows. Likely causes: a fixed gutter width, the line-height or alignment against a tall image, or the 12-hour format being too wide.
- Fix it so the full time fits, and aligns with the first line of content, in both 12-hour and 24-hour formats, at desktop width and at 390 px.
- Add a unit or story test that fails today.

## 10. The Giphy picker tiles crop the GIFs
Jonas, 2026-10-21: every tile in GifPicker.tsx is a fixed box, so the whole image cannot be seen.
- Size the tiles to each GIF's own aspect ratio: a masonry grid of 3 columns, 2 at 390 px, each tile's height taken from the width and height Giphy returns for the preview.
- Check the server's search response (internal/api/gifs.go) and client-core's gifSearch types. If they do not carry the width and height, add them. They are plain numbers from Giphy and no new privacy surface, but keep them validated as small positive integers, and update the Go and TS tests.
- Before a preview loads, reserve its box from those dimensions so the grid does not jump.
- Keep keyboard order and visible focus in reading order (left to right, then down), and keep "Powered by GIPHY".
- No object-fit cropping.
- Tests: a tall and a wide result get different tile heights, and the dimensions are validated.

## Gates (9 and 10)
lint, npm test, typecheck, Go tests for gifs if touched, golangci-lint.
