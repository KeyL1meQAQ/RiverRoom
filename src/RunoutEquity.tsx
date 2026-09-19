import { useEffect, useRef, useState } from 'react';

function percentage(value: number) {
  if (value === 0 || value === 100) return `${value}%`;
  if (value < 1) return '<1%';
  if (value > 99) return '>99%';
  return `${Math.round(value)}%`;
}

/** The parent remounts on a new hand, board or connection: no stale animation. */
export function RunoutEquity({ wins, total, tone }: {
  wins: number; total: number; tone: 'leading' | 'trailing' | 'tied';
}) {
  const value = wins * 100 / total;
  const [display, setDisplay] = useState(value);
  const current = useRef(value);
  useEffect(() => {
    let frame = 0;
    const from = current.current;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const finish = () => { cancelAnimationFrame(frame); current.current = value; setDisplay(value); };
    if (from === value || reduced.matches || document.visibilityState !== 'visible') {
      finish();
      return;
    }
    const start = performance.now();
    const step = (at: number) => {
      const progress = Math.min(1, (at - start) / 220);
      current.current = from + (value - from) * progress;
      setDisplay(current.current);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    document.addEventListener('visibilitychange', finish);
    reduced.addEventListener('change', finish);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', finish);
      reduced.removeEventListener('change', finish);
    };
  }, [value]);
  const label = percentage(value);
  const state = { leading: '领先', trailing: '落后', tied: '持平' }[tone];
  // Endpoints and boundary labels describe the true target, never an animation.
  const text = value < 1 || value > 99 ? label : percentage(Math.max(1, Math.min(99, display)));
  return <span className={`runout-equity ${tone}`} role="img" data-value={value} data-tone={tone}
    title={`独赢胜率 ${label} · ${state}（平分不计胜，忽略边池）`}
    aria-label={`独赢胜率 ${label}，${state}`}>{text}</span>;
}
