import type { Page } from 'playwright';
import { injectAxe, checkA11y } from 'axe-playwright';

const STRICT_TARGET_TITLES = ['Form/', 'Ceremony/', 'Shell/', 'Conversation/', 'Settings/', 'Search/', 'Voice/', 'Media/'];

type StoryContext = { id: string; title: string; name: string };

/** The element whose border is a control's only boundary, for the stories that must draw it in --edge. */
function boundarySelector(id: string): string | null {
  if (id.startsWith('primitives-keyhint--')) return '.d-keyhint__kbd';
  if (id === 'form-toggle--off') return '.d-toggle__track';
  if (id.startsWith('form-segmented--')) return '.d-segmented__group';
  if (id === 'form-select--default') return '.d-select__input';
  if (id === 'form-textfield--empty' || id === 'form-textfield--filled') return '.d-text-field__input';
  if (id.startsWith('shell-topbar--')) return '.d-topbar__kbd';
  return null;
}

/** README §5.1: the column aside's settled width (members 232, thread 340, closed 0). */
const ASIDE_STORIES: Record<string, number> = {
  'shell-appshell--aside-wide': 232, 'shell-appshell--frame-members': 232, 'shell-appshell--aside-thread': 340,
  'shell-appshell--aside-closed': 0, 'shell-appshell--frame-members-closed': 0,
};
async function checkAside(page: Page, context: StoryContext, want: number): Promise<void> {
  // Let the width transition settle (the runner already waited for finite animations; this is the belt to that).
  await page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity), undefined, { timeout: 5_000 }).catch(() => {});
  const got = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('#storybook-root .d-app-shell__aside');
    if (el === null) return null;
    const control = el.querySelector<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])');
    control?.focus();
    return {
      width: Math.round(el.getBoundingClientRect().width * 10) / 10, visibility: getComputedStyle(el).visibility, inert: el.inert,
      bodyWidth: Math.round((el.querySelector('.d-app-shell__aside-body')?.getBoundingClientRect().width ?? 0) * 10) / 10,
      focused: control !== null && document.activeElement === control,
    };
  });
  const name = `${context.title} / ${context.name}`;
  if (got === null) throw new Error(`${name}: no aside`);
  if (Math.abs(got.width - want) > 0.5) throw new Error(`${name}: the aside is ${String(got.width)} wide, want ${String(want)}`);
  if (want === 0) {
    if (got.visibility !== 'hidden' || !got.inert) throw new Error(`${name}: the closed aside is ${got.visibility} and inert=${String(got.inert)}`);
    if (got.focused) throw new Error(`${name}: a control in the closed aside takes focus`);
  } else {
    if (got.visibility !== 'visible' || got.inert) throw new Error(`${name}: the open aside is ${got.visibility} and inert=${String(got.inert)}`);
    // The body is the open width less the 1px hairline, whatever the column is doing.
    if (Math.abs(got.bodyWidth - (want - 1)) > 0.5) throw new Error(`${name}: the aside body is ${String(got.bodyWidth)} wide, want ${String(want - 1)}`);
    await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  }
}

/**
 * Fix round 2: the web app's close path (the content goes with the close). The same aside element animates its width to 0:
 * ~100ms after the click it is between 0 and 232, then it ends hidden or unmounted; a reopen animates from 0 again.
 */
