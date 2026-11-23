/**
 * Our colour variable -> the CNCjs token (src/app/styles/theme.styl) it takes its value from. CNCjs has no
 * "success" green, so the OK green stays our own (the stylesheet picks one for light or dark).
 */
const TOKENS = {
  '--bg': '--color-surface',
  '--fg': '--color-text',
  '--muted': '--color-text-subtle',
  '--card': '--color-surface-alt',
  '--border': '--color-border',
  '--head-bg': '--color-widget-header-bg',
  '--head-fg': '--color-text',
  '--head-border': '--color-border-strong',
  '--accent': '--color-status-info-text',
  '--down': '--color-status-danger-text',
  '--warn': '--color-warning-text',
  '--btn-bg': '--btn-default-top',
  '--focus': '--color-focus-ring'
};

/**
 * Takes the colours from the CNCjs page the widget is embedded in: its light/dark mode (the data-color-mode
 * attribute on <html>) and the values of its theme tokens. Follows the page when the mode changes. Only possible
 * when the widget is served from the same origin as CNCjs; otherwise (or if CNCjs has no such tokens) the
 * widget's own stylesheet applies.
 *
 * @returns {?function(): void} stops following the page, or null if the page cannot be read
 */
export default function adoptHostTheme() {
  try {
    if (!window.frameElement) return null;
    const root = window.parent.document.documentElement;
    const mine = document.documentElement;
    const apply = () => {
      const mode = root.getAttribute('data-color-mode');
      if (mode === 'light' || mode === 'dark') mine.dataset.theme = mode;
      const computed = window.parent.getComputedStyle(root);
      Object.keys(TOKENS).forEach((name) => {
        const value = computed.getPropertyValue(TOKENS[name]).trim();
        if (value) mine.style.setProperty(name, value);
        else mine.style.removeProperty(name);
      });
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ['data-color-mode', 'class', 'style'] });
    return () => observer.disconnect();
  } catch (err) {
    return null; // cross-origin parent
  }
}
