import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type APIRequestContext } from '@playwright/test';

export const STANDALONE = 'http://127.0.0.1:18091';
export const NEXORA = 'http://127.0.0.1:18092';
export const ADMIN = { email: 'admin@example.com', password: 'correct-horse-battery-staple' };

/** Collect console errors and 5xx responses; call `assertClean()` at the end of a test. Expected 4xx are allowed. */
export function watch(page: Page) {
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // The browser logs every non-2xx fetch as a console error; those are asserted through the UI instead.
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`);
  });
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? '';
    // A navigation or reload cancels in-flight requests; that is not a failure.
    if (!/ERR_ABORTED/.test(why)) problems.push(`requestfailed ${r.url()}: ${why}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 500) problems.push(`${r.status()} ${r.url()}`);
  });
  return { assertClean: () => expect(problems).toEqual([]) };
}

/** WCAG A/AA scan of the current screen. */
export async function a11y(page: Page, label: string) {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = res.violations.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes[0]?.target.join(' ')}`);
  expect(summary, `axe on ${label}`).toEqual([]);
}

export const echoWorkflow = (name: string) => `apiVersion: omniflow.dev/v1
kind: Workflow
metadata: { name: ${name}, version: 1.0.0, owner: qa@example.com, criticality: low }
triggers: [{ type: manual }]
inputs: {}
steps:
  - id: say
    type: capability
    uses: util-echo@^1
    with: { value: hello }
`;

/** Sign in over the API and return a context that carries the session cookie. */
export async function apiLogin(request: APIRequestContext, base: string) {
  const res = await request.post(`${base}/v1/auth/login`, { data: ADMIN });
  expect(res.status()).toBe(200);
}

export const csrf = { 'x-requested-with': 'omniflow' };
