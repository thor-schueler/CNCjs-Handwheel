import { useEffect, useRef, useState } from 'react';

const params = new URLSearchParams(window.location.search);

/**
 * Base URL of the bridge's HTTP endpoint as seen from the browser. In production this is a path on the
 * same origin as CNCjs that the reverse proxy forwards to the bridge (see the README); `?api=` overrides it.
 */
export const API_BASE = (params.get('api') || '/handwheel-api').replace(/\/+$/, '');

const FETCH_TIMEOUT_MS = 3000;

/** Poll interval in ms: `?poll=` (at least 200), default 400. The bridge answers from memory, so this is cheap. */
const POLL_MS = Math.max(200, Number(params.get('poll')) || 400);

/**
 * GETs JSON from the bridge, failing after FETCH_TIMEOUT_MS.
 *
 * @param {string} path - e.g. '/status'
 * @param {AbortSignal} [signal] - cancels the request
 * @returns {Promise<object>} the parsed body
 */
async function getJson(path, signal) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort);
  try {
    const res = await fetch(API_BASE + path, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Polls the bridge. /status is always polled; /log only while `withLog` is true (expanded view),
 * incrementally by entry id. Polling pauses while the page is hidden.
 *
 * @param {object} opts
 * @param {boolean} opts.withLog - also poll /log
 * @param {number} [opts.intervalMs] - poll interval
 * @param {number} [opts.logMax] - log entries kept in memory
 * @returns {{status: ?object, error: ?string, lastOkAt: ?number, log: object[]}}
 */
export function useBridge({ withLog, intervalMs = POLL_MS, logMax = 300 }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [lastOkAt, setLastOkAt] = useState(null);
  const [log, setLog] = useState([]);
  const lastLogId = useRef(0);

  useEffect(() => {
    let stopped = false;
    let timer = null;
    const ctrl = new AbortController();

    const tick = async () => {
      if (!document.hidden) {
        try {
          const st = await getJson('/status', ctrl.signal);
          if (stopped) return;
          setStatus(st);
          setError(null);
          setLastOkAt(Date.now());
          if (withLog) {
            const lg = await getJson('/log?since=' + lastLogId.current, ctrl.signal);
            if (stopped) return;
            // The ring buffer ids only grow; `last` going backwards means the bridge restarted.
            if (lg.last < lastLogId.current) {
              lastLogId.current = 0;
              setLog([]);
            } else if (lg.entries.length) {
              lastLogId.current = lg.last;
              setLog((prev) => prev.concat(lg.entries).slice(-logMax));
            }
          }
        } catch (err) {
          if (stopped) return;
          setError(err && err.name === 'AbortError' ? 'timeout' : String((err && err.message) || err));
        }
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    tick();

    return () => {
      stopped = true;
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [withLog, intervalMs, logMax]);

  return { status, error, lastOkAt, log };
}

/**
 * Reduces a /status report to one of the five link states the indicator shows.
 *
 * @param {?object} status - last /status body, or null if never fetched
 * @param {?string} error - last fetch error, null if the last fetch worked
 * @returns {{level: 'offline'|'down'|'warn'|'ok'|'unknown', text: string}}
 */
export function linkState(status, error) {
  if (error) return { level: 'offline', text: 'Bridge unreachable' };
  if (!status) return { level: 'unknown', text: 'Connecting…' };
  // Older bridge versions report fewer fields; treat a missing one as "not connected".
  if (!(status.pendant && status.pendant.connected)) return { level: 'down', text: 'Handwheel disconnected' };
  if (!(status.cncjs && status.cncjs.socketConnected)) return { level: 'warn', text: 'CNCjs not reachable' };
  if (!status.cncjs.portOpen) return { level: 'warn', text: 'Machine port closed' };
  return { level: 'ok', text: 'Handwheel connected' };
}
