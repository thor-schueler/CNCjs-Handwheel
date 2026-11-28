import { useEffect, useState } from 'react';

const params = new URLSearchParams(window.location.search);
const token = params.get('token');

/** `?debug=1` shows the widget's own expand/collapse button. */
export const DEBUG = params.get('debug') === '1';

/** What CNCjs last told this page about its widget (see onMessage for the message shapes); null = not told. */
const hostProps = { disabled: null, fullscreen: null };
const subscribers = new Set();
let connected = false;

/** @returns {{disabled: ?boolean, fullscreen: ?boolean}} a copy of what CNCjs reported */
export const getHostProps = () => ({ ...hostProps });

/**
 * Calls `fn` with the full props object whenever CNCjs reports a change.
 *
 * @param {function(object): void} fn
 * @returns {function(): void} unsubscribe
 */
export function subscribeHostProps(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/**
 * Takes what a CNCjs message says about the widget. Three shapes exist, depending on the CNCjs version:
 *  - `change` with `payload.props` ({disabled, fullscreen}): the earlier fork-only `props` protocol (a `colorMode` in it is ignored);
 *  - `widget:state` with the fields directly in `payload` (upstream cncjs master): currently just `fullscreen`;
 *  - `change` with `payload.fullscreen` (cncjs between #1060 and #1069), and `widget:fullscreenchange` (same era).
 * Unknown or mistyped fields are ignored, and a message without any known field (a plain port `change`) is not
 * an update. A `change` also announces a new serial port, which is not this page's business.
 */
function onMessage(event) {
  const { token: t, action } = { ...event.data };
  if (event.source !== window.parent || (token && t !== token)) return; // not from CNCjs for this widget
  if (!action || !action.payload || typeof action.payload !== 'object') return;
  let source = null;
  if (action.type === 'change') {
    source = action.payload.props && typeof action.payload.props === 'object' ? action.payload.props : action.payload;
  } else if (action.type === 'widget:state' || action.type === 'widget:fullscreenchange') {
    source = action.payload;
  }
  if (!source) return;
  let updated = false;
  if (typeof source.disabled === 'boolean') { hostProps.disabled = source.disabled; updated = true; }
  if (typeof source.fullscreen === 'boolean') { hostProps.fullscreen = source.fullscreen; updated = true; }
  if (updated) subscribers.forEach((fn) => fn(getHostProps()));
}

/**
 * Handshake with CNCjs: starts listening, then asks once. CNCjs answers with its current state (full screen). The listener must exist first: the answer can arrive
 * before the page has finished starting, and the earlier `change` messages are lost when the iframe is
 * created by the very update they describe. Call once; further calls do nothing.
 */
export function connectToHost() {
  if (connected || window.parent === window) return;
  connected = true;
  window.addEventListener('message', onMessage);
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
 * True while the CNCjs widget is shown full screen. CNCjs says so in a `widget:state` message (cncjs master) or in the
 * `fullscreen` prop of its `change` messages (Custom widget `props`, see onMessage). Against a CNCjs that does neither
 * it falls back to watching the CNCjs page (same origin only) and otherwise stays false. `?mode=full` forces it on, `?debug=1` adds an expand button.
 *
 * @returns {boolean}
 */
export function useHostFullscreen() {
  const forced = params.get('mode') === 'full';
  const [fullscreen, setFullscreen] = useState(forced || !!getHostProps().fullscreen);
  useEffect(() => {
    if (forced) return undefined;
    const sync = (p) => { if (p.fullscreen !== null) setFullscreen(p.fullscreen); };
    sync(getHostProps());
    const unsubscribe = subscribeHostProps(sync);
    // The fallback only speaks while CNCjs has not sent the prop.
    const stopWatching = watchParentFullscreen((v) => { if (getHostProps().fullscreen === null) setFullscreen(v); });
    return () => {
      unsubscribe();
      if (stopWatching) stopWatching();
    };
  }, [forced]);
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

/** `?theme=light|dark`, or null: an explicit choice that also turns off following CNCjs. */
export const forcedTheme = ['light', 'dark'].includes(params.get('theme')) ? params.get('theme') : null;

/** The colour mode read off the CNCjs page itself (same origin only), or null; see setPageColorMode. */
let pageColorMode = null;
let applyColorMode = () => {};

/**
 * Tells the theme follower what the CNCjs page itself says its colour mode is. Only a same-origin widget can read
 * that (hostTheme.js does); it is exact where the browser does not pass the CNCjs colour scheme on to the
 * iframe (Safari before 2026), so it wins over the media query.
 *
 * @param {?('light'|'dark')} mode - the mode, or null when the page cannot be read
 */
export function setPageColorMode(mode) {
  pageColorMode = mode === 'light' || mode === 'dark' ? mode : null;
  applyColorMode();
}

/**
 * Keeps `data-theme` on <html> at the colour mode CNCjs is in. CNCjs sets `color-scheme: light|dark` on its root
 * element, the browser hands that to the iframe element, and the page inside sees it as `prefers-color-scheme`,
 * also across origins (Chrome, Edge, Firefox). So the media query is the source, and it is followed live.
 * Precedence: `?theme=`, then the CNCjs page itself (setPageColorMode), then the media query.
 *
 * @returns {function(): void} stops following
 */
export function followColorScheme() {
  const root = document.documentElement;
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  applyColorMode = () => {
    root.dataset.theme = forcedTheme || pageColorMode || (mq && mq.matches ? 'dark' : 'light');
  };
  applyColorMode();
  if (forcedTheme || !mq) return () => {};
  mq.addEventListener('change', applyColorMode);
  return () => mq.removeEventListener('change', applyColorMode);
}
