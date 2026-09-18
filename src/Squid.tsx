import { useRef } from 'react';
import type { Hand, Room, SquidSettlement } from './types';
import './squid.css';

const n = (v: number) => v.toLocaleString('zh-CN');
const signed = (v: number) => `${v > 0 ? '+' : ''}${n(v)}`;

export function SquidRules() {
  return <div className="bounty-rules">
    <p>每轮至少两人，N 人发 N−1 个鱿鱼，可以重复获得。全部发完后结算，再开始下一轮。</p>
    <ul>
      <li>独赢主池获得一个，其他人全部弃牌也算；平分、仅赢边池或未形成底池不发放。发两次牌只看第一组主池。</li>
      <li>可选“获得鱿鱼时自动亮出两张底牌”，默认关闭。</li>
      <li>新人从实际参与下一手起加入本轮，并增加一个鱿鱼；同身份恢复或重新入座不重复增加。</li>
      <li>没有鱿鱼的玩家向持有者按数量 × 单价付款；有鱿鱼者之间不互付。</li>
      <li>先结算底池、2–7奖励，再结算鱿鱼，最后买出和补码。各人按自己余额支付，不足额按应收比例分配，不让其他付款者补足，不欠账。</li>
      <li>离座、AWAY、断线不免除本轮责任，也不减少鱿鱼总数。离座筹码暂留，轮末收付后再买出；同身份经批准可恢复入座。</li>
      <li>每轮全部标记采用生效后的单价，包括离座者；改价从下一手生效，不追溯已结算轮次。</li>
      <li>进入 Straddle 询问就锁定本手规则；没有进行或准备中的手牌时，修改立即生效。生效前反复修改以最终设置为准。</li>
      <li>关闭玩法作废未完成轮次并释放暂留筹码。本手恰好完成整轮仍照常结算；结束房间同样处理。</li>
      <li>暂停、人数不足、重启保留进度。鱿鱼扣光也计被清台；原已为零且实付零不会重复计数。</li>
    </ul>
  </div>;
}

export function SquidSettlementView({ event }: { event: SquidSettlement }) {
  return <section className="squid-settlement" aria-label={`第 ${event.number} 轮鱿鱼记录`}>
    <h3>第 {event.number} 轮鱿鱼 · {event.status === 'cancelled' ? '已作废' : '已结算'}</h3>
    <p>单价 {n(event.amount)} · {event.status === 'cancelled' ? event.reason : `共 ${event.total} 个`}</p>
    {event.results.map(r => <p key={r.pid}><strong>{r.name}</strong> · {r.count} 个
      <b className={r.delta >= 0 ? 'positive' : 'negative'}>{signed(r.delta)}</b></p>)}
    {event.payments.map(p => <details key={p.pid}><summary>{p.name} 实付 {n(p.amount)} / 应付 {n(p.due)}
      {p.amount < p.due ? '（余额不足）' : ''}</summary>
      {p.transfers.map(t => <p key={t.pid}>向 {t.name} 支付 {n(t.amount)} / 应付 {n(t.due)}</p>)}
    </details>)}
  </section>;
}

export function SquidDetails({ room }: { room: Room }) {
  const round = room.squid_round;
  return <div className="squid-details">
    {round ? <section><h3>第 {round.number} 轮 · 已发 {round.members.reduce((s, m) => s + m.count, 0)}/{round.total}</h3>
      <p>每个 {n(round.amount)} 筹码</p>
      {round.members.map(m => {
        const p = room.players.find(p => p.id === m.pid);
        return <div className="squid-member" key={m.pid}><strong>{p?.name || m.name}</strong>
          <span>🦑 {m.count}</span><small>{p?.squid_held ? `已离座 · 待结算筹码 ${n(p.holding)}`
            : p?.away ? 'AWAY · 保留本轮收付' : '本轮参与者'}</small></div>;
      })}</section> : <p className="muted">{room.closed_at ? '房间已结束' : room.settings.squid ? '等待至少两人发牌，开始新一轮' : '鱿鱼游戏已关闭'}</p>}
    {[...(room.squid_history || [])].reverse().map(e => <SquidSettlementView event={e} key={e.id} />)}
    <details className="squid-rules-details"><summary>玩法规则</summary><SquidRules /></details>
  </div>;
}

export function SquidNotice({ hand, connection, now }: { hand: Hand | null; connection: number; now: number }) {
  const event = hand?.squid;
  const baseline = useRef({ connection, id: event?.award.id, until: 0 });
  if (baseline.current.connection !== connection) baseline.current = { connection, id: event?.award.id, until: 0 };
  else if (baseline.current.id !== event?.award.id) baseline.current = { connection, id: event?.award.id,
    until: event ? Math.min(now + 3, event.award.at + 3) : 0 };
  if (!event || now >= baseline.current.until) return null;
  return <div className="squid-notice" role="status">🦑 {event.award.name} 获得鱿鱼 · 本轮 {event.award.count} 个
    {event.settlement && <span>第 {event.award.round} 轮已结算 · 点击鱿鱼状态查看收付</span>}
  </div>;
}
