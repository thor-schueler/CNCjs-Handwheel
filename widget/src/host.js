import { useEffect, useState } from 'react';

const params = new URLSearchParams(window.location.search);
const token = params.get('token');

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
 * True while the CNCjs widget is shown full screen. Stock CNCjs does not tell custom widgets, so this
 * stays false unless CNCjs posts `{ action: { type: 'fullscreen', payload: { fullscreen } } }`
 * (see the README); the in-widget expand button is the fallback.
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
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return fullscreen;
}

/**
 * Picks light or dark: `?theme=` wins, then a "dark" class or data attribute on the CNCjs page's <html>
 * (readable because the widget is served from the same origin), then the OS preference.
 *
 * @returns {'light'|'dark'}
 */
export function detectTheme() {
  const forced = params.get('theme');
  if (forced === 'dark' || forced === 'light') return forced;
  try {
    const el = window.parent.document.documentElement;
    const marks = [el.className, ...Array.from(el.attributes).map((a) => a.name + '=' + a.value)].join(' ');
    if (/dark/i.test(marks)) return 'dark';
    if (/light/i.test(marks)) return 'light';
  } catch (err) {
    // cross-origin parent: fall through
  }
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
