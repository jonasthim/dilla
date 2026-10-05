import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page } from '@playwright/test';

export interface AxeFinding { id: string; impact: 'serious' | 'critical'; help: string; targets: string[] }

let source: string | null = null;
function axeSource(): string {
  source ??= readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  return source;
}

type AxeWindow = Window & { axe?: { version: string; run(context: unknown, options: unknown): Promise<{ violations: { id: string; impact: string | null; help: string; nodes: { target: string[] }[] }[] }> } };

/** Not page.addScriptTag: an inline <script> is refused by the served CSP (L-HTTP-10) and reported as a
 *  securitypolicyviolation. A protocol-level evaluate is not subject to the page's CSP. */
export async function injectAxe(page: Page): Promise<void> {
  if (!(await page.evaluate(() => typeof (window as AxeWindow).axe !== 'undefined'))) {
    await page.evaluate(axeSource());
  }
}

export async function runAxe(page: Page): Promise<AxeFinding[]> {
  await injectAxe(page);
  return page.evaluate(async () => {
    const result = await (window as AxeWindow).axe!.run(document, {
      resultTypes: ['violations'],
      rules: { 'target-size': { enabled: true } },
    });
    return result.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => ({ id: v.id, impact: v.impact as 'serious' | 'critical', help: v.help, targets: v.nodes.map((n) => n.target.join(' ')) }));
  });
}
