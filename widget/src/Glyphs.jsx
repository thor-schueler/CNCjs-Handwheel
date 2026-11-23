const base = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };

/** USB trident. */
export function Usb() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" {...base} strokeWidth="1.8">
      <path d="M12 18V4" />
      <path d="M12 14l-5-3V8.5M12 12l5-3V7.5" />
      <circle cx="12" cy="20" r="1.7" fill="currentColor" />
      <rect x="5.6" y="6" width="2.8" height="2.8" fill="currentColor" />
      <circle cx="17" cy="6.6" r="1.6" fill="currentColor" />
      <path d="M12 2l-2 3h4z" fill="currentColor" />
    </svg>
  );
}

/** Bluetooth rune. */
export function Bluetooth() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" {...base} strokeWidth="1.8">
      <path d="M6.5 7.5l11 9-5.5 4.5V3l5.5 4.5-11 9" />
    </svg>
  );
}

/** Dashed circle: unknown. */
export function Unknown({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} {...base} strokeWidth="1.8">
      <circle cx="12" cy="12" r="8" strokeDasharray="3 3" />
    </svg>
  );
}

/**
 * Battery gauge, filled to `pct` percent (null: unknown, drawn dashed), with a bolt when charging.
 */
export function Battery({ pct, charging }) {
  const known = pct !== null && pct !== undefined;
  const fillW = known ? Math.max(0, Math.min(100, pct)) * 0.19 : 0;
  return (
    <svg viewBox="0 0 28 16" width="34" height="19" {...base}>
      <rect x="1" y="1.5" width="23" height="13" rx="2.5" strokeWidth="1.6" strokeDasharray={known ? undefined : '3 2.4'} />
      <rect x="25" y="5.5" width="2" height="5" rx="1" fill="currentColor" stroke="none" />
      {known && <rect x="3" y="3.5" width={fillW} height="9" rx="1" fill="currentColor" stroke="none" />}
      {charging && <path d="M12.5 4.5L8 11h3l-1 4.5 4.5-6.5h-3z" fill="var(--bg)" stroke="none" />}
    </svg>
  );
}

/** Circle with a check mark, triangle with an exclamation mark, or circle with a cross. */
export function Indicator({ kind }) {
  if (kind === 'ok') {
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" {...base} strokeWidth="2.2"><circle cx="12" cy="12" r="9" /><path d="M8 12.5l3 3 5-6" /></svg>
    );
  }
  if (kind === 'warn') {
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" {...base} strokeWidth="2.2">
        <path d="M12 3.5L21.5 20h-19z" /><path d="M12 10v4.5" /><circle cx="12" cy="17.3" r=".6" fill="currentColor" />
      </svg>
    );
  }
  if (kind === 'err') {
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" {...base} strokeWidth="2.2"><circle cx="12" cy="12" r="9" /><path d="M8.5 8.5l7 7M15.5 8.5l-7 7" /></svg>
    );
  }
  return <Unknown size={18} />;
}
