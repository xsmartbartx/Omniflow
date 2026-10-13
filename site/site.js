// Theme: follow the OS by default; the toggle stores an explicit choice. Storage may be blocked, so every access is guarded.
(() => {
  const KEY = 'constans-site-theme';
  const root = document.documentElement;
  const read = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  };
  const write = (v) => {
    try {
      localStorage.setItem(KEY, v);
    } catch {
      /* private mode: the choice just lasts for this page */
    }
  };
  const apply = (mode) => {
    root.classList.toggle('light', mode === 'light');
    root.classList.toggle('dark', mode === 'dark');
  };
  const saved = read();
  if (saved === 'light' || saved === 'dark') apply(saved);

  document.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('theme');
    if (!btn) return;
    const isDark = () =>
      root.classList.contains('dark') ||
      (!root.classList.contains('light') && !matchMedia('(prefers-color-scheme: light)').matches);
    const sync = () => btn.setAttribute('aria-pressed', String(!isDark()));
    sync();
    btn.addEventListener('click', () => {
      const next = isDark() ? 'light' : 'dark';
      apply(next);
      write(next);
      sync();
    });
  });
})();