async function checkAsideTransition(page: Page, context: StoryContext): Promise<void> {
  const name = `${context.title} / ${context.name}`;
  const read = () => page.evaluate(() => {
    const el = document.querySelector<HTMLElement & { __mark?: boolean }>('#storybook-root .d-app-shell__aside');
    return el === null ? null : { width: el.getBoundingClientRect().width, same: el.__mark === true, open: el.dataset.open, visibility: getComputedStyle(el).visibility };
  });
  await page.waitForTimeout(600);
  const before = await read();
  if (before === null || Math.abs(before.width - 232) > 0.5) throw new Error(`${name}: the open aside is ${String(before?.width)} wide, want 232`);
  await page.evaluate(() => { (document.querySelector('#storybook-root .d-app-shell__aside') as (HTMLElement & { __mark?: boolean }) | null)!.__mark = true; });
  await page.click('#storybook-root .story-aside-toggle');
  await page.waitForTimeout(100);
  const mid = await read();
  if (mid === null || !mid.same) throw new Error(`${name}: closing replaced or removed the aside at once`);
  if (mid.open !== 'false' || !(mid.width > 0.5 && mid.width < 231.5)) throw new Error(`${name}: 100ms into the close the aside is ${String(mid.width)} wide (data-open ${String(mid.open)}), want between 0 and 232`);
  await page.waitForTimeout(800);
  const after = await read();
  if (after !== null && (after.width > 0.5 || after.visibility !== 'hidden')) throw new Error(`${name}: the closed aside is ${String(after.width)} wide and ${after.visibility}`);
  await page.click('#storybook-root .story-aside-toggle');
  await page.waitForTimeout(100);
  const reopening = await read();
  if (reopening === null || !(reopening.width > 0.5 && reopening.width < 231.5)) throw new Error(`${name}: 100ms into the reopen the aside is ${String(reopening?.width)} wide, want between 0 and 232`);
  await page.waitForTimeout(600);
  const reopened = await read();
  if (reopened === null || Math.abs(reopened.width - 232) > 0.5) throw new Error(`${name}: the reopened aside is ${String(reopened?.width)} wide, want 232`);
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
}

