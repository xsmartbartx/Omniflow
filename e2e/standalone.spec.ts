import { expect, test } from '@playwright/test';
import { a11y, ADMIN, apiLogin, csrf, echoWorkflow, STANDALONE as BASE, watch } from './helpers';

test.describe.configure({ mode: 'serial' });

test('F01-H1/N1: sign-in rejects a wrong password, accepts the right one', async ({ page }) => {
  const w = watch(page);
  await page.goto(BASE);
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await a11y(page, 'login');

  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill('definitely-the-wrong-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByText('Could not sign in')).toBeVisible();

  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  // standalone shows no NEXORA plan card
  await expect(page.getByText('Plan usage')).toHaveCount(0);
  w.assertClean();
});

test('F01/F02-H1: publish a workflow, run it from the console, see it succeed', async ({ page, request }) => {
  const w = watch(page);
  await apiLogin(request, BASE);
  const pub = await request.post(`${BASE}/v1/workflows`, {
    data: { manifest: echoWorkflow('e2e-hello') },
    headers: csrf,
  });
  expect(pub.status(), await pub.text()).toBeLessThan(300);

  await page.goto(BASE);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Workflows' }).click();
  await a11y(page, 'workflows');
  await page.getByRole('link', { name: 'e2e-hello' }).first().click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('button', { name: 'Start run' }).click();
  await expect(page).toHaveURL(/#\/runs\/run_/);
  await expect(page.getByText(/succeeded/i).first()).toBeVisible({ timeout: 15_000 });
  await a11y(page, 'run detail');
  w.assertClean();
});

test('F02-E: a second tab sees the same run in the list', async ({ browser }) => {
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  for (const p of [a, b]) {
    await p.goto(BASE);
    if (
      await p
        .getByRole('button', { name: 'Sign in' })
        .isVisible()
        .catch(() => false)
    ) {
      await p.getByLabel('Email').fill(ADMIN.email);
      await p.getByLabel('Password').fill(ADMIN.password);
      await p.getByRole('button', { name: 'Sign in' }).click();
    }
  }
  await b.goto(`${BASE}/#/runs`);
  await expect(b.getByText('e2e-hello').first()).toBeVisible();
  await a.goto(`${BASE}/#/runs`);
  await expect(a.getByText('e2e-hello').first()).toBeVisible();
  await ctx.close();
});

test('F03-H1: audit log verifies', async ({ page }) => {
  const w = watch(page);
  await page.goto(BASE);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Audit log' }).click();
  await page.getByRole('button', { name: 'Verify integrity' }).click();
  await expect(page.getByText('The audit log is intact.')).toBeVisible();
  await a11y(page, 'audit log');
  w.assertClean();
});

test('F01-E: an expired session sends the user back to sign-in', async ({ page, context }) => {
  await page.goto(BASE);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await context.clearCookies();
  await page
    .getByRole('button', { name: 'Refresh' })
    .click()
    .catch(() => page.reload());
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 10_000 });
});

test('F01-E: 390px width has no horizontal scroll and no accessibility violations', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await a11y(page, 'dashboard 390px');
  await ctx.close();
});

test('F01-E: every console screen passes the accessibility scan, dark and light', async ({ page }) => {
  const w = watch(page);
  const routes = [
    'dashboard',
    'workflows',
    'editor',
    'runs',
    'approvals',
    'changes',
    'insights',
    'capabilities',
    'triggers',
    'secrets',
    'audit',
    'admin',
    'account',
  ];
  await page.goto(BASE);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const r of routes) {
      await page.goto(`${BASE}/#/${r}`);
      await expect(page.getByRole('heading').first()).toBeVisible();
      await page.waitForTimeout(250);
      await a11y(page, `${r} (${scheme})`);
    }
  }
  w.assertClean();
});

test('F01-E: workflow search supports * and the last-run filter narrows the list', async ({ page, request }) => {
  await apiLogin(request, BASE);
  for (const n of ['find-alpha', 'find-beta', 'other-gamma'])
    expect(
      (await request.post(`${BASE}/v1/workflows`, { data: { manifest: echoWorkflow(n) }, headers: csrf })).status(),
    ).toBeLessThan(300);
  await request.post(`${BASE}/v1/workflows/find-alpha/run`, { data: { inputs: {} }, headers: csrf });
  await page.goto(BASE);
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Workflows' }).click();
  const search = page.getByLabel('Filter workflows');
  await search.fill('find-*');
  await expect(page.getByRole('link', { name: 'find-alpha' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'find-beta' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'other-gamma' })).toHaveCount(0);
  await page.getByLabel('Last run').selectOption('succeeded');
  await expect(page.getByRole('link', { name: 'find-alpha' })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole('link', { name: 'find-beta' })).toHaveCount(0);
  await a11y(page, 'workflows (filtered)');
});

test('self-serve sign-up: a visitor creates an account, lands in a workspace of their own, and the screen is accessible', async ({
  page,
}) => {
  const w = watch(page);
  await page.goto(BASE);
  await page.getByRole('link', { name: 'Create an account' }).click();
  await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible();
  await a11y(page, 'sign-up');
  const email = `visitor-${Date.now()}@example.com`;
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Company').fill('Visitors Ltd');
  await page.getByLabel('Password (at least 12 characters)').fill('a-long-enough-passphrase');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  w.assertClean();
});
