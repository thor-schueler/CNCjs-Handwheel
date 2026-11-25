import { useEffect, useState } from 'react';

const params = new URLSearchParams(window.location.search);
const token = params.get('token');

/** `?debug=1` shows the widget's own expand/collapse button. */
export const DEBUG = params.get('debug') === '1';

/** What CNCjs last told this page about its widget (the `props` of a `change` message); null = not told. */
const hostProps = { disabled: null, fullscreen: null, colorMode: null };
const subscribers = new Set();
let connected = false;

/** @returns {{disabled: ?boolean, fullscreen: ?boolean, colorMode: ?('light'|'dark')}} a copy of what CNCjs reported */
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

/** Takes the `props` of a CNCjs `change` message; unknown or mistyped fields are ignored. */
function onMessage(event) {
  const { token: t, action } = { ...event.data };
  if (event.source !== window.parent || (token && t !== token)) return; // not from CNCjs for this widget
  // A `change` also announces a new serial port; only `payload.props` matters here, and an older CNCjs sends none.
  const props = action && action.type === 'change' && action.payload && action.payload.props;
  if (!props || typeof props !== 'object') return;
  if (typeof props.disabled === 'boolean') hostProps.disabled = props.disabled;
  if (typeof props.fullscreen === 'boolean') hostProps.fullscreen = props.fullscreen;
  if (props.colorMode === 'light' || props.colorMode === 'dark') hostProps.colorMode = props.colorMode;
  subscribers.forEach((fn) => fn(getHostProps()));
}

/**
 * Handshake with CNCjs: starts listening, then asks once. CNCjs answers with a `change` message holding the
 * current props (full screen, colour mode, disabled). The listener must exist first: the answer can arrive
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
 * True while the CNCjs widget is shown full screen. CNCjs says so in the `fullscreen` prop of its `change`
 * messages. Against a CNCjs that does not (older than the Custom widget `props`) it falls back to watching the
 * CNCjs page (same origin only) and otherwise stays false. `?mode=full` forces it on, `?debug=1` adds an expand button.
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

/** `?theme=light|dark`, or null: an explicit choice that also turns off following the CNCjs theme. */
export const forcedTheme = ['light', 'dark'].includes(params.get('theme')) ? params.get('theme') : null;

/**
 * The colour mode to start with, before CNCjs has said which it is: `?theme=` or else the OS preference.
 *
 * @returns {'light'|'dark'}
 */
export function initialTheme() {
  if (forcedTheme) return forcedTheme;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Keeps `data-theme` on <html> at the colour mode CNCjs reports (its `colorMode` prop, which works across
 * origins). `?theme=` stays in charge when given.
 *
 * @returns {function(): void} stops following
 */
export function followHostColorMode() {
  const root = document.documentElement;
  root.dataset.theme = initialTheme();
  if (forcedTheme) return () => {};
  const apply = (p) => { if (p.colorMode) root.dataset.theme = p.colorMode; };
  apply(getHostProps());
  return subscribeHostProps(apply);
}