/** The top bar's geometry (README §5.2, the prototype's inline sizes), in CSS px at a 16px root. */
async function checkTopBar(page: Page, context: StoryContext): Promise<void> {
  const got = await page.evaluate(() => {
    const box = (sel: string) => {
      const el = document.querySelector(`#storybook-root ${sel}`);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
    };
    return { bar: box('.d-topbar'), search: box('.d-topbar__search'), bell: box('.d-topbar__bell .d-icon-button'), gear: box('.d-topbar__gear'),
      chip: box('.d-topbar__voice'), badge: box('.d-topbar__badge'), tile: box('.d-brand__tile'), caret: box('.d-brand__caret') };
  });
  const bad: string[] = [];
  const want = (what: string, b: { w: number; h: number } | null, w: number | null, h: number) => {
    if (b === null) { bad.push(`no ${what}`); return; }
    if (Math.abs(b.h - h) > 0.5 || (w !== null && Math.abs(b.w - w) > 0.5)) bad.push(`${what} is ${String(b.w)}x${String(b.h)}, want ${w === null ? '…' : String(w)}x${String(h)}`);
  };
  want('the bar', got.bar, null, 44);
  want('the search trigger', got.search, null, 28);
  want('the bell', got.bell, 28, 28);
  want('the gear', got.gear, 28, 28);
  want('the D tile', got.tile, 18, 18);
  want('the caret', got.caret, 6, 12);
  if (got.search !== null && got.search.w > 360.5) bad.push(`the search trigger is ${String(got.search.w)} wide, at most 360`);
  if (context.id.endsWith('--in-voice')) want('the voice chip', got.chip, null, 28);
  else if (got.chip !== null) bad.push('a voice chip outside a call');
  if (context.id.endsWith('--reminders-due')) want('the due badge', got.badge, 14, 14);
  else if (got.badge !== null) bad.push('a due badge with nothing due');
  // The gear keeps its 45° hover turn while pressed (the prototype has no press state).
  if (context.id === 'shell-topbar--default') {
    await page.hover('#storybook-root .d-topbar__gear');
    await page.mouse.down();
    await page.waitForTimeout(300);
    const turn = await page.evaluate(() => {
      const el = document.querySelector('#storybook-root .d-topbar__gear');
      return el === null ? '' : getComputedStyle(el).transform;
    });
    await page.mouse.up();
    await page.mouse.move(0, 0);
    // rotate(45deg) is matrix(0.707107, 0.707107, -0.707107, 0.707107, 0, 0); a scale would shrink the terms.
    const m = /^matrix\(([-\d.]+), ([-\d.]+)/.exec(turn);
    if (m === null || Math.abs(Number(m[1]) - Math.SQRT1_2) > 0.01 || Math.abs(Number(m[2]) - Math.SQRT1_2) > 0.01) bad.push(`the pressed gear's transform is ${turn}, want rotate(45deg)`);
  }
  if (bad.length > 0) throw new Error(`${context.title} / ${context.name}: ${bad.join('; ')}`);
}

export async function checkStory(page: Page, context: StoryContext): Promise<void> {
    if (context.id === 'settings-settingsframe--phone-index') {
      await page.setViewportSize({ width: 640, height: 400 });
      await page.waitForFunction(() => document.querySelector('.d-settings-frame')?.getAttribute('data-layout') === 'phone');
    }
    await injectAxe(page);
    const strict = STRICT_TARGET_TITLES.some(prefix => context.title.startsWith(prefix));
    await checkA11y(page, '#storybook-root', {
      detailedReport: true, detailedReportOptions: { html: true }, includedImpacts: ['critical', 'serious'],
      ...(strict ? { axeOptions: { rules: { 'target-size': { enabled: true } } } } : {}),
    });
    // Control boundaries meet WCAG 1.4.11 (3:1): an input, a select, a segmented outline and the off toggle's
    // track are drawn in --edge, rgb(92, 99, 110) in the signal theme, never the fainter hairline.
    const edgeSelector = boundarySelector(context.id);
    if (edgeSelector) {
      const edge = await page.evaluate(sel => {
        const el = document.querySelector(sel);
        return el ? { theme: document.documentElement.getAttribute('data-theme'), border: getComputedStyle(el).borderTopColor } : null;
      }, edgeSelector);
      if (!edge) throw new Error(`${context.title} / ${context.name}: no ${edgeSelector} to check`);
      if (edge.theme !== 'signal') throw new Error(`${context.title} / ${context.name}: expected theme signal, got ${edge.theme}`);
      if (edge.border !== 'rgb(92, 99, 110)') {
        throw new Error(`${context.title} / ${context.name}: ${edgeSelector} border is ${edge.border}, not --edge rgb(92, 99, 110)`);
      }
    }
    if (context.id.startsWith('shell-topbar--')) await checkTopBar(page, context);
    if (context.id === 'shell-appshell--aside-close-live') await checkAsideTransition(page, context);
    const asideWant = ASIDE_STORIES[context.id];
    if (asideWant !== undefined) await checkAside(page, context, asideWant);
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
    // Chrome labels (design ruling (i), task 24): the channel inside the composer's label keeps the case it was given.
    const casing = await page.evaluate(() => {
      const bad: string[] = [];
      const want = (selector: string, transform: string) => {
        for (const el of Array.from(document.querySelectorAll(`#storybook-root ${selector}`))) {
          const got = getComputedStyle(el).textTransform;
          if (got !== transform) bad.push(`${selector} "${el.textContent ?? ''}" is ${got}, expected ${transform}`);
        }
      };
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
    // the effective 640 × 400 CSS viewport enters the existing phone breakpoint: the section frame stays fullscreen,
    // with its title/actions and footer outside the scrolling body.
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
      await page.waitForFunction(() => document.querySelector('.d-settings-frame')?.getAttribute('data-layout') === 'phone');
      await checkA11y(page, '#storybook-root', {
        detailedReport: true, detailedReportOptions: { html: true }, includedImpacts: ['critical', 'serious'],
        ...(strict ? { axeOptions: { rules: { 'target-size': { enabled: true } } } } : {}),
      });
      const zoomed = await page.evaluate(() => {
        const frame = document.querySelector('.d-settings-frame');
        const panel = document.querySelector('.d-settings-frame__panel');
        const body = document.querySelector('.d-settings-frame__body');
        const nav = document.querySelector('.d-settings-frame__nav');
        const bar = document.querySelector('.d-settings-frame__bar');
        const footer = document.querySelector('.d-settings-frame__footer');
        const back = document.querySelector('[data-settings-back]');
        const sectionTitle = document.querySelector('.d-settings-frame__section-title');
        const last = Array.from(document.querySelectorAll('.d-settings-frame__body button')).at(-1);
        if (!frame || !panel || !body || !nav || !bar || !footer || !back || !sectionTitle || !last) return null;
        const size = frame.getBoundingClientRect();
        body.scrollTop = body.scrollHeight;
        const bodyRect = body.getBoundingClientRect();
        const headerRect = bar.getBoundingClientRect();
        const footerRect = footer.getBoundingClientRect();
        const lastRect = last.getBoundingClientRect();
        return {
          width: Math.round(size.width), height: Math.round(size.height), x: Math.round(size.x), y: Math.round(size.y),
          isPhoneSection: frame.getAttribute('data-layout') === 'phone' && frame.getAttribute('data-phone-page') === 'section',
          panelColumns: getComputedStyle(panel).gridTemplateColumns.trim().split(/\s+/).length,
          bodyScrolls: body.scrollHeight > body.clientHeight + 1, bodyOverflow: getComputedStyle(body).overflowY,
          navigationHidden: nav.hasAttribute('hidden'), hasClose: Array.from(frame.querySelectorAll('.d-settings-frame__bar button'))
            .some(button => button.textContent?.includes('Close settings') ?? false),
          sectionTitle: sectionTitle.textContent?.trim(),
          headerInPlace: Math.abs(headerRect.top - size.top) <= 1 && headerRect.bottom <= bodyRect.top + 1,
          footerInPlace: Math.abs(footerRect.bottom - size.bottom) <= 1 && footerRect.top >= bodyRect.bottom - 1,
          backVisible: back.getBoundingClientRect().width > 0 && back.getBoundingClientRect().height > 0,
          lastInView: lastRect.top >= bodyRect.top - 1 && lastRect.bottom <= bodyRect.bottom + 1,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1
            || document.body.scrollWidth > innerWidth + 1 || panel.scrollWidth > panel.clientWidth + 1,
        };
      });
      if (!zoomed || zoomed.width !== 640 || zoomed.height !== 400 || zoomed.x !== 0 || zoomed.y !== 0
        || !zoomed.isPhoneSection || zoomed.panelColumns !== 1 || !zoomed.bodyScrolls || zoomed.bodyOverflow !== 'auto'
        || !zoomed.navigationHidden || zoomed.hasClose || !zoomed.headerInPlace || !zoomed.footerInPlace
        || !zoomed.backVisible || zoomed.sectionTitle !== 'Devices' || !zoomed.lastInView || zoomed.horizontalOverflow) {
        throw new Error(`${context.title} / ${context.name}: phone section frame breaks its fullscreen scroll regions at 200% zoom (${JSON.stringify(zoomed)})`);
      }
    }
    if (context.id === 'settings-settingsframe--phone-index') {
      const index = await page.evaluate(() => {
        const frame = document.querySelector('.d-settings-frame');
        const panel = document.querySelector('.d-settings-frame__panel');
        const side = document.querySelector('.d-settings-frame__side');
        const nav = document.querySelector('.d-settings-frame__nav');
        const close = frame?.querySelector('.d-settings-frame__bar button');
        if (!frame || !panel || !side || !nav || !close) return null;
        const size = frame.getBoundingClientRect();
        const navRect = nav.getBoundingClientRect();
        close.scrollIntoView({ block: 'nearest' });
        const closeBefore = close.getBoundingClientRect();
        nav.scrollTop = nav.scrollHeight;
        const last = Array.from(nav.querySelectorAll('.d-settings-nav__item')).at(-1);
        if (!last) return null;
        const lastRect = last.getBoundingClientRect();
        const closeAfter = close.getBoundingClientRect();
        return {
          width: Math.round(size.width), height: Math.round(size.height), x: Math.round(size.x), y: Math.round(size.y),
          isPhoneIndex: frame.getAttribute('data-layout') === 'phone' && frame.getAttribute('data-phone-page') === 'index',
          navOverflow: getComputedStyle(nav).overflowY, navScrolls: nav.scrollHeight > nav.clientHeight + 1,
          lastInView: lastRect.top >= navRect.top - 1 && lastRect.bottom <= navRect.bottom + 1,
          closeInView: closeAfter.top >= size.top && closeAfter.bottom <= size.bottom && closeAfter.top >= navRect.bottom - 1,
          closeDoesNotMove: Math.abs(closeBefore.top - closeAfter.top) < 1,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1
            || document.body.scrollWidth > innerWidth + 1 || panel.scrollWidth > panel.clientWidth + 1,
        };
      });
      if (!index || index.width !== 640 || index.height !== 400 || index.x !== 0 || index.y !== 0
        || !index.isPhoneIndex || index.navOverflow !== 'auto' || !index.navScrolls || !index.lastInView
        || !index.closeInView || !index.closeDoesNotMove || index.horizontalOverflow) {
        throw new Error(`${context.title} / ${context.name}: phone index navigation scrolls with or hides Close (${JSON.stringify(index)})`);
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
