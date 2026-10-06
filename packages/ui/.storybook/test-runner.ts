import type { TestRunnerConfig } from '@storybook/test-runner';
import { injectAxe, checkA11y } from 'axe-playwright';

const STRICT_TARGET_TITLES = ['Form/', 'Ceremony/', 'Shell/', 'Conversation/'];

const config: TestRunnerConfig = {
  async preVisit(page) { await injectAxe(page); },
  async postVisit(page, context) {
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
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const s = getComputedStyle(el);
      return { tag: el.tagName.toLowerCase(), outlineStyle: s.outlineStyle, outlineWidth: s.outlineWidth };
    });
    if (focused && (focused.outlineStyle !== 'solid' || focused.outlineWidth !== '2px')) {
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
  },
};
export default config;
