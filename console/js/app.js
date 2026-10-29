import * as api from './api.js';
import { clear, h } from './dom.js';
import { matchRoute, navigate } from './router.js';
import { can, clearSession, loadSession, session } from './session.js';
import { errorBox, icon, spinner, toast } from './ui.js';

// Route table. Views are loaded lazily; each exports `default async function (ctx) → Node`.
const ROUTES = [
  { path: '/', redirect: '/dashboard' },
  {
    path: '/dashboard',
    title: 'Dashboard',
    nav: ['Overview', 'dashboard'],
    view: () => import('./views/dashboard.js'),
  },
  { path: '/workflows', title: 'Workflows', nav: ['Build', 'workflow'], view: () => import('./views/workflows.js') },
  { path: '/workflows/:name', title: 'Workflow', parent: '/workflows', view: () => import('./views/workflow.js') },
  {
    path: '/editor',
    title: 'Editor',
    nav: ['Build', 'authoring', 'Editor & AI'],
    view: () => import('./views/editor.js'),
  },
  { path: '/editor/:draft', title: 'Editor', parent: '/editor', view: () => import('./views/editor.js') },
  { path: '/runs', title: 'Runs', nav: ['Operate', 'runs'], view: () => import('./views/runs.js') },
  { path: '/runs/:id', title: 'Run', parent: '/runs', view: () => import('./views/run.js') },
  {
    path: '/approvals',
    title: 'Approvals',
    nav: ['Operate', 'approvals', null, 'approvals'],
    view: () => import('./views/approvals.js'),
  },
  {
    path: '/changes',
    title: 'Change requests',
    nav: ['Operate', 'changes', null, 'changes'],
    view: () => import('./views/changes.js'),
  },
  {
    path: '/insights',
    title: 'Insights',
    nav: ['Operate', 'insight', null, 'alerts'],
    view: () => import('./views/insights.js'),
  },
  {
    path: '/capabilities',
    title: 'Capabilities',
    nav: ['Configure', 'capability'],
    view: () => import('./views/capabilities.js'),
  },
  { path: '/triggers', title: 'Triggers', nav: ['Configure', 'trigger'], view: () => import('./views/triggers.js') },
  { path: '/secrets', title: 'Secrets', nav: ['Configure', 'secret'], view: () => import('./views/secrets.js') },
  { path: '/audit', title: 'Audit log', nav: ['Govern', 'audit'], view: () => import('./views/audit.js') },
  {
    path: '/admin',
    title: 'Users & keys',
    nav: ['Govern', 'admin'],
    can: 'user.manage',
    view: () => import('./views/admin.js'),
  },
  {
    path: '/billing',
    title: 'Plans & billing',
    nav: ['Configure', 'capability', 'Plans & billing'],
    view: () => import('./views/billing.js'),
  },
  { path: '/account', title: 'Account', view: () => import('./views/account.js') },
];

const root = document.getElementById('app');
const cleanups = [];
let badgeTimer;
const counts = { approvals: 0, changes: 0, alerts: 0 };

function makeCtx(match) {
  return {
    params: match.params,
    query: match.query,
    cleanup: (fn) => cleanups.push(fn),
    /** Run `fn` now and every `ms` while the view is shown and the tab is visible. */
    poll(fn, ms) {
      let stopped = false;
      const tick = async () => {
        if (stopped || document.hidden) return;
        try {
          await fn();
        } catch {
          /* a failed refresh is not worth interrupting the person */
        }
      };
      const id = setInterval(tick, ms);
      cleanups.push(() => {
        stopped = true;
        clearInterval(id);
      });
    },
    navigate,
    refreshBadges,
  };
}

