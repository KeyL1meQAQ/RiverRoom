import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Coins } from 'lucide-react';
import type { ChipTransfer, Room, SettlementPresentation } from './types';
import './settlement.css';

const number = (value: number) => value.toLocaleString('zh-CN');

export function settlementBalances(plan: SettlementPresentation, now: number) {
  const balances = Object.fromEntries(Object.entries(plan.accounts).map(([pid, account]) => [pid, account.before]));
  for (const event of plan.events) {
    if (event.source && now >= event.start) balances[event.source] -= event.amount;
    if (now >= event.until) balances[event.target] += event.amount;
  }
  return balances;
}

/** A connection/visibility boundary suppresses missed motion, not future events. */
export function useMotionBaseline(connection: number, now: number) {
  const latest = useRef({ now, local: performance.now() });
  latest.current = { now, local: performance.now() };
  const [visibility, setVisibility] = useState(0);
  const baseline = useRef({ connection, visibility, at: now });
  useEffect(() => {
    const change = () => {
      baseline.current.at = latest.current.now + (performance.now() - latest.current.local) / 1000;
      setVisibility(value => value + 1);
    };
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  if (baseline.current.connection !== connection) {
    baseline.current = { connection, visibility, at: now };
  }
  baseline.current.visibility = visibility;
  return { at: baseline.current.at, key: `${connection}:${visibility}`, visible: document.visibilityState === 'visible' };
}

export function FlipNumber({ value, now, motionKey }: { value: number; now: number; motionKey: string }) {
  const text = number(value);
  const state = useRef({ text, old: text, at: now, motionKey, seq: 0 });
  if (state.current.motionKey !== motionKey) state.current = { text, old: text, at: now, motionKey, seq: 0 };
  else if (state.current.text !== text) state.current = {
    text, old: state.current.text, at: now, motionKey, seq: state.current.seq + 1,
  };
  const old = state.current.old.padStart(text.length, ' ');
  const flipping = now - state.current.at < .4 && document.visibilityState === 'visible';
  return <span className="flip-number stack-full" aria-label={text}>
    <span aria-hidden="true" className="flip-digits">{Array.from(text).map((digit, i) => {
      const before = old[old.length - text.length + i];
      const changed = flipping && before !== digit && /\d/.test(digit);
      return <span className={`flip-digit ${digit === ',' ? 'separator' : ''}`} key={text.length - i}>
        <span className="digit-current">{digit}</span>
        {changed && <span className="digit-flaps" key={state.current.seq}>
          <span className="digit-old">{before.trim() || '0'}</span>
          <span className="digit-new">{digit}</span>
        </span>}
      </span>;
    })}</span>
  </span>;
}

type Point = { x: number; y: number };
function Flight({ event, index, count, plan, root, now, baseline }: {
  event: ChipTransfer; index: number; count: number; plan: SettlementPresentation;
  root: RefObject<HTMLDivElement | null>; now: number; baseline: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const clock = useRef({ now, local: performance.now() });
  clock.current = { now, local: performance.now() };
  useLayoutEffect(() => {
    const chip = ref.current, stage = root.current;
    if (!chip || !stage) return;
    const begin = event.kind === 'pot' && count > 1 && event.start <= plan.split_at + .251 ? plan.split_at : event.start;
    if (begin < baseline || document.visibilityState !== 'visible') return;
    let animation: Animation | undefined;
    const position = () => {
      const bounds = stage.getBoundingClientRect();
      const point = (pid: string | null): Point | null => {
        const target = pid ? Array.from(stage.querySelectorAll<HTMLElement>('[data-chip-target]'))
          .find(el => el.dataset.chipTarget === pid) : stage.querySelector<HTMLElement>('[data-pot-origin]');
        if (!target) return null;
        const rect = target.getBoundingClientRect();
        return { x: rect.left + rect.width / 2 - bounds.left, y: rect.top + rect.height / 2 - bounds.top };
      };
      const from = point(event.source), to = point(event.target);
      if (!from || !to) { chip.style.visibility = 'hidden'; return; }
      chip.style.visibility = 'visible';
      const transform = (p: Point) => `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
      const frames: Keyframe[] = [{ transform: transform(from), opacity: 1, easing: 'ease-out' }];
      if (begin < event.start) {
        const spread = { x: from.x + (index - (count - 1) / 2) * Math.min(80, 240 / Math.max(1, count - 1)), y: from.y - 16 };
        frames.push({ transform: transform(spread), opacity: 1, offset: (event.start - begin) / (event.until - begin), easing: 'ease-in-out' });
      }
      frames.push({ transform: `${transform(to)} scale(.65)`, opacity: .35 });
      animation?.cancel();
      animation = chip.animate(frames, { duration: (event.until - begin) * 1000, fill: 'both' });
      animation.currentTime = Math.max(0, (clock.current.now - begin) * 1000 + performance.now() - clock.current.local);
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(stage);
    stage.querySelectorAll('[data-chip-target]').forEach(el => observer.observe(el));
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => { animation?.cancel(); observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [event, index, count, plan, root, baseline]);
  return <div ref={ref} className={`flying-chip ${event.kind}`} data-transfer-kind={event.kind}
    data-source={event.source || 'pot'} data-target={event.target} aria-hidden="true">
    <Coins size={14} /><strong>{number(event.amount)}</strong>
  </div>;
}

export function SettlementLayer({ room, now, baseline, motionKey, root }: {
  room: Room; now: number; baseline: number; motionKey: string; root: RefObject<HTMLDivElement | null>;
}) {
  const plan = room.hand?.presentation;
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  if (!plan || now >= plan.until || room.recovery) return null;
  const pots = plan.events.filter(e => e.kind === 'pot');
  const begins = (e: ChipTransfer) => e.kind === 'pot' && pots.length > 1 && e.start <= plan.split_at + .251 ? plan.split_at : e.start;
  const active = plan.events.filter(e => now >= begins(e) && now < e.until);
  // Hold the last transfer's participants while their final digits finish flipping.
  const last = [...plan.events].reverse().find(e => now >= e.start && now < e.until + .4);
  const upcoming = plan.events.find(e => e.start > now && e.start - now <= .15);
  const displayed = active.length ? active : last ? [last] : upcoming ? [upcoming] : [];
  const ids = [...new Set(displayed.flatMap(e => [e.source, e.target]).filter((pid): pid is string => !!pid))]
    .filter(pid => room.players.find(p => p.id === pid)?.seat == null);
  const balances = settlementBalances(plan, now);
  return <>
    {ids.length > 0 && <div className={`departed-transfer ${ids.length > 1 ? 'paired' : ''}`} aria-label="离座玩家结算">
      {ids.map(pid => <div className="departed-account" key={pid}>
        <span className="departed-caption">{displayed.some(e => e.source === pid) ? '付款人' : '收款人'} · 已离座</span>
        <strong className="departed-name">{plan.accounts[pid].name}</strong>
        <strong className="departed-stack" data-chip-target={pid}>
          <FlipNumber value={balances[pid]} now={now} motionKey={`${motionKey}:${pid}`} />
        </strong>
      </div>)}
    </div>}
    {!reduced && document.visibilityState === 'visible' && active.map((event) => {
      const begin = begins(event);
      return begin >= baseline && <Flight key={`${event.kind}:${event.start}:${event.target}`} event={event}
        index={pots.indexOf(event)} count={pots.length} plan={plan} root={root} now={now} baseline={baseline} />;
    })}
  </>;
}
