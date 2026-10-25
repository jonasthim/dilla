import type { Page } from 'playwright';
import { injectAxe, checkA11y } from 'axe-playwright';

const STRICT_TARGET_TITLES = ['Form/', 'Ceremony/', 'Shell/', 'Conversation/', 'Settings/', 'Search/', 'Voice/', 'Media/'];

type StoryContext = { id: string; title: string; name: string };

export async function checkStory(page: Page, context: StoryContext): Promise<void> {
    await injectAxe(page);
    const strict = STRICT_TARGET_TITLES.some(prefix => context.title.startsWith(prefix));
    await checkA11y(page, '#storybook-root', {
      detailedReport: true, detailedReportOptions: { html: true }, includedImpacts: ['critical', 'serious'],
      ...(strict ? { axeOptions: { rules: { 'target-size': { enabled: true } } } } : {}),
    });
    // A container focused only by script, an opened dialog, draws no ring: around the whole dialog it reads
    // as an error box (design ruling 23(h), A11Y-DESIGN-11). Its operable controls keep the ring (below).
    const dialogRing = await page.evaluate(() => {
      const el = document.activeElement;
      return el instanceof HTMLDialogElement ? getComputedStyle(el).outlineStyle : null;
    });
    if (dialogRing !== null && dialogRing !== 'none') {
      throw new Error(`${context.title} / ${context.name}: the opened dialog, focused by script, draws a ring (outline-style: ${dialogRing})`);
    }
    // Focus-ring guard. The visible ring is an outline, never a box-shadow,
    // so that a component's own box-shadow state cue (the active channel
    // row's inset bar, the pressed button's underline) cannot swallow it.
    // Tab once: if anything takes focus, its computed outline must be the
    // 2px solid accent ring.
    // One exception (Jonas, 2026-10-14): the composer's textarea draws no visible ring; its box shows
    // focus instead, its border turning the resolved --accent (WCAG 2.4.7 still holds). The textarea keeps
    // a transparent outline, so under Windows forced colors it is painted and focus still shows.
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const s = getComputedStyle(el);
      const box = el.matches('textarea.d-composer__input') ? el.closest('.d-composer__box') : null;
      let composer: { border: string; accent: string; outlineColor: string } | null = null;
      if (box) {
        // Settle the border-color transition so the value read is the focused one.
        for (const a of box.getAnimations()) a.finish();
        const probe = document.createElement('span');
        probe.style.color = 'var(--accent)';
        box.appendChild(probe);
        const accent = getComputedStyle(probe).color;
        probe.remove();
        const b = getComputedStyle(box);
        const sides = [b.borderTopColor, b.borderRightColor, b.borderBottomColor, b.borderLeftColor];
        composer = { border: sides.every(c => c === sides[0]) ? sides[0] : sides.join(' / '), accent, outlineColor: s.outlineColor };
      }
      return { tag: el.tagName.toLowerCase(), outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth, composer };
    });
    if (focused?.composer) {
      const { composer } = focused;
      const bad: string[] = [];
      if (composer.outlineColor !== 'rgba(0, 0, 0, 0)') bad.push(`outline-color ${composer.outlineColor}, expected transparent rgba(0, 0, 0, 0)`);
      if (composer.border !== composer.accent) bad.push(`box border-color ${composer.border}, expected --accent ${composer.accent}`);
      // Forced colors paint the transparent outline in a system colour: the textarea must still have one.
      await page.emulateMedia({ forcedColors: 'active' });
      try {
        const forced = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el) return null;
          const s = getComputedStyle(el);
          return { style: s.outlineStyle, width: s.outlineWidth };
        });
        if (!forced || forced.style !== 'solid' || !(parseFloat(forced.width) >= 1)) {
          bad.push(`under forced colors outline-style ${forced?.style} / width ${forced?.width}, expected solid / at least 1px`);
        }
      } finally {
        await page.emulateMedia({ forcedColors: 'none' });
      }
      if (bad.length > 0) {
        throw new Error(
          `${context.title} / ${context.name}: the focused composer textarea should show focus through its box, ` +
          `with only a transparent ring (${bad.join('; ')})`,
        );
      }
    } else if (focused && (focused.outlineStyle !== 'solid' || focused.outlineWidth !== '2px')) {
      throw new Error(
        `${context.title} / ${context.name}: the focused <${focused.tag}> has no visible focus ring ` +
        `(outline-style: ${focused.outlineStyle}, outline-width: ${focused.outlineWidth}; expected solid / 2px)`,
      );
    }
    // Chrome labels (design ruling (i), task 24): a status chunk's label is cased as a label; its
    // value, and the channel inside the composer's label, keep the case they were given.
    const casing = await page.evaluate(() => {
      const bad: string[] = [];
      const want = (selector: string, transform: string) => {
        for (const el of Array.from(document.querySelectorAll(`#storybook-root ${selector}`))) {
          const got = getComputedStyle(el).textTransform;
          if (got !== transform) bad.push(`${selector} "${el.textContent ?? ''}" is ${got}, expected ${transform}`);
        }
      };
      want('.d-chunk__k', 'uppercase');
      want('.d-chunk__v', 'none');
      want('.d-composer__target', 'none');
      return bad;
    });
    if (casing.length > 0) throw new Error(`${context.title} / ${context.name}: ${casing.join('; ')}`);
    // Print (L-UI DOM contract; F2 allows printing the recovery key). Browsers do not print
    // backgrounds and the default theme's text is near-white, so under print media the key must be
    // the system colour CanvasText under a light scheme, and the chrome around it must not print.
    if (context.id.startsWith('ceremony-recoverykey--')) {
      await page.emulateMedia({ media: 'print' });
      try {
        const r = await page.evaluate(() => {
          const root = document.querySelector('.d-recovery-key');
          const group = document.querySelector('.d-recovery-key__group');
          const actions = document.querySelector('.d-recovery-key__actions');
          if (!root || !group || !actions) return null;
          const probe = document.createElement('span');
          probe.style.color = 'CanvasText';
          root.appendChild(probe);
          const want = getComputedStyle(probe).color;
          probe.remove();
          return { want, got: getComputedStyle(group).color, scheme: getComputedStyle(root).colorScheme, actions: getComputedStyle(actions).display };
        });
        if (!r || r.got !== r.want || r.scheme !== 'light' || r.actions !== 'none') {
          throw new Error(
            `${context.title} / ${context.name}: under print media the recovery key is not CanvasText on a light scheme ` +
            `(group colour ${r?.got}, CanvasText ${r?.want}, color-scheme ${r?.scheme}, actions display ${r?.actions})`,
          );
        }
      } finally {
        await page.emulateMedia({ media: 'screen' });
      }
    }
    // A11Y-DESIGN-01: desktop settings keep the sidebar and body as independent scroll regions. At 200% zoom,
    // the effective 640 × 400 CSS viewport enters the existing narrow-frame breakpoint and the stacked panel scrolls.
    if (context.id === 'settings-settingsframe--zoomed-in') {
      const desktop = await page.evaluate(() => {
        const frame = document.querySelector('.d-settings-frame');
        const panel = document.querySelector('.d-settings-frame__panel');
        const body = document.querySelector('.d-settings-frame__body');
        const side = document.querySelector('.d-settings-frame__side');
        if (!frame || !panel || !body || !side) return null;
        const rect = frame.getBoundingClientRect();
        const styles = getComputedStyle(panel);
        return {
          width: Math.round(rect.width), height: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y),
          columns: styles.gridTemplateColumns.trim().split(/\s+/).length,
          sideOverflow: getComputedStyle(side).overflowY, bodyOverflow: getComputedStyle(body).overflowY,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1
            || document.body.scrollWidth > innerWidth + 1 || panel.scrollWidth > panel.clientWidth + 1,
        };
      });
      if (!desktop || desktop.width !== 1280 || desktop.height !== 800 || desktop.x !== 0 || desktop.y !== 0
        || desktop.columns < 2 || desktop.sideOverflow !== 'auto' || desktop.bodyOverflow !== 'auto' || desktop.horizontalOverflow) {
        throw new Error(`${context.title} / ${context.name}: desktop settings geometry or independent scrolling is incorrect (${JSON.stringify(desktop)})`);
      }

      // A 1280 × 800 physical display at 200% browser zoom exposes a 640 × 400 CSS viewport.
      await page.setViewportSize({ width: 640, height: 400 });
      const zoomed = await page.evaluate(() => {
        const frame = document.querySelector('.d-settings-frame');
        const panel = document.querySelector('.d-settings-frame__panel');
        const body = document.querySelector('.d-settings-frame__body');
        const side = document.querySelector('.d-settings-frame__side');
        const last = Array.from(document.querySelectorAll('.d-settings-frame__body button')).at(-1);
        if (!frame || !panel || !body || !side || !last) return null;
        const size = frame.getBoundingClientRect();
        panel.scrollTop = panel.scrollHeight;
        const p = panel.getBoundingClientRect();
        const b = last.getBoundingClientRect();
        return {
          width: Math.round(size.width), height: Math.round(size.height), x: Math.round(size.x), y: Math.round(size.y),
          panelScrolls: panel.scrollHeight > panel.clientHeight,
          bodyScrolls: body.scrollHeight > body.clientHeight + 1, sideScrolls: side.scrollHeight > side.clientHeight + 1,
          lastInView: b.top >= p.top - 1 && b.bottom <= p.bottom + 1,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1
            || document.body.scrollWidth > innerWidth + 1 || panel.scrollWidth > panel.clientWidth + 1,
        };
      });
      if (!zoomed || zoomed.width !== 640 || zoomed.height !== 400 || zoomed.x !== 0 || zoomed.y !== 0
        || !zoomed.panelScrolls || zoomed.bodyScrolls || zoomed.sideScrolls || !zoomed.lastInView || zoomed.horizontalOverflow) {
        throw new Error(`${context.title} / ${context.name}: the fullscreen settings frame is not reachable at 200% zoom (${JSON.stringify(zoomed)})`);
      }
    }
    if (context.id.startsWith('ceremony-onboardingframe--')) {
      await page.emulateMedia({ media: 'print' });
      try {
        const footer = await page.evaluate(() => {
          const el = document.querySelector('.d-onboarding-frame__footer');
          return el ? getComputedStyle(el).display : null;
        });
        if (footer !== null && footer !== 'none') {
          throw new Error(`${context.title} / ${context.name}: under print media the onboarding footer is displayed (display: ${footer})`);
        }
      } finally {
        await page.emulateMedia({ media: 'screen' });
      }
    }
}