function runCleanups() {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

async function refreshBadges() {
  try {
    const [approvals, changes, alerts] = await Promise.all([
      api.get('/v1/approvals?status=pending&limit=200'),
      api.get('/v1/changes?status=pending'),
      api.get('/v1/insights/alerts'),
    ]);
    counts.approvals = approvals.items.filter((a) => a.canDecide).length;
    counts.changes = changes.items.length;
    counts.alerts = alerts.active.length;
    for (const [key, n] of Object.entries(counts)) {
      const el = document.querySelector(`[data-badge="${key}"]`);
      if (el) {
        el.textContent = String(n);
        el.hidden = n === 0;
      }
    }
  } catch {
    /* badges are a convenience */
  }
}

function buildShell() {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Main' });
  let group = '';
  for (const r of ROUTES.filter((x) => x.nav && (!x.can || can(x.can)))) {
    const [g, ic, label, badgeKey] = r.nav;
    if (g !== group) {
      nav.append(h('div', { class: 'nav-group' }, g));
      group = g;
    }
    nav.append(
      h(
        'a',
        { href: `#${r.path}`, dataset: { path: r.path } },
        icon(ic),
        h('span', {}, label ?? r.title),
        badgeKey ? h('span', { class: 'count', dataset: { badge: badgeKey }, hidden: true }, '0') : null,
      ),
    );
  }
  const me = session.me;
  if (!me) throw new Error('The shell needs a loaded session');
  const side = h(
    'aside',
    { class: 'side', id: 'side' },
    h(
      'div',
      { class: 'brand' },
      h('img', { src: '/favicon.svg', alt: '' }),
      'OmniFlow',
      h('span', { class: ['env-pill', me.environment] }, me.environment),
    ),
    nav,
    h(
      'div',
      { class: 'side-foot' },
      h('div', { class: 'who' }, me.user?.name ?? me.principal.name),
      h('div', { class: 'roles' }, me.principal.roles.join(', ')),
      h('a', { href: '#/account', class: 'row' }, icon('admin', { size: 14 }), 'Account'),
      h('a', { href: '#/login', class: 'row', onClick: signOut }, icon('logout', { size: 14 }), 'Sign out'),
    ),
  );
  const main = h('main', { class: 'main', id: 'main', tabindex: -1 });
  const menu = h(
    'button',
    { type: 'button', class: 'btn menu-btn', 'aria-label': 'Menu', onClick: () => side.classList.toggle('open') },
    icon('menu'),
  );
  return { shell: h('div', { class: 'shell' }, side, h('div', { class: 'content' }, menu, main)), main, side };
}

async function signOut(ev) {
  ev?.preventDefault();
  try {
    await api.post('/v1/auth/logout');
  } catch {
    /* already gone */
  }
  void showLogin();
}

let shellParts;

async function renderRoute() {
  if (!session.me) return showLogin();
  runCleanups();
  const match = matchRoute(ROUTES, location.hash);
  if (match.route?.redirect) return navigate(match.route.redirect);
  if (!shellParts) return;
  const { main, side } = shellParts;
  side.classList.remove('open');
  const active = match.route?.parent ?? match.route?.path;
  for (const a of side.querySelectorAll('.nav a')) {
    if (a.dataset.path === active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }

  if (!match.route || (match.route.can && !can(match.route.can))) {
    document.title = 'Not found · OmniFlow';
    return clear(main).append(
      errorBox(new Error(match.route ? 'You do not have access to this page.' : 'That page does not exist.'), {
        title: 'Not found',
      }),
      h('p', {}, h('a', { href: '#/dashboard' }, 'Back to the dashboard')),
    );
  }
  document.title = `${match.route.title} · OmniFlow`;
  clear(main).append(spinner());
  try {
    const mod = await match.route.view();
    const ctx = makeCtx(match);
    const node = await mod.default(ctx);
    clear(main).append(node);
    main.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (e) {
    clear(main).append(errorBox(e));
  }
}

function boot() {
  const { shell, main, side } = buildShell();
  shellParts = { main, side };
  clear(root).append(shell);
  void refreshBadges();
  clearInterval(badgeTimer);
  badgeTimer = setInterval(() => !document.hidden && refreshBadges(), 30000);
}

async function showLogin() {
  runCleanups();
  clearInterval(badgeTimer);
  clearSession();
  shellParts = undefined;
  const mod = await import('./views/login.js');
  const info = await api.get('/v1/info').catch(() => undefined);
  const { node, title } = loginScreen(mod, info);
  clear(root).append(node);
  document.title = `${title} · OmniFlow`;
}

/** Which signed-out screen the address asks for: sign in, create an account, or one of the password-reset steps. */
function loginScreen(mod, info) {
  const hash = location.hash;
  if (info?.mode === 'nexora') return { node: mod.nexoraSignIn(), title: 'Sign in' };
  if (info?.signup && hash === '#/signup')
    return { node: mod.signUp({ onSignedIn: start, terms: info.signupTerms }), title: 'Create an account' };
  if (info?.passwordReset && hash === '#/forgot') return { node: mod.forgotPassword(), title: 'Reset your password' };
  if (info?.passwordReset && hash.startsWith('#/reset')) {
    const token = new URLSearchParams(hash.split('?')[1] ?? '').get('token') ?? '';
    const onDone = () => {
      location.hash = '#/login';
    };
    return { node: mod.resetPassword({ token, onDone }), title: 'Choose a new password' };
  }
  return {
    node: mod.default({
      onSignedIn: start,
      signup: Boolean(info?.signup),
      passwordReset: Boolean(info?.passwordReset),
    }),
    title: 'Sign in',
  };
}

async function start() {
  try {
    await loadSession();
  } catch (e) {
    if (e.status === 401) return showLogin();
    clear(root).append(errorBox(e, { title: 'Cannot load the console' }));
    return;
  }
  if (session.me.user?.mustChangePassword) {
    const mod = await import('./views/login.js');
    clear(root).append(mod.changePassword({ onDone: start }));
    return;
  }
  boot();
  if (['#/login', '#/signup'].some((h) => location.hash.startsWith(h)) || !location.hash) location.hash = '#/dashboard';
  void renderRoute();
}

api.onUnauthenticated(() => {
  if (session.me) {
    toast('Your session ended. Sign in again to pick up where you were.', 'warn');
    void showLogin();
  }
});
window.addEventListener('hashchange', renderRoute);
await start();
