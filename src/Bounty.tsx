import { useRef } from 'react';
import type { CSSProperties } from 'react';
import type { Hand } from './types';
import './bounty.css';

const n = (value: number) => value.toLocaleString('zh-CN');

export function BountyRules() {
  return <div className="bounty-rules">
    <div className="bounty-rule-mark" aria-hidden="true">7♠ <span>2♥</span></div>
    <p>用不同花色的 2 和 7 赢下主池，收取其他玩家支付的额外奖励。</p>
    <ul>
      <li>独赢主池才触发，诈唬让其他人全部弃牌也算。仅赢边池、主池平分或未形成底池不奖励。</li>
      <li>发两次牌时，必须独赢两组主池；每手只奖励一次，不要求赢得边池。</li>
      <li>中奖时自动公开两张底牌。本手其他获发底牌的玩家都要支付，已弃牌或断线也一样；观战、AWAY 和等待下一手加入者不支付。</li>
      <li>先分配底池，再支付奖励，最后处理离座和补码。余额不足就付清剩余筹码，不欠账、不自动补码；奖励扣光也计一次被清台。</li>
      <li>每人金额是固定筹码，首次开启默认一个大盲；改盲注、Straddle 或关闭再开启不会自动改变已保存金额。</li>
      <li>房主可随时修改奖励，从下一手生效。已经进入 Straddle 询问的一手保持原规则。</li>
    </ul>
    <p className="muted">杂色指花色不同，7♠2♣ 也符合。公屏显示实际收到的奖励总额，包括 +0。</p>
  </div>;
}

export function BountyCelebration({ hand, connection, now }: {
  hand: Hand | null; connection: number; now: number;
}) {
  const award = hand?.bounty;
  const at = hand?.presentation?.until ?? award?.at ?? 0;
  const baseline = useRef({ connection, event: award?.id, until: 0 });
  if (baseline.current.connection !== connection) {
    baseline.current = { connection, event: award?.id, until: 0 };
  } else if (baseline.current.event !== award?.id) {
    baseline.current = { connection, event: award?.id,
      until: award ? at + 3 : 0 };
  }
  if (!award || !hand?.result || now < at || now >= baseline.current.until || document.visibilityState !== 'visible') return null;
  return <div className="bounty-celebration" key={award.id} role="status" aria-live="polite"
    aria-label={`${award.name}获得2-7奖励 +${n(award.total)}`}>
    <div className="bounty-halo" aria-hidden="true" />
    <div className="bounty-sparks" aria-hidden="true">
      {Array.from({ length: 12 }, (_, i) => <i key={i} style={{ rotate: `${i * 30}deg` }} />)}
    </div>
    <div className="bounty-emblem" aria-hidden="true">
      <div className="bounty-laurel">✦</div>
      <div className="bounty-mini-card seven">7<span>♠</span></div>
      <div className="bounty-mini-card deuce">2<span>♥</span></div>
      <span className="bounty-ribbon">SEVEN DEUCE</span>
    </div>
    <div className="bounty-caption"><strong>{award.name}</strong><span>获得2-7奖励</span></div>
    <div className="bounty-total" style={{ '--bounty-units': (n(award.total).length + 1) * .7 } as CSSProperties}>+{n(award.total)}</div>
  </div>;
}
