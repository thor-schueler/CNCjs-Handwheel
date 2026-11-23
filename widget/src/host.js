import { useEffect, useState } from 'react';

const params = new URLSearchParams(window.location.search);
const token = params.get('token');

/** `?debug=1` shows the widget's own expand/collapse button. */
export const DEBUG = params.get('debug') === '1';

/**
 * Announces the widget to CNCjs. CNCjs answers with its 'change' message and, when patched
 * (see the README), with the current full screen state.
 */
export function announce() {
  window.parent.postMessage({ token, action: { type: 'connect' } }, '*');
}

/**
 * Tells CNCjs the iframe's content size (the Custom widget sizes the iframe from it, it cannot
 * know it otherwise) and keeps doing so when the content changes.
 */
export function reportSize() {
  const post = () => {
    const b = document.body;
    window.parent.postMessage({
      token,
      action: {
        type: 'resize',
        payload: {
          clientHeight: b.clientHeight, clientWidth: b.clientWidth,
          offsetHeight: b.offsetHeight, offsetWidth: b.offsetWidth,
          scrollHeight: b.scrollHeight, scrollWidth: b.scrollWidth
        }
      }
    }, '*');
  };
  const observer = new ResizeObserver(post);
  observer.observe(document.body);
  return () => observer.disconnect();
}

/**
 * Watches the CNCjs widget container in the parent page for the class CNCjs puts on it while it is shown
 * full screen. Only possible when the widget is served from the same origin as CNCjs; returns null otherwise.
 *
 * @param {function(boolean): void} onChange - called with the current state now and on every change
 * @returns {?function(): void} stops watching, or null if the parent page cannot be inspected
 */
function watchParentFullscreen(onChange) {
  try {
    const region = window.frameElement && window.frameElement.closest('[role="region"]');
    if (!region) return null;
    // CSS-modules class such as "...Widget-index__widget-fullscreen--x1y2z"
    const read = () => /widget-fullscreen/.test(region.className);
    onChange(read());
    const observer = new MutationObserver(() => onChange(read()));
    observer.observe(region, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  } catch (err) {
    return null; // cross-origin parent
  }
}

/**
 * True while the CNCjs widget is shown full screen. Detected, in order, from the CNCjs page itself (same
 * origin only) and from a `{ action: { type: 'fullscreen', payload: { fullscreen } } }` message that a patched
 * CNCjs posts (see the README). With neither it stays false. `?mode=full` forces it on, and `?debug=1` adds an expand button.
 *
 * @returns {boolean}
 */
export function useHostFullscreen() {
  const [fullscreen, setFullscreen] = useState(params.get('mode') === 'full');
  useEffect(() => {
    const onMessage = (event) => {
      const { token: t, action } = { ...event.data };
      if (token && t !== token) return; // not from CNCjs for this widget
      if (action && action.type === 'fullscreen') {
        setFullscreen(!!(action.payload && action.payload.fullscreen));
      }
    };
    window.addEventListener('message', onMessage);
    const stopWatching = params.get('mode') === 'full' ? null : watchParentFullscreen(setFullscreen);
    return () => {
      window.removeEventListener('message', onMessage);
      if (stopWatching) stopWatching();
    };
  }, []);
  return fullscreen;
}

/**
 * Height available to the widget's content while CNCjs shows it full screen: the CNCjs widget box minus its
 * header. Needs a same-origin parent page (null otherwise, or when not `active`).
 *
 * @param {boolean} active - only measure while full screen
 * @returns {?number} pixels
 */
export function useHostHeight(active) {
  const [height, setHeight] = useState(null);
  useEffect(() => {
    if (!active) {
      setHeight(null);
      return undefined;
    }
    try {
      const region = window.frameElement && window.frameElement.closest('[role="region"]');
      if (!region) return undefined;
      const header = region.querySelector('[class*="widget-header"]');
      const read = () => setHeight(region.clientHeight - (header ? header.offsetHeight : 34));
      read();
      const observer = new ResizeObserver(read);
      observer.observe(region);
      return () => observer.disconnect();
    } catch (err) {
      return undefined; // cross-origin parent
    }
  }, [active]);
  return height;
}

/** `?theme=light|dark`, or null: an explicit choice that also turns off following the CNCjs theme. */
export const forcedTheme = ['light', 'dark'].includes(params.get('theme')) ? params.get('theme') : null;

/**
 * Picks light or dark: `?theme=` wins, then the CNCjs page's data-color-mode (readable because the widget is
 * served from the same origin), then a "dark" class on its <html>, then the OS preference.
 *
 * @returns {'light'|'dark'}
 */
export function detectTheme() {
  if (forcedTheme) return forcedTheme;
  try {
    const el = window.parent.document.documentElement;
    const mode = el.getAttribute('data-color-mode'); // CNCjs sets this on <html>
    if (mode === 'light' || mode === 'dark') return mode;
    const marks = [el.className, ...Array.from(el.attributes).map((a) => a.name + '=' + a.value)].join(' ');
    if (/dark/i.test(marks)) return 'dark';
    if (/light/i.test(marks)) return 'light';
  } catch (err) {
    // cross-origin parent: fall through
  }
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
