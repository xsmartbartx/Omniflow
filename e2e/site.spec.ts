import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const SITE = 'http://127.0.0.1:18093';
const PAGES = ['/', '/platform.html', '/security.html', '/pricing.html'];

for (const path of PAGES) {
  for (const scheme of ['dark', 'light'] as const) {
    test(`site ${path} (${scheme}): accessible, one h1, no console errors`, async ({ page }) => {
      const problems: string[] = [];
      page.on('pageerror', (e) => problems.push(e.message));
      page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(SITE + path);
      await expect(page.locator('h1')).toHaveCount(1);
      const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      expect(res.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(' ')}`)).toEqual([]);
      expect(problems).toEqual([]);
    });
  }
}

test('site: no horizontal scroll at 390px and every internal link resolves', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  for (const path of PAGES) {
    await page.goto(SITE + path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const hrefs = await page.locator('a[href^="/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
    for (const h of new Set(hrefs)) expect((await request.get(SITE + h.split('#')[0]!)).status(), h).toBe(200);
  }
});
