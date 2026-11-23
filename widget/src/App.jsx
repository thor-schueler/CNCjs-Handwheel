import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import Dial from './Dial';
import PendantRow from './PendantRow';
import { API_BASE, useBridge, linkState } from './bridge';
import { DEBUG, useHostFullscreen, useHostHeight } from './host';
import { ago, clock, coord, duration } from './format';

/** One "label value" row. */
function Row({ label, children }) {
  return (
    <div className="row">
      <span className="label">{label}</span>
      <span className="value">{children}</span>
    </div>
  );
}

/** A titled group of rows. */
function Card({ title, children }) {
  return (
    <section className="card">
      <h3>{title}</h3>
      <div className="body">{children}</div>
    </section>
  );
}

/**
 * A counter. kind 'bad': red when not zero. kind 'good': green when zero. kind 'plain' (default): never coloured.
 */
function Num({ value, kind = 'plain' }) {
  const n = Number(value) || 0;
  const cls = kind === 'bad' ? (n > 0 ? 'bad' : '') : kind === 'good' ? (n === 0 ? 'good' : '') : '';
  return <b className={cls}>{value === undefined || value === null ? '–' : value}</b>;
}

/** Joins counters as 1|2|3; each item is `[value, kind]`. */
function Bar({ items }) {
  return items.map(([v, kind], i) => (
    <span key={i}>{i > 0 && <i>|</i>}<Num value={v} kind={kind} /></span>
  ));
}

/** Smallest height of the log pane when it is fitted to the screen, and the room left below for the iframe's baseline gap. */
const MIN_LOG_HEIGHT = 120;
const FIT_SLACK = 6;

/** How long "Jog" stays up after the last jog the wheel asked for. */
const JOG_HOLD_MS = 700;

/** CSS class of the Grbl machine state in the status line. */
const stateClass = (s) => (/^(Run|Jog|Home)/i.test(s) ? 'busy' : /^(Hold|Door)/i.test(s) ? 'warn' : /^Alarm/i.test(s) ? 'bad' : '');

/** Auto-scrolling pendant log; stops following when the user scrolls up. */
function Log({ entries, height, boxRef, emptyNote }) {
  const own = useRef(null);
  const box = boxRef || own;
  const follow = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const onScroll = () => {
    const el = box.current;
    follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
  };

  return (
    <div className="log" ref={box} style={height ? { height } : undefined} onScroll={onScroll} role="log" aria-label="Handwheel log">
      {entries.length === 0
        ? <div className="empty">No log lines from the handwheel yet.{emptyNote ? ' ' + emptyNote : ''}</div>
        : entries.map((e) => (
          <div key={e.id} className="logline"><span className="time">{clock(e.t)}</span> {e.text}</div>
        ))}
    </div>
  );
}

/** The detail view: machine, pendant, CNCjs and jog statistics plus the pendant log. */
function Details({ status, log, age, machineState, logHeight, logRef }) {
  // Everything but the link state is optional: older bridge versions report fewer fields.
  const { pendant = {}, cncjs = {}, jog, lastCommand } = status;
  const s = status.status || {};
  const sender = s.sender || {};
  const wpos = s.wpos;
  return (
    <>
      <div className="cards">
        <Card title="Machine">
          <Row label="State"><span className={'mstate ' + stateClass(machineState)}>{machineState}</span></Row>
          {wpos && ['x', 'y', 'z'].map((a) => (
            <Row key={a} label={'Work ' + a.toUpperCase()}><span className="mono">{coord(wpos[a])}</span></Row>
          ))}
          {s.feed !== null && s.feed !== undefined && (
            <Row label="Feed / spindle">{s.feed} / {s.spindle === null || s.spindle === undefined ? '–' : s.spindle}</Row>
          )}
          {sender.name && <Row label="Job">{sender.name} {sender.sent}/{sender.total}{sender.hold ? ' (hold)' : ''}</Row>}
        </Card>
        <Card title="Handwheel">
          <Row label="Port">{pendant.path || '–'}</Row>
          {pendant.powerDetect && (
            <Row label="Power">{pendant.powered === true ? 'on' : pendant.powered === false ? 'switched off' : pendant.powerError ? 'unreadable' : 'checking…'}</Row>
          )}
          {status.version && <Row label="Bridge">v{status.version}{status.uptimeMs !== undefined ? ', up ' + duration(status.uptimeMs) : ''}</Row>}
          <Row label="Last line in">{ago(age(pendant.lastRxAgeMs))}</Row>
          <Row label="Last line out">{ago(age(pendant.lastTxAgeMs))}</Row>
          <Row label="Lines in / out">{pendant.rxLines} / {pendant.txLines}</Row>
          <Row label="Reconnects"><Num value={pendant.reconnects} kind="bad" /></Row>
          <Row label="Errors"><Num value={pendant.errors} kind="bad" />{pendant.lastError ? <span className="bad"> – {pendant.lastError}</span> : null}</Row>
          <Row label="Dropped lines"><Num value={pendant.garbageLines} kind="bad" /></Row>
          {pendant.sendEnabled !== undefined && <Row label="Status to pendant">{pendant.sendEnabled ? 'on' : 'off'}</Row>}
        </Card>
        <Card title="CNCjs">
          <Row label="Socket">{cncjs.socketConnected ? 'connected' : 'down'}</Row>
          <Row label="Machine port">{cncjs.portOpen ? 'open' : 'closed'}</Row>
          <Row label="Device">{cncjs.port || '–'}</Row>
          <Row label="Controller">{cncjs.controllerType || '–'}</Row>
          <Row label="Dropped commands"><Num value={cncjs.droppedCommands} kind="bad" /></Row>
          {cncjs.lastError && <Row label="Last error"><span className="bad">{cncjs.lastError}</span></Row>}
        </Card>
        {(jog || lastCommand) && (
          <Card title="Jogging">
            {jog && (
              <>
                <Row label="Sent | merged"><Bar items={[[jog.sent], [jog.merged]]} /></Row>
                <Row label="Discarded"><Num value={jog.discarded} /></Row>
                <Row label="In flight | held"><Bar items={[[jog.inFlight || 0, 'good'], [jog.held ? 1 : 0, 'good']]} /></Row>
                <Row label="Cancels | stalls"><Bar items={[[jog.cancels], [jog.stalls, 'bad']]} /></Row>
              </>
            )}
            {lastCommand && <Row label="Last command"><span className="mono">{lastCommand.name}</span> {ago(Date.now() - lastCommand.at)}</Row>}
          </Card>
        )}
      </div>
      <section className="card logcard">
        <h3>Handwheel log</h3>
        <Log entries={log} height={logHeight} boxRef={logRef}
          emptyNote={'The bridge has received ' + (pendant.rxLines || 0) + ' lines from it, ' + (pendant.logLines || 0)
            + ' of them log lines (log lines start with a semicolon).'} />
      </section>
    </>
  );
}

