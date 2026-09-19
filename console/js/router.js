// Hash router. `#/runs/run_123?tab=events` → { route, params: { id }, query: { tab } }.

export function compile(pattern) {
  const keys = [];
  const source = pattern.replace(/\/:([A-Za-z]+)/g, (_m, k) => {
    keys.push(k);
    return '/([^/]+)';
  });
  const re = new RegExp(`^${source.replace(/\//g, '\\/')}$`);
  return { re, keys };
}

export function matchRoute(routes, hash) {
  const raw = (hash || '').replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs));
  for (const route of routes) {
    const { re, keys } = route.compiled ?? (route.compiled = compile(route.path));
    const m = re.exec(path);
    if (m)
      return { route, params: Object.fromEntries(keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])), query, path };
  }
  return { route: undefined, params: {}, query, path };
}

export function href(path, query) {
  const qs = query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : '';
  return `#${path}${qs}`;
}

export function navigate(path, query) {
  const target = href(path, query);
  if (location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = target;
}
