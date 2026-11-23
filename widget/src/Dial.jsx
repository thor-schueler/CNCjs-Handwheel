/**
 * Handwheel icon: a dial with detent ticks and a knob. The colour comes from CSS (`currentColor`).
 */
export default function Dial({ size = 36 }) {
  const ticks = [];
  for (let i = 0; i < 24; i++) {
    const a = (i * Math.PI * 2) / 24;
    const long = i % 6 === 0;
    const r1 = long ? 13 : 14.5;
    ticks.push(
      <line key={i} x1={20 + Math.sin(a) * r1} y1={20 - Math.cos(a) * r1}
        x2={20 + Math.sin(a) * 17.5} y2={20 - Math.cos(a) * 17.5} strokeWidth={long ? 2 : 1.2} />
    );
  }
  return (
    <svg className="dial" width={size} height={size} viewBox="0 0 40 40" fill="none"
      stroke="currentColor" strokeLinecap="round" aria-hidden="true">
      {ticks}
      <circle cx="20" cy="20" r="10" strokeWidth="2" />
      <circle cx="20" cy="13" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  );
}