export default function App() {
  const hostFullscreen = useHostFullscreen();
  const [manual, setManual] = useState(false);
  const expanded = hostFullscreen || manual;

  const { status, error, lastOkAt, log } = useBridge({ withLog: expanded });
  const link = linkState(status, error);
  // Ages in the report are relative to the moment it was built; add the time since it arrived.
  const age = (ms) => (ms === null || ms === undefined ? null : ms + (Date.now() - lastOkAt));

  let machineState = ((status && status.status && status.status.state) || '–').replace(/:\d+$/, ''); // Grbl's Hold:0 / Door:1 sub-state
  // Grbl is only sampled a few times a second and each 0.1 mm jog is over in milliseconds, so a wheel being
  // turned shows up as "Idle" most of the time. The bridge knows better: while jogs are in flight or were
  // requested a moment ago, say so.
  if (machineState === 'Idle' && status && status.jog && (status.jog.inFlight > 0
    || (status.jog.lastAgeMs !== null && status.jog.lastAgeMs !== undefined && age(status.jog.lastAgeMs) < JOG_HOLD_MS))) {
    machineState = 'Jog';
  }
  // "Drop" adds the pendant lines the bridge could not use and the commands it could not hand to CNCjs.
  const counts = status && status.pendant
    ? [status.pendant.reconnects || 0, status.pendant.errors || 0,
      (status.pendant.garbageLines || 0) + ((status.cncjs && status.cncjs.droppedCommands) || 0)]
    : null;

  // Full screen: the iframe is exactly as tall as its content, so a log of fixed height makes the CNCjs widget
  // scroll whenever the screen is shorter than the content, and leaves empty space when it is taller. Make the
  // log take up whatever height is left instead (same origin only; elsewhere it keeps its default height).
  const rootRef = useRef(null);
  const logRef = useRef(null);
  const availHeight = useHostHeight(hostFullscreen);
  const [logHeight, setLogHeight] = useState(null);
  useLayoutEffect(() => {
    const fit = hostFullscreen && availHeight !== null && rootRef.current && logRef.current;
    const next = fit ? Math.max(MIN_LOG_HEIGHT, Math.floor(availHeight - (rootRef.current.offsetHeight - logRef.current.offsetHeight) - FIT_SLACK)) : null;
    if (next !== logHeight) setLogHeight(next);
  });

  return (
    <div ref={rootRef} className={'widget level-' + link.level + (expanded ? ' expanded' : '')}>
      <header className="head">
        <span className="icon"><Dial size={36} /></span>
        <span className="title">
          <strong>{link.text}</strong>
          <small className="counts">
            {status && !error ? (
              <>
                <span className={'mstate ' + stateClass(machineState)}>{machineState}</span>
                {counts && <span><em>Reconn|Err|Drop</em> <Bar items={counts.map((v) => [v, 'bad'])} /></span>}
                {status.jog && <span><em>In flight|Held</em> <Bar items={[[status.jog.inFlight || 0, 'good'], [status.jog.held ? 1 : 0, 'good']]} /></span>}
              </>
            ) : (error && lastOkAt ? 'last seen ' + ago(Date.now() - lastOkAt) : '')}
          </small>
        </span>
        {DEBUG && !hostFullscreen && (
          <button type="button" className="toggle" onClick={() => setManual(!manual)}
            aria-label={expanded ? 'Show less' : 'Show details'} aria-expanded={expanded} title={expanded ? 'Show less' : 'Show details'}>
            {expanded ? '▴' : '▾'}
          </button>
        )}
      </header>
      {status && !error && <PendantRow pendant={status.pendant} />}
      {expanded && status && !error && (
        <Details status={status} log={log} age={age} machineState={machineState} logHeight={logHeight} logRef={logRef} />
      )}
      {expanded && error && <p className="hint">Cannot reach the bridge at <code>{API_BASE}</code> ({error}). Is the service running and the proxy route in place?</p>}
    </div>
  );
}
