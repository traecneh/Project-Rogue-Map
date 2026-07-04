export function debounce(fn, ms = 120) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function escHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

export function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

export function readCssVar(name) {
  const root = typeof document !== 'undefined' ? document.documentElement : null;
  if (!root) return '';
  return getComputedStyle(root).getPropertyValue(name).trim();
}
