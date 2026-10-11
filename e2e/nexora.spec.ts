import { expect, test } from '@playwright/test';
import { a11y, csrf, echoWorkflow, NEXORA as BASE, watch } from './helpers';

test.describe.configure({ mode: 'serial' });

const ident = (orgId: string, userId: string, role: string) => ({
  orgId,
  userId,
  email: `${userId}@example.com`,
  name: userId,
  role,
});

async function enter(page: import('@playwright/test').Page, who: ReturnType<typeof ident>) {
  const r = await page.request.post(`${BASE}/app/dev-login`, { data: who });
  expect(r.status()).toBe(200);
  await page.goto(`${BASE}/app`);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
}

test('F12-N: without a NEXORA identity the console offers NEXORA sign-in, not a password form', async ({ page }) => {
  const w = watch(page);
  await page.goto(BASE);
  await expect(page.getByRole('link', { name: 'Continue with NEXORA' })).toBeVisible();
  await expect(page.getByLabel('Password')).toHaveCount(0);
  await a11y(page, 'nexora sign-in');
  w.assertClean();
});

test('F12-H1: sign in as a NEXORA org, run a workflow, see usage go up', async ({ page }) => {
  const w = watch(page);
  await enter(page, ident('org_e2e1', 'e2e_owner', 'owner'));
  await expect(page.getByRole('paragraph').filter({ hasText: '0 of 100 runs this month · free plan' })).toBeVisible();
  await a11y(page, 'dashboard (nexora)');

  const pub = await page.request.post(`${BASE}/v1/workflows`, {
    data: { manifest: echoWorkflow('nx-hello') },
    headers: csrf,
  });
  expect(pub.status(), await pub.text()).toBeLessThan(300);
  expect(
    (await page.request.post(`${BASE}/v1/workflows/nx-hello/run`, { data: { inputs: {} }, headers: csrf })).status(),
  ).toBe(202);
  await page.reload();
  await expect(page.getByRole('paragraph').filter({ hasText: '1 of 100 runs this month · free plan' })).toBeVisible();
  w.assertClean();
});

test('F12-N: at the plan limit the console says so and new runs get 429', async ({ page }) => {
  await enter(page, ident('org_e2e2', 'e2e_owner2', 'owner'));
  await page.request.post(`${BASE}/v1/workflows`, { data: { manifest: echoWorkflow('nx-limit') }, headers: csrf });
  for (let i = 0; i < 100; i++) {
    const r = await page.request.post(`${BASE}/v1/workflows/nx-limit/run`, { data: { inputs: {} }, headers: csrf });
    if (r.status() === 429) break;
  }
  const refused = await page.request.post(`${BASE}/v1/workflows/nx-limit/run`, { data: { inputs: {} }, headers: csrf });
  expect(refused.status()).toBe(429);
  expect((await refused.json()).error.code).toBe('ENTITLEMENT_EXCEEDED');
  await page.reload();
  await expect(page.getByText('Plan limit reached')).toBeVisible();
  await a11y(page, 'dashboard at limit');
});

test('F12-E: a second organisation cannot see the first one’s workflows', async ({ page }) => {
  await enter(page, ident('org_e2e3', 'e2e_other', 'owner'));
  await page.getByRole('link', { name: 'Workflows' }).click();
  await expect(page.getByText('nx-hello')).toHaveCount(0);
  await expect(page.getByText('nx-limit')).toHaveCount(0);
});

test('F12-N: a viewer cannot start runs or publish', async ({ page }) => {
  await enter(page, ident('org_e2e1', 'e2e_viewer', 'viewer'));
  const r = await page.request.post(`${BASE}/v1/workflows/nx-hello/run`, { data: { inputs: {} }, headers: csrf });
  expect(r.status()).toBe(403);
  const p = await page.request.post(`${BASE}/v1/workflows`, {
    data: { manifest: echoWorkflow('nope') },
    headers: csrf,
  });
  expect(p.status()).toBe(403);
});

test('F12-E: forged or missing identity is refused', async ({ request }) => {
  expect((await request.get(`${BASE}/app`, { maxRedirects: 0 })).status()).toBe(401);
  const forged = await request.get(`${BASE}/app`, { maxRedirects: 0, headers: { cookie: '__session=fake.AAAA' } });
  expect(forged.status()).toBe(401);
  // a forged application session cookie is refused too
  const forgedSession = await request.get(`${BASE}/v1/auth/me`, { headers: { cookie: 'cns_session=fake.AAAA' } });
  expect(forgedSession.status()).toBe(401);
});

test('F12-E: 390px width, no horizontal scroll', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const page = await ctx.newPage();
  await enter(page, ident('org_e2e1', 'e2e_owner', 'owner'));
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await a11y(page, 'dashboard (nexora) 390px');
  await ctx.close();
});

test('F12-E: when the short NEXORA session ends the user is sent to NEXORA sign-in, and Continue renews it', async ({
  page,
  context,
}) => {
  await enter(page, ident('org_e2e1', 'e2e_owner', 'owner'));
  await context.clearCookies({ name: 'cns_session' });
  await page.reload();
  await expect(page.getByRole('link', { name: 'Continue with NEXORA' })).toBeVisible();
  // the NEXORA identity cookie is still there, so Continue signs straight back in
  await page.getByRole('link', { name: 'Continue with NEXORA' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
});
