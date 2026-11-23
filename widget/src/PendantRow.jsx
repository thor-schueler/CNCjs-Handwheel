import { Battery, Bluetooth, Indicator, Unknown, Usb } from './Glyphs';
import { eta as formatEta } from './format';

const LINK_NAME = { usb: 'USB', bluetooth: 'Bluetooth' };

/** Battery colour class: green, amber at 30 % and below, red at 15 % and below. */
const batteryLevel = (pct) => (pct <= 15 ? 'low' : pct <= 30 ? 'mid' : 'ok');

const INDICATOR_TEXT = { ok: 'OK', warn: 'Check log', err: 'Check log' };

/**
 * The handwheel's own state as a row of glyphs: connection type, battery (gauge, charging, time to full or
 * empty) and an ok / warning / error indicator. Shows "no data" while the pendant is not connected or does
 * not report its state (yet).
 *
 * @param {object} props
 * @param {object} props.pendant - `pendant` part of the bridge's /status
 */
export default function PendantRow({ pendant }) {
  const up = !!(pendant && pendant.connected);
  const info = up && pendant.info ? pendant.info : null;
  const link = up ? pendant.link : null;
  const hasBat = !!info && info.bat !== undefined;
  const state = info && info.st ? info.st : null;

  return (
    <div className="pend">
      <span className={'g' + (link ? '' : ' muted')} title={link ? LINK_NAME[link] : 'Connection type unknown'}>
        {link === 'usb' ? <Usb /> : link === 'bluetooth' ? <Bluetooth /> : <Unknown />}
        <small>{link ? LINK_NAME[link] : '–'}</small>
      </span>
      <span className={'g bat ' + (hasBat ? batteryLevel(info.bat) : 'muted')}>
        <Battery pct={hasBat ? info.bat : null} charging={hasBat && !!info.chg} />
        <span className="pct">{hasBat ? info.bat + '%' : '–'}</span>
        {hasBat && info.eta !== undefined && <small>{formatEta(info.eta)} {info.chg ? 'to full' : 'left'}</small>}
      </span>
      <span className={'g st s-' + (state || 'unk')}>
        <Indicator kind={state} />
        <small>{state ? INDICATOR_TEXT[state] : up ? 'No status' : 'No data'}</small>
      </span>
    </div>
  );
}
