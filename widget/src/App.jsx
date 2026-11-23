import { useEffect, useRef, useState } from 'react';
import Dial from './Dial';
import { API_BASE, useBridge, linkState } from './bridge';
import { useHostFullscreen } from './host';
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
      {children}
    </section>
  );
}

/** Auto-scrolling pendant log; stops following when the user scrolls up. */
function Log({ entries }) {
  const box = useRef(null);
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
    <div className="log" ref={box} onScroll={onScroll} role="log" aria-label="Handwheel log">
      {entries.length === 0
        ? <div className="empty">No log lines from the handwheel yet.</div>
        : entries.map((e) => (
          <div key={e.id} className="logline"><span className="time">{clock(e.t)}</span> {e.text}</div>
        ))}
    </div>
  );
}

/** The detail view: machine, pendant, CNCjs and jog statistics plus the pendant log. */
function Details({ status, log, age }) {
  // Everything but the link state is optional: older bridge versions report fewer fields.
  const { pendant = {}, cncjs = {}, jog, lastCommand } = status;
  const s = status.status || {};
  const sender = s.sender || {};
  const wpos = s.wpos;
  return (
    <>
      <div className="cards">
        <Card title="Machine">
          <Row label="State">{s.state || '–'}</Row>
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
          <Row label="Last line in">{ago(age(pendant.lastRxAgeMs))}</Row>
          <Row label="Last line out">{ago(age(pendant.lastTxAgeMs))}</Row>
          <Row label="Lines in / out">{pendant.rxLines} / {pendant.txLines}</Row>
          <Row label="Reconnects">{pendant.reconnects}</Row>
          <Row label="Errors">{pendant.errors}{pendant.lastError ? ' – ' + pendant.lastError : ''}</Row>
          <Row label="Dropped lines">{pendant.garbageLines}</Row>
          {pendant.sendEnabled !== undefined && <Row label="Status to pendant">{pendant.sendEnabled ? 'on' : 'off'}</Row>}
        </Card>
        <Card title="CNCjs">
          <Row label="Socket">{cncjs.socketConnected ? 'connected' : 'down'}</Row>
          <Row label="Machine port">{cncjs.portOpen ? 'open' : 'closed'}</Row>
          <Row label="Device">{cncjs.port || '–'}</Row>
          <Row label="Controller">{cncjs.controllerType || '–'}</Row>
          <Row label="Dropped commands">{cncjs.droppedCommands}</Row>
          {cncjs.lastError && <Row label="Last error">{cncjs.lastError}</Row>}
        </Card>
        {(jog || lastCommand) && (
          <Card title="Jogging">
            {jog && (
              <>
                <Row label="Sent / merged">{jog.sent} / {jog.merged}</Row>
                <Row label="Discarded">{jog.discarded}</Row>
                <Row label="In flight">{jog.inFlight}{jog.held ? ' (+1 held)' : ''}</Row>
                <Row label="Cancels / stalls">{jog.cancels} / {jog.stalls}</Row>
              </>
            )}
            {lastCommand && <Row label="Last command"><span className="mono">{lastCommand.name}</span> {ago(Date.now() - lastCommand.at)}</Row>}
          </Card>
        )}
      </div>
      <h3 className="logtitle">Handwheel log</h3>
      <Log entries={log} />
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

  let line = '';
  if (status && !error) {
    const s = status.status || {};
    line = s.state || '';
    if (status.jog && status.jog.inFlight) line += ' · jog ' + status.jog.inFlight + ' in flight';
    if (status.pendant && status.pendant.connected && status.pendant.lastRxAgeMs !== undefined) {
      line += ' · ' + ago(age(status.pendant.lastRxAgeMs));
    }
  } else if (error && lastOkAt) {
    line = 'last seen ' + ago(Date.now() - lastOkAt);
  }

  return (
    <div className={'widget level-' + link.level + (expanded ? ' expanded' : '')}>
      <header className="head">
        <span className="icon"><Dial size={expanded ? 44 : 36} /></span>
        <span className="title">
          <strong>{link.text}</strong>
          <small>{line}{expanded && status && !error ? (status.uptimeMs !== undefined ? ' · up ' + duration(status.uptimeMs) : '') + (status.version ? ' · v' + status.version : '') : ''}</small>
        </span>
        {!hostFullscreen && (
          <button type="button" className="toggle" onClick={() => setManual(!manual)}
            aria-label={expanded ? 'Show less' : 'Show details'} aria-expanded={expanded} title={expanded ? 'Show less' : 'Show details'}>
            {expanded ? '▴' : '▾'}
          </button>
        )}
      </header>
      {expanded && status && !error && <Details status={status} log={log} age={age} />}
      {expanded && error && <p className="hint">Cannot reach the bridge at <code>{API_BASE}</code> ({error}). Is the service running and the proxy route in place?</p>}
    </div>
  );
}
