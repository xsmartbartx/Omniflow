// Tiny DOM helpers. Everything is built with createElement/textContent — never innerHTML — so
// server-provided strings can never become markup, and the page needs no inline script or style.

const SVG_NS = 'http://www.w3.org/2000/svg';
const FORBIDDEN = new Set(['innerHTML', 'outerHTML', 'srcdoc']);

function apply(el, props) {
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (FORBIDDEN.has(key)) throw new Error(`${key} is not allowed`);
    if (key === 'class') el.setAttribute('class', Array.isArray(value) ? value.filter(Boolean).join(' ') : value);
    else if (key === 'style') {
      if (typeof value !== 'object')
        throw new Error('style must be an object (inline style attributes are blocked by CSP)');
      Object.assign(el.style, value);
    } else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function')
      el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'selected') el[key] = value;
    else if (/^on/i.test(key)) throw new Error(`event handler attribute ${key} must be a function`);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/** Create an HTML element. `h('div', { class: 'x', onClick: fn }, 'text', child)` */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  apply(el, props);
  append(el, children);
  return el;
}

/** Create an SVG element. */
export function svg(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, props);
  append(el, children);
  return el;
}

/** Empty an element. Its `append` becomes null-safe (null/false are skipped, arrays flattened), so views can write `clear(box).append(cond ? node : null)`. */
export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  if (!el.dataset.safeAppend) {
    const native = Element.prototype.append.bind(el);
    el.append = (...children) =>
      native(
        ...children
          .flat(Infinity)
          .filter((c) => c !== null && c !== undefined && c !== false)
          .map((c) => (c instanceof Node ? c : String(c))),
      );
    el.dataset.safeAppend = '1';
  }
  return el;
}

export function replace(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
