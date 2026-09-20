import { useRef } from 'react';
import type { CSSProperties } from 'react';
import type { Hand } from './types';
import './bounty.css';

const n = (value: number) => value.toLocaleString('zh-CN');

export function BountyRules() {
  return <div className="bounty-rules">
    <div className="bounty-rule-mark" aria-hidden="true">7♠ <span>2♥</span></div>
    <p className="rules-intro">用不同花色的 2 和 7 独赢主池，赢取底池之外的额外奖励。</p>
    <h3>怎么玩</h3>
    <ul>
      <li><strong>拿到 2–7 杂色底牌：</strong>两张底牌一张是 2、一张是 7，花色不同即可。7♠2♣ 也算，不必一红一黑。</li>
      <li><strong>独赢主池：</strong>摊牌获胜，或让其他人全部弃牌，都能获得奖励。</li>
      <li><strong>其他玩家每人付一份：</strong>本手拿到底牌的其他玩家各支付房间约定的筹码，弃牌、离座或断线也要支付。</li>
    </ul>
    <aside className="rules-example"><strong>举个例子</strong><p>6 人参与一手牌，每人奖励 10 筹码。你用 7♠2♥ 独赢主池，其他 5 人各付 10，你额外获得 <b>50 筹码</b>（筹码充足时）。</p></aside>
    <h3>需要注意</h3>
    <ul>
      <li><strong>自动亮牌：</strong>获得奖励时，会向所有人公开你的两张底牌，无需手动领取。</li>
      <li><strong>筹码不足不欠账：</strong>先分配底池，再从桌上筹码支付奖励。余额不足就付清剩余筹码，赢家收到的是实际支付的总额。</li>
      <li><strong>设置修改从下一手生效：</strong>当前手仍按原来的奖励规则进行。</li>
    </ul>
    <details className="rules-more"><summary>更多规则</summary>
      <ul>
        <li><strong>哪些情况不奖励：</strong>同花的 2 和 7、仅公共牌出现 2 和 7、主池平分、只赢边池，或没有形成底池而仅退回投入。</li>
        <li><strong>发两次牌：</strong>必须独赢两组主池；不要求赢得边池，每手只奖励一次。</li>
        <li><strong>谁不用支付：</strong>没有参与本手发牌的玩家和观战者。</li>
        <li><strong>奖励金额：</strong>首次开启默认每人一个大盲的筹码数，房主可以修改。之后调整盲注、Straddle 或关闭再开启，都不会自动改变已设金额。</li>
        <li><strong>支付后筹码归零：</strong>也算被清台。奖励结算后再处理离座取回筹码和补码。</li>
        <li><strong>正在询问 Straddle：</strong>这一手也按原规则进行，新设置从随后一手生效。</li>
      </ul>
    </details>
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
